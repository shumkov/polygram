const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'scripts/spikes/claude-2.1.283-matrix.json'),
  'utf8',
));
const CANDIDATE_EXPECTATIONS = manifest.expectations[manifest.versions.candidate];
// A version whose SDK stream carries no task_updated for the child task. No
// pinned version behaves this way today, but the per-version oracle must still
// tell the two lifecycles apart.
const NO_TASK_UPDATE_EXPECTATIONS = {
  ...CANDIDATE_EXPECTATIONS,
  subagentTaskUpdated: 0,
};

function assistant({
  parent = null,
  blocks,
}) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      model: 'claude-sonnet-4-6',
      content: blocks,
    },
  };
}

function user({
  parent = null,
  blocks,
}) {
  return {
    type: 'user',
    parent_tool_use_id: parent,
    message: { content: blocks },
  };
}

function toolUse(id, name) {
  return { type: 'tool_use', id, name, input: {} };
}

function toolResult(toolUseId, isError = false) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: isError,
    content: 'private result',
  };
}

function subagentMessages({
  candidate,
  extraAmbient = false,
}) {
  const messages = [
    { type: 'system', subtype: 'hook_started' },
    { type: 'system', subtype: 'hook_response' },
    {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
    },
    { type: 'system', subtype: 'thinking_tokens' },
    assistant({
      blocks: [{ type: 'thinking', thinking: 'private' }],
    }),
    assistant({
      blocks: [toolUse('search-1', 'ToolSearch')],
    }),
    { type: 'rate_limit_event' },
    user({ blocks: [toolResult('search-1')] }),
    assistant({
      blocks: [toolUse('agent-1', 'Agent')],
    }),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'agent-1',
    },
    user({
      parent: 'agent-1',
      blocks: [{ type: 'text', text: 'private child prompt' }],
    }),
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-1',
      tool_use_id: 'agent-1',
    },
    assistant({
      parent: 'agent-1',
      blocks: [toolUse('child-tool-1', 'Bash')],
    }),
    user({
      parent: 'agent-1',
      blocks: [toolResult('child-tool-1')],
    }),
  ];
  if (extraAmbient) {
    messages.push(
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'agent-1',
      },
      assistant({
        parent: 'agent-1',
        blocks: [
          { type: 'text', text: 'private child narration' },
          toolUse('child-tool-2', 'Glob'),
        ],
      }),
      user({
        parent: 'agent-1',
        blocks: [toolResult('child-tool-2')],
      }),
    );
  }
  if (candidate) {
    messages.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      tool_use_id: 'agent-1',
      patch: { status: 'completed' },
    });
  }
  messages.push(
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'agent-1',
      status: 'completed',
    },
    user({ blocks: [toolResult('agent-1')] }),
    { type: 'system', subtype: 'thinking_tokens' },
    assistant({
      blocks: [{ type: 'text', text: 'private top-level narration' }],
    }),
    { type: 'result', subtype: 'success' },
  );
  return messages;
}

async function modules() {
  const [subagentGate, gateEvidence, matrix] = await Promise.all([
    import('../scripts/spikes/subagent-gate.mjs'),
    import('../scripts/spikes/claude-gate-evidence.mjs'),
    import('../scripts/spikes/claude-gate-matrix.mjs'),
  ]);
  return { subagentGate, gateEvidence, matrix };
}

function resultFromMessages({
  messages,
  candidate,
  subagentGate,
  gateEvidence,
}) {
  const childParents = new Set(
    messages
      .map((message) => message.parent_tool_use_id)
      .filter(Boolean),
  );
  return {
    resolvedModel: 'claude-sonnet-4-6',
    resultSubtype: messages.findLast(
      (message) => message.type === 'result',
    )?.subtype,
    reasonCount: 0,
    subagentMessages: messages.filter(
      (message) => (
        message.type === 'assistant'
        && message.parent_tool_use_id
      ),
    ).length,
    distinctParentCount: childParents.size,
    subagentLifecycleProof:
      subagentGate.createSubagentLifecycleProof(messages),
    lifecycle: messages.map(gateEvidence.normalizeGateRecord),
    candidate,
  };
}

