import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from './claude-executable.mjs';
import {
  readGateSessionTerminalState,
  waitForGateEventSequence,
} from './claude-gate-evidence.mjs';

const SOURCE_ROOT = fileURLToPath(
  new URL('./fixtures/workflow-project', import.meta.url),
);
const SKILL_RELATIVE_PATH = path.join(
  '.claude',
  'skills',
  'completion-sentinel',
  'SKILL.md',
);

export const WORKFLOW_GATE_SESSION_PREFIX = 'polygram-gate';
export const WORKFLOW_GATE_ORIGIN_ROUTE = '-999000220:220';

export function readWorkflowPreLaunchTerminalState(sessionPath) {
  if (typeof sessionPath !== 'string' || sessionPath.length === 0) {
    throw new TypeError('Workflow pre-launch session path is required');
  }
  if (!fs.existsSync(sessionPath)) {
    return {
      turnDurationCount: 0,
      pivotalSuffix: [],
    };
  }
  return readGateSessionTerminalState(sessionPath);
}

function readWorkflowReplyReceiptEvidence({
  sessionPath,
  completionMarker,
  replyToolName,
  toolUseId,
  deliveryMode,
}) {
  const records = [];
  for (const line of fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error('Workflow session contains malformed receipt evidence');
    }
  }

  const toolUses = [];
  const toolResults = [];
  records.forEach((record, recordIndex) => {
    const blocks = Array.isArray(record?.message?.content)
      ? record.message.content
      : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && block.id === toolUseId) {
        toolUses.push({ block, recordIndex });
      }
      if (block?.type === 'tool_result' && block.tool_use_id === toolUseId) {
        toolResults.push({ block, recordIndex });
      }
    }
  });

  if (toolUses.length === 0 || toolResults.length === 0) return null;
  if (toolUses.length !== 1 || toolResults.length !== 1) {
    throw new Error('Workflow completion receipt identity is ambiguous');
  }

  const [{ block: toolUse, recordIndex: toolUseIndex }] = toolUses;
  const [{ block: toolResult, recordIndex: toolResultIndex }] = toolResults;
  if (
    toolUse.name !== replyToolName
    || typeof toolUse.input?.text !== 'string'
    || toolUse.input.text !== completionMarker
    || toolResultIndex <= toolUseIndex
  ) {
    throw new Error('Workflow completion receipt does not match the captured reply');
  }

  const payloadTexts = typeof toolResult.content === 'string'
    ? [toolResult.content]
    : Array.isArray(toolResult.content)
      ? toolResult.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
      : [];
  const payloads = payloadTexts.flatMap((text) => {
    try {
      const payload = JSON.parse(text);
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? [payload]
        : [];
    } catch {
      return [];
    }
  });
  if (payloads.length !== 1) {
    throw new Error('Workflow completion receipt payload is not unambiguous JSON');
  }

  const [payload] = payloads;
  const receiptIsError = toolResult.is_error === true;
  if (deliveryMode === 'direct') {
    if (payload.ok !== true || receiptIsError) {
      throw new Error('Workflow direct receipt does not prove successful delivery');
    }
  } else if (
    payload.ok !== false
    || typeof payload.error !== 'string'
    || payload.error.length === 0
    || !receiptIsError
  ) {
    throw new Error('Workflow fallback receipt does not prove failed direct delivery');
  }

  return {
    transcriptToolUseCount: toolUses.length,
    transcriptToolResultCount: toolResults.length,
    receiptOk: payload.ok,
    receiptIsError,
  };
}

