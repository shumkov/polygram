# Claude proxy auth gate correction

Status: owner approved; implementation and independent code review complete. Production activation pending.
Base: `07ef87ccd9da65cd36c38c5f7a5b3c34f23467ac`, branch `dead`; initially clean.

## Problem and evidence

On 2026-10-09 the VPS native Claude refresh token expired at 09:29 UTC.
Polygram 0.39.0 emitted dispatch-gate auth-expired at 10:52:54 UTC and replied
that login must be refreshed. Both daemons actually select enabled proxy
launchers. Both proxy Claude accounts refresh successfully; the host login
is not the credential used by their CLI turns. The gate returns before spawn.

`polygram.js` calls Orchestra's native-file `checkClaudeAuthHealth()` in the
inbound gate and the boot/30-minute monitor. Neither call knows the auth source.
The original gate prevents a documented native-login silent CLI wedge; removing
it globally would restore that failure. Existing tests check provider separation
but have no expired-native-login plus externally authenticated CLI case.

## Research

- `docs/claude-auth-detection-spec.md`: preserve the native refresh-expiry gate;
  native CLI auth failure does not reliably reach the error classifier.
- `lib/sdk/build-options.js`: SDK env construction is independent of CLI launching.
- Orchestra `lib/process/factory.js`: channels/tmux aliases normalize to `cli`;
  sessionLauncher reaches CliProcess only. Missing CLI dependencies can fall back
  to SDK. SDK must not inherit a CLI-only external-auth exemption.
- Live VPS wrappers read enabled private configuration, override the child
  ANTHROPIC_BASE_URL/AUTH_TOKEN, and leave Codex untouched. Daemon environment
  alone does not reveal those child overrides. Wrapper presence is not proof
  that its proxy mode is enabled.
- Official Claude environment reference: https://code.claude.com/docs/en/env-vars
  describes BASE_URL routing and AUTH_TOKEN authentication. This supports separate
  native and gateway auth ownership; it does not attest any installed wrapper.
- Targeted GitHub open-PR and issue searches found no existing proxy-auth fix.

## Chosen approach

Add one explicit operator setting at `bots.<name>.claudeCliAuthSource`, read
through the merged effective `config.bot`:

    "claudeCliAuthSource": "external"

Absent or `native` preserves today's native-login check. Only canonical `cli`
turns can use `external`. SDK always retains the current native check; Codex
continues to bypass the Claude gate. Reject values other than native/external.
This is an operator declaration of credential ownership, not a claim that the
proxy is reachable or authenticated. It changes no provider or routing env.

Put a small pure `needsNativeClaudeAuth(botConfig, canonicalBackend)` predicate
in `lib/ops/claude-auth-health.js`, shared by dispatch and monitoring. Return
false for Codex and explicitly external CLI, true for native CLI and SDK. Keep
Orchestra's native-health result contract unchanged. Validate the setting before
PID ownership mutations at boot. Policy errors must not enter the existing
try/catch that converts native credential-read failures to unknown. Preserve that
fail-open behavior only for the native read. Log no config, URLs, or secrets.

At boot, declaring external CLI mode always requires an absolute configured
session launcher and successful existing pinned-Claude preflight, even if no
chat currently selects CLI. This also protects future in-memory backend changes. Missing prerequisites are a clear
configuration failure, not permission to silently fall back to native SDK.
Do not change wrapper bytes, Orchestra, credential files, or the CLI version.

The monitor uses the same policy: inspect every configured chat default and explicit
topic with `resolveRuntimeDescriptor` (not Orchestra pickBackend alone, which
does not recognize Codex, and not the availability-enforcing prompt resolver). Check native credentials only if at least one
configured Claude runtime uses them. Proxy-only CLI plus Codex configurations do
not emit native auth-expired/auth-expiring alarms. Mixed SDK/CLI deployments keep
native monitoring with wording that identifies native Claude auth, rather than
claiming all Claude turns are refused. Re-evaluate current configuration on each
monitor run; invalid selections must be surfaced, not silently skipped. This
means current in-memory selections, not reloading config from disk. Auth-source
changes are restart-only, since configuration is read at boot.

## Alternatives

1. Delete the gate or make it warning-only: rejected; brings back the known native
   CLI silent wedge.
2. Renew/delete the host credentials: rejected; masks the bug and alters unrelated
   native sessions.
3. Skip whenever a launcher or BASE_URL exists: rejected; containment and disabled
   proxy wrappers are not auth-source proof; child env differs from daemon env.
