/**
 * Factory for the SDK pm's spawn `Options` builder.
 *
 * polygram.js wires this at boot via createBuildSdkOptions(deps);
 * the returned function is what gets passed to ProcessManagerSdk
 * as `spawnFn`. Per-call, it composes the SdkOptions object the SDK
 * needs: model + effort + cwd + permissionMode +
 * canUseTool wiring + agent overlay + per-topic overrides + env
 * shadow + appended display hint.
 *
 * Why a factory instead of a top-level function: buildSdkOptions
 * needs polygram-runtime context (config, botName, childHome,
 * makeCanUseTool, logEvent, agentLoader). Passing them via
 * factory closure keeps the per-call signature `(sessionKey, ctx)`
 * — the shape pm-sdk's spawnFn contract requires.
 *
 * Per v4 plan §6.5.7 — explicit env enumeration (Options.env is
 * SHADOW per Phase 0 gate 33), bypassPermissions +
 * allowDangerouslySkipPermissions both set for forward-compat,
 * agent-loader composes per-chat agent into systemPrompt + skills +
 * mcpServers, optional resume sessionId for continuity.
 */

'use strict';

const agentLoader = require('../agents/loader');
const { getTopicConfig } = require('../session-key');
const { appendDisplayHint, buildPolygramDisplayHint } = require('../telegram/display-hint');
const { resolveRichTextEnabled } = require('../telegram/rich');

// Env: SHADOW semantics — must enumerate every var the spawned
// worker is allowed to see. Anything else is dropped.
const CHILD_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM',
  'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'PWD', 'SHLVL',
]);
const CHILD_ENV_PREFIXES = ['LC_', 'NODE_', 'CLAUDE_', 'ANTHROPIC_'];