function waitForWorkflowDurableCompletionEvidence({
  sessionPath,
  completionMarker,
  replyToolName,
  toolUseId,
  deliveryMode,
  afterTurnDurationCount,
  timeoutMs,
  pollMs,
}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let terminal;
      let receipt;
      try {
        terminal = readGateSessionTerminalState(sessionPath);
        receipt = readWorkflowReplyReceiptEvidence({
          sessionPath,
          completionMarker,
          replyToolName,
          toolUseId,
          deliveryMode,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const terminalAdvanced = (
        terminal.turnDurationCount > afterTurnDurationCount
        && terminal.pivotalSuffix.length === 2
        && terminal.pivotalSuffix[0]?.type === 'system'
        && terminal.pivotalSuffix[0]?.subtype === 'stop_hook_summary'
        && terminal.pivotalSuffix[1]?.type === 'system'
        && terminal.pivotalSuffix[1]?.subtype === 'turn_duration'
      );
      if (terminalAdvanced && receipt) {
        resolve({
          ...receipt,
          terminalAdvanced: true,
          turnDurationCount: terminal.turnDurationCount,
        });
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(
          `Workflow completion evidence timed out after ${timeoutMs}ms`,
        ));
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

export function waitForWorkflowCompletionTurnEvidence({
  emitter,
  sessionPath,
  completionMarker,
  replyToolName,
  deliveryMode,
  afterTurnDurationCount,
  eventTimeoutMs,
  durableTimeoutMs,
  pollMs = 25,
}) {
  if (
    typeof sessionPath !== 'string'
    || sessionPath.length === 0
    || typeof completionMarker !== 'string'
    || completionMarker.length === 0
    || typeof replyToolName !== 'string'
    || replyToolName.length === 0
    || !['direct', 'fail'].includes(deliveryMode)
    || !Number.isInteger(afterTurnDurationCount)
    || afterTurnDurationCount < 0
    || !Number.isFinite(durableTimeoutMs)
    || durableTimeoutMs <= 0
    || !Number.isFinite(pollMs)
    || pollMs <= 0
  ) {
    throw new TypeError('Workflow completion evidence requires bounded correlation inputs');
  }

  const state = {};
  const steps = [
    {
      eventName: 'tool-use-detail',
      matches: (event) => (
        event?.name === replyToolName
        && typeof event?.toolUseId === 'string'
        && event.toolUseId.length > 0
        && typeof event?.input?.text === 'string'
        && event.input.text === completionMarker
      ),
      capture: (event, sequenceState) => {
        sequenceState.toolUseId = event.toolUseId;
      },
    },
    ...(deliveryMode === 'direct' ? [{
      eventName: 'tool-result',
      matches: (event, sequenceState) => (
        event?.name === replyToolName
        && event?.toolUseId === sequenceState.toolUseId
        && event?.isError === false
      ),
    }] : []),
    {
      eventName: 'stop-hook',
      matches: () => true,
    },
  ];
  const eventSequence = waitForGateEventSequence({
    emitter,
    steps,
    timeoutMs: eventTimeoutMs,
    label: `Workflow ${deliveryMode} completion lifecycle`,
    state,
  });

  return eventSequence.then(async () => {
    const durable = await waitForWorkflowDurableCompletionEvidence({
      sessionPath,
      completionMarker,
      replyToolName,
      toolUseId: state.toolUseId,
      deliveryMode,
      afterTurnDurationCount,
      timeoutMs: durableTimeoutMs,
      pollMs,
    });
    return {
      toolUseMatched: true,
      toolResultEventMatched: deliveryMode === 'direct',
      stopAfterToolUse: true,
      ...durable,
    };
  });
}

export function makeTreePrivate(root) {
  const stat = fs.statSync(root);
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) {
      makeTreePrivate(path.join(root, name));
    }
  } else {
    fs.chmodSync(root, 0o600);
  }
}

function hasWorkflowPolicyOverride(cwd) {
  for (const fileName of ['settings.json', 'settings.local.json']) {
    const settingsPath = path.join(cwd, '.claude', fileName);
    if (!fs.existsSync(settingsPath)) continue;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (Object.hasOwn(settings, 'workflowSizeGuideline')) return true;
  }
  return false;
}

export function summarizeWorkflowRecord(record, { expectedResult } = {}) {
  const progressTypes = {};
  for (const entry of Array.isArray(record?.workflowProgress)
    ? record.workflowProgress
    : []) {
    if (typeof entry?.type !== 'string') continue;
    progressTypes[entry.type] = (progressTypes[entry.type] || 0) + 1;
  }

  return {
    status: typeof record?.status === 'string' ? record.status : null,
    agentCount: Number.isFinite(record?.agentCount) ? record.agentCount : null,
    defaultModel: typeof record?.defaultModel === 'string'
      ? record.defaultModel
      : null,
    durationMs: Number.isFinite(record?.durationMs) ? record.durationMs : null,
    totalTokens: Number.isFinite(record?.totalTokens) ? record.totalTokens : null,
    totalToolCalls: Number.isFinite(record?.totalToolCalls)
      ? record.totalToolCalls
      : null,
    phaseCount: Array.isArray(record?.phases) ? record.phases.length : null,
    progressCount: Array.isArray(record?.workflowProgress)
      ? record.workflowProgress.length
      : null,
    progressTypes: Object.fromEntries(
      Object.entries(progressTypes).sort(([left], [right]) => (
        left.localeCompare(right)
      )),
    ),
    reportComplete: typeof record?.result === 'string'
      && record.result.length > 0,
    ...(typeof expectedResult === 'string' && {
      reportMatchesExpected: record?.result === expectedResult,
    }),
  };
}

export function summarizeWorkflowRecordsForTask(
  records,
  { taskId, expectedResult } = {},
) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError('taskId must be a non-empty string');
  }
  const matching = records.filter((record) => record?.taskId === taskId);
  if (matching.length !== 1) {
    throw new Error('Workflow metadata must contain exactly one notification-linked run');
  }
  return matching.map((record) => summarizeWorkflowRecord(record, { expectedResult }));
}