test('per-version subagent task lifecycle accepts model-stream volatility without losing task identity', async () => {
  const { subagentGate, gateEvidence, matrix } = await modules();
  const oldResult = resultFromMessages({
    messages: subagentMessages({ candidate: false }),
    candidate: false,
    subagentGate,
    gateEvidence,
  });
  const candidateResult = resultFromMessages({
    messages: subagentMessages({
      candidate: true,
      extraAmbient: true,
    }),
    candidate: true,
    subagentGate,
    gateEvidence,
  });

  assert.equal(
    subagentGate.evaluateSubagentEvidence(oldResult, {
      expectedTaskUpdated: 0,
    }).pass,
    true,
  );
  assert.equal(
    subagentGate.evaluateSubagentEvidence(candidateResult, {
      expectedTaskUpdated: 1,
    }).pass,
    true,
  );
  const scenario = {
    id: 'sdk-subagent',
    comparison: {
      lifecycle: {
        mode: 'version-specific-oracle',
        oracle: 'sdk-subagent-v1',
      },
      equalFields: ['resolvedModel', 'resultSubtype'],
    },
  };
  assert.deepEqual(matrix.evaluateMatrixEvidencePair({
    scenario,
    oldResult,
    candidateResult,
    oldExpectations: NO_TASK_UPDATE_EXPECTATIONS,
    candidateExpectations: CANDIDATE_EXPECTATIONS,
  }), {
    pass: true,
    differences: [],
  });
  // Each side is judged by its own version's declaration, so swapping the
  // declarations, or omitting one, must fail instead of passing by default.
  for (const [oldExpectations, candidateExpectations] of [
    [CANDIDATE_EXPECTATIONS, NO_TASK_UPDATE_EXPECTATIONS],
    [undefined, CANDIDATE_EXPECTATIONS],
    [NO_TASK_UPDATE_EXPECTATIONS, undefined],
  ]) {
    assert.deepEqual(matrix.evaluateMatrixEvidencePair({
      scenario,
      oldResult,
      candidateResult,
      oldExpectations,
      candidateExpectations,
    }).differences, ['lifecycle']);
  }
});

test('ambient commands_changed after a ToolSearch load keeps the subagent lifecycle valid', async () => {
  const { subagentGate, gateEvidence } = await modules();
  // Real 2.1.283 order: ToolSearch loads a deferred tool, Claude streams a
  // commands_changed notice, then the Agent task runs.
  const withNotice = (notice) => {
    const messages = subagentMessages({ candidate: true });
    const searchResult = messages.findIndex((message) => (
      message.type === 'user'
      && message.message.content.some((block) => block.tool_use_id === 'search-1')
    ));
    messages.splice(searchResult + 1, 0, notice);
    return resultFromMessages({
      messages,
      candidate: true,
      subagentGate,
      gateEvidence,
    });
  };
  assert.equal(subagentGate.evaluateSubagentEvidence(
    withNotice({ type: 'system', subtype: 'commands_changed' }),
    { expectedTaskUpdated: 1 },
  ).pass, true);
  // It stays ambient: task identity on it, or an unreviewed subtype, fails.
  assert.equal(subagentGate.evaluateSubagentEvidence(
    withNotice({ type: 'system', subtype: 'commands_changed', task_id: 'task-1' }),
    { expectedTaskUpdated: 1 },
  ).pass, false);
  assert.equal(subagentGate.evaluateSubagentEvidence(
    withNotice({ type: 'system', subtype: 'brand_new_notice' }),
    { expectedTaskUpdated: 1 },
  ).pass, false);
});

test('successful SDK tool results may omit is_error', async () => {
  const { subagentGate, gateEvidence } = await modules();
  const messages = subagentMessages({ candidate: true });
  for (const message of messages) {
    for (const block of message.message?.content || []) {
      if (block.type === 'tool_result') delete block.is_error;
    }
  }
  const result = resultFromMessages({
    messages,
    candidate: true,
    subagentGate,
    gateEvidence,
  });

  assert.equal(subagentGate.evaluateSubagentEvidence(result, {
    expectedTaskUpdated: 1,
  }).pass, true);
});

