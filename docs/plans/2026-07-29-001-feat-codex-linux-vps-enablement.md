---
title: Codex Linux x64 VPS Enablement
type: implementation-plan
date: 2026-07-29
status: in-progress
depends_on:
  - 2026-07-26-001-feat-codex-app-server-steering-plan.md
  - 2026-07-26-002-codex-native-macos-beta-amendment.md
---

# Codex Linux x64 VPS Enablement

## Outcome

Enable the existing JavaScript `codex app-server` backend for Ivan's private
Shumabit Polygram chat on the `umi-vps` Linux x64 host without changing Claude
SDK/CLI behavior or weakening the accepted Codex security and recovery
contract.

This is a narrow Linux x64 canary extension. It is not a Codex CLI/tmux
backend, a broad multi-user Linux launch, Linux arm64 support, Windows support,
or per-session cgroup containment.

## Verified facts

These are observations, not estimates:

- The VPS runs Linux x64 and the user can start Codex interactively with an
  authenticated ChatGPT account.
- Polygram 0.24.0 intentionally rejects Linux in
  `lib/codex/binary.js` and `lib/codex/host-identity.js`.
- Orchestra 0.8.0 rejects only Windows at the client boundary, but its single
  embedded binary checksum is the macOS arm64 checksum. Removing only
  Polygram's platform guard would therefore fail the next Orchestra
  attestation.
- The official npm artifact is `@openai/codex@0.145.0-linux-x64`, target
  `x86_64-unknown-linux-musl`. The canonical native executable installed on
  the VPS reports `codex-cli 0.145.0` and has SHA-256
  `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14`.
  Its package tarball registry integrity is
  `sha512-u8w8LLv3DvsfrDCoswLIemZ0SoNEXyi511WsfFsSiYUazk9qMsB/NtU8N9vhAfN7mZAxLFoMex4v66JjHuZWwA==`.
  An independent download of the official registry artifact reproduced the
  native hash; it was not learned only from the installed VPS copy.
- The existing macOS arm64 native checksum is
  `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590`,
  and that binary also reports `codex-cli 0.145.0`.
- Fresh stable and experimental app-server schema generation on macOS arm64
  and Linux x64 produces identical recursively canonicalized JSON hashes.
  Two stable raw-file hashes differ because serialization order differs; the
  protocol shape does not.
- `/etc/machine-id` on this VPS is a root-owned, read-only, valid 32-hex
  machine ID. `/proc/sys/kernel/random/boot_id` is a valid kernel boot UUID.
- The existing service has `HOME` but no `TMPDIR`. Codex preflight will fail
  until Polygram supplies an explicit absolute temp directory to the Codex
  child only.
