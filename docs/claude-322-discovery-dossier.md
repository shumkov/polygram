# Provisional Claude .283/.322 discovery expectations

This dossier is preparation, not observed compatibility. The separate manifest
`scripts/spikes/claude-2.1.322-discovery.json` is explicitly `discovery`: only
candidate-filtered execution is permitted, no acceptance. No provider run has
been authorized or performed. SDK stays 0.3.283. The default accepted
.220/.283 manifest remains byte-for-byte unchanged.

## Sources and unresolved expectations

The old .283 entry and all scenario/comparator definitions are copied unchanged
from the reviewed .283 manifest at consumer commit
`960b0be3b191f5a336bab8d5d6577d411c548a3a`. The following table covers every
candidate expectation key. Copying an oracle does not prove it still holds.

| Candidate key | Provisional source / reason | Required observation before acceptance |
| --- | --- | --- |
| `wrapperRequired: true` | Existing .283 provenance requirement retained conservatively | Selected native process and self-spawn wrapper evidence |
| `delayedMcpModes.default: foreground` | Prior production-path hypothesis | Real delayed tool/result lifecycle and ordering |
| `delayedMcpModes.autoBackground: background` | Intended native background contract; .283 regression waiver deliberately absent | Background completion and follow-up; failure blocks unless separately justified and reviewed |
| `passiveSessionAttachmentCounts` | Prior .283 instructions/session_context/date/credential_org/remote_session_change/environment/model/deferred_tools_record counts, each one | Exact CLI raw lifecycle, including attachment count/order allowances |
| `opusPassiveSessionAttachmentCounts.auto_mode: 1` | Prior .283 hypothesis | Actual Opus projection lifecycle |
| `projectedInsertions.cli-contract-v1.hooks` | Prior .283 hook insertion at index 9 | Actual hook/prompt and queue attribution shape; do not adjust merely to make green |
| `subagentTaskUpdated: 1` | Prior .283 hypothesis; upstream task/report changes make this especially uncertain | Task lifecycle and pending-turn attribution, including empty queued results |
| `taskReminderInsertions: 1` | Prior .283 hypothesis | Exact task reminder count and parser-removal evidence |
| `resolvedOpus: claude-opus-5-5` | Prior .283 resolution hypothesis | Real alias resolution, independent observed model hints, nested Workflow evidence |
| `workflowSizeGuideline: medium` | Candidate bytes describe medium default, small for Pro | Approved account must actually meet the declared context; do not fabricate plan/account status |
| `workflowSizeGuidelineAnchors` | Six exact candidate byte strings, including new session-start latch | Re-attest executable hash and re-derive source anchors plus observed Workflow lifecycle |

Candidate executable: official SDK platform package
`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.322`, reported CLI 2.1.322,
SHA-256 `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450`.
Every declared candidate Workflow anchor was found in these exact bytes during
manifest creation. This is static evidence only. It does not establish account
authorization, Workflow delivery, or any model behavior.

## Consent and Channels

The official [settings reference](https://code.claude.com/docs/en/settings-reference#skipdangerousmodepermissionprompt)
supports consent in local project settings. Both attested binaries reached
readiness with the synthetic included consent file, then the checked
API-error driver detected explicit unavailable Channels output and exited 2
before calling its turn sender (old 3.466s, candidate 2.966s). No success or
failure of the actual API-error oracle was established. The harness retained
its synthetic onboarding and legacy global consent fields plus excluded user
settings; this demonstrates functional startup with the included file, not an
isolated necessity test for old .283. Minimal local-file content is checked by
unit tests, and both attested binaries statically consult local consent. Both runs used the
retained OS sandbox denying external outbound and real credentials/Keychain.

[Channels](https://code.claude.com/docs/en/channels) needs supported Anthropic
authentication and feature access; Team/Enterprise additionally needs org
enablement. The [development flag](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)
allows the custom server, not account enrollment. Both binaries consult
`tengu_harbor`; candidate also consults `allow_channels`. No supported
credential-free enrollment mechanism was found. No real login/cache was read
or changed and no feature cache was forged. Stop retries until an authorized
account context changes this prerequisite. Mailbox and the remaining local
error modes were deliberately not retried.

## Discovery and acceptance procedure

After a separate explicit provider go, invoke the runner with the absolute
discovery manifest and `--version candidate`. Pure planning yields 13 candidate
invocations (CLI contract twice, eleven other cells once). Existing child
deadlines are 15 minutes: 195 minutes aggregate, plus startup/cleanup overhead.
Stop on the first failure or unexplained result; no automatic paid retries.
This scope is not a dollar, token, API-request or strict whole-run bound.
The manifest's `cost.usdEstimate` values are estimates; existing driver turn
limits and timeouts remain intact. No new spending/metering gate is imposed.

Review each observation against this table, including raw-source privacy and
all existing oracles. Revise only with evidence and independent review. Prepare
a distinct `validationStage: acceptance` manifest on one recorded immutable
gate commit, then obtain a separate go for the complete 23-run comparison
(10 old + 13 candidate; 345 minutes of child deadlines plus overhead). The
.283 opt-in waiver is the only retained waiver. A discovery summary, static
anchor match, local fixture or unit test cannot authorize a pin move. Preserve
private evidence until independently reviewed and cleanup separately approved.

Tracking issue publication, aligned reviewed SDK/CLI pins, actual-new-SDK
consumer validation, separately reviewed Polygram consumer update and both
24h soaks remain pending. This worker leaves source/docs uncommitted.
