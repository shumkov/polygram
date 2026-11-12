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