test('subagent proof rejects mixed identities, unmatched results, and unsuccessful task outcomes', async () => {
  const { subagentGate, gateEvidence } = await modules();
  const mutations = [
    (messages) => {
      messages.find(
        (message) => (
          message.type === 'assistant'
          && message.parent_tool_use_id
        ),
      ).parent_tool_use_id = 'agent-other';
    },
    (messages) => {
      messages.find(
        (message) => message.subtype === 'task_started',
      ).task_id = 'task-other';
    },
    (messages) => {
      messages.find(
        (message) => message.subtype === 'task_notification',
      ).tool_use_id = 'agent-other';
    },
    (messages) => {
      messages.find(
        (message) => (
          message.type === 'user'
          && !message.parent_tool_use_id
          && message.message.content.some(
            (block) => block.tool_use_id === 'agent-1',
          )
        ),
      ).message.content[0].tool_use_id = 'agent-other';
    },
    (messages) => {
      messages.find(
        (message) => (
          message.type === 'user'
          && message.parent_tool_use_id
          && message.message.content.some(
            (block) => block.type === 'tool_result',
          )
        ),
      ).message.content[0].tool_use_id = 'child-tool-other';
    },
    (messages) => {
      messages.find(
        (message) => (
          message.type === 'user'
          && message.parent_tool_use_id
          && message.message.content.some(
            (block) => block.type === 'tool_result',
          )
        ),
      ).message.content[0].is_error = true;
    },
    (messages) => {
      messages.find(
        (message) => message.subtype === 'task_notification',
      ).status = 'failed';
    },
    (messages) => {
      messages.find(
        (message) => message.subtype === 'task_updated',
      ).patch.status = 'failed';
    },
    (messages) => {
      const target = messages.find(
        (message) => (
          message.type === 'user'
          && !message.parent_tool_use_id
          && message.message.content.some(
            (block) => block.tool_use_id === 'agent-1',
          )
        ),
      );
      target.message.content[0].is_error = true;
    },
    (messages) => {
      messages.find(
        (message) => message.type === 'result',
      ).subtype = 'error_during_execution';
    },
  ];

  for (const mutate of mutations) {
    const messages = subagentMessages({ candidate: true });
    mutate(messages);
    const result = resultFromMessages({
      messages,
      candidate: true,
      subagentGate,
      gateEvidence,
    });
    assert.equal(
      subagentGate.evaluateSubagentEvidence(result, {
        expectedTaskUpdated: 1,
      }).pass,
      false,
    );
  }
});

test('subagent lifecycle rejects missing, duplicate, reordered, and unknown task events', async () => {
  const { subagentGate, gateEvidence } = await modules();
  const mutations = [
    (messages) => {
      messages.splice(
        messages.findIndex(
          (message) => message.subtype === 'task_updated',
        ),
        1,
      );
    },
    (messages) => {
      const update = messages.find(
        (message) => message.subtype === 'task_updated',
      );
      messages.splice(
        messages.findIndex(
          (message) => message.subtype === 'task_notification',
        ),
        0,
        structuredClone(update),
      );
    },
    (messages) => {
      const updateIndex = messages.findIndex(
        (message) => message.subtype === 'task_updated',
      );
      const [update] = messages.splice(updateIndex, 1);
      messages.splice(
        messages.findIndex(
          (message) => (
            message.type === 'user'
            && message.parent_tool_use_id
            && message.message.content.some(
              (block) => block.type === 'tool_result',
            )
          ),
        ),
        0,
        update,
      );
    },
    (messages) => {
      const started = messages.find(
        (message) => message.subtype === 'task_started',
      );
      messages.splice(
        messages.indexOf(started),
        0,
        structuredClone(started),
      );
    },
    (messages) => {
      messages.splice(-1, 0, {
        type: 'system',
        subtype: 'new_task_boundary',
      });
    },
    (messages) => {
      messages.splice(-1, 0, { type: 'brand-new-sdk-record' });
    },
    (messages) => {
      messages.push({ type: 'system', subtype: 'thinking_tokens' });
    },
  ];

  for (const mutate of mutations) {
    const messages = subagentMessages({ candidate: true });
    mutate(messages);
    const result = resultFromMessages({
      messages,
      candidate: true,
      subagentGate,
      gateEvidence,
    });
    assert.equal(
      subagentGate.evaluateSubagentEvidence(result, {
        expectedTaskUpdated: 1,
      }).pass,
      false,
    );
  }

  const oldWithUpdate = resultFromMessages({
    messages: subagentMessages({ candidate: true }),
    candidate: false,
    subagentGate,
    gateEvidence,
  });
  assert.equal(
    subagentGate.evaluateSubagentEvidence(oldWithUpdate, {
      expectedTaskUpdated: 0,
    }).pass,
    false,
  );
});

