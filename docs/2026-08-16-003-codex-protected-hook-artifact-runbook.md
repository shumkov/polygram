# Codex protected hook artifacts — build, install, upgrade, retire

Codex hook trust is content-addressed over the hook's **command string**, and a
command string names paths, never bytes. A trust stanza therefore certifies
nothing about what actually executes unless the paths it names are unwritable by
the account that runs the sessions. This runbook covers the tree that makes them
unwritable, the one artifact Polygram ships into it, and the operations that
keep it honest.

Everything here is host provisioning plus one deterministic build. It does not
enable hooks anywhere: hook enablement is a separate, later change, and until it
lands an installed artifact tree changes nothing about how Codex runs.

## The protected closure

Exactly three things are executed or read on a hook fire, and all three are
attested before every use:

1. **the protected Node runtime** — an operator-owned canonical executable under
   a versioned runtime root,
2. **the hook bundle** — one self-contained file, built from checked-in sources,
3. **the digest manifest** — rendered from the trusted closure declaration, and
   compared byte for byte against what is installed.

The closure is **generated, never authored**: the installer derives it from the
shipped build output. There is no option, flag, or argument that lets a caller
name a body, add a member, or drop one.

### How the bundle is confined

**The mechanical gate is a syntax policy over the checked-in sources**, not the
emitted facades. A facade is a convenience for code that already passed the
gate: any function value hands back the host realm through
`writeFileSync['constructor']`, and the property name can be assembled at run
time, so no textual scan and no wrapper can stop a source that wants out. The
build step therefore parses each source and accepts only:

- an enumerated set of syntax nodes — no classes, `this`, tagged templates,
  sequence expressions, `import()`, or module syntax,
- an enumerated set of free identifiers, resolved **lexically** against the
  scope chain, so a binding introduced in one function or block cannot vouch
  for an ambient name at a use site it never covers; an unresolved identifier
  outside the allowlist is a refusal, so `globalThis`, `global`, `Reflect`,
  `eval`, `Function` and `__dirname` cannot be named at all,
- non-computed member access only, except a numeric index; `constructor`,
  `prototype`, `__proto__`, `call`, `apply` and `bind` are refused by name, as
  are loader, child-process and external-read members wherever they appear,
- a **positive member policy on ambient intrinsics** — `Object`, `JSON`,
  `Buffer`, `Date` and friends carry only the members listed for them, so
  `Object.getOwnPropertyDescriptor`, `Object.getPrototypeOf` and
  `Object.getOwnPropertyNames` are refused rather than reasoned about,
- destructuring only of an import binding or a parameter, never of an
  arbitrary value, and never of a denied property name — lifting `constructor`
  off a function through a pattern is closed the same way member access is,
- `require` of an exact allowlisted specifier in a plain binding declaration,
  with each imported member checked against that facade's exact surface.

The policy governs the **checked-in sources this repository builds**. It is not
a general sandbox for arbitrary JavaScript, and it makes no claim about code
that reaches the tree by any other route.

The emitted bundle then hands each module a frozen facade as defence in depth:

- `require` is a facade loader over a **closed member-level allowlist** —
  `node:crypto.createHash`, `node:fs.writeFileSync`, `node:path.join`. There is
  no read API in the closure at all, and no `child_process` to reach.
- The raw loader is never bound to a name. It is called once, in the argument
  list of the wrapper, outside the scope any module body runs in.
- `process` is a curated object (`argv`, `pid`, `setExitCode`, `stdin`), so
  `process.getBuiltinModule`, `process.binding`, `process.env` and
  `process.mainModule` are absent by construction.
- `globalThis`, `global` and `Function` are bound to `undefined` inside every
  module body.

The emitted file is additionally checked so that no specifier outside the
closure ever reaches the real loader.

**The explicitly trusted boundary is the operating system.** The dynamic loader
and the shared libraries the runtime links against are root-owned on both
targets and are *not* attested here. An attacker who can replace them already
owns the host.

