# G13 — corrected reading

The automated test reported FAIL because the `isReady()` regex was tuned for the default TUI state (`? for shortcuts` in the bottom hint), but `--permission-mode acceptEdits` changes the bottom hint to `⏵⏵ accept edits on (shift+tab to cycle)`. The script's polling loop never matched `isReady()` and hit the 45s timeout — but the actual filesystem check shows the file WAS created.

**Reading the captures by hand:**

| Mode | TUI behavior | File created? | Verdict |
|------|--------------|---------------|---------|
| `none` (default) | `Do you want to create g13-probe-none.txt? ❯ 1. Yes / 2. Yes-allow-all / 3. No` — BLOCKED on prompt | ❌ no | EXPECTED (matches G8.S2 finding) |
| `bypassPermissions` | tmux session vanished — claude refused to launch without companion flag | ❌ no | Needs `--dangerously-skip-permissions` companion |
| `acceptEdits` | `⏺ Wrote 1 lines to g13-probe-acceptEdits.txt` + `⏺ Done.` | ✅ **YES** | **WORKS** |

**Production answer**:

```js
// lib/process/tmux-process.js — start()
const args = [
  '--model', chatConfig.model,
  '--effort', chatConfig.effort,
  '--permission-mode', 'acceptEdits',  // OR 'bypassPermissions' + '--dangerously-skip-permissions'
  ...(existingSessionId ? ['--resume', existingSessionId] : []),
];
```

This matches the SDK pm's current default (`permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` per `lib/sdk/build-options.js`). Per-chat overrides via `chatConfig.permissionMode` apply to both backends uniformly — same as today.

**Final G13 status: PASS (corrected).**

**Implication for the spec**: R1-F6 (approval-hook revival) and R2-F4 (PreToolUse hook security hardening) are NOT blockers for Phase 1. They become **Phase 3 enhancements** for chats that explicitly want the in-chat approval flow (`canUseTool`-equivalent). Default Phase 1 behavior is "tmux backend matches SDK pm permission semantics — bypassPermissions / acceptEdits — no hook involvement."

The Phase 2.5 design gate (in the v3 plan) can be DROPPED. Approval-surface fork is no longer split-brain by default; it becomes opt-in for chats that want it.

**Phase day delta**: -1 dev day (drop the Phase 2.5 gate from §16 schedule).