- Before the AppArmor prerequisite was applied, the exact harmless sandbox
  self-test
  `codex sandbox --permission-profile polygram-session -- /bin/true`
  returned `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.
  Ubuntu's AppArmor restriction on unprivileged user namespaces is active and
  no `bwrap` profile was installed. A process trace confirmed Codex reached
  `/usr/bin/bwrap` through its Linux sandbox helper. The reviewed infrastructure
  profile and stage-zero positive/negative sandbox proof have since passed;
  application release and final published-artifact gates remain in progress.
- Ubuntu provides `bwrap-userns-restrict` in
  `apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.7`. The package SHA-256
  is `bdac5b74d884643653565c52ed7483c9582e646ff72cce8d95d0eb8467a3139c`;
  the supplied profile SHA-256 is
  `11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9`.
- Restarting the current legacy Polygram unit runs
  `tmux kill-server`. That can disrupt Claude tmux sessions, the administrative
  tmux session, and Water as well as restarting both bot daemons.
- The dedicated `/home/shumabit/.codex-polygram` is already owner-only and
  authenticated. No reboot or additional login is needed for a normal
  canary.

Official identity semantics:

- [`machine-id(5)`](https://man7.org/linux/man-pages/man5/machine-id.5.html)
  defines `/etc/machine-id` as a stable local-system identifier and says raw
  IDs should not be exposed directly.
- [Linux kernel `boot_id`](https://www.kernel.org/doc/html/latest/admin-guide/sysctl/kernel.html#random)
  is generated once and remains unchanged for that kernel boot.

## Why terminal success is not the whole gate

Interactive `codex` proves that the CLI starts and the account is
authenticated. Polygram additionally needs:

1. the exact reviewed native executable that matches its embedded app-server
   protocol;
2. stable host and current-boot identities for durable ambiguity quarantine;
3. the controlled service environment used by preflight; and
4. a working Linux tool sandbox for commands started by an agent.

The first two checks are not requirements imposed by Codex. They preserve
Polygram's existing pinning and crash-recovery guarantees. The fourth is the
only current hard blocker to a useful tool-running VPS canary.

## Chosen design

### 1. One target-aware Orchestra runtime pin

Add an exact native-binary checksum map to Orchestra's protocol schema:

```text
aarch64-apple-darwin       -> existing macOS arm64 checksum
x86_64-unknown-linux-musl  -> verified Linux x64 checksum
```

Add and export one pure resolver that maps Node host identity to the reviewed
target:

```text
darwin + arm64 -> aarch64-apple-darwin
linux  + x64   -> x86_64-unknown-linux-musl
anything else -> CODEX_UNSUPPORTED_PLATFORM
```

The resolver returns one immutable receipt:

```text
{ target, cliVersion, binarySha256 }
```

Every Orchestra binary-attestation, client-start, and preflight comparison
uses that same receipt. Canonical path, ownership/mode, executable bit,
single-link, full-file hash, exact `--version`, and pre/post-spawn fingerprint
checks remain unchanged.

Keep target resolution lazy. Importing Orchestra, creating a Claude-only
Polygram configuration, or running on an unsupported host must not fail until
Codex is actually selected. Validate the map's shape at module load, but
resolve the current host only at the Codex boundary.

For public-schema compatibility, retain the existing scalar
`binarySha256` as a deprecated macOS-arm64 provenance field and add
`binarySha256ByTarget` for new consumers. Orchestra's own runtime must never
use the deprecated scalar. Remove it only in a later announced breaking
release.

Continue launching the canonical native executable directly. Do not accept the
global npm symlink or JavaScript launcher, add `@openai/codex` as an Orchestra
dependency, or infer a binary from npm's directory layout.

The shared canonical protocol hash remains shared because the generated
schemas match semantically. Spike provenance records target-specific raw JSON
hashes for the deterministic `ClientRequest` and legacy protocol files where
serialization differs. The v2 bundles are compared only through their shared
recursively canonical hashes because definition emission order is
nondeterministic. Both supported targets remain pinned to Codex 0.145.0; this
plan does not introduce per-target CLI versions.

### 2. Polygram consumes Orchestra's pin

Polygram's binary resolver obtains the current reviewed target/version/hash
from Orchestra rather than duplicating a second platform hash table. The
existing test factory can still accept explicit fixture pins.

`darwin/arm64` behavior remains byte-for-byte compatible. `linux/x64` becomes
accepted. Linux arm64, Darwin x64, Windows, unknown architectures, wrong
target hashes, PATH-only names, symlinks, unsafe parents, hard links, and
replacement races fail closed.

Translate Orchestra's unsupported-target error to Polygram's existing
`CODEX_BINARY_PLATFORM_UNSUPPORTED` diagnostic. Requiring either package on
an unsupported host remains safe for Claude; the error appears only if Codex
is selected.

Runtime-profile and doctor comparisons use the selected receipt rather than a
macOS-global checksum. No Claude selection, process, persistence, or callback
path changes.

### 3. Linux host and boot identity

Extend `resolveCodexHostIdentity()` with fixed, injected reads:

```text
/etc/machine-id
/proc/sys/kernel/random/boot_id
```

Accept only the documented bounded canonical formats, with at most one
trailing newline. Reject empty, uninitialized, all-zero, malformed,
oversized, missing, or unreadable sources. Never fall back to hostname,
service invocation ID, daemon-start randomness, or `/proc/stat` boot time.

Freeze the Linux persistence ABI at the byte level:

```text
machineBytes = decodeHex(normalized 32-lowercase-hex machine ID)
bootBytes    = decodeHex(normalized boot UUID with hyphens removed)