**What the checks can and cannot see.** Ownership and POSIX mode bits only.
ACLs, extended attributes, and mount options are not inspected, so a passing
attestation is a necessary condition for unwritability, not a proof of it.

## Layout

```
<artifact-root>/                     operator-owned, service-unwritable
  artifact-root.json                 marker proving this tree is ours
  1.0.0/                             one directory per released version
    hook-observer.js                 the bundle, mode 0644
    manifest.json                    the generated digest manifest, mode 0644
  quarantine/1.0.0/1/                retired closures, one dir per retirement
<runtime-root>/
  node-24.4.0/bin/node               the protected runtime, mode 0755
```

Requirements enforced by attestation, each of which fails closed:

- every path is **absolute and canonical**; an alias, a relative path, or a
  `PATH`-resolved name is refused,
- no component of the chain is a **symlink** — there is no `current` alias, and
  a version or runtime identity of `current` / `latest` / `stable` is refused,
- every canonical **ancestor** up to `/` is owned by root or by the **operator
  uid the caller configured** (never read from the tree), is not
  service-writable, and is traversable by the service account,
- **closed mode sets**: directories `0755`/`0555`, members `0644`/`0444`,
  runtime `0755`/`0555`. A `0700` runtime is refused — a distinct service
  account could not execute it — and a setuid, setgid, or sticky bit is
  refused anywhere in the chain, on any file, directory, or runtime,
- every **version-shaped entry** in the root is a real version directory; a
  file or a symlink wearing a version name fails the run closed,
- each file is a **regular file with `nlink === 1`**, digest-equal to the
  **checked-in declaration** (not to the manifest beside it),
- the version directory contains **exactly** the declared closure,
- the manifest **byte-equals a rendering from the trusted expectation**.

A digest in a filename is a label, not a permission: a digest-named file in a
service-writable tree is refused, because the account that can write the tree
can replace the file between verification and execution.

## Build

```sh
polygram-build-codex-hook-bundle            # regenerate the bundle
polygram-build-codex-hook-bundle --check    # drift gate, exits 1 on drift
```

From a checkout, the same commands are
`node scripts/build-codex-hook-bundle.js [--check]`. The bundle at
`lib/codex/hooks/hook-observer.bundle.js` is checked in and is a pure function
of `lib/codex/hooks/observer-*.js`. Editing a source without rebuilding is a
review-visible failure: `--check` exits non-zero, the test suite fails, and the
installer refuses to install the stale bundle.

## Install a version

Run as the operator or root — **never as the service account**, which the
installer refuses outright. Installs on one artifact root are serialized by an
exclusive lock, and `--runtime-sha256` is mandatory: the expected runtime digest
comes from configuration, never from the tree.

```sh
polygram-codex-hook-artifacts install \
  --artifact-root /opt/polygram/codex-hooks \
  --version 1.0.0 \
  --runtime-root /opt/polygram/runtime \
  --runtime-id node-24.4.0 \
  --runtime-sha256 <expected 64 hex> \
  --operator-uid <operator uid> \
  --service-uid <service uid>
```

The first install on a root claims the marker, and it does so **only on a
directory dedicated to hook artifacts** — an otherwise empty one. An existing
directory with unrelated contents is never claimed, marked, or cleaned.

The install stages into a temporary directory inside the artifact root, renames
it into place, and then attests what landed; it prints the receipt it verified.
**Record `runtime.sha256` from that receipt into deployment configuration** —
every later attestation requires it as the expected runtime digest.

A staging directory is cleared only after the root marker is verified, and only
when its name is exactly the one this version would have used; anything else
with the staging prefix stops the install rather than being reclaimed. Staging
is created private (`0700`) and each member is written with an exclusive,
no-follow create; the final modes and the publishing rename happen only after
every member is in place, so a half-written version is never visible under its
final name.