4. Read deployment-specific private proxy config paths from Polygram: rejected;
   couples generic application code to host layouts and secret-bearing schema.
5. Add a launcher introspection protocol: reliable longer-term option, but requires
   wrapper changes, deployment coordination and Codex launcher re-attestation.
   Unnecessary for a bounded fix with an explicit operator declaration.

## Failure modes and limits

- Operator config can drift from proxy enablement. Deployment must set external
  only after verifying the running launcher and enabled private config; reverting
  to native requires restoring this setting too. No automatic route detection is
  claimed. This is the main tradeoff against launcher introspection.
- Proxy outages/auth failures are not solved or declared healthy by this policy.
  Existing runtime errors/timeouts remain; no inference on each inbound message.
- SDK remains native-checked; SDK proxy detection is outside this incident.
- Previously rejected messages are not automatically replayed by this fix.
- Warm CLI processes retain their route; activation requires normal daemon
  retirement/replacement, avoiding mixed old/new auth assumptions.

## Test-first verification

1. Executed before implementation: a reproducible offline test using the
   existing gate extracted from polygram.js with stubbed native auth returning
   expired, canonical cli backend, and external bot auth source. Assert the
   request reaches post-gate dispatch. Current code failed that assertion and sent
   the exact login-expired reply with an auth-expired/dispatch-gate event. Persist
   this regression test during implementation and also exercise the real monitor
   block offline before changing it.
2. Add executable policy tests: external CLI does not read native credentials;
   native CLI and SDK with expired credentials still block; Codex bypass;
   native healthy/unknown/throw handling; invalid values; disabled/missing setting;
   mixed SDK/proxy CLI monitoring; aliases and topic overrides; startup preconditions,
   including external mode initially configured with only SDK/Codex chats and a
   missing pinned CLI (reject before a future switch could bypass native checking).
3. Run the same gate/monitor reproduction after the fix, plus existing provider
   separation and configuration wiring tests, then npm test. Report all skips.
4. Independent diff review after implementation; repair must-fixes.

## Activation and acceptance

Prepare the code and reviewed test evidence before any production activation.
Publish/deploy through the existing polygram-deploy workflow, without upgrading
Orchestra or Claude. Back up runtime config and add the external declaration only
to shumabit and umi-assistant after verifying their enabled proxy launchers.
Preserve all other config and owners. Restart through the authorized lifecycle
workflow with fresh busy checks. Do not interrupt active work without authority.
Verify installed bytes/version, declaration, route, lifecycle, and that native
credential expiry no longer produces proxy dispatch refusals. An isolated
proxy-only probe does not prove Telegram delivery: a real user turn is the final
acceptance. Do not manufacture a customer message or replay rejected work.

Owner alignment is required before implementation by the supplied AGENTS rules.
Production activation remains a concrete follow-on step after implementation.

## Independent review disposition

Three reviewers covered correctness/feasibility, simplicity/scope, and failure
modes/security/rollout. All endorse explicit CLI auth ownership. Incorporated
required clarifications: validation outside native-read fail-open; unconditional
external-mode CLI prerequisites; exact persisted config path and restart-only
semantics. Simplified to one pure predicate with existing health states and
existing runtime resolver. No unresolved design blockers remain.

## Implementation verification (2026-10-09)

- Before implementation, executable dispatch/monitor reproduction: 9 tests,
  7 passed and 2 failed on the exact intended symptoms (proxy turn rejection
  and false native-login monitor alarm). Red output: `/tmp/polygram-auth-red.log`.
- After implementation, 37 focused policy, actual gate/monitor and provider
  wiring checks pass, with no skips.
- Full suite with Node 24.4.0: 4,438 tests; 4,422 passed, 0 failed, 16 explicitly
  gated real-Claude E2E tests skipped. These require `E2E_REAL_CLAUDE=1` and were
  not run. Output: `/tmp/polygram-auth-full-test-node24.log`.
- The first broad run used shell-default Node 26.5.0 and failed loading the
  existing SQLite binary (built for Node ABI 137 rather than 147). Using the
  installed matching Node 24 runtime corrected the environment without changing
  dependencies or lockfiles. This failed run is not counted as passing evidence.
- Three simplification reviews (reuse, quality, efficiency) found no changes to
  make. The package defines neither a lint nor a typecheck command.
- Six independent code-review lenses (correctness, standards, testing,
  maintainability, security, reliability) found no actionable defects. The
  separate Claude adversarial pass proposed suppressing repeated invalid-backend
  warnings; this was rejected because the approved policy intentionally surfaces
  invalid configuration. No production correctness claim is inferred from review.