stable = HMAC-SHA256(
  key=UTF8("polygram/codex/stable-host/linux/v1"),
  data=machineBytes
)
boot = HMAC-SHA256(
  key=UTF8("polygram/codex/boot-session/linux/v1"),
  data=machineBytes || bootBytes
)
```

Persist and log only:

```text
host:<64 lowercase hex>
boot:<64 lowercase hex>
```

Keep the existing Darwin derivation exactly unchanged because its output is a
persistence ABI. The database, reconciliation, runtime controller, and doctor
already treat both projections as opaque values and need no schema change.

The Linux golden fixture is:

```text
machine ID: 0123456789abcdef0123456789abcdef
boot UUID:  11111111-2222-4333-8444-555555555555
stable:     host:b31d5ae71acd368ab2297814cf7c483ade00dfa4be7ab8d3faf2e67e57418734
boot:       boot:f8f5ef453e1c98731241349e6f816e044a7389ac5427d29de593d884a6316d09
```

Tests also freeze the existing Darwin fixture:

```text
stable: host:dda4442821794ae69a907e13696600e96a9174cbda56ce219901431858328bc6
boot:   boot:81629cacb5d6654afafea27d0497fefa7c03bc7bba7ae08d966179b037ae42e5
```

For this normal systemd-managed VM, the machine ID is the stable host boundary.
A cloned image that copies both the database and machine ID could defeat
relocation detection; cloned/container rollout is explicitly outside this
canary.

### 4. Supply a Codex-only private temp directory

Provision `/run/polygram-codex` with systemd
`RuntimeDirectory=polygram-codex` and `RuntimeDirectoryMode=0700`, owned by
the service UID. Set
`POLYGRAM_CODEX_TMPDIR=/run/polygram-codex` on the service.

Polygram resolves the Codex temp directory from
`POLYGRAM_CODEX_TMPDIR`, falling back to the inherited `TMPDIR` for existing
macOS installations. It validates the canonical owner-only directory, adds it
to the daemon-secret roots, and injects it as `TMPDIR` only into the Codex
app-server child. It must not mutate `process.env` or the environment inherited
by Claude SDK/CLI children.

Keep the fail-loud requirement. The selected path must be outside the
workspace and `CODEX_HOME`, must not be a symlink, and is always denied to
agent-started commands.

### 5. Enable Codex's existing Linux sandbox

Install the exact Ubuntu-provided `bwrap-userns-restrict` AppArmor profile
described under Verified facts, and preserve its source in the VPS
infrastructure repository with the package/profile checksums. Assert that
local include overrides are absent or inert. Keep the global
unprivileged-user-namespace restriction enabled.

The profile is purpose-built to let bubblewrap set up its private namespaces
and strip capabilities from the child. It attaches to `/usr/bin/bwrap`, so it
applies to every caller of that executable on this single-user host, not only
Polygram. That host-wide scope is accepted for this canary. Do not attempt to
confine the entire legacy Polygram unit: doing so would also pull Claude,
tmux, and Water into a separate confinement project.

The profile must be reviewed in the VPS infrastructure repository and loaded
before any Polygram Codex route is enabled. It must not grant
`danger-full-access`, disable AppArmor globally, change the Codex permission
profile, enable command network, or expose daemon/Codex credential roots.

The acceptance gate is the exact existing permission profile successfully
running `/bin/true`, followed by negative filesystem, process, IPC, and
network checks. Record the executable actually invoked and require
`/usr/bin/bwrap`; do not silently accept a bundled fallback.

## Data flow

```text
Polygram config
  -> Orchestra target pin(platform, arch)
  -> Polygram canonical native-binary attestation
  -> Linux stable-host/current-boot projection
  -> existing Codex recovery reconstruction
  -> existing owned profile + authenticated preflight
  -> Orchestra client re-attests the same target pin
  -> direct native app-server under the existing supervisor
  -> Ivan's configured private Telegram chat