**Durability is availability here, not integrity.** There is no fsync layer: a
power loss can leave a staging directory or a partly written file behind. The
next run fails closed rather than trusting it — attestation refuses anything
that does not match the declaration — and the leftover staging is recoverable
by the operator. A new durability subsystem is deliberately out of scope.

### A held lock is never reclaimed automatically

A lock file records the holder's pid and a unique token, and release verifies
that token — a run never removes a lock that is no longer its own. There is no
liveness-based reclaim: a pid can be reused, and a lock cannot prove which run
created it, so an existing lock always fails the run closed with
`CODEX_HOOK_ARTIFACT_LOCKED`.

**Recovering a stuck lock is a deliberate operator act.** Confirm no install,
attestation, or retirement is running against that root — check the recorded pid
on the host — then, as the account that owns the tree, remove
`<artifact-root>/install.lock` and re-run the command. Never remove it from the
service account, and never as part of an automated retry.

Verify at any time, from any account:

```sh
polygram-codex-hook-artifacts attest \
  --artifact-root /opt/polygram/codex-hooks --version 1.0.0 \
  --runtime-root /opt/polygram/runtime --runtime-id node-24.4.0 \
  --runtime-sha256 <expected 64 hex> \
  --operator-uid <operator uid> --service-uid <service uid>
polygram-codex-hook-artifacts list --artifact-root /opt/polygram/codex-hooks
```

## Upgrade

A new bundle is a **new version directory**. Versions are never overwritten in
place — a second install of an existing version is refused — because a session
that is already running holds the version it started with, and rewriting it
under that session swaps executed bytes without changing any digest anyone
checked.

The runtime obeys the same contract: a runtime upgrade is a **new runtime
identity** under the runtime root. One identity may never denote two different
binaries, and an in-place swap under an existing identity is refused by the next
install.

Because trust is content-addressed over a command string that embeds absolute
paths, **every path change invalidates every hook hash**: a new artifact version,
a new runtime identity, or a moved capture root all require reprovisioning each
hook-enabled Codex home. That is planned work, not self-healing.

## Retire a version

```sh
polygram-codex-hook-artifacts quarantine \
  --artifact-root /opt/polygram/codex-hooks --version 1.0.0 \
  --runtime-root /opt/polygram/runtime --runtime-id node-24.4.0 \
  --runtime-sha256 <expected 64 hex> \
  --operator-uid <operator uid> --service-uid <service uid> \
  --referenced 1.1.0,1.2.0
```

Retirement **moves** the version into `<artifact-root>/quarantine/<version>`;
nothing is deleted. The version must attest first, so only a recognized closure
in a marked artifact root can be touched at all, and a directory that merely
looks like a version tree is never moved.

The exact root marker is verified **before** a lock file is written into the
tree — an unmarked directory is never even locked — and the root lock is then
held across the attestation and the rename, so nothing can be swapped between
the two.

**Precondition, owned by the runtime integration, not by this tooling:** close
admission for the version first. Retirement verifies what is on disk and moves
it; it cannot see, and does not coordinate with, a session that activates a
version between the attestation and the rename. The integration that enables
hooks must retire the sessions holding a version — and stop new ones from
starting against it — before retirement runs. This runbook does not add a state
machine for that.

`--referenced` is mandatory and lists every version still referenced by a live
session or an installed configuration; pass `--referenced ''` only when the
answer is genuinely none. Retiring a referenced version is refused. Because that
list cannot be verified from here, quarantine is deliberately recoverable: to
restore, move the directory back out of `quarantine/` and re-attest. Deleting a
quarantined version stays a manual operator decision.

**A retired version id is spent, exactly.** Retirement moves the closure to
`quarantine/<version>/<n>`, so the retired identity reads back as the name it
had — `1.0.0-1` and `1.0.0` are different ids and neither reserves the other.
Reinstalling a retired name is refused (`CODEX_HOOK_ARTIFACT_VERSION_RESERVED`),
so a session still holding that version can never be pointed at different bytes
under the same name. Release the next change under a new id.

