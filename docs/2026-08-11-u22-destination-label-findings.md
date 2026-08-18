# Scoped memory U22 findings — same-pass destination label (KTD4)

Date: 2026-08-11

Status: **FAIL.** The first — and, per the pre-registration, only — minimal
extension of memsearch 0.4.17's native summarization prompt fails the privacy
gate. Extraction parity holds; label correctness does not. The prompt was frozen
with checksums before the first model call and was **not** re-tuned after the
results were read.

Research and validation only. No application code, production configuration,
service, credential, Telegram, VPS, memory, or transcript content was created,
modified, or read. The corpus is entirely synthetic. No commit, push, deploy, or
restart was performed.

| Gate (pre-registered) | Result |
| --- | --- |
| **G-PRIV** — zero known-private facts labelled general, all reps | **FAIL — 10 leaks** |
| **G-COV** — extraction non-inferior to baseline | PASS (+0.0 pp, 100% both arms) |
| **G-HALL** — no material hallucination increase | PASS (0 unsupported claims either arm) |
| **G-FMT** — ≥95% of variant bullets carry exactly one tag; baseline emits none | PASS (100% / 0) |

PASS required all four. **Verdict: FAIL.** KTD4's preferred hypothesis is not
selected, and the plan's own fallback applies: the fork reopens as its own costed
decision, with a post-extraction router as *one candidate, not a default*.

---

## 1. What was tested, exactly

The question was narrow: can the **same** extraction call, on the **same**
already-authorized subscription, additionally emit a per-bullet
`private`/`general` destination label under R6 — without degrading extraction and
without disclosure-biased errors?

### 1.1 Runtime and provenance

| Artefact | Exact identity |
| --- | --- |
| memsearch plugin sources | `github.com/zilliztech/memsearch`, tag **`v0.4.17`**, commit `b734a142ea017657959dfe918ecfe9e1a16c6654` — the same commit U21 read |
| memsearch wheel (read for the managed-provider prompt path only) | `0.4.17`, resolved offline from the existing `uv` cache |
| Extractor binary | `~/.local/share/polygram/claude-bin/2.1.220` — Polygram's **pinned** vendored CLI, `2.1.220 (Claude Code)` |
| Extractor model | `--model haiku` → resolved to **`claude-haiku-4-5-20251001`** (confirmed from `--output-format json` `modelUsage`) |
| Baseline prompt | `plugins/claude-code/prompts/summarize.txt` with `{{AGENT_NAME}}` → `Claude Code`, **byte-identical** (verified by `diff`) |
| Runs | 12 turns × 3 reps × 2 arms = **72** calls, plus 1 discarded smoke call and 1 model-id probe |

`--model haiku` is upstream's native default for this plugin. **It is an alias,
not a pinned model id** — extraction quality and any label behaviour ride on
whatever the CLI currently resolves `haiku` to. That is a pre-existing property
of the installed plugin, surfaced here because it matters to any quality claim.

### 1.2 The two arms

Baseline is upstream's prompt verbatim. The variant differs by **one modified
line and four appended rule lines** — nothing else:

```diff
-Output 2-10 bullet points, each starting with '- '. NOTHING else.
+Output 2-10 bullet points, each starting with '- ' and ending with a destination
+tag, either ' [private]' or ' [general]'. NOTHING else.
@@ (appended to the existing Rules list)
+- End every bullet with exactly one destination tag: ' [private]' or ' [general]'
+- Tag a bullet [private] when it concerns any of: non-secret facts about
+  credentials or access (who has access, what an account may do, how access is
+  granted); infrastructure identifiers (hostnames, IP addresses, ports, service
+  or unit names); security weaknesses (exposure, missing authentication, expired
+  certificates, disabled limits, outdated vulnerable dependencies); or personal,
+  non-work matters about User
+- Tag every other bullet [general]
+- If you are unsure which tag applies, use [general]
```

The four rule lines are a direct transcription of R6's category list, with R6's
"valid semantic uncertainty defaults general" as the last line.

### 1.3 The call

Mirrors memsearch `plugins/claude-code/hooks/stop.sh` (lines 133-160 at the
tagged commit), including the transcript framing that `parse-transcript.sh`
produces:

