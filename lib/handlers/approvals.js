/**
 * Approval flow — SDK canUseTool callback + Telegram callback_query
 * handler + timeout sweeper.
 *
 * This factory owns the approvalWaiters Map (approval_id → array of
 * Promise-resolver fns) and exposes:
 *
 *   - makeCanUseTool(sessionKey) — closure that returns the SDK
 *     canUseTool callback. Per-call: lookup chat_tool_decisions,
 *     match against gatedTools patterns, issue pending row, post
 *     4-button card to admin chat, park resolver, race against
 *     opts.signal + timeout, return PermissionResult.
 *
 *   - handleApprovalCallback(ctx) — grammy callback_query handler
 *     for the approve / deny / approve-always / deny-always buttons.
 *     Validates token + status, atomically resolves the row,
 *     persists chat_tool_decisions for always-* clicks, edits the
 *     card to show the decision, resolves the parked waiter.
 *
 *   - startApprovalSweeper(intervalMs?) — periodic timeout sweeper.
 *     Sweeps pending rows past timeout_ts, marks them 'timeout',
 *     edits the card to ⏰ Timed out, resolves the waiter.
 *
 *   - resolveApprovalWaiter(id, decision, reason?, extra?) +
 *     dropWaiter(id, fn) — internal-but-exported for adjacent code
 *     that needs to feed back from the callback flow.
 *
 * No more dual-pm IPC: the deleted bin/approval-hook.js used to
 * connect to polygram via Unix-socket IPC; SDK pm wires canUseTool
 * in-process.
 */

'use strict';

const { canonicalizeToolInput } = require('../canonical-json');
const {
  matchesAnyPattern: matchesApprovalPattern,
  tokensEqual: approvalTokensEqual,
  DEFAULT_TIMEOUT_MS: APPROVAL_DEFAULT_TIMEOUT_MS,
} = require('../approvals/store');
const {
  buildApprovalKeyboardWithAlways,
  approvalCardText,
} = require('../approvals/ui');