A quarantine that cannot be read, or that holds anything other than retired
version directories, fails every install and attestation closed rather than
quietly freeing an id for reuse. Retired manifests also stay in the
runtime-identity history, so a retired closure still forbids its runtime id
denoting different bytes.

## Failure modes

| Code | Meaning | First move |
| --- | --- | --- |
| `CODEX_HOOK_BUNDLE_UNSAFE_SOURCE` | a source (or the generated bundle) reaches outside the closure | fix the source; the closure is not negotiable |
| `CODEX_HOOK_BUNDLE_INVALID` | the declared source set, entry, or checked-in bundle is stale | rebuild in the same change as the sources |
| `CODEX_HOOK_ARTIFACT_UNSAFE` | ownership, mode, symlink, or ancestor chain fails the boundary | fix host provisioning; do not relax the rule |
| `CODEX_HOOK_ARTIFACT_MISMATCH` | a digest, the manifest, the marker, or the runtime binding disagrees — including a sibling version whose manifest is unreadable | repair the tree; attestation never reads past damage |
| `CODEX_HOOK_ARTIFACT_MISSING` | version, marker, manifest, or runtime absent | install or provision it |
| `CODEX_HOOK_ARTIFACT_INVALID` | non-canonical root, alias version or runtime id, missing uid or digest | correct the configuration |
| `CODEX_HOOK_ARTIFACT_VERSION_EXISTS` | the version is already installed | release a new version |
| `CODEX_HOOK_ARTIFACT_VERSION_REFERENCED` | a live session still names the version | retire the sessions first |
| `CODEX_HOOK_ARTIFACT_LOCKED` | a lock file exists, a live staging directory blocks the root, or the lock was replaced mid-run | confirm no run is in flight, then clear the lock by hand |
| `CODEX_HOOK_ARTIFACT_VERSION_RESERVED` | the version id was retired already | release under a new id |
| `CODEX_HOOK_COMMAND_INVALID` | descriptor path or argument is unsafe, or an argument is untyped | fix the descriptor; nothing is quoted around a bad token |
| `CODEX_HOOK_COMMAND_UNATTESTED` | a descriptor path — including one in an argument — is not in the attested closure, or the receipt is not a live attestation | attest the version the command names, and render from that receipt |

### Command arguments are typed

A rendered command is built from a descriptor whose arguments are typed, so a
token's meaning is declared rather than guessed from its spelling:

- `{ kind: 'literal', value: 'SessionStart' }` — a word with no path separator
  in it at all,
- `{ kind: 'attested-path', path: '/…' }` — an absolute canonical path that
  must already be in the attested closure.

There is no bare-string form and no relative-path ambiguity: a literal that
contains a separator is refused, and a path argument outside the closure is
refused. Rendering also requires the receipt object a full attestation
returned — identity, not a shape — so a copy, a clone, or a forwarding proxy
cannot authorise a command.

If the boundary cannot be installed on a host — any ancestor writable by the
service account, any executed input outside the tree, any manifest mismatch —
hooks cannot be enabled there. Codex itself is unaffected; only hook enablement
is refused.

## What this does not cover

- **Enabling hooks**, rendering `hooks.json`, the trust stanza, provisioning
  state, and rollback: a later change owns those.
- **A writable capture root.** Every path in a rendered command, arguments
  included, must be in the attested closure, so a hook that writes captures
  needs its capture root brought inside the boundary — or its descriptor
  reshaped — before that command can be rendered.
- **The memory wrapper and `stop.sh`.** They are not built or installed here.
  Building them through this same build step and proving their generated closure
  is a prerequisite for enabling memory; `stop.sh` shells out by nature, so its
  inputs must come inside the tree or that design must change.
- **Creating the root-owned tree itself.** Polygram attests and fails closed; it
  cannot create root-owned infrastructure. That is host provisioning on both the
  Mac and the VPS.