export function readWorkflowTaskNotificationEvidence(sessionPath, expectedMarker) {
  if (typeof expectedMarker !== 'string' || expectedMarker.length === 0) {
    throw new TypeError('expectedMarker must be a non-empty string');
  }
  const serializedExpectedResult = JSON.stringify(expectedMarker);
  const evidence = [];
  for (const line of fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (
        record?.type !== 'user'
        || record.origin?.kind !== 'task-notification'
        || record.promptSource !== 'system'
        || typeof record.message?.content !== 'string'
        || !record.message.content.includes('<task-notification>')
      ) {
        continue;
      }
      const results = [...record.message.content.matchAll(
        /<result>([\s\S]*?)<\/result>/g,
      )].map((match) => match[1]);
      if (
        results.length !== 1
        || results[0] !== serializedExpectedResult
        || JSON.parse(results[0]) !== expectedMarker
      ) {
        continue;
      }
      const taskIds = [...record.message.content.matchAll(
        /<task-id>\s*([^<]+?)\s*<\/task-id>/g,
      )].map((match) => match[1].trim());
      if (taskIds.length !== 1 || !taskIds[0]) {
        throw new Error('matching Workflow task notification must contain one task id');
      }
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp)) {
        throw new Error('matching Workflow task notification must have a timestamp');
      }
      evidence.push({ timestamp, taskId: taskIds[0] });
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  if (evidence.length !== 1) {
    throw new Error('Workflow session must contain exactly one timed matching task notification');
  }
  return evidence[0];
}

export function readWorkflowTaskNotificationAt(sessionPath, expectedMarker) {
  return readWorkflowTaskNotificationEvidence(sessionPath, expectedMarker).timestamp;
}

