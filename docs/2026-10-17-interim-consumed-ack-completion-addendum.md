# Interim consumption is not turn completion

## Problem and evidence

The accepted notification contract advances the processed cursor only after the agent turn completes. The 2026-10-17 source batch violated it: Orchestra finalized at 07:08:14.994 UTC, Polygram marked success at 07:08:15.122, and the same provider turn continued foreground tools through 07:10:12 without an `end_turn`. Events show an interim-only reply, `consumed_acked=true`, no Stop and activity-quiet finalization.

`CliProcess._ledgerAckConsumed` marks consumption before dispatch; `_activityQuietEligible` treats that flag as a captured answer even for `interim:true`. `_checkpointAbsolute` repeats the same shortcut. Polygram correctly trusts the returned success result, then its notification consumer commits the cursor; the false success originates in Orchestra.

## Chosen correction

Preserve consumption acknowledgement for input-ledger/drop detection. Separately retain proof that a consuming reply successfully delivered a non-interim answer. Require that proof, plus the existing seen/consumed checks, wherever the finalizer/checkpoint currently treats consumption alone as an answer.

Record the proof after successful reply dispatch, before recording the attributed reply and releasing the delivery-in-flight guard. Rearm activity quiet after proof becomes available so a genuine sibling final answer still recovers when hooks stall. An interim reply must never grant or revoke a previously delivered final-answer proof. Empty text does not grant proof.

Apply the delivered-answer predicate in four places: activity-quiet eligibility, both absolute-checkpoint checks (before and after the asynchronous busy probe), and the consumed-only success branch in `fireTimeout`. The latter prevents a failed/empty sibling dispatch from succeeding at its terminal ceiling. In `fireTimeout`, reuse existing activity-quiet eligibility so a current captured Stop still rescues its answer after failed dispatch; stale Stop data (followed by newer work hooks) cannot provide that proof. Preserve its separate existing handling of directly recorded replies.

This follows the existing `progress-is-not-turn-end-spec.md` contract; there is no new completion protocol, prompt, retry, runtime API, schema or CLI pin. Existing attributed Stop rescue, final reply recovery, questions, busy-aware extension and terminal ceilings remain.

## Alternatives

- Disable activity-quiet recovery: rejected because genuine delivered answers with lost Stop/hooks would hang until ceilings.
- Remove consumed IDs from interim replies: rejected because they carry input-consumption/fold evidence independently of completion.
- Treat every consumed receipt as a final answer after a longer silence: rejected because elapsed silence does not turn a status message into an answer.
- Require provider JSONL `end_turn` for every completion: broader lifecycle redesign; unnecessary for this proven interim eligibility defect and outside this correction.

## Verification

Use existing Orchestra CLI integration coverage and full reply dispatch. First demonstrate RED for a seen turn whose successfully delivered interim reply includes its own consumed ID, quiet-window expiry, and later foreground activity. It must remain pending/busy and emit no result/idle until an attributed Stop or actual final answer. Also pin consumed-only sibling interim and failed-send cases; final consumed sibling answers and existing final reply/Stop recovery must still settle. Verify the absolute checkpoint extends a working interim-consumed turn rather than shortcutting success, including delivery landing during its async probe.

Run the affected Orchestra suite, then full Orchestra tests and Polygram finalizer/ledger/checkpoint/external-job/notification suites against the candidate package. The real source batch remains historical premature success; do not reset or replay it. Release acceptance needs a new bounded same-topic source turn with actual final completion, plus source ownership handoff gates, before restoring collection.

## Failure boundaries

This fix removes the interim/consumption conflation. It does not claim that generic silence proves provider inactivity, change the legacy hooks-never-live path, or reconcile historical report-unknown obligations. A dispatcher success is delivery proof only for the existing declared final reply contract; the existing activity/Stop semantics still govern turn retirement.

## Review and regression receipt

Independent correctness/simplicity and failure-mode reviewers approved the separation before implementation. Both required the consumed-only terminal-ceiling branch to use final delivery proof too. Existing regression coverage also required retaining current captured-Stop rescue when an in-flight consuming send rejects; it now uses the existing eligibility predicate.

Before the patch, the production-shaped interim-consumed quiet-gap regression failed on early pending-turn removal. Six negative checks failed and the genuine final-sibling control passed. After the patch, all eleven targeted checks pass, including delayed/failed/rejected/empty delivery, unrelated consumed IDs, shorter final text after interim, later interim, both async checkpoint boundaries, and the existing rejecting-send Stop-rescue control. The final-during-probe test uses a consumed-only sibling so directly recorded reply state cannot mask the new guard.

Both independent actual-diff reviews approved the implementation with no must-fix findings. Exact-lock Node 24.4.0 full Orchestra verification passed: 1,493 passed, zero failed, 19 explicit channels/Codex capability N/A skips (1,512 tests, 72 suites). `npm pack --dry-run` and `git diff --check` passed. The first full run found a stale SDK in a temporary link to the canonical checkout's old dependency tree; removing that link and installing the unchanged lock restored SDK 0.3.283 and the clean pass. No SDK or Claude source pin changed.

Existing interim coverage exercised direct reply bookkeeping and Stop rescue, while consumed-ack coverage exercised final answers; neither combined interim dispatch, consumption IDs and expiry of the quiet timer. The new socket integration regression covers that composition.

Evidence is retained at `~/Downloads/polygram-cli-completion-fix-20261017/`. Polygram 0.41.1 candidate verification uses the published Orchestra 0.11.1 artifact with a production-source hash matching the reviewed fix. Its full Node 24.4.0 suite passed: 4,494 passed, zero failed, 16 opt-in real-Claude E2E skips (4,510 total). SDK 0.3.283 and Claude CLI 2.1.283 remain unchanged. Production release acceptance remains pending; the source batch is not replayed or reclassified.