function createApprovals({
  config,
  db,
  bot,
  botName,
  tg,
  logEvent,
  approvals,           // approvals store instance
  getChatIdFromKey,
  logger = console,
} = {}) {
  // approval_id → array of resolver fns
  const approvalWaiters = new Map();

  function dropWaiter(id, fn) {
    const list = approvalWaiters.get(id);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) approvalWaiters.delete(id);
  }

  function resolveApprovalWaiter(id, decision, reason, extra) {
    // `extra` carries SDK-shape updatedPermissions for always-* clicks.
    // canUseTool waiters use it to populate
    // PermissionResult.updatedPermissions so the in-flight Query
    // picks up the new rule for the rest of the turn.
    const list = approvalWaiters.get(id);
    if (!list) return;
    approvalWaiters.delete(id);
    for (const fn of list) {
      try { fn(decision, reason, extra); } catch {}
    }
  }

  function makeCanUseTool(sessionKey) {
    const chatId = getChatIdFromKey(sessionKey);
    return async function canUseTool(toolName, input, opts) {
      const apprCfg = config.bot?.approvals;
      if (!apprCfg || !apprCfg.adminChatId) {
        // Not configured for this bot → allow everything.
        return { behavior: 'allow' };
      }

      const canonicalInput = canonicalizeToolInput(input);

      // chat_tool_decisions short-circuit.
      try {
        const persisted = db.lookupChatToolDecision({
          bot_name: botName, chat_id: chatId, tool_name: toolName,
          canonical_input: canonicalInput, now: Date.now(),
        });
        if (persisted) {
          logEvent('canusetool-shortcircuit', {
            chat_id: chatId, tool_name: toolName,
            decision: persisted.decision, match_type: persisted.match_type,
            tool_use_id: opts?.toolUseID || null,
          });
          if (persisted.decision === 'allow') return { behavior: 'allow' };
          return { behavior: 'deny', message: 'matched persisted always-deny rule' };
        }
      } catch (err) {
        logger.error?.(`[${sessionKey}] chat_tool_decisions lookup: ${err.message}`);
      }

      const gated = matchesApprovalPattern(toolName, input, apprCfg.gatedTools || []);
      if (!gated.matched) return { behavior: 'allow' };

      // Issue + post + park. tool_use_id is the dedup key when
      // the SDK supplies it; falls back to the legacy
      // (turn_id, tool_input_digest) tuple for cron / IPC callers.
      const row = approvals.issue({
        bot_name: botName,
        turn_id: opts?.toolUseID || null,
        tool_use_id: opts?.toolUseID || null,
        requester_chat_id: chatId,
        approver_chat_id: String(apprCfg.adminChatId),
        tool_name: toolName, tool_input: input,
        timeoutMs: apprCfg.timeoutMs || APPROVAL_DEFAULT_TIMEOUT_MS,
      });
      if (!bot) {
        approvals.resolve({ id: row.id, status: 'cancelled', reason: 'bot not ready' });
        return { behavior: 'deny', message: 'bot not ready' };
      }
      if (!row.reused || !row.approver_msg_id) {
        try {
          const sent = await tg(bot, 'sendMessage', {
            chat_id: apprCfg.adminChatId,
            text: approvalCardText(row),
            reply_markup: buildApprovalKeyboardWithAlways(row.id, row.callback_token),
          }, { source: 'canusetool-card', botName, plainText: true });
          if (sent?.message_id) approvals.setApproverMsgId(row.id, sent.message_id);
        } catch (err) {
          logger.error?.(`[${sessionKey}] failed to post canUseTool card: ${err.message}`);
          approvals.resolve({ id: row.id, status: 'cancelled', reason: `post failed: ${err.message}` });
          return { behavior: 'deny', message: `post failed: ${err.message}` };
        }
      }

      // Race signal + timeout + click.
      return await new Promise((resolve) => {
        let settled = false;
        const settle = (decision) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (opts?.signal && sigCleanup) {
            try { opts.signal.removeEventListener('abort', sigCleanup); }
            catch {}
          }
          dropWaiter(row.id, wrappedResolve);
          resolve(decision);
        };
        const timer = setTimeout(() => {
          approvals.resolve({ id: row.id, status: 'timeout' }).catch?.(() => {});
          settle({ behavior: 'deny', message: 'approval timed out' });
        }, Math.max(1000, row.timeout_ts - Date.now()));
        const sigCleanup = opts?.signal
          ? () => settle({ behavior: 'deny', message: 'aborted' })
          : null;
        if (opts?.signal && sigCleanup) {
          opts.signal.addEventListener('abort', sigCleanup, { once: true });
        }
        const wrappedResolve = (decision, reason, extra) => {
          // decision: 'approved' | 'denied' | 'approved-always' | 'denied-always'
          if (decision === 'approved' || decision === 'approved-always') {
            settle({
              behavior: 'allow',
              ...(decision === 'approved-always' && extra?.updatedPermissions
                ? { updatedPermissions: extra.updatedPermissions }
                : {}),
            });
          } else {
            settle({
              behavior: 'deny',
              message: reason || decision || 'denied',
            });
          }
        };
        const list = approvalWaiters.get(row.id) || [];
        list.push(wrappedResolve);
        approvalWaiters.set(row.id, list);
      });
    };
  }

  async function handleApprovalCallback(ctx) {
    const data = ctx.callbackQuery?.data || '';
    const m = String(data).match(/^(approve|deny|approve-always|deny-always):(\d+):(\S+)$/);
    if (!m) return;
    const decision = m[1];
    const id = parseInt(m[2], 10);
    const token = m[3];

    const row = approvals.getById(id);
    if (!row) {
      await ctx.answerCallbackQuery({ text: 'Unknown approval.', show_alert: true }).catch(() => {});
      return;
    }
    if (!approvalTokensEqual(row.callback_token, token)) {
      logEvent('approval-token-mismatch', { id, from_user: ctx.from?.id });
      await ctx.answerCallbackQuery({ text: 'Bad token.', show_alert: true }).catch(() => {});
      return;
    }
    if (row.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: `Already ${row.status}.`, show_alert: true }).catch(() => {});
      return;
    }

    // Only the configured approver chat is authoritative.
    const apprCfg = config.bot?.approvals;
    const expectedChat = String(apprCfg?.adminChatId || '');
    if (String(ctx.chat?.id) !== expectedChat) {
      logEvent('approval-foreign-chat', {
        id, from_chat: ctx.chat?.id, expected: expectedChat,
      });
      await ctx.answerCallbackQuery({ text: 'Not authorised here.', show_alert: true }).catch(() => {});
      return;
    }

    const isApprove = decision === 'approve' || decision === 'approve-always';
    const isAlways = decision === 'approve-always' || decision === 'deny-always';
    const status = isApprove ? 'approved' : 'denied';
    const user = ctx.from?.first_name || ctx.from?.username || null;
    const userId = ctx.from?.id || null;
    // Atomic SQL UPDATE ... WHERE status='pending' — double-click
    // race: only one writer wins; the second sees changes=0.
    const changes = approvals.resolve({
      id, status,
      decided_by_user_id: userId, decided_by_user: user,
    });
    if (changes === 0) {
      const fresh = approvals.getById(id);
      await ctx.answerCallbackQuery({
        text: `Already ${fresh?.status || 'resolved'}.`,
        show_alert: true,
      }).catch(() => {});
      return;
    }
    logEvent('approval-resolved', {
      id, status, by: userId, user, bot: botName,
    });

    // Edit the card to show the decision.
    try {
      const fresh = approvals.getById(id);
      await tg(bot, 'editMessageText', {
        chat_id: row.approver_chat_id,
        message_id: row.approver_msg_id,
        text: approvalCardText(fresh, {
          resolvedBy: `${status === 'approved' ? '✅ Approved' : '❌ Denied'} by ${user || userId}`,
        }),
      }, { source: 'approval-card-decision', botName, plainText: true });
    } catch (err) {
      logger.error?.(`[${botName}] edit approval card failed: ${err.message}`);
    }
    // Persist always-* clicks to chat_tool_decisions.
    let updatedPermissions = null;
    if (isAlways) {
      try {
        const canonical = canonicalizeToolInput(row.tool_input);
        db.insertChatToolDecision({
          bot_name: botName,
          chat_id: row.requester_chat_id,
          tool_name: row.tool_name,
          match_type: 'prefix',
          input_pattern: canonical,
          decision: status === 'approved' ? 'allow' : 'deny',
          issued_by_user_id: userId ? String(userId) : null,
          expires_ts: null,
        });
        logEvent('chat-tool-decision-persisted', {
          chat_id: row.requester_chat_id,
          tool_name: row.tool_name,
          decision: status === 'approved' ? 'allow' : 'deny',
          match_type: 'prefix',
        });
        updatedPermissions = [{
          type: 'addRules',
          rules: [{
            toolName: row.tool_name,
            decision: status === 'approved' ? 'allow' : 'deny',
          }],
        }];
      } catch (err) {
        logger.error?.(`[${botName}] chat_tool_decisions persist failed: ${err.message}`);
      }
    }

    await ctx.answerCallbackQuery({ text: status }).catch(() => {});

    // Pass the original decision back to the waiter so it can
    // distinguish 'approved-always' (SDK gets updatedPermissions)
    // from plain 'approved'.
    resolveApprovalWaiter(id, decision === 'approve-always' ? 'approved-always'
      : decision === 'deny-always' ? 'denied-always'
      : status, undefined, { updatedPermissions });
  }

  function startApprovalSweeper(intervalMs = 30_000) {
    return setInterval(() => {
      let rows;
      try {
        rows = approvals.sweepTimedOut();
      } catch (err) {
        logger.error?.(`[approvals] sweeper DB error: ${err.message}`);
        logEvent('approval-sweep-failed', { error: err.message?.slice(0, 300) });
        return;
      }
      for (const row of rows) {
        approvals.resolve({ id: row.id, status: 'timeout' });
        logEvent('approval-timeout', { id: row.id, bot: botName, tool: row.tool_name });
        resolveApprovalWaiter(row.id, 'timeout', 'swept');
        if (bot && row.approver_msg_id) {
          tg(bot, 'editMessageText', {
            chat_id: row.approver_chat_id,
            message_id: row.approver_msg_id,
            text: approvalCardText(approvals.getById(row.id), { resolvedBy: '⏰ Timed out' }),
          }, { source: 'approval-card-timeout', botName, plainText: true })
            .catch((err) => logger.error?.(`[${botName}] approval-card-timeout edit: ${err.message}`));
        }
      }
    }, intervalMs);
  }

  /**
   * Reject every parked waiter with the supplied decision (default
   * 'denied'). Called from polygram.js's shutdown handler so any
   * in-flight canUseTool Promises don't dangle with the daemon
   * gone — the SDK Query gets a deny and the tool call fails
   * cleanly instead of timing out into the void.
   */
  function cancelAllWaiters(decision = 'denied', reason = 'shutdown') {
    let count = 0;
    for (const list of approvalWaiters.values()) {
      for (const fn of list) {
        try { fn(decision, reason); count++; } catch {}
      }
    }
    approvalWaiters.clear();
    return count;
  }

  return {
    makeCanUseTool,
    handleApprovalCallback,
    resolveApprovalWaiter,
    dropWaiter,
    startApprovalSweeper,
    cancelAllWaiters,
    // Test introspection
    _approvalWaiters: approvalWaiters,
  };
}

module.exports = { createApprovals };
