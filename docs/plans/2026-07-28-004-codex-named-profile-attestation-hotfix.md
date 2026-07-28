---
title: Codex Named-Profile Attestation Hotfix
type: bugfix
date: 2026-07-28
status: implemented
affects:
  - "@shumkov/orchestra"
  - "polygram"
---

# Codex Named-Profile Attestation Hotfix

## Problem

The first local Polygram Codex canary message failed before its prompt was
sent. Orchestra accepted a successful `thread/start` response from pinned
Codex 0.145.0, then rejected the response with
`CODEX_THREAD_POLICY_MISMATCH`. Polygram correctly persisted
`thread-accepted-before-startup-failure` and quarantined native Codex for the
daemon.

The requested `polygram-session` named permission profile was active and its
materialized managed policy was correct. The mismatch was caused by Orchestra
comparing the profile's intended writable workspace root with Codex's lossy
legacy `sandbox` compatibility projection.

## Verified Evidence

These are observed facts, not estimates:

1. Telegram message `2580` selected runtime `codex` and failed during
   `CodexProcess._validateThreadResult`. No `turn/start` existed for the
   Telegram source message, and no user prompt or client user-message ID was
   dispatched.
2. The mutation ledger records a successful, response-observed
   `thread/start`; the generation and daemon lease are quarantined with
   `thread-accepted-before-startup-failure`.
3. Bounded fresh-thread and resume probes against the exact production binary,
   `CODEX_HOME`, config hash, workspace, and Node runtime returned:

   ```json
   {
     "runtimeWorkspaceRoots": {
       "count": 1,
       "sha256": ["sha256(owned-cwd)"]
     },
     "modelProvider": "openai",
     "approvalPolicy": "never",
     "approvalsReviewer": "user",
     "sandbox": {
       "type": "workspaceWrite",
       "networkAccess": false,
       "excludeSlashTmp": true,
       "excludeTmpdirEnvVar": true,
       "writableRootCount": 0,
       "writableRootSha256": []
     },
     "activePermissionProfile": {
       "id": "polygram-session",
       "extends": null
     }
   }
   ```

   The runtime root was absolute, normalized, contained by the owned cwd, and
   identical on fresh and resumed threads.
4. A reversible, settings-only probe of the persisted diagnostic thread
   changed effort and restored it without starting a model turn. The resulting
   `thread/settings/updated` notification returned the same legacy sandbox
   envelope and profile/approval/provider values. It did not contain
   `runtimeWorkspaceRoots`.
5. Codex's durable internal state for that resumed thread records a managed
   policy with restricted network and exactly one writable entry: the owned
   Polygram workspace.
6. The generated 0.145.0 `ThreadStartResponse` schema describes `sandbox` as a
   legacy compatibility field and tells experimental clients to prefer
   `activePermissionProfile` for profile provenance.
7. The authenticated compatibility checker proved the materialized named
   profile can write the workspace and denies credential/daemon-secret roots,
   but it did not assert the raw fresh/resume legacy sandbox projection.
   Unit fixtures invented `writableRootCount: 1`, so they could not catch the
   production shape.

## Root Cause

The causal chain is:

1. Polygram materializes and preflights a correct named permission profile.
2. `thread/start` activates `polygram-session`.
3. Codex enforces the profile as a managed policy with the workspace write
   entry.
4. Codex also returns a lossy legacy `workspaceWrite` compatibility object.
   For a managed named profile, that object reports no additional legacy
   writable roots. The concrete materialized roots are returned separately in
   `runtimeWorkspaceRoots`.
5. Orchestra builds its expected thread policy by translating the
   materialized profile into the legacy response shape and expects one root.
6. Deep equality fails on `writableRootCount` and
   `writableRootSha256`.
7. Because `thread/start` already returned success, the existing safety
   contract enters containment and Polygram quarantines Codex.

The security boundary did not widen. The selected named profile, concrete
runtime workspace root, and internal managed policy remained correct; the
legacy projection was simply lossy.

## Chosen Approach

Treat the protocol surfaces according to what they actually prove:

- The owned config/layer/requirements attestation proves the exact materialized
  `polygram-session` policy, including its workspace write rule, credential and
  daemon-secret denies, and disabled network.
- `activePermissionProfile` proves that the exact named profile was selected
  for the thread.
- Fresh and resume response `runtimeWorkspaceRoots` prove which concrete roots
  Codex used to materialize the profile's symbolic workspace-root grant.
- The legacy `sandbox` response is pinned only as a compatibility envelope:
  `workspaceWrite`, network disabled, temp-root exclusions enabled, and no
  additional legacy writable roots.

For pinned Codex 0.145.0, Orchestra will use two distinct expected views:

1. Fresh/resume attachment must include exactly one absolute, normalized,
   owned root in `runtimeWorkspaceRoots`, canonically represented as
   `count: 1` plus `sha256(cwd)`.
2. Attachment and `thread/settings/updated` must both include this exact
   observed legacy envelope:

```js
{
  type: 'workspaceWrite',
  networkAccess: false,
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
  writableRootCount: 0,
  writableRootSha256: [],
}
```

`thread/settings/updated` does not contain `runtimeWorkspaceRoots`, so its
static view must not be conflated with the attachment view. It re-attests the
legacy envelope, exact named profile, provider, approval policy, and reviewer;
the already-admitted attachment supplies the concrete-root proof. A fresh or
resumed response with a missing, outside-workspace, duplicated, additional, or
wrong runtime root fails closed. A legacy response that adds any root, enables
network, disables either temp exclusion, changes sandbox type, omits profile
provenance, or selects another profile also fails closed.

This is not normalization of zero and one as equivalent. It pins the exact
fresh, resume, and settings-notification shapes observed from the supported
runtime. The legacy root count means zero *additional legacy roots*; it does
not mean the owned workspace is unwritable.

## Alternatives Rejected

### Send `runtimeWorkspaceRoots` on `thread/start`

Rejected for this hotfix. It expands the production request surface and may
change permission semantics. The accepted design deliberately sends no
experimental permission or workspace-root selector, and the managed policy
already contains the intended workspace write rule. Orchestra instead reads,
validates, and pins the concrete `runtimeWorkspaceRoots` returned by Codex.

### Accept either zero or one writable root

Rejected because it weakens the pinned protocol contract without explaining
which surface is authoritative.

### Ignore the legacy sandbox entirely

Rejected because its type, network flag, and absence of extra legacy roots
remain useful defense-in-depth signals.

### Clear the production quarantine manually

Rejected. The accepted native macOS containment contract has no force-release.
A same-host daemon restart in the same kernel boot must remain quarantined.

### Fall back to Claude or automatically replay message `2580`

Rejected. Provider fallback would hide the Codex failure, and replay is not
authorized. The prompt was definitely not sent as a Codex turn; the owner may
send a new message after recovery.

## Changes by Repository

### Orchestra

Implementation must use a new worktree based on current `origin/main` /
released `v0.7.3`. The existing `/Users/ivanshumkov/Projects/shumkov/orchestra`
checkout is an older feature branch and must remain untouched.

1. In `lib/codex/app-server-client.js`, project and validate
   `runtimeWorkspaceRoots` for fresh/resume responses. Require an array of
   canonical absolute roots contained by the owned cwd and represent it as a
   bounded count plus sorted hashes. Also retain and validate
   `excludeSlashTmp` and `excludeTmpdirEnvVar` in the legacy sandbox projection.
2. In `lib/process/codex-process.js`, keep distinct attachment and
   settings-notification attestation views: attachment includes exact runtime
   roots; settings notification does not.
3. In `lib/process/factory.js`, build the exact expected named-profile
   attachment policy: one runtime root equal to the owned cwd, zero additional
   legacy roots, both temp exclusions enabled, and the existing exact
   profile/provider/approval fields.
4. Update the real-runtime compatibility characterization and
   `docs/codex-app-server-compatibility.md` to assert and report redacted
   fresh/resume runtime roots plus the fresh/resume/settings legacy envelope.
   Preserve the full existing named-profile enforcement and side-channel gate.
5. Replace invented one-root fake responses only where a fixture represents a
   named managed profile; retain generic legacy-root tests.
6. Add focused regression coverage proving:
   - fresh and resumed responses are admitted only with exactly
     `runtimeWorkspaceRoots == [ownedCwd]` and zero additional legacy roots;
   - missing, malformed, duplicated, additional, outside-workspace, or wrong
     runtime roots are rejected;
   - a non-empty legacy writable-root projection is rejected;
   - missing/alternate network forms, either disabled temp exclusion, wrong
     sandbox type, missing/wrong profile or parent, wrong approvals/reviewer,
     or wrong provider remain rejected;
   - a real-shaped settings notification after an admitted thread accepts the
     same legacy envelope without requiring absent runtime roots, while any
     settings-policy drift quarantines the generation;
   - the user prompt is not dispatched when any static field mismatches.
7. Release the smallest unused patch version, expected to be `0.7.4`.

### Polygram

1. Pin the patched Orchestra version in `package.json` and
   `package-lock.json`.
2. Update the fake app-server integration fixture to use the real zero-root
   legacy response, exact runtime root, and temp-exclusion fields.
3. Add or strengthen an integration test proving a preflighted
   `polygram-session` thread reaches `turn/start` with the chosen
   model/effort when Codex returns the pinned fresh-thread policy.
4. Update `tests/orchestra-dependency-contract.test.js` and
   `.claude-plugin/plugin.json` with the exact release versions.
5. Keep Claude SDK/CLI tests and behavior unchanged.
6. Release the smallest unused Polygram patch version, expected to be
   `0.23.3`.

No runtime config, schema migration, session row, Telegram handler, model
selection, or production message is changed by the code fix.

## Test-First Verification

### Red