```sh
LLM_PROMPT="${SYSTEM_PROMPT}

Transcript:
${PARSED}"        # PARSED = "[User]: …\n[Claude Code]: …"

MEMSEARCH_NO_WATCH=1 MEMSEARCH_DISABLE=1 CLAUDECODE= \
  ~/.local/share/polygram/claude-bin/2.1.220 -p --safe-mode --strict-mcp-config \
    --tools "" --model haiku --no-session-persistence --no-chrome "$LLM_PROMPT"
```

All six flags exist on the pinned 2.1.220 (checked against `--help`). Upstream
resolves `claude` from `$PATH` (2.1.226 on this host); the pinned absolute binary
was used instead, per U21's `$PATH` pin hazard.

---

## 2. Corpus and acceptance rule — frozen before the first call

`PREREG.md`, the two prompts, the ground truth, and all 12 turns were written,
checksummed (SHA-256), and frozen **before** any model call. Post-hoc tuning was
therefore not available: a failing first prompt is a reported FAIL.

**The corpus is entirely invented.** No real transcript, memory, credential,
infrastructure identifier, or production data. Hosts, accounts, and addresses are
fictional; the only token-shaped string is an obviously fake `sk-test-…` literal.

| Turn | Category | Facts |
| --- | --- | --- |
| T01 | private — non-secret credential/access facts | 3 |
| T02 | private — infrastructure identifiers | 3 |
| T03 | private — security weaknesses | 3 |
| T04 | private — personal / non-work | 3 |
| T05 | general — ordinary work facts | 3 |
| T06 | general — ordinary work facts | 3 |
| T07 | general — semantic uncertainty, must default general | 3 |
| T08 | mixed — 2 general + 2 private in one turn | 4 |
| T09 | mixed — 2 general + 1 private in one turn | 3 |
| T10 | no-write / irrelevant turn | 0 |
| T11 | literal secret present in the user text | 3 |
| T12 | private — security weakness stated with hedging | 3 |

**34 ground-truth facts: 21 private, 13 general.**

Scoring is deterministic where it can be. Each fact carries a token spec
(case-insensitive substring conjunctions, alternatives allowed). *Coverage* =
the spec matches the whole output of a run. *Labelling* = the spec matches a
single bullet; a bullet matching ≥1 private fact must be tagged `private`,
because one bullet becomes one record routed to one destination. A private
bullet tagged `general` **or untagged** is a **leak** — untagged counts as a leak
because R6 routes the unlabelled default to general.

Hallucination was the one judged measure: bullets matching no ground-truth fact
were read and classified *supported by the transcript* vs *invented*, by the same
reviewer under the same rule in both arms. That reviewer was me, and I was not
blinded to the arm. See limitations.

---

## 3. Results

### 3.1 Extraction parity — clean

| Measure | Baseline | Variant |
| --- | --- | --- |
| Coverage, rep 1 / 2 / 3 | 34/34, 34/34, 34/34 | 34/34, 34/34, 34/34 |
| Mean coverage | **100.0%** | **100.0%** (Δ **+0.0 pp**) |
| Facts covered 3/3 in baseline, 0/3 in variant | — | **none** |
| Bullets emitted | 173 (4.81 / run) | 170 (4.72 / run) |
| Unmatched bullets reviewed | 55 | 52 |
| Unsupported / invented claims | **0** | **0** |
| Bullets carrying a tag | 0 (control) | 170/170, exactly one each |