test('review false positives: every tool lineage and child boundary is exact', async () => {
  const { subagentGate, gateEvidence } = await modules();
  const mutations = {
    'unmatched auxiliary result': (messages) => {
      messages.splice(-1, 0, user({
        blocks: [toolResult('never-used')],
      }));
    },
    'unmatched auxiliary use': (messages) => {
      messages.splice(
        messages.findIndex((message) => (
          message.type === 'assistant'
          && message.message?.content?.some(
            (block) => block.name === 'Agent',
          )
        )),
        0,
        assistant({ blocks: [toolUse('never-returned', 'Glob')] }),
      );
    },
    'child before task start': (messages) => {
      const childIndex = messages.findIndex(
        (message) => message.parent_tool_use_id === 'agent-1',
      );
      const [child] = messages.splice(childIndex, 1);
      messages.splice(
        messages.findIndex(
          (message) => message.subtype === 'task_started',
        ),
        0,
        child,
      );
    },
    'child result before use': (messages) => {
      const useIndex = messages.findIndex((message) => (
        message.parent_tool_use_id === 'agent-1'
        && message.type === 'assistant'
        && message.message.content.some(
          (block) => block.id === 'child-tool-1',
        )
      ));
      const resultIndex = messages.findIndex((message) => (
        message.parent_tool_use_id === 'agent-1'
        && message.type === 'user'
        && message.message.content.some(
          (block) => block.tool_use_id === 'child-tool-1',
        )
      ));
      [messages[useIndex], messages[resultIndex]] = [
        messages[resultIndex],
        messages[useIndex],
      ];
    },
    'Agent and child ids collide': (messages) => {
      messages.find((message) => (
        message.parent_tool_use_id === 'agent-1'
        && message.type === 'assistant'
      )).message.content.find(
        (block) => block.type === 'tool_use',
      ).id = 'agent-1';
      messages.find((message) => (
        message.parent_tool_use_id === 'agent-1'
        && message.type === 'user'
        && message.message.content.some(
          (block) => block.type === 'tool_result',
        )
      )).message.content.find(
        (block) => block.type === 'tool_result',
      ).tool_use_id = 'agent-1';
    },
    'lost text-only child attribution': (messages) => {
      const taskStart = messages.findIndex(
        (message) => message.subtype === 'task_started',
      );
      messages.splice(taskStart + 1, 0, assistant({
        parent: 'agent-1',
        blocks: [{ type: 'text', text: 'private child narration' }],
      }));
      delete messages[taskStart + 1].parent_tool_use_id;
    },
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    const messages = subagentMessages({ candidate: true });
    mutate(messages);
    const result = resultFromMessages({
      messages,
      candidate: true,
      subagentGate,
      gateEvidence,
    });
    assert.equal(
      subagentGate.evaluateSubagentEvidence(result, {
        expectedTaskUpdated: 1,
      }).pass,
      false,
      name,
    );
  }
});

test('matrix acceptance regenerates the subagent proof from the private SDK stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-subagent-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const privateArtifactDir = path.join(dir, 'raw-private');
  fs.mkdirSync(privateArtifactDir, { mode: 0o700 });
  const streamPath = path.join(privateArtifactDir, 'sdk-stream.ndjson');
  const validMessages = subagentMessages({ candidate: true });
  const rawMessages = structuredClone(validMessages);
  rawMessages.find(
    (message) => message.subtype === 'task_notification',
  ).task_id = 'task-other';
  fs.writeFileSync(
    streamPath,
    `${rawMessages.map(JSON.stringify).join('\n')}\n`,
    { mode: 0o600 },
  );

  const { subagentGate, gateEvidence, matrix } = await modules();
  const streamEvidence = gateEvidence.collectGateLifecycleEvidence(
    streamPath,
    { stream: 'sdk' },
  );
  const result = {
    ...resultFromMessages({
      messages: validMessages,
      candidate: true,
      subagentGate,
      gateEvidence,
    }),
    evidenceSchemaVersion: 1,
    matrixScenario: 'sdk-subagent',
    status: 'PASS',
    attestation: {
      version: manifest.versions.candidate,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    },
    lifecycle: streamEvidence.records,
    lifecycleSources: {
      sdk: streamEvidence.source,
    },
    lifecycleProofs: [],
  };
  const run = {
    scenarioId: 'sdk-subagent',
    versionKey: 'candidate',
    version: manifest.versions.candidate,
    expectations: CANDIDATE_EXPECTATIONS,
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    versionSpecificLifecycleOracle: 'sdk-subagent-v1',
    evidenceSources: {
      sdk: 'sdk-stream.ndjson',
    },
  };

  assert.equal(
    subagentGate.evaluateSubagentEvidence(result, {
      expectedTaskUpdated: 1,
    }).pass,
    true,
    'the self-reported sanitized proof remains internally green',
  );
  assert.equal(matrix.evaluateMatrixRunResult({
    run,
    result,
    privateArtifactDir,
  }).pass, false);

  const validStream = `${validMessages.map(JSON.stringify).join('\n')}\n`;
  fs.writeFileSync(streamPath, validStream, { mode: 0o600 });
  const validSource = gateEvidence.collectGateLifecycleEvidence(
    streamPath,
    { stream: 'sdk' },
  );
  const validResult = {
    ...result,
    lifecycle: validSource.records,
    lifecycleSources: {
      sdk: validSource.source,
    },
  };
  assert.equal(matrix.evaluateMatrixRunResult({
    run,
    result: validResult,
    privateArtifactDir,
  }).pass, true);
});