Before the Orchestra fix, add a regression test whose thread response is the
observed named-profile shape with zero legacy roots. Assert that startup
succeeds and the first prompt reaches `turn/start`. It must fail with
`CODEX_THREAD_POLICY_MISMATCH` on the released 0.7.3 behavior.

In Polygram, update the fake server to the same observed shape. The existing
fresh-thread integration must fail against exact released Orchestra `0.7.3`
and pass unchanged against the packed patch.

### Green

After the fix:

- run the focused Orchestra process/factory/client tests;
- run Orchestra's full Node 24 suite;
- run the full authenticated named-profile enforcement and side-channel checker
  against Codex 0.145.0 using the packed candidate and production service
  identity; keep the fresh/resume/settings policy characterization as an
  additive assertion, not a replacement for the workspace-write,
  credential/daemon-secret-denial, network-denial, and same-user-side-channel
  probes;
- install the packed Orchestra patch into Polygram;
- run focused Polygram Codex runtime/controller/integration tests;
- run Polygram's full Node 24 suite;
- inspect both tarballs and run packaging/version consistency checks.

The authenticated gate must not send production Telegram content. Its existing
synthetic no-tools compatibility prompt is the only model input allowed.

## Failure and Security Semantics

- Any static mismatch other than the pinned zero-root legacy representation
  retains the current fail-closed containment behavior.
- `activePermissionProfile`, `runtimeWorkspaceRoots`, and the settings-update
  notification are pinned experimental/full-schema surfaces in Codex 0.145.0.
  Their absence or shape drift in any future pin is a compatibility failure,
  not something to infer or normalize.
- No hashes or raw paths from policy responses are logged. Test output may
  compare hashes internally but durable compatibility output remains
  redacted.
- No automatic retry or provider fallback is introduced.
- The one-live-native-Codex-generation limit is unchanged.
- The `thread/start` and `thread/resume` mutation ledger is unchanged.
- The current production incident remains immutable and quarantined through
  the patch deployment.

## Release, Recovery, and Rollout

1. Before any tag, inspect the Orchestra tarball and cross-test that exact
   packed artifact in Polygram. After both code reviews are clean, publish
   Orchestra first through its normal signed release/tag workflow.
2. Replace the packed dependency with that exact published Orchestra version,
   inspect the Polygram tarball, rerun the exact-artifact tests, then publish
   Polygram through its normal signed release/tag workflow.
3. Install Polygram only on the local `shumorobot` canary first. Before reboot,
   validate only the installed package/version, native binding, offline doctor
   checks, launchd health, same-boot quarantine reconstruction, and—separately—
   the direct compatibility checker. Polygram doctor does not start app-server,
   and the quarantined daemon cannot exercise normal runtime admission.
4. The patched daemon will still reconstruct the current same-boot
   quarantine. Do not edit the database or force-release it.
5. With separate explicit approval for the host-wide disruption, reboot this
   Mac. A new kernel boot-session identity on the same stable host is the only
   accepted quarantine release.
6. After reboot, verify:
   - the daemon starts once;
   - exactly one durable `codex_reboot_releases` audit row records release for
     the same stable host and changed boot-session identity;
   - only the stale containment lease is cleared;
   - incident message `2580` remains immutable/ambiguous, with no retry
     reservation and no replay;
   - preflight still attests the exact config/profile;
   - after those checks, Ivan sends one new topic-5 canary message, which
     creates one fresh thread and one ordinary test turn;
   - the provider thread ID persists and resumes across a daemon restart;
   - Claude topics remain healthy.
7. Do not auto-replay message `2580`.
8. Hold the canary locally for the planned observation window. Do not enable
   Codex on the VPS or additional topics in this hotfix.

## Rollback

- Before reboot: reinstall the prior Polygram release or route topic 5 back to
  Claude; quarantine remains intact.
- After reboot but before a successful Codex turn: route topic 5 back to
  Claude and restart only `shumorobot`.
- After a new ambiguous Codex mutation: preserve the new quarantine and follow
  the existing incident contract; do not retry or manually clear state.

## Success Criteria

- The exact observed fresh/resume policy passes without weakening any other
  static check.
- A regression test is red on Orchestra 0.7.3 and green on the patch.
- Both repository suites pass with all skips reported.
- Released Polygram consumes the exact released Orchestra patch.
- The current incident is never deleted, rewritten, retried, or force-cleared.
- After an explicitly approved reboot, a new topic-5 message reaches Codex and
  returns a normal text reply while Claude topics remain unchanged.

## Review Outcomes

Independent feasibility, simplicity/scope, and failure/security reviews all
blocked the initial draft until these changes were made:

- concrete fresh/resume `runtimeWorkspaceRoots` are now authoritative and
  exact, while zero means only zero additional legacy roots;
- attach and settings-notification policy views are separate;
- temp-root exclusion flags are projected and pinned;
- the full authenticated enforcement/side-channel gate remains mandatory;
- the exact worktree, version-file, packaging, pre-reboot, and post-reboot
  release steps are explicit.

No reviewer requested a broader feature, schema migration, force-release path,
fallback, or replay mechanism.