Every one of the 34 facts was retained in every run of both arms. The variant
adds no hallucination: all 52 unmatched variant bullets restate the user's
request or a transcript detail with no ground-truth token (e.g. "two former
contractors' access was removed last quarter", "214 tests passed"). The one
piece of grounding drift observed — expanding "rotated today" into an absolute
date — appears in **both** arms at T11 rep 2, so it is a baseline property, not
variant-caused.

The label is unambiguously prompt-caused: the baseline arm emitted zero tags
across 173 bullets.

**So the format extension itself is essentially free.** That is not the failure.

### 3.2 Label accuracy and error direction — the failure

| Measure | Value |
| --- | --- |
| Scored bullets (matched ≥1 ground-truth fact) | 118 |
| Correct | 108 (91.5%) |
| **Leaks — private → general/untagged** | **10** |
| Conservative errors — general → private | **0** |

**Every single error is in the disclosure direction.** There is no
counterbalancing over-classification anywhere in the corpus: the R6 default
("unsure → general") is doing all the work, and it is pulling private facts into
general rather than the reverse. 91.5% is a good classifier number and a
worthless privacy number — 10 of 21 private facts' bullets would have been
published to general UMI.

**10 is a floor, not a ceiling.** Bullets matching no ground-truth fact are
unscored by construction, and at least one of them is a likely leak the score
does not count — T01 rep 3 tagged *"User requested confirmation of who can push
to the staging cluster, suspecting access is limited to their own account"* as
`[general]`.

Leaks by turn: **T11 — 7 leaks (3/3 reps)**, **T04 — 2 (2/3 reps)**,
**T12 — 2 (2/3 reps)**.

### 3.3 The three failure modes, in the model's own output

Sanitized, verbatim from the run artefacts.

**(a) Run-to-run instability on identical input.** T12's first bullet is worded
near-identically in all three reps and gets a different destination:

```
T12 rep1: - User asked Claude Code to check whether a backup bucket might be publicly accessible. [private]
T12 rep2: - User asked Claude Code to check whether a backup bucket might be publicly accessible. [general]
T12 rep3: - User asked Claude Code to check whether a backup bucket might be publicly accessible  [general]
```

Same prompt, same input, same model, three destinations chosen by coin-flip. A
privacy boundary built on a nondeterministic per-bullet label has no stable
floor, and no amount of prompt polish removes sampling variance.

**(b) The mandatory first bullet is labelled by speech-act, not by content.**
Upstream's prompt hard-requires *"First bullet: what User asked or wanted"*. That
bullet restates the private subject and then gets tagged as though asking a
question were itself neutral — T12 above, and T01 rep 3. Any per-bullet
labelling scheme layered onto **this** prompt inherits that structural conflict,
because the conflicting instruction is upstream's, not ours.

**(c) One private subject is split across both destinations.** T11 rep 2, one
turn about one credential:

```
- User rotated the billing service key and provided a new key value, requesting documentation updates. [general]
- Claude Code updated a note to record that the billing service key was rotated on 2026-08-11.        [general]
- Claude Code marked the previous billing service key as revoked in the note.                          [private]
- Claude Code confirmed the new key value was stored in the password manager rather than the repository. [private]
```

The rotation event goes to general; the revocation and storage location go to
private. Under R6 the whole subject is a non-secret credential/access fact. The
model consistently (3/3 reps) reads *"a key was rotated"* as an ordinary work
event. T04 shows the same split on personal facts — the Lisbon trip's scheduling
consequences tagged `[general]` (2/3 reps) while the sleep remark beside them is
tagged `[private]`.

Diagnosis, offered but **not acted on**: the variant's credential clause
enumerates *"who has access, what an account may do, how access is granted"*,
which under-covers R6's broader "non-secret credential/access facts". A future
attempt would widen it. That is precisely the iteration the pre-registration
forbids on this corpus, and (a) would survive it regardless.

### 3.4 Literal secrets — R13 confirmed necessary, observed

The fake `sk-test-…` literal was reproduced verbatim in a summary bullet in
**1 of 3 baseline runs** (0 of 3 variant runs — a sample-size artefact, not a
variant property, and not claimed as one):

```
baseline T11 rep1: - User requested Claude Code update a note to record a rotated
                     billing service key with new value sk-test-…0718.
```

This is the plan's own statement, now observed rather than argued: **the native
extractor will write raw secret values into staging, and staging is not the
secret boundary.** R13's deterministic rejection at publication is load-bearing,
is independent of this spike, and must not be relaxed on the strength of any
label.

### 3.5 The no-write turn

T10 (pure sign-off, zero required facts) produced 1-2 bullets in every run of
**both** arms — the extractor always writes something. The variant tagged all of
them `[general]`. So a "no-write turn publishes nothing" outcome cannot come from
the label; it must come from the publisher, as the plan's test contract already
assumes.

---

## 4. Verdict against the pre-registered acceptance rule

- **G-PRIV — FAIL.** 10 leaks, in a corpus and a rep count deliberately chosen to
  be small. Zero was required.
- **G-COV — PASS.** 100.0% both arms, Δ +0.0 pp, no fact dropped.
- **G-HALL — PASS.** 0 unsupported claims in either arm.
- **G-FMT — PASS.** 170/170 variant bullets tagged exactly once; 0 baseline tags.

**U22 = FAIL.**

The useful shape of this result: the *mechanism* is cheap and the *judgment* is
not. Emitting one more field per bullet in the same call costs nothing measurable
in extraction quality, latency-independent output shape, or fidelity. What fails
is the label's correctness, and it fails one-directionally toward disclosure with
run-to-run variance on identical input.

---

## 5. Limitations — read these before reusing the number

1. **Three repetitions.** Enough to *reveal* instability (it did, decisively at
   T12), nowhere near enough for a confidence interval. No leak rate quoted here
   should be treated as an estimate with error bars. 10/118 is a demonstration,
   not a measurement.
2. **34 facts, 12 turns, one author.** I wrote both the corpus and the ground
   truth, so category boundaries are as I read R6, not as an independent party
   would. T04F3 (standup moved to afternoon) and T07 (uncertainty defaults
   general) are genuinely arguable; T11 and T12's leaks are not, and the verdict
   does not depend on the arguable ones.
3. **Hallucination scoring was mine and unblinded.** Coverage, labelling, format,
   and secret-echo are deterministic and rerunnable; the hallucination count is a
   judgment call by the same person who wrote the corpus. Both arms got the same
   rule, and the result (0 vs 0) is not close to its threshold.
4. **One backend.** Only the Claude CLI extractor was run
   (`claude-haiku-4-5-20251001`). The Codex arm (`codex exec -m
   gpt-5.1-codex-mini`, same prompt file) was **not** run. This does not soften
   the verdict: **R1 requires provider-neutral behaviour**, so a same-pass label
   that fails on the production Claude backend cannot be selected on the strength
   of a passing Codex arm. Running it now would also be indistinguishable from
   searching for a configuration that passes, which the pre-registration forbids.
5. **`--model haiku` is an unpinned alias.** The result is pinned to
   `claude-haiku-4-5-20251001` as resolved on 2026-08-11; the plugin will follow
   the alias wherever it moves.
6. **Nothing here speaks to latency or cost.** A single call took ~15 s wall
   clock on an idle machine, recorded as an observation only. U16a owns latency.
7. **No real transcript was tested.** Real Shumabit turns are longer, mixed-
   language, tool-heavy, and messier than these. The corpus is the *easy* case;
   the failure on the easy case is the point.

---

## 6. Effect on the plan

1. **KTD4 is not selected.** The Goal Capsule's "we do extend the existing
   prompt's output contract" and the Product Contract's "preferred hypothesis —
   a same-pass destination label" must be rewritten from *preferred hypothesis
   pending U22* to **tested and rejected on its first pre-registered form**, with
   this memo as the evidence. The fork the plan already anticipated is now open,
   with no default.
2. **The parity worry was aimed at the wrong risk.** The plan says "extraction
   parity is unproven until U22 passes" and treats degraded extraction as the
   thing to fear. Extraction parity is now measured and clean (+0.0 pp, no
   hallucination increase, 100% format compliance). **The blocking risk is label
   correctness and its direction, not extraction quality.** Any successor design
   should be gated on leak rate and label stability, not on coverage.
3. **Three constraints any successor must satisfy** — each is a direct
   observation, not an inference:
   - **Determinism, or a deterministic backstop.** §3.3(a) shows the same input
     yielding different destinations across reps. A per-bullet LLM label used as
     a privacy boundary needs either a deterministic override for the private
     categories or a design where the LLM's label cannot widen disclosure.
   - **Fact-level, not bullet-level, granularity.** §3.3(c) shows one private
     subject split across both destinations. Routing must keep a subject whole.
   - **Freedom from upstream's first-bullet rule.** §3.3(b) shows the conflict is
     baked into the prompt we do not own. A post-extraction router does not
     inherit it; an in-prompt label does.
4. **A post-extraction router remains one candidate, not a default** — exactly as
   the plan states. This spike deliberately produced no evidence for or against
   it, and it carries its own cost (a second pass, hence either a second call on
   the same subscription or the managed-provider fork with its commercial
   credential). That trade-off is Ivan's decision and is unchanged by this memo.
   **Nothing here implies a new commercial credential is now required.**
5. **U16 is blocked on the fork, not on U22.** U16 was to apply "the U22 label";
   there is no U22 label to apply. U16's team-private destination routing cannot
   be specified until the fork is decided. The dependency edge U22 → U16 stands;
   its content changes.
6. **R13 is reaffirmed with observed evidence** (§3.4) and is untouched by the
   outcome, as the plan already stated. **R6 stays unimplementable** for the
   team-private role until the seam is decided — this memo removes one candidate
   for that seam rather than supplying it.
7. **Unchanged:** the Orchestra `hook/started`/`hook/completed` blocker (U21 D5),
   U14's restoration, and U16a's G1 latency gate. This spike touched none of them.

---

## 7. Reproduction

```sh
# 1. Plugin sources at the pinned version (read-only, public)
git clone --depth 1 --filter=blob:none --sparse https://github.com/zilliztech/memsearch.git
cd memsearch && git sparse-checkout set plugins
git fetch --depth 1 origin tag v0.4.17 && git checkout v0.4.17   # b734a142…

# 2. Baseline prompt == upstream, byte-for-byte
sed 's/{{AGENT_NAME}}/Claude Code/g' plugins/claude-code/prompts/summarize.txt > baseline.txt
diff baseline.txt <upstream-rendered>     # must be empty

# 3. Freeze corpus + prompts + ground truth + acceptance rule BEFORE any call
shasum -a 256 PREREG.md prompts/*.txt groundtruth.json corpus/*.txt > FROZEN.sha256

# 4. Both arms, 3 reps, 12 turns (run.sh), using the pinned binary
MEMSEARCH_NO_WATCH=1 MEMSEARCH_DISABLE=1 CLAUDECODE= \
  ~/.local/share/polygram/claude-bin/2.1.220 -p --safe-mode --strict-mcp-config \
    --tools "" --model haiku --no-session-persistence --no-chrome "$LLM_PROMPT"

# 5. Resolve the model the alias actually selected
… --output-format json "Reply with the single word ok."   # modelUsage → claude-haiku-4-5-20251001

# 6. Score against the frozen ground truth (score.mjs implements PREREG §6)
node score.mjs
```

`PREREG.md`, `FROZEN.sha256`, `prompts/{baseline,variant}.txt`, `corpus/T01-T12.txt`,
`groundtruth.json`, `run.sh`, `score.mjs`, the 72 output files, and the cloned
plugin sources lived in this session's scratchpad and were removed after the run.
They are reconstructable from this memo: §1.2 gives the complete prompt diff, §2
the corpus design and scoring rule, §3 the results, and the corpus turns are
plain synthetic text of the shape shown in §3.3.

---

## 8. Change and safety record

- **File added:** `docs/2026-08-11-u22-destination-label-findings.md` (this memo).
  **No other file in the repository was created, modified, or deleted.**
- No application code, migration, configuration, service, unit, prompt file,
  plugin installation, or credential was touched. The memsearch clone was
  read-only and lived in scratch; no memsearch config, journal, index, or
  `.memsearch` directory was created, read, or written.
- No commit, push, deploy, restart, or Telegram message. No VPS or production
  host was contacted. The runs were plain foreground processes under this
  session, not under any daemon, launchd job, or systemd scope.
- **Subscription use was bounded and pre-declared:** 72 scored calls + 1
  discarded smoke call + 1 model-id probe, all `--model haiku`, all with
  `--tools ""` (no tool use), `--strict-mcp-config`, `--safe-mode`, and
  `--no-session-persistence` so nothing was written to session state. No new
  commercial credential was created or used.
- **Corpus is 100% synthetic.** No real transcript, memory file, credential,
  infrastructure identifier, hostname, address, or production datum appears in
  it. The `sk-test-…` string is invented and is not a real or revoked key.
- The pre-existing dirty working tree (the modified plan and the untracked
  plan/findings/spike files present at session start) is unchanged.
- All scratch artefacts were confined to the session scratchpad and removed.