function filterEnv(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (CHILD_ENV_ALLOWLIST.has(k) || CHILD_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.config             — runtime config object (config.bot, config.chats, config.defaults)
 * @param {string} deps.botName            — current bot's name
 * @param {string} deps.childHome          — HOME passed to spawned child
 * @param {(sessionKey: string) => Function} deps.makeCanUseTool  — closure that builds canUseTool callbacks
 * @param {(kind: string, detail: object) => void} deps.logEvent  — bound to db
 * @param {object} [deps.logger=console]
 * @param {object} [deps.processEnv=process.env]  — overridable for tests
 * @returns {(sessionKey: string, ctx: object) => object}  spawnFn
 */
function createBuildSdkOptions({
  config,
  botName,
  childHome,
  makeCanUseTool,
  logEvent,
  logger = console,
  processEnv = process.env,
} = {}) {

  return function buildSdkOptions(sessionKey, ctx) {
    const { chatConfig, existingSessionId, label, chatId, threadId } = ctx;

    // rc.48: per-topic config overrides. Per-topic agent / cwd /
    // permissionMode take precedence over chat-level config when
    // isolateTopics is true (each topic has its own SDK Query).
    const topicConfig = getTopicConfig(chatConfig, threadId);
    const effectiveAgent = topicConfig.agent || chatConfig.agent;

    // Per-chat agent: load + compose. Failure is non-fatal — chat
    // falls back to defaults; the failure is logged for ops.
    let agentBundle = null;
    if (effectiveAgent) {
      try {
        agentBundle = agentLoader.loadAgent(effectiveAgent, {
          homeDir: childHome,
          cwd: topicConfig.cwd || chatConfig.cwd,
          logger,
        });
      } catch (err) {
        logger.error?.(`[${label}] agent-loader: ${err.message}`);
        logEvent('agent-load-failed', {
          chat_id: chatId, agent: effectiveAgent, error: err.message,
          topic: threadId || null,
        });
      }
    }

    const effectiveModel = topicConfig.model || chatConfig.model;
    const effectiveEffort = topicConfig.effort || chatConfig.effort;
    const agentSuffix = effectiveAgent && effectiveAgent !== chatConfig.agent
      ? ` agent=${effectiveAgent}` : '';
    logger.log?.(`[${label}] Spawning SDK Query (${effectiveModel}/${effectiveEffort}${agentSuffix})`);

    // Env scrub: SHADOW. Pass the bot's per-call additions on top.
    const botConfig = config.bot || {};
    const childEnv = filterEnv(processEnv);
    childEnv.HOME = childHome;
    childEnv.CLAUDE_CHANNEL_BOT = botName;
    // 0.9.0: gated behind explicit opt-in. Pre-cleanup, the IPC secret
    // was unconditionally exported so the deleted bin/approval-hook.js
    // could authenticate; with the hook gone, the only IPC consumers
    // are external scripts (cron-driven sends) running in their own
    // processes with access to the owner-only IPC runtime directory.
    if (botConfig.exposeIpcSecretToChildren && processEnv.POLYGRAM_IPC_SECRET) {
      childEnv.POLYGRAM_IPC_SECRET = processEnv.POLYGRAM_IPC_SECRET;
      if (processEnv.POLYGRAM_IPC_DIR) {
        childEnv.POLYGRAM_IPC_DIR = processEnv.POLYGRAM_IPC_DIR;
      }
    }
    if (botConfig.needsToken) {
      childEnv.TELEGRAM_BOT_TOKEN = botConfig.token || '';
    }

    // canUseTool: in-process approval flow. Wire up only when
    // approvals.gatedTools is configured for this bot — otherwise
    // leave canUseTool unset and rely on bypassPermissions.
    const apprCfg = config.bot?.approvals;
    const useCanUseTool = apprCfg && apprCfg.adminChatId
      && Array.isArray(apprCfg.gatedTools) && apprCfg.gatedTools.length > 0;

    const baseOpts = {
      model: chatConfig.model || config.defaults.model,
      effort: chatConfig.effort || config.defaults.effort,
      cwd: chatConfig.cwd,
      env: childEnv,
      permissionMode: useCanUseTool ? 'default' : 'bypassPermissions',
      allowDangerouslySkipPermissions: !useCanUseTool,
      ...(useCanUseTool && { canUseTool: makeCanUseTool(sessionKey) }),
      hooks: {},
      executable: 'node',
      ...(existingSessionId && { resume: existingSessionId }),
      ...(processEnv.POLYGRAM_CLAUDE_BIN && {
        pathToClaudeCodeExecutable: processEnv.POLYGRAM_CLAUDE_BIN,
      }),
    };

    // agent-loader precedence: topicConfig > chatConfig > agent > defaults.
    const composed = agentLoader.composeSdkOptions(
      {
        model: chatConfig.model,
        effort: chatConfig.effort,
        cwd: chatConfig.cwd,
        ...(chatConfig.thinking && { thinking: chatConfig.thinking }),
      },
      agentBundle,
      baseOpts,
      topicConfig,
    );

    // rc.48: keep permissionMode + allowDangerouslySkipPermissions
    // consistent. If a topic flipped permissionMode away from
    // 'bypassPermissions', also disable the skip flag.
    if (composed.permissionMode && composed.permissionMode !== 'bypassPermissions') {
      composed.allowDangerouslySkipPermissions = false;
    }

    // Append polygram's display constraints to the systemPrompt —
    // infrastructure-layer hint, not agent business logic.
    //
    // Resolve the authoring hint through the same topic→chat→bot→default
    // precedence as delivery. The hint is fixed at spawn, while delivery
    // reads the value live for each send.
    // inlineMedia: replies on this path are delivered by the streamer, which
    // resolves and uploads local media into the rich payload. The reply-tool
    // path cannot, so it asks for the hint without those paragraphs.
    composed.systemPrompt = appendDisplayHint(
      composed.systemPrompt,
      buildPolygramDisplayHint(
        resolveRichTextEnabled(config, chatId, threadId),
        { inlineMedia: true },
      ),
    );
    return composed;
  };
}

module.exports = {
  createBuildSdkOptions,
  // Exposed for tests + adjacent extractions that need the same env
  // discipline (e.g. lib/sdk/callbacks.js when it ships).
  filterEnv,
  CHILD_ENV_ALLOWLIST,
  CHILD_ENV_PREFIXES,
};
