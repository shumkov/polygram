'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Build a rewound FORK of a claude session transcript (0.13 /rewind P2; the mechanism P0.6
 * validated). Keep the prefix up to — not including — the user turn carrying `targetMsgId`,
 * rewrite the in-file `sessionId` to `newSessionId` on every line, and write a new
 * `<newSessionId>.jsonl` next to the original (mode 0o600). NEVER touches the original.
 *
 * Fail-safe by construction — any anomaly returns `{ ok:false, error }`, never a partial/
 * corrupt fork:
 *   - transcript unreadable / not valid JSONL
 *   - target not found (scrolled out OR compacted away — the locate-miss IS the compaction
 *     guard: a target older than a compaction boundary no longer carries its msg_id wrapper)
 *   - target is already the conversation start
 *   - the cut point is mid-tool-call (a tool_use in the prefix without its tool_result)
 *
 * A clean prefix needs no `parentUuid` reconciliation — a prefix of a backward-linked chain
 * is self-consistent (verified in the P0.6 spike).
 *
 * @param {object} args
 * @param {string} args.transcriptPath
 * @param {string|number} args.targetMsgId — TG msg_id of the user message to rewind to.
 * @param {string} args.newSessionId
 * @param {object} [io] { fsImpl } — inject a fake fs for tests.
 * @returns {{ ok:true, forkPath:string, droppedTurns:number } | { ok:false, error:string }}
 */
function buildFork({ transcriptPath, targetMsgId, newSessionId }, { fsImpl = fs } = {}) {
  if (!transcriptPath || !newSessionId || targetMsgId == null) {
    return { ok: false, error: 'buildFork: transcriptPath, targetMsgId, newSessionId required' };
  }
  let raw;
  try { raw = fsImpl.readFileSync(transcriptPath, 'utf8'); }
  catch (e) { return { ok: false, error: `transcript unreadable: ${e.code || e.message}` }; }

  const lines = String(raw).split('\n').filter((l) => l.trim());
  let objs;
  try { objs = lines.map((l) => JSON.parse(l)); }
  catch { return { ok: false, error: 'transcript is not valid JSONL' }; }

  // The channel wrapper lives in the user turn's content as a PLAIN string (the parsed value,
  // not JSON-escaped) — search that, not JSON.stringify (which escapes the inner quotes).
  const contentText = (o) => {
    const c = o && o.message ? o.message.content : null;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ');
    return '';
  };
  const needle = `msg_id="${targetMsgId}"`;
  const isChannelUser = (o) => o && o.type === 'user' && contentText(o).includes('msg_id=');
  const cutIdx = objs.findIndex((o) => o && o.type === 'user' && contentText(o).includes(needle));
  if (cutIdx < 0) {
    return { ok: false, error: "couldn't find that message in the conversation (it may have scrolled out of memory)" };
  }

  const prefix = objs.slice(0, cutIdx);
  if (!prefix.some(isChannelUser)) {
    return { ok: false, error: "that's already the start of the conversation" };
  }

  // Clean-boundary check: no tool_use in the prefix left without its matching tool_result.
  const openTools = new Set();
  for (const o of prefix) {
    const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && b.id) openTools.add(b.id);
      if (b && b.type === 'tool_result' && b.tool_use_id) openTools.delete(b.tool_use_id);
    }
  }
  if (openTools.size > 0) {
    return { ok: false, error: 'that point is mid-tool-call — pick the message just before or after' };
  }

  // Rewrite sessionId on EVERY kept line (the resume id must match the filename + in-file id,
  // else claude's ghost-session guard drops it and starts fresh = a silent full wipe).
  const forked = prefix.map((o) => {
    if (o && typeof o === 'object' && 'sessionId' in o) o.sessionId = newSessionId;
    return JSON.stringify(o);
  });

  const forkPath = path.join(path.dirname(transcriptPath), `${newSessionId}.jsonl`);
  try {
    fsImpl.writeFileSync(forkPath, forked.join('\n') + '\n', { mode: 0o600 });
  } catch (e) { return { ok: false, error: `couldn't write the fork: ${e.code || e.message}` }; }

  const droppedTurns = objs.slice(cutIdx).filter(isChannelUser).length;
  return { ok: true, forkPath, droppedTurns };
}

module.exports = { buildFork };