```

The existing daemon-wide one-live-generation lease and same-host/new-boot
quarantine semantics do not change.

## Concrete changes

### Orchestra

- `lib/codex/protocol-schema.json`
  - add the two exact target hashes while retaining the deprecated legacy
    scalar;
  - keep one CLI version and one canonical protocol pin.
- `lib/codex/app-server-client.js`
  - validate the exact target map;
  - add/export lazy target resolution;
  - use the target receipt in attestation and start consistency checks.
- `lib/codex/preflight.js`
  - compare the expected profile against the current target receipt.
- `index.js`
  - export the target-pin resolver.
- Codex client/preflight/factory/process tests
  - select fixture receipts through the resolver;
  - prove exact accepted and rejected platform/architecture combinations;
  - prove importing Orchestra and a Claude-only caller on an unsupported
    target does not throw;
  - preserve all unsafe-path and TOCTOU tests.
- Real-runtime manifest/checker and compatibility documentation
  - record Linux artifact provenance;
  - distinguish target-specific raw schema serialization from shared canonical
    protocol identity;
  - add mandatory Linux replacements for the macOS-only credential and
    same-user isolation probes rather than skip-passing them.

Every former consumer of the scalar pin moves to the receipt: app-server
attestation/start, preflight, the real-runtime checker, and their client,
preflight, process, and factory tests.

### Polygram

- `lib/codex/binary.js`
  - accept only the two reviewed targets using Orchestra's resolver;
  - keep all existing filesystem and race checks.
- `lib/codex/runtime-profile.js` and `lib/codex/diagnostics.js`
  - compare against the selected target receipt;
  - resolve and validate the Codex-only temp directory.
- `lib/codex/host-identity.js`
  - add the Linux fixed-source identity path while preserving Darwin output.
- Codex process/factory environment assembly
  - pass the selected path as `TMPDIR` only to the Codex child;
  - include it in protected daemon roots.
- `package.json` and `package-lock.json`
  - pin the exact newly released Orchestra version before the Polygram suite.
- `lib/handlers/config-ui.js`
  - change the beta description from macOS-specific wording to
    platform-neutral “native Codex beta.”
- Focused binary, identity, runtime-profile, doctor, prompt, and integration
  tests.
- `config.example.json`, `docs/FEATURES.md`, operational documentation, and the
  Codex system prompt
  - describe the macOS/Linux native beta accurately;
  - retain the background-process/quarantine limitation.

Historical accepted plan documents remain historical and are not rewritten.
This plan records the Linux extension.

### VPS infrastructure/configuration

- Add the exact Ubuntu `bwrap-userns-restrict` AppArmor profile in the
  infrastructure source of truth and load it.
- Provision the private systemd runtime directory and configure
  `POLYGRAM_CODEX_TMPDIR`.
- Keep the exact native Codex path and dedicated authenticated
  `/home/shumabit/.codex-polygram`.
- Add `pm:"codex"` only to Shumabit bot chat `68861949` after every preflight
  gate passes. This is Ivan's private DM, not a group/topic; the existing
  allowlist must identify Ivan.

## Failure behavior

- Unsupported host/architecture, wrong executable, schema mismatch, missing
  identity, unsafe credentials, missing `TMPDIR`, sandbox failure, auth/model
  failure, or policy drift disables Codex before a turn. Claude traffic stays
  unchanged.
- A state-changing Codex request with unknown outcome retains the existing
  durable daemon-wide quarantine. It is never auto-replayed.
- A normal Linux canary does not require a reboot.
- If a future hard loss creates containment quarantine, immediately return the
  canary route to Claude and investigate. Do not force-clear quarantine or
  reboot as an automatic canary step.
- The native beta still cannot prove arbitrary deliberately daemonized
  descendants dead after app-server loss. Broad Linux rollout still requires
  the separately planned per-session systemd/cgroup containment work.
- This narrow owner-only canary accepts residual host resource-exhaustion risk:
  AppArmor/bubblewrap do not provide memory or task limits. Per-session cgroup
  containment remains deliberately out of scope; if that risk is not
  acceptable, it becomes a prerequisite and materially enlarges this change.

## Verification

### TDD and automated tests

1. Add tests that fail on current releases:
   - Linux x64 exact artifact is rejected;
   - Linux identity is rejected;
   - opposite-target hash and unsupported architectures fail closed.
2. Implement the smallest target/identity changes.
3. Re-run the same tests green, then both complete package suites with zero
   failures and no new or unexpected skips. Report any baseline skips.
4. Preserve explicit Claude non-regression coverage.

Identity tests freeze the existing Darwin projection and cover Linux
stability, new boot, new machine, raw-value redaction, invalid formats,
missing files, source separation, and Windows rejection. Existing DB tests
continue proving same-boot quarantine, same-host/new-boot release, and
different-host fail-closed behavior.

### Stage-zero Linux sandbox proof

Before writing or releasing application code:

1. Add the exact Ubuntu AppArmor profile and checksums to the infrastructure
   source of truth, apply it, and confirm no local include overrides alter it.
2. Keep `kernel.apparmor_restrict_unprivileged_userns=1`, and prove a direct
   unprofiled `unshare --user --map-root-user /bin/true` still fails.
3. As the Polygram service user with the exact `HOME`, `CODEX_HOME`, and
   Codex temp path, require the existing
   `sandbox --permission-profile polygram-session -- /bin/true`
   self-test to pass through `/usr/bin/bwrap`.
4. Require AppArmor to report both profile stages loaded and no relevant audit
   denial during the self-test.
5. Run early negative workspace/secret/process/socket/network probes. If the
   positive or any negative check fails, stop before Orchestra work and revert
   the profile through the infrastructure source of truth.

This changes no Polygram route and starts no Codex Telegram session.

### Bounded VPS gates

Before changing Polygram routing:

1. Attest the official native path, target, version, checksum, ownership, mode,
   link count, and npm provenance.
2. Re-run the exact sandbox `/bin/true` self-test in the final service
   environment and record `/usr/bin/bwrap` as the executable used.
3. Require workspace write success while denying all of:
   - dedicated and generic Codex homes, `.claude`, `.ssh`, Polygram
     configuration/database/IPC, `/run/shumabit-secrets` where present, and
     `/run/polygram-codex`;
   - `/proc/<daemon-pid>/environ`, `cmdline`, and file descriptors;
   - ptrace/process-memory inspection and inherited-descriptor recovery;
   - Polygram Unix sockets, loopback TCP, DNS, and external network.
   Use synthetic secret sentinels and never log their contents. Host-side
   positive controls must prove the targets were actually available. An
   unsupported Linux security probe is a stop condition, never a skipped pass.
4. Require owner-only `/run/polygram-codex`, dedicated
   `/home/shumabit/.codex-polygram`, and authenticated configured
   `gpt-5.6-sol` with `xhigh` effort. The exact workspace is
   `/home/shumabit/shumabit-claude`; every credential, daemon-secret, and temp
   root must be outside its writable boundary.
5. Run the direct native app-server checker as the service user:
   schema, first turn, stable resume, two ordered steers, interrupt,
   background clean/list-empty, and supervisor exit.

Only then:

6. Create an atomic owner-only mode-0600 configuration backup outside every
   Codex workspace, temp directory, and credential home. Attest its path,
   owner, mode, and link count; never log its contents.
7. Re-check the live unit topology and wait for a quiet window with no active
   turns. Explicitly accept that restarting the legacy unit kills the shared
   tmux server and can interrupt Claude tmux, the administrative session, and
   Water.
8. Configure only Shumabit bot chat `68861949` with:

   ```json
   {
     "pm": "codex",
     "codexModel": "gpt-5.6-sol",
     "codexEffort": "xhigh",
     "cwd": "/home/shumabit/shumabit-claude"
   }
   ```

9. Restart once. Require both bot IPC endpoints, Claude SDK and CLI health, the
   expected administrative tmux session, and Water health. Then verify one
   Codex text reply with workspace write, one mid-turn steer/interrupt, and
   one resumed follow-up.
10. Inspect bounded structured diagnostics/events without logging prompts,
   credentials, file contents, machine ID, boot ID, or command strings.

The initial canary is complete when all enumerated Telegram scenarios pass
once, diagnostics contain no hard-gate event, and Claude/Water checks remain
green. A longer 24-hour observation is required only before enabling Codex for
any additional chat.

### Rollback

Rollback changes only future inbound routing. It never replays or transfers an
ambiguous Codex input to Claude and never deletes or clears attempt, lease,
provider-thread, quarantine, or incident records; existing supervisor and boot
reconciliation remain authoritative for the prior generation.

Restore the protected backup atomically and restart the legacy service once,
using the same quiet-window and post-restart blast-radius checks. Do not
downgrade packages. Leave the AppArmor profile installed only if its standalone
sandbox and negative-security gates remain green; otherwise revert it through
the infrastructure source of truth. Remove the backup after the accepted
rollback window.

## Dependencies and sequencing

1. Review and approve this plan.
2. Prove the AppArmor prerequisite and Linux negative-security gates on the
   VPS while Codex routing remains disabled.
3. Implement/review/release Orchestra target-aware pins.
4. Implement/review Polygram against that exact Orchestra release, including
   the Codex-only temp contract.
5. Apply/review the systemd runtime-directory configuration and pass the final
   direct Linux security/session gates.
6. Release the then-current Polygram version; never deploy below the latest
   main/released line.
7. Enable the single private-DM canary and complete the bounded scenarios.

The critical path is AppArmor sandbox proof -> Orchestra pin release ->
Polygram consumption/release -> final direct app-server gate -> private-DM
canary.

## Effort estimate

Engineer-days below include implementation, focused tests, independent review,
and bounded fixes. They exclude waiting for CI or release propagation.

| Phase | Repository/host | Best | Likely | Worst |
|---|---|---:|---:|---:|
| AppArmor and service-context sandbox proof | VPS infrastructure | 0.5 | 1.0 | 2.0 |
| Target pin, schema, checker compatibility, release | Orchestra | 1.0 | 1.5 | 2.5 |
| Linux identity, Codex-only temp, pin consumption, UI/tests | Polygram | 1.5 | 2.5 | 4.0 |
| Linux same-user security checker and final direct gates | Orchestra + VPS | 1.0 | 2.0 | 3.0 |
| Polygram release, quiet-window restart, canary/rollback proof | Polygram + VPS | 0.5 | 1.0 | 2.0 |
| **Total** |  | **4.5** | **8.0** | **13.5** |

The largest worst-case driver is a failed Linux same-user isolation probe. If
the current Codex sandbox cannot deny a required `/proc` or local-IPC path
without broader containment, implementation stops and per-session
systemd/cgroup isolation becomes a separately approved prerequisite.

## Alternatives rejected

- **Trust `codex --version` only.** It accepts a replaced executable that
  prints the expected string and weakens the existing reviewed-runtime
  contract.
- **Run `/usr/bin/codex` or the npm JavaScript launcher.** It adds a mutable
  selection layer and does not attest the native executable actually spawned.
- **Disable AppArmor's user-namespace restriction globally.** It expands the
  privilege surface for every unprivileged process on the host.
- **Use `danger-full-access`.** It contradicts the accepted secret, workspace,
  and network boundary.
- **Add cgroups/containers before this canary.** They are credible broad Linux
  hardening, but unnecessary to test one owner-controlled private chat under the
  existing reboot-fenced native-beta limitation.
- **Stop after a direct VPS smoke.** This is a useful intermediate gate and
  the safest fast proof, but it does not validate Telegram routing,
  persistence, replay, or steering end to end.

## Approval decisions

Ivan needs to approve:

1. Linux x64 only, with macOS arm64 unchanged.
2. The official host-wide `/usr/bin/bwrap` AppArmor profile while retaining the
   global unprivileged-user-namespace restriction.
3. Shumabit bot chat `68861949` as the first VPS canary under the existing
   native-beta quarantine and residual resource-exhaustion limitations.
4. One quiet-window restart that may disrupt the shared tmux server, followed
   by the explicit Claude, Water, and bot health checks.
5. Broad Linux/per-session cgroup containment remains a separate later change.
