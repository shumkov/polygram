# Claude consumer update after Polygram 0.46.0 publication

Orchestra0.12.1 is published through PR71, merged main/tag source
8457bd601269396e167cafa12747e255e51814eb. Signed annotated tagv0.12.1 points to
that commit; release workflow43220554574 succeeded through npmOIDC and GitHub
release. Authoritative registry metadata, SHA512/SHA1 and every one of57tarball
files were verified against the reviewed merged source. Exact npm integrity:
sha512-6OEVR60rzm9QHrd4w1MBO2PcQaL2PktjNgF/W8tkQpv4/g7ghWfv3wMEMGS5YWI9OF8uQhG7V9lj5FOKW+11nA==

Published artifact: https://registry.npmjs.org/@shumkov/orchestra/-/orchestra-0.12.1.tgz
Release: https://github.com/shumkov/orchestra/releases/tag/v0.12.1
Related tracking issue: https://github.com/shumkov/polygram/issues/133 (stays open).

The actual published package was freshly installed with scripts disabled in a
separate credential-free disposable project: Orchestra0.12.1, SDK0.3.322,
claudeCodeVersion/CLI2.1.322, same physical hoisted SDK, accepted SDK/runtime/binary
hashes and native --version verified. Released Codex0.167.2 pin is unchanged.
This is artifact/metadata proof, not Polygram consumer/deployment/inference proof.

## Ready local work and concrete dependency

Bounded ownership fix0664a00 and aligned .322pinsf9ef1b8 are included in the actual
Orchestra release; full combined local suite1614PASS/19existing skips, PR CI and
release strict gate succeeded. Accepted original matched matrix remains23/23;
strict focused traces stay INCONCLUSIVE, with no further provider loop required.

This child retains signed gate6cceb3b and signed consumer identity contract commit
4c9fcc59d2188c5639df12c2abe268970a915b46. The latter reads actual installed SDK
metadata and same physical root/Orchestra resolution; its current.283pair checks
pass3/3with0skips. Dependencies/package release version remain unchanged; no fake
future release or incoherent SDK-only consumer bump. Parent piddock is untouched.

Coordinator must supply the actual released Polygram0.46.0 base before consumer
merge/version/publication. Once supplied, integrate that exact base in this owned
child preserving work, then update ONLY exact Orchestra0.12.1 and SDK0.3.322,
regenerate package-lock with scripts disabled, and set the dependency contract's
REQUIRED_ORCHESTRA_VERSION to0.12.1 while preserving the released base's Codex
pin/feature assertions. Do not copy the old0.145.0 assertion over the new0.167.2
contract. Independently review the actual dependency/lock/integration delta and
run the contract plus directly affected SDK consumer tests before release.

Concrete dependency update command, ONLY after that released-base integration:

```fish
npm install --ignore-scripts --save-exact @shumkov/orchestra@0.12.1 @anthropic-ai/claude-agent-sdk@0.3.322
node --test tests/orchestra-dependency-contract.test.js
```

Old SDK source is additionally archived outside updater/vendor GC with verified
entry/package hashes, before any future child dependency install; the original
matrix child SDK remains untouched. Baseline/candidate native binaries remain
preserved offline separately. This archive is source preservation, not a portable
full dependency install. No failed or INCONCLUSIVE artifact is relabelled.

No consumer version/tag/merge/publication or deployment was performed. No new
provider call. Coordinator owns required24hSDKstaging on shumorobot then coordinated
VPS rollout/24hCLIsoak, preserving Linux rollback binary before vendor GC and
watching autosteer-match-miss, autonomous-wakeup-message and tool-only-completion.

## Released 0.46.0 integration amendment

Coordinator now supplies actual published Polygram0.46.0 main/tag base
f401ba44489925f7861f07b72db51288ebe4968b (PR134, OIDC43219636597), ending the
consumer source integration/PR/CI/merge hold. Fresh main API and public npm
package polygram both confirm0.46.0, and0.46.1 is absent; choose patch0.46.1.
This worker MUST NOT tag, publish or deploy Polygram. The canonical helper owns
publication and staging; coordinator owns both24hsoaks and active production
Codex work. No production operations occur here.

Research: released base changes only12files: Codex controller/profile and tests,
a new Codex spike/spec, dependency contract Codex0.167.2 hashes, package/plugin
0.46.0 and Orchestra0.12.0 metadata. It does not change Claude gate inputs or
SDK caller production code. Preserve all released Codex behavior/bytes and its
new dependency-contract assertions. The current branch is clean, with signed
consumer contract4c9fcc5/handofff9f1360 and accepted gate6cceb3b history intact.

Merge the exact released base into this related owned child with a signed
non-rewriting merge; resolve/review only actual conflicts. Then npm-install exact
Orchestra0.12.1 + SDK0.3.322 with scripts disabled, isolated npm HOME/cache and
no credentials, without touching parent piddock/dependencies. Preserve the old
SDK source archive and offline native binaries; old/current failed evidence is
immutable. Update REQUIRED_ORCHESTRA_VERSION only from0.12.0to0.12.1, retaining
the released Codex0.167.2/hash/features assertions and our generic actual-installed
SDK/CLI/physical-resolution checks. Reject unrelated npm lock drift; preserve
other production dependency pins. Alternative SDK-only bump is an incoherent
shipped pair; file tarball dependencies/invented integrity are unnecessary now
that the exact registry0.12.1 artifact is verified.

Record consumer patch0.46.1 consistently in package.json, package-lock root and
.claude-plugin/plugin.json, preserving other plugin fields; no tag. Run existing
alignment contract, directly affected SDK tests and the relevant full local unit/
integration suite once under credential-free synthetic HOME/CODEX_HOME/TMP/tmux/
vendor/version roots, E2E_REAL_CLAUDE disabled. Inspect real-test guards and boot
preflight before launch; no provider call, login mutation or production vendor GC.
Classify/resolve actual local failures only and do not repeat unaffected paid
matrix inputs; full23/23 and accepted runtime source remain unchanged. Independent
design review precedes integration; independent final code review checks exact
Codex/gate input preservation, aligned registry lock/no nested SDK, version/plugin
coherence and retained coverage. Push feature branch, PR against released main,
await CI and merge only exact reviewed head; read back authoritative main tuple
and report it to coordinator for canonical publication. No tag/publish/deploy.