export function evaluateWorkflowOutOfTurnTiming({
  launchStopHookAt,
  launchTurnClosedAt,
  taskNotificationAt,
  completionAt,
  stopGraceMs,
  schedulingMarginMs,
  completionProcessingMarginMs,
}) {
  const reasons = [];
  const requiredTaskNotificationDelayMs = stopGraceMs + schedulingMarginMs;
  const requiredCompletionAfterNotificationMs = completionProcessingMarginMs;
  const taskNotificationAfterStopMs = (
    Number.isFinite(taskNotificationAt) && Number.isFinite(launchStopHookAt)
  ) ? taskNotificationAt - launchStopHookAt : null;
  const completionAfterLaunchTurnMs = (
    Number.isFinite(completionAt) && Number.isFinite(launchTurnClosedAt)
  ) ? completionAt - launchTurnClosedAt : null;
  const completionAfterTaskNotificationMs = (
    Number.isFinite(completionAt) && Number.isFinite(taskNotificationAt)
  ) ? completionAt - taskNotificationAt : null;

  if (
    !Number.isFinite(taskNotificationAfterStopMs)
    || taskNotificationAfterStopMs < requiredTaskNotificationDelayMs
  ) {
    reasons.push('task notification did not cross the launch stop-grace boundary');
  }
  if (
    !Number.isFinite(completionAfterLaunchTurnMs)
    || completionAfterLaunchTurnMs <= 0
  ) {
    reasons.push('completion did not arrive after the launch turn closed');
  }
  if (
    !Number.isFinite(completionAfterTaskNotificationMs)
    || completionAfterTaskNotificationMs < requiredCompletionAfterNotificationMs
  ) {
    reasons.push('completion did not arrive after the task notification');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    requiredTaskNotificationDelayMs,
    requiredCompletionAfterNotificationMs,
    taskNotificationAfterStopMs,
    completionAfterLaunchTurnMs,
    completionAfterTaskNotificationMs,
  };
}

export function waitForWorkflowDeliveryWorkSettled(
  process,
  { timeoutMs = 30_000 } = {},
) {
  if (
    typeof process?.hasPendingDeliveryWork !== 'function'
    || typeof process?.on !== 'function'
    || typeof process?.off !== 'function'
  ) {
    throw new TypeError('Workflow delivery settlement requires a process emitter');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Workflow delivery settlement timeout must be positive');
  }
  if (!process.hasPendingDeliveryWork()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      process.off('delivery-work-settled', onSettled);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onSettled = () => {
      if (!process.hasPendingDeliveryWork()) finish(resolve);
    };
    timer = setTimeout(() => {
      finish(
        reject,
        new Error('Workflow delivery work did not settle before timeout'),
      );
    }, timeoutMs);
    process.on('delivery-work-settled', onSettled);
    onSettled();
  });
}

export async function inspectWorkflowSizeGuidelineDefault({
  executablePath,
  executableSha256,
  expectedGuideline,
}) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new TypeError('executablePath must be an absolute path');
  }
  if (!/^[a-f0-9]{64}$/.test(executableSha256 || '')) {
    throw new TypeError('executableSha256 must be a SHA-256 digest');
  }
  if (expectedGuideline !== 'medium') {
    throw new TypeError('the selected-binary fingerprint only defines the medium default');
  }

  // These semantic anchors bind the documented value to the executable's
  // actual no-override branch. Upstream minifier drift intentionally blocks
  // the gate until the new runtime contract is inspected.
  const fingerprints = [
    Buffer.from('"medium" (the default) fewer than 15'),
    Buffer.from('var rLs,_Td="medium",oko'),
    Buffer.from(
      'settings.workflowSizeGuideline)??Msn(e);return t===void 0?{size:_Td,isDefault:!0}',
    ),
  ];
  const found = fingerprints.map(() => false);
  const maxFingerprintLength = Math.max(
    ...fingerprints.map((fingerprint) => fingerprint.length),
  );
  const hash = crypto.createHash('sha256');
  let tail = Buffer.alloc(0);

  for await (const chunk of fs.createReadStream(executablePath)) {
    hash.update(chunk);
    const searchable = Buffer.concat([tail, chunk]);
    fingerprints.forEach((fingerprint, index) => {
      if (!found[index] && searchable.includes(fingerprint)) found[index] = true;
    });
    tail = searchable.subarray(
      Math.max(0, searchable.length - maxFingerprintLength + 1),
    );
  }

  if (hash.digest('hex') !== executableSha256) {
    throw new Error('selected executable changed after attestation');
  }
  return {
    source: 'selected-binary-runtime-default',
    value: expectedGuideline,
    executableSha256,
    fingerprintMatched: found.every(Boolean),
  };
}

