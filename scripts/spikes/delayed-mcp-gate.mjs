const MODES = new Set(['foreground', 'background']);

export function evaluateDelayedMcpEvidence(evidence) {
  if (!MODES.has(evidence?.expectedMode)) {
    throw new TypeError('expectedMode must be foreground or background');
  }

  const reasons = [];
  if (evidence.handlerDurationMs < evidence.thresholdMs) {
    reasons.push('handler did not remain active beyond the configured threshold');
  }
  if (evidence.toolUseCount !== 1) {
    reasons.push('expected exactly one delayed MCP tool use');
  }
  if (evidence.markerCount !== 1) {
    reasons.push('expected exactly one marker in assistant output');
  }
  if (evidence.resultSubtype !== 'success') {
    reasons.push('query did not end with a successful result');
  }

  if (evidence.expectedMode === 'foreground') {
    if (evidence.toolResultBeforeHandlerCompletion) {
      reasons.push('foreground tool result arrived before the handler completed');
    }
    if (
      evidence.taskStartedCount !== 0
      || evidence.backgroundTransitionCount !== 0
      || evidence.taskNotificationCount !== 0
    ) {
      reasons.push('foreground comparator unexpectedly used native background task lifecycle');
    }
  } else {
    if (!evidence.toolResultBeforeHandlerCompletion) {
      reasons.push('background tool result did not arrive before the handler completed');
    }
    if (evidence.taskStartedCount < 1 || evidence.backgroundTransitionCount < 1) {
      reasons.push('native background task lifecycle was not observed');
    }
    if (evidence.taskNotificationCount < 1) {
      reasons.push('native task notification was not observed');
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}
