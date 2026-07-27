export function evaluateSessionResumeEvidence({
  firstResultSubtype,
  secondResultSubtype,
  markerRecalled,
}) {
  const reasons = [];
  if (firstResultSubtype !== 'success') {
    reasons.push('first query did not finish successfully');
  }
  if (secondResultSubtype !== 'success') {
    reasons.push('second query did not finish successfully');
  }
  if (markerRecalled !== true) {
    reasons.push('resumed query did not recall the marker');
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

export function evaluateToolLessDrainEvidence({
  hookFiredCount,
  resultSubtypes,
  bufferedMarkerCount,
}) {
  const reasons = [];
  if (hookFiredCount !== 0) {
    reasons.push('tool-less turn unexpectedly fired PostToolBatch');
  }
  if (
    !Array.isArray(resultSubtypes)
    || resultSubtypes.length !== 2
    || resultSubtypes.some((subtype) => subtype !== 'success')
  ) {
    reasons.push('tool-less drain did not complete two successful turns');
  }
  if (bufferedMarkerCount !== 1) {
    reasons.push('buffered marker was not delivered exactly once');
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}
