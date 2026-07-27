import { hashSensitiveString } from './claude-executable.mjs';

const REQUIRED_KINDS = [
  'establish-prompt',
  'establish-result',
  'compact-prompt',
  'pre-compact',
  'compact-boundary',
  'compact-result',
  'recall-prompt',
  'recall-result',
];

function occurrences(value, marker) {
  return typeof value === 'string' ? value.split(marker).length - 1 : 0;
}

export function evaluateManualCompactEvidence({ timeline, marker } = {}) {
  if (!Array.isArray(timeline)) throw new TypeError('timeline must be an array');
  if (typeof marker !== 'string' || marker.length === 0) {
    throw new TypeError('marker must be a non-empty string');
  }

  const reasons = [];
  const byKind = new Map(REQUIRED_KINDS.map((kind) => [
    kind,
    timeline.filter((entry) => entry?.kind === kind),
  ]));
  for (const kind of REQUIRED_KINDS) {
    if (byKind.get(kind).length !== 1) {
      reasons.push(`timeline must contain exactly one ${kind}`);
    }
  }

  const requiredIndexes = REQUIRED_KINDS.map((kind) => (
    timeline.findIndex((entry) => entry?.kind === kind)
  ));
  const ordered = requiredIndexes.every((index, position) => (
    index >= 0 && (position === 0 || index > requiredIndexes[position - 1])
  ));
  if (!ordered) reasons.push('manual compaction events are not causally ordered');

  const sessionIds = timeline
    .map((entry) => entry?.sessionId)
    .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
  const sameSession = sessionIds.length === REQUIRED_KINDS.length
    && new Set(sessionIds).size === 1;
  if (!sameSession) reasons.push('manual compaction events must share one session');

  const establishPrompt = byKind.get('establish-prompt')[0];
  if (occurrences(establishPrompt?.value, marker) !== 1) {
    reasons.push('establishing prompt must contain the marker exactly once');
  }
  const compactPrompt = byKind.get('compact-prompt')[0];
  if (
    typeof compactPrompt?.value !== 'string'
    || !compactPrompt.value.trim().startsWith('/compact')
  ) {
    reasons.push('compact prompt must use the manual compact command');
  }
  const preCompact = byKind.get('pre-compact')[0];
  if (preCompact?.trigger !== 'manual') {
    reasons.push('PreCompact must report the manual trigger');
  }
  const compactBoundary = byKind.get('compact-boundary')[0];
  if (compactBoundary?.trigger !== 'manual') {
    reasons.push('compact boundary must report the manual trigger');
  }
  for (const kind of ['establish-result', 'compact-result', 'recall-result']) {
    if (byKind.get(kind)[0]?.subtype !== 'success') {
      reasons.push(`${kind} must succeed`);
    }
  }

  const recallPrompt = byKind.get('recall-prompt')[0];
  const recallPromptMarkerFree = occurrences(recallPrompt?.value, marker) === 0;
  if (!recallPromptMarkerFree) reasons.push('recall prompt must omit the marker');
  const recallResult = byKind.get('recall-result')[0];
  const markerRecallCount = occurrences(recallResult?.value, marker);
  if (markerRecallCount !== 1) {
    reasons.push('recall result must contain the marker exactly once');
  }

  const preCompactCount = byKind.get('pre-compact').length;
  const compactBoundaryCount = byKind.get('compact-boundary').length;
  const resultCount = timeline.filter((entry) => (
    typeof entry?.kind === 'string' && entry.kind.endsWith('-result')
  )).length;
  const orderedEvidence = timeline.map((entry, index) => ({
    order: index + 1,
    kind: typeof entry?.kind === 'string' ? entry.kind : 'invalid',
    sessionHash: hashSensitiveString(
      typeof entry?.sessionId === 'string' ? entry.sessionId : '',
    ),
    valueHash: hashSensitiveString(
      typeof entry?.value === 'string' ? entry.value : '',
    ),
    ...(typeof entry?.trigger === 'string' && { trigger: entry.trigger }),
    ...(typeof entry?.subtype === 'string' && { subtype: entry.subtype }),
  }));

  return {
    pass: reasons.length === 0,
    reasons,
    preCompactCount,
    compactBoundaryCount,
    resultCount,
    sameSession,
    ordered,
    recallPromptMarkerFree,
    markerRecallCount,
    orderedEvidence,
  };
}
