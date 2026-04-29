/**
 * G12: Session resume after daemon restart.
 *
 * Validates that an SDK Query started in one process can be resumed
 * with the saved claude_session_id in a NEW process and the
 * conversation continues coherently.
 *
 * Strategy:
 *   1. Spawn a Query, ask "remember the magic word: <marker>".
 *   2. Capture the result.session_id.
 *   3. Spawn a NEW Query with `resume: <session_id>`.
 *   4. Ask "what was the magic word?".
 *   5. Pass criterion: response includes the marker.
 *
 * Burns ~$0.005 per run.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const MARKER = 'magic-' + Math.random().toString(36).slice(2, 8);

async function runQuery(prompt, resumeId) {
  const q = query({
    prompt,
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(resumeId && { resume: resumeId }),
    },
  });
  let text = '';
  let sessionId = null;
  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text') text += b.text;
      }
    }
    if (m.type === 'result') {
      sessionId = m.session_id;
      break;
    }
  }
  return { text, sessionId };
}

console.log(`Step 1: priming the session with marker "${MARKER}"`);
const first = await runQuery(`Please remember this magic word: ${MARKER}. Just acknowledge briefly.`);
console.log('first reply:', first.text.slice(0, 100));
console.log('session_id:', first.sessionId);

if (!first.sessionId) {
  console.log('FAIL — first turn did not return a session_id');
  process.exit(1);
}

console.log('\nStep 2: resuming session in fresh Query');
const second = await runQuery('What was the magic word I asked you to remember? Just the word, nothing else.', first.sessionId);
console.log('second reply:', second.text.slice(0, 100));

const recalled = second.text.toLowerCase().includes(MARKER.toLowerCase());
console.log(recalled ? '\nPASS — session resume preserved transcript' : '\nFAIL — marker not recalled');
process.exit(recalled ? 0 : 1);