export function evaluateOpusProjection(evidence) {
  const reasons = [];
  if (evidence?.resolvedModel !== evidence?.expectedResolvedModel) {
    reasons.push('resolved model does not match the expected Opus model');
  }
  if (evidence?.workflowPolicyOverridePresent !== false) {
    reasons.push('synthetic project contains a Workflow policy override');
  }
  if (
    evidence?.workflowSizeGuidelineEvidence?.source
      !== 'selected-binary-runtime-default'
    || evidence.workflowSizeGuidelineEvidence.value
      !== evidence?.documentedWorkflowSizeGuideline
    || evidence.workflowSizeGuidelineEvidence.executableSha256
      !== evidence?.selectedExecutableSha256
    || evidence.workflowSizeGuidelineEvidence.fingerprintMatched !== true
  ) {
    reasons.push('Workflow size guideline was not attested in the selected binary');
  }
  if (evidence?.workflowExitStatus !== 0) {
    reasons.push('bounded Workflow gate did not exit successfully');
  }
  if (!Array.isArray(evidence?.workflowMetadata) || evidence.workflowMetadata.length === 0) {
    reasons.push('bounded Workflow metadata is missing');
  } else {
    if (evidence.workflowMetadata.some((record) => (
      record.status !== 'completed'
      || !Number.isFinite(record.agentCount)
      || record.agentCount < 1
      || record.agentCount > 3
    ))) {
      reasons.push('bounded Workflow topology is incomplete or exceeds three agents');
    }
    if (evidence.workflowMetadata.some((record) => record.reportComplete !== true)) {
      reasons.push('bounded Workflow report is incomplete');
    }
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

function markerOccurrences(text, marker) {
  return typeof text === 'string' ? text.split(marker).length - 1 : 0;
}

export function evaluateWorkflowLaunchDeliveryEvidence({
  calls,
  launchMarker,
  originRoute,
}) {
  if (
    !Array.isArray(calls)
    || typeof launchMarker !== 'string'
    || launchMarker.length === 0
    || typeof originRoute !== 'string'
    || originRoute.length === 0
  ) {
    throw new TypeError('Workflow launch evidence requires calls, marker, and route');
  }

  const exactlyOneCall = calls.length === 1;
  const call = exactlyOneCall ? calls[0] : null;
  const proof = {
    launchDeliveryCount: calls.length,
    exactlyOneCall,
    replyToolMatched: call?.toolName === 'reply',
    originRouteMatched: call?.route === originRoute,
    exactTextMatched: call?.text === launchMarker,
    deliverySucceeded: call?.delivered === true,
    nonInterim: call?.interim !== true,
    zeroFiles: Array.isArray(call?.files) && call.files.length === 0,
  };
  const reasons = [];
  if (!proof.exactlyOneCall) {
    reasons.push('launch turn must make exactly one channel call');
  } else {
    if (!proof.replyToolMatched) reasons.push('launch call must use the reply tool');
    if (!proof.originRouteMatched) reasons.push('launch reply must use the origin route');
    if (!proof.exactTextMatched) reasons.push('launch reply must contain exact text');
    if (!proof.deliverySucceeded) reasons.push('launch reply must prove successful delivery');
    if (!proof.nonInterim) reasons.push('launch reply must be non-interim');
    if (!proof.zeroFiles) reasons.push('launch reply must be sent without files');
  }
  return {
    pass: reasons.length === 0,
    reasons,
    proof,
  };
}

export function evaluateWorkflowDeliveryEvidence({
  deliveryMode,
  marker,
  completionPrefix = marker,
  originRoute,
  foreignRoutes = [],
  directAttempts = [],
  fallbackDeliveries = [],
  fallbackPipeline = null,
  fallbackSentCount = 0,
  fallbackFailedCount = 0,
}) {
  const reasons = [];
  const foreign = new Set(foreignRoutes);
  const matchingAttempts = directAttempts.filter(
    (attempt) => attempt.text === marker,
  );
  const unexpectedCompletionAttempts = directAttempts.filter((attempt) => (
    typeof attempt.text === 'string'
    && attempt.text.includes(completionPrefix)
    && attempt.text !== marker
  ));
  if (unexpectedCompletionAttempts.length > 0) {
    reasons.push('unexpected completion-shaped direct attempt was observed');
  }
  if (matchingAttempts.length !== 1) {
    reasons.push('completion must make exactly one direct attempt');
  }
  if (
    matchingAttempts.some((attempt) => (
      attempt.route !== originRoute
      || attempt.text !== marker
    ))
  ) {
    reasons.push('direct attempt must contain one unambiguous completion on the origin route');
  }
  if (
    [...directAttempts, ...fallbackDeliveries].some((call) => (
      foreign.has(call.route) && markerOccurrences(call.text, marker) > 0
    ))
  ) {
    reasons.push('completion appeared on a foreign route');
  }

  if (deliveryMode === 'direct') {
    if (matchingAttempts[0]?.delivered !== true) {
      reasons.push('direct completion attempt was not delivered');
    }
    if (fallbackDeliveries.length !== 0) {
      reasons.push('successful direct delivery did not suppress fallback');
    }
  } else if (deliveryMode === 'fail') {
    if (matchingAttempts[0]?.delivered !== false) {
      reasons.push('forced direct failure did not fail');
    }
    if (
      fallbackDeliveries.length !== 1
      || fallbackDeliveries[0]?.route !== originRoute
      || fallbackDeliveries[0]?.text !== marker
      || fallbackDeliveries[0]?.delivered !== true
    ) {
      reasons.push('fallback must deliver one unambiguous completion on the origin route');
    }
    if (
      fallbackPipeline !== 'helper'
      || fallbackSentCount !== 1
      || fallbackFailedCount !== 0
    ) {
      reasons.push('fallback must use the production helper pipeline successfully');
    }
  } else {
    reasons.push('delivery mode is not recognized');
  }

  const visibleMarkerCount = directAttempts.reduce(
    (count, attempt) => count + (
      attempt.delivered ? markerOccurrences(attempt.text, marker) : 0
    ),
    0,
  ) + fallbackDeliveries.reduce(
    (count, delivery) => count + (
      delivery.delivered ? markerOccurrences(delivery.text, marker) : 0
    ),
    0,
  );
  if (visibleMarkerCount !== 1) {
    reasons.push('completion marker was not visibly delivered exactly once');
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}

export async function prepareWorkflowProject({ parentDir } = {}) {
  if (!parentDir || !path.isAbsolute(parentDir)) {
    throw new TypeError('parentDir must be an absolute path');
  }
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(parentDir, 0o700);
  const cwd = path.join(parentDir, `workflow-${crypto.randomBytes(6).toString('hex')}`);
  fs.cpSync(SOURCE_ROOT, cwd, { recursive: true, errorOnExist: true });
  makeTreePrivate(cwd);
  const skillPath = path.join(cwd, SKILL_RELATIVE_PATH);
  return {
    cwd,
    skillName: 'completion-sentinel',
    skillPath,
    fixtureHash: await sha256File(skillPath),
    workflowPolicyOverridePresent: hasWorkflowPolicyOverride(cwd),
  };
}
