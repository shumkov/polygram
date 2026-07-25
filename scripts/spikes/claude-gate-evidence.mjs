import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN_REVIEW_KEYS = new Set([
  'argv',
  'command',
  'content',
  'cwd',
  'executablePath',
  'parentUuid',
  'prompt',
  'sessionId',
  'session_id',
  'text',
  'toolInput',
  'tool_input',
  'uuid',
]);

function stringField(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeGateRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.hook_event_name) {
    return {
      type: 'hook',
      hookEventName: stringField(obj.hook_event_name),
      ...(stringField(obj.tool_name) && { toolName: obj.tool_name }),
    };
  }

  if (obj.type === 'system') {
    return {
      type: 'system',
      ...(stringField(obj.subtype) && { subtype: obj.subtype }),
      ...(stringField(obj.model) && { model: obj.model }),
    };
  }

  if (obj.type === 'queue-operation') {
    return {
      type: 'queue-operation',
      ...(stringField(obj.operation) && { operation: obj.operation }),
    };
  }

  if (obj.type === 'assistant') {
    const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
    return {
      type: 'assistant',
      hasParent: Boolean(obj.parentUuid || obj.parent_uuid || obj.parent_tool_use_id),
      ...(stringField(obj.message?.stop_reason) && { stopReason: obj.message.stop_reason }),
      contentTypes: blocks.map((block) => block?.type).filter(Boolean),
      toolNames: blocks
        .filter((block) => block?.type === 'tool_use' && stringField(block.name))
        .map((block) => block.name),
    };
  }

  if (obj.type === 'user') {
    const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
    const stringContent = typeof obj.message?.content === 'string'
      ? obj.message.content
      : '';
    return {
      type: 'user',
      hasParent: Boolean(obj.parentUuid || obj.parent_uuid || obj.parent_tool_use_id),
      contentKind: Array.isArray(obj.message?.content)
        ? 'blocks'
        : typeof obj.message?.content,
      contentTypes: blocks.map((block) => block?.type).filter(Boolean),
      ...(stringField(obj.origin?.kind) && { originKind: obj.origin.kind }),
      ...(stringField(obj.promptSource) && { promptSource: obj.promptSource }),
      ...(stringContent.includes('<task-notification>') && { hasTaskNotification: true }),
    };
  }

  if (obj.type === 'attachment') {
    return {
      type: 'attachment',
      ...(stringField(obj.attachment?.type) && { attachmentType: obj.attachment.type }),
    };
  }

  return {
    type: stringField(obj.type) || 'unknown',
    ...(stringField(obj.subtype) && { subtype: obj.subtype }),
  };
}

export function normalizeGateJsonl(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const normalized = normalizeGateRecord(JSON.parse(line));
      if (normalized) records.push(normalized);
    } catch {
      records.push({ type: 'malformed' });
    }
  }
  return records;
}

export function readWrapperRecords(selection) {
  const recordsPath = path.join(selection.artifactDir, 'process-wrapper.ndjson');
  if (!fs.existsSync(recordsPath)) return [];
  return fs.readFileSync(recordsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function validateWrapperProvenance(
  selection,
  records,
  {
    observedClaudePids = [],
    unwrappedRootPids = [],
    requireWrapperRecord = true,
  } = {},
) {
  if (selection.sessionLauncher) {
    if (records.some((record) => (
      record.version !== selection.version
      || record.executableSha256 !== selection.sha256
      || record.executablePathHash
        !== selection.sanitizedAttestation.executablePathHash
    ))) {
      throw new Error('candidate wrapper provenance does not match the selected executable');
    }
    const recordedPids = new Set(
      records.map((record) => record.pid).filter(Number.isInteger),
    );
    const permittedRoots = new Set(unwrappedRootPids);
    const observedWrappedPids = [...new Set(observedClaudePids)]
      .filter((pid) => Number.isInteger(pid))
      .filter((pid) => !permittedRoots.has(pid));
    if (records.length === 0 && (requireWrapperRecord || observedWrappedPids.length > 0)) {
      throw new Error('candidate wrapper provenance is required');
    }
    const missing = observedWrappedPids
      .filter((pid) => !recordedPids.has(pid));
    if (missing.length > 0) {
      throw new Error(`missing wrapper provenance for observed Claude pid ${missing.join(',')}`);
    }
  } else if (records.length !== 0) {
    throw new Error('legacy run must not claim wrapper provenance');
  }
}

export function evaluateSdkGateEvidence({
  selection,
  resolvedModel,
  expectedResolvedModel = selection?.model,
  wrapperRecords = [],
  observedClaudePids = [],
  unwrappedRootPids = [],
}) {
  const reasons = [];
  if (typeof resolvedModel !== 'string' || resolvedModel !== expectedResolvedModel) {
    reasons.push('observed SDK init model does not match the expected model');
  }
  try {
    validateWrapperProvenance(selection, wrapperRecords, {
      observedClaudePids,
      unwrappedRootPids,
      requireWrapperRecord: false,
    });
  } catch (error) {
    reasons.push(error.message);
  }
  return {
    pass: reasons.length === 0,
    reasons,
  };
}

export function createSdkGateObserver(
  selection,
  {
    expectedResolvedModel = selection?.model,
  } = {},
) {
  let resolvedModel = null;
  let resultSubtype = null;
  const lifecycle = [];

  return {
    observe(message) {
      const normalized = normalizeGateRecord(message);
      if (normalized) lifecycle.push(normalized);
      if (
        message?.type === 'system'
        && message.subtype === 'init'
        && typeof message.model === 'string'
      ) {
        resolvedModel = message.model;
      }
      if (message?.type === 'result' && typeof message.subtype === 'string') {
        resultSubtype = message.subtype;
      }
    },
    finish() {
      selection?.stopSdkProcessSampling?.();
      const wrapperRecords = selection?.artifactDir
        ? readWrapperRecords(selection)
        : [];
      const observedClaudePids = selection?.sdkProcessEvidence
        ?.selectedBinaryPids || [];
      const unwrappedRootPids = selection?.sdkProcessEvidence?.rootPids || [];
      const evaluation = evaluateSdkGateEvidence({
        selection,
        resolvedModel,
        expectedResolvedModel,
        wrapperRecords,
        observedClaudePids,
        unwrappedRootPids,
      });
      return {
        ...evaluation,
        resolvedModel,
        resultSubtype,
        wrapperRecords,
        processEvidence: {
          rootPids: [...unwrappedRootPids],
          selectedBinaryPids: [...observedClaudePids],
          sampleCount: selection?.sdkProcessEvidence?.sampleCount || 0,
        },
        lifecycle,
      };
    },
  };
}

function assertReviewSafe(value, keyPath = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertReviewSafe(item, `${keyPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_REVIEW_KEYS.has(key)) {
      throw new Error(`review evidence contains forbidden key ${keyPath}.${key}`);
    }
    assertReviewSafe(child, `${keyPath}.${key}`);
  }
}

export function writeSanitizedGateResult(artifactDir, result) {
  assertReviewSafe(result);
  const outputPath = path.join(artifactDir, 'sanitized-result.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}

export function copyPrivateGateArtifact(sourcePath, artifactDir, fileName) {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new TypeError('private artifact fileName must be a safe basename');
  }
  const rawDir = path.join(artifactDir, 'raw-private');
  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rawDir, 0o700);
  const destination = path.join(rawDir, fileName);
  fs.copyFileSync(sourcePath, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}
