# `/schedule` (Claude Code routines) vs shumabit jobs — research

Status: research artefact, not a release deliverable.
Date: 2026-05-01.
Sources cited inline as `file:line` for local code and full URL for remote
docs. Anything I could not verify is flagged "needs runtime verification".

---

## 1. Executive summary

There are two completely different scheduling systems in your setup. They
look superficially similar ("a thing that fires Claude on a cron") but they
share almost no infrastructure.

**Claude Code `/schedule`** creates "routines": saved Claude Code
configurations (prompt + repos + connectors + triggers) that execute as full
cloud sessions on **Anthropic-managed infrastructure** under your
`claude.ai` account. State lives entirely in Anthropic's cloud; the local
CLI is just a thin remote control. Routines keep firing when your laptop is
shut, count against your subscription's daily routine cap, and have a
1-hour minimum interval. Source: <https://code.claude.com/docs/en/routines>.

**Shumabit jobs** are a YAML-driven launchd scheduler living in
`/Users/shumabit/shumabit-claude/tools/scheduler/` (CLI binary `bin/jobs`).
The single source of truth, `tools/scheduler/jobs.yaml`, renders one
`~/Library/LaunchAgents/com.shumabit.jobs.<id>.plist` per job. macOS's
`launchctl` fires Node scripts on the **local Mac as the `shumabit` user**
with full filesystem, keychain, and network access. Failures surface
through `~/.shumabit-health-state.json`, are detected by
`scripts/health-check.js` every 30 min, and get pushed to your Telegram
DM by polygram.

**Single biggest difference**: routines run an *agent* in the *cloud* with
*no local-FS access*. Shumabit jobs run *deterministic Node scripts* (or
in some cases an `claude -p` headless one-shot) on the *local Mac* with
*full local-FS, keychain, and ssh-able-to-other-users access*. They
solve different problems.

---

## 2. Claude Code `/schedule` (routines) — verified facts

All facts in this section are sourced from
<https://code.claude.com/docs/en/routines> (fetched 2026-05-01) unless
otherwise noted.

### 2.1 What a routine is

> "A routine is a saved Claude Code configuration: a prompt, one or more
> repositories, and a set of connectors, packaged once and run
> automatically. Routines execute on Anthropic-managed cloud
> infrastructure, so they keep working when your laptop is closed."
> — <https://code.claude.com/docs/en/routines>

### 2.2 Where state is stored

- **Remote, in your `claude.ai` account.** Quote: "All three surfaces
  write to the same cloud account, so a routine you create in one shows
  up in the others immediately."
- The `/schedule` CLI is *not* the storage backend; it's a client that
  calls a remote API (the `RemoteTrigger` tool — referenced in
  `~/.claude/cache/changelog.md` line: "Fixed `RemoteTrigger` tool's
  `run` action sending an empty body and being rejected by the server").
- Manage them at <https://claude.ai/code/routines> from any device.
- **Implication**: the routine you created earlier this session (the
  2026-05-15 architecture review) survives a Claude Code reinstall, an OS
  reinstall, even moving Macs. As long as you log into the same
  `claude.ai` account, it's there.

### 2.3 Where they execute

- **Anthropic-managed cloud infrastructure**, in a "cloud environment"
  (<https://code.claude.com/docs/en/claude-code-on-the-web#the-cloud-environment>).
  Your repos are *git-cloned fresh* at the start of every run from
  GitHub; they don't see your local working tree.
- The cloud session has its own network policy, env vars, and a cached
  setup script. Source: docs §"Select an environment".
- Your local laptop can be off. Quote: "they keep working when your
  laptop is closed."
- A routine run = a real Claude Code session you can open in the browser
  and continue interactively if needed.

### 2.4 Persistence guarantees

- Survives logout, reboot, Claude Code restart, OS reinstall — state is
  cloud-side.
- Pause/resume toggle exists in the web UI ("Use the toggle in the
  **Repeats** section to pause or resume the schedule").
- One-off routines auto-disable after firing and are marked **Ran**.

### 2.5 Cost model

- **Counts against your `claude.ai` subscription usage** like any
  interactive session. Source: docs §"Usage and limits".
- **Plus** a per-account *daily routine run cap* on top of normal subs
  limits. The exact number isn't documented; check
  <https://claude.ai/code/routines> or
  <https://claude.ai/settings/usage>.
- **One-off runs are exempt** from the daily cap (but still consume
  subscription usage). Quote: "One-off runs do not count against the
  daily routine cap."
- Overage: only available if "extra usage" is enabled in
  Settings → Billing.

### 2.6 Limits

- **Minimum cron interval: 1 hour.** Quote: "The minimum interval is
  one hour; expressions that run more frequently are rejected."
- Plan gating: "Pro, Max, Team, and Enterprise plans with Claude Code
  on the web enabled."
- GitHub triggers have per-routine and per-account hourly webhook caps
  (exact numbers shown at <https://claude.ai/code/routines>) — events
  beyond cap are dropped, not queued.
- Stagger: "Runs may start a few minutes after the scheduled time due
  to stagger." Don't expect minute-precision.

### 2.7 Auth / permission model

- The agent runs **as you** through your connected GitHub identity and
  MCP connectors. Commits/PRs carry your GitHub user; Slack messages,
  Linear tickets, etc. use your linked accounts.
- Routines are **per-user**, not shared with teammates.
- Inside a run there is **no permission picker, no approval prompts**.
  Quote: "Routines run autonomously as full Claude Code cloud
  sessions: there is no permission-mode picker and no approval prompts
  during a run."
- Branch safety: by default Claude can only push to `claude/`-prefixed
  branches; "Allow unrestricted branch pushes" is opt-in per repo.
- API trigger tokens are shown **once** and stored in the alerting
  tool's secret store; rotation is via Regenerate/Revoke in the UI.

### 2.8 Failure modes

- Each run is a normal session you can open in the browser to inspect.
- I could not find documented retry semantics for missed fires (e.g.
  laptop-was-off doesn't apply since it's cloud-side; but what if
  Anthropic infra has an outage?). **Needs runtime verification.**
- GitHub events past the hourly cap are **dropped silently** (per
  research-preview note).
- No mention of dead-letter or failure notification — if a run errors,
  you only see it by visiting the routine detail page or opening the
  session. **No equivalent of polygram pushing a Telegram alert.**

### 2.9 Trigger types

| Trigger    | Cadence                                                          | Created from   |
| ---------- | ---------------------------------------------------------------- | -------------- |
| Schedule   | Hourly/daily/weekdays/weekly preset, or custom cron (≥ 1h)       | CLI + web      |
| One-off    | Single fire at a future timestamp                                | CLI + web      |
| API        | HTTP POST to per-routine `/fire` endpoint with bearer token      | Web only       |
| GitHub     | `pull_request.*` and `release.*` events with filters             | Web only       |

CLI: `/schedule <description>`, `/schedule list`, `/schedule update`,
`/schedule run`. From `/Users/ivanshumkov/.claude/cache/changelog.md`:
the underlying tool is `RemoteTrigger` with actions
`create | update | list | run | get`.

### 2.10 Beta / stability caveat

- "Routines are in research preview. Behavior, limits, and the API
  surface may change."
- The `/fire` endpoint is gated by `anthropic-beta:
  experimental-cc-routine-2026-04-01`. Breaking changes ship behind new
  dated headers; the two most-recent prior headers stay accepted.

---

## 3. Shumabit jobs tooling — what's actually there

All facts in this section come from live inspection of the shumabit user
on this Mac (via `ssh shumabit@127.0.0.1`).

### 3.1 Layout

- **Source of truth**:
  `/Users/shumabit/shumabit-claude/tools/scheduler/jobs.yaml`
  (`scp shumabit@127.0.0.1:~/shumabit-claude/tools/scheduler/jobs.yaml`).
  16 jobs as of 2026-05-01.
- **CLI**:
  `/Users/shumabit/shumabit-claude/tools/scheduler/bin/jobs`
  (Node, ~9 KB). Subcommands: `list / render / load / unload / sync /
  status / logs / run / health` — see
  `~/shumabit-claude/tools/scheduler/README.md`.
- **Library**:
  - `lib/config.js` — YAML loader/validator.
  - `lib/schedule.js` — converts cron string → `StartCalendarInterval`
    plist entries (subset only: lists `1,15`, ranges `1-5`, names are
    *rejected*).
  - `lib/render.js` — emits the plist XML.
  - `lib/launchctl.js` — wraps `launchctl bootstrap | bootout | print
    | list`.
  - `lib/health.js` — health report; what `health-check.js` consumes.
- **Rendered plists**:
  `~/Library/LaunchAgents/com.shumabit.jobs.<id>.plist`. Verified —
  16 plists present (`com.shumabit.jobs.auto-commit.plist`,
  `…health-check.plist`, `…meta-campaign.plist`, etc.).
- **Logs**: `~/logs/jobs/<id>.log` (versus the old cron path
  `~/logs/cron/`; the README notes they coexist for migration).

### 3.2 Trigger mechanism

`launchd` (macOS) via `StartCalendarInterval`. Example from the
auto-commit plist (paraphrased from
`~/Library/LaunchAgents/com.shumabit.jobs.auto-commit.plist`):

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>_TS=$(date -u …); printf "[RUN:START ts=%s job=auto-commit]\n" …;
            cd /Users/shumabit/shumabit-claude && node skills/git-workspace/scripts/commit-push.js;
            _EC=$?; printf "[RUN:END ts=%s job=auto-commit exit=%d]\n" … $_EC; exit $_EC</string>
</array>
<key>StartCalendarInterval</key>
<array>
    <dict><key>Minute</key><integer>0</integer><key>Hour</key><integer>0</integer></dict>
    …  <!-- one entry per fire-time -->
</array>
```

The `[RUN:START …]` / `[RUN:END … exit=N]` markers are inserted by the
job-render layer so `lib/health.js` can parse the *last* run from the
log (see `parseLastRun` in
`/Users/shumabit/shumabit-claude/tools/scheduler/lib/health.js:18-55`).

A side-by-side legacy path exists as `~/shumabit-crontab` (155 lines).
The README explicitly notes "Runs side-by-side with cron: logs go to
`~/logs/jobs/` (cron uses `~/logs/cron/`)."

### 3.3 Execution context

- **User**: `shumabit` (separate macOS user from `ivanshumkov`).
- **Working dir**: `/Users/shumabit/shumabit-claude` (overrideable per
  job — e.g. `auto-commit-partners` sets `cwd:
  /Users/shumabit/shumabit-partners`).
- **Env**: `PATH=/opt/homebrew/bin:…/.npm-global/bin:…/.cargo/bin:/usr/bin:/bin`,
  `HOME=/Users/shumabit`,
  `NODE_PATH=/Users/shumabit/shumabit-claude/node_modules`. Source:
  `defaults.env` block in `jobs.yaml`.
- **Available**: full local FS, the shumabit user's keychain (when
  launched from a logged-in Aqua session — relevant for keychain-backed
  Anthropic OAuth), Telegram bot tokens, Xero/Shopify/Meta cookies in
  Chrome session dirs (`~/.chrome-shopify-session/`,
  `~/.chrome-xero-session/`), GPG keys.
- **What runs**: mostly plain `node skills/<x>/scripts/<x>.js` —
  *deterministic scripts* hitting Xero / Shopify / Meta APIs, posting to
  Telegram via `lib/telegram.js`. A subset (`meta-campaign`,
  `context-audit`, `weekly-summary`) shells out to
  `claude-with-auth.sh -p "…" --bare` to invoke headless Claude.

### 3.4 Schedule examples (from `jobs.yaml`)

- `inventory` — `0 8 * * *` daily at 08:00 Bangkok time.
- `pnl-sync` — `0 10 */2 * *` every 2 days at 10:00.
- `weekly-summary` — `0 20 * * 0` Sunday 20:00.
- `auto-commit` — `0 */5 * * *` every 5 hours.
- `health-check` — `*/30 * * * *` every 30 minutes.
- `monthly-ops-task` — `0 9 28 * *` 28th of each month, 09:00.

Timezone is **Asia/Bangkok (host TZ)**. `launchd` reads local time.

### 3.5 Logging / observability

The bot's "auto-commit job last run failed" reply traces as follows:

1. `health-check` job fires every 30 min: `node
   scripts/health-check.js`
   (`~/shumabit-claude/scripts/health-check.js`).
2. `health-check.js` shells out to `JOBS_BIN health --json` (= `node
   tools/scheduler/bin/jobs health --json`).
3. `bin/jobs health` calls `lib/health.js::buildHealth(cfg)`, which:
   - Parses each job's log for the last `[RUN:START]` / `[RUN:END
     exit=N]` pair (`parseLastRun()` lines 18-55).
   - Categorises into `missing | stale | failed | ok |
     unloaded_optional`.
4. `health-check.js` turns each entry into an alert and dedups via
   `~/.shumabit-health-state.json` (6 h suppression).
5. Alerts are posted to Ivan's Telegram DM (chat `68861949`) via
   `lib/telegram.js::apiCall`. The message is literally `job
   "auto-commit" last run failed` — observed in
   `~/.shumabit-health-state.json` at the moment of inspection:
   ```json
   "job:failed:auto-commit": {
     "lastAlertedMs": 1777622406525,
     "title": "job \"auto-commit\" last run failed",
     "contentHash": "5a408a5b"
   }
   ```

### 3.6 Comparison with stock Unix cron

- Same cron-string syntax (with caveats — no lists/ranges/names).
- launchd handles missed fires when system was asleep ≠ cron (cron
  drops missed fires; launchd will run "as soon as possible" once awake
  for `StartCalendarInterval`, though there's a long-standing macOS bug
  about coalescing).
- Side-by-side with the legacy `~/shumabit-crontab` while migration is
  underway.

---

## 4. Direct comparison table

| Dimension                | `/schedule` (routines)                                    | shumabit jobs                                                |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ |
| **Where state lives**    | Anthropic cloud (claude.ai account)                       | Local: `tools/scheduler/jobs.yaml` + `~/Library/LaunchAgents/` |
| **Where it runs**        | Anthropic cloud env (cloud sandbox)                       | Local Mac as `shumabit` user                                 |
| **Survives laptop off**  | Yes                                                       | No (only fires when Mac is awake / logged-in user session)   |
| **Survives reinstall**   | Yes (cloud-side)                                          | Only if `shumabit-claude` repo + plists are restored         |
| **Local FS access**      | None — repos are git-cloned fresh                         | Full — anything `shumabit` user can read/write               |
| **Local secrets/keychain**| Only via env vars or MCP connectors                      | Yes — Aqua keychain, Chrome session dirs, GPG, ssh keys      |
| **Min cron interval**    | 1 hour                                                    | Effectively 1 minute (launchd `StartCalendarInterval`)       |
| **Cost**                 | Subscription usage + daily routine cap                    | Free (you own the Mac)                                       |
| **Auth model**           | Cloud-Claude, runs as your claude.ai user, MCP connectors | Local Unix user, plus optional headless `claude -p` for AI  |
| **Failure observability**| Manual: open the routine page                             | Auto: Telegram DM via `health-check` + dedup state           |
| **What does the work**   | A Claude agent (LLM-driven, autonomous)                   | Mostly deterministic Node scripts; *some* call `claude -p`  |
| **External triggers**    | Schedule, one-off, HTTP API, GitHub webhooks              | launchd cron only (no API/webhook surface)                   |
| **Edit surface**         | CLI `/schedule …`, web, Desktop app                       | Edit `jobs.yaml`, `bin/jobs load --all`                      |
| **Version control**      | Cloud — no git                                            | `jobs.yaml` is checked into shumabit-claude repo             |
| **Permission model**     | No prompts; full autonomy in the cloud env                | Whatever `shumabit` user permissions allow                   |
| **Identity for actions** | Your claude.ai-linked GitHub/Slack/Linear/etc.            | `shumabit` Telegram bot, shumabit-owned API tokens           |

---

## 5. When to use which

### 5.1 `/schedule` shines when

- The work is **agentic and conversational**: needs an LLM to read,
  decide, write, summarise.
- It must keep firing **with the laptop off** (e.g. you're travelling).
- The action is **GitHub-resident**: opening a cleanup PR in
  N weeks, weekly dependency audits, PR review on `pull_request.opened`.
- Triggering from external systems (alerting/CD tools) via HTTP.
- Cadence is hourly or slower.
- You don't need local-FS access or your local Aqua keychain.
- Examples that fit your setup: "open polygram cleanup PR for
  experimental flag in 2 weeks", "weekly architecture review of
  polygram", "every Monday: triage open PRs across shumkov/polygram".

### 5.2 Shumabit jobs shine when

- The job is **deterministic** (a script, not an agent) — Xero billing
  sync, Shopify export, Meta campaign report.
- Needs **local resources**: Aqua keychain, Chrome session cookies,
  Playwright browsers, ssh-able-to-other-users, Notion API tokens stored
  locally.
- Cadence finer than 1 hour (e.g. `health-check` every 30 min,
  `auto-commit` every 5 h is also fine).
- Telegram-DM-on-failure observability is required (your real ops
  signal).
- The script can already run unattended without an LLM — adding LLM
  cost makes no sense.
- Logs need to be greppable from the local Mac.

### 5.3 Where they overlap (either could work)

- "Weekly memory summary" (`weekly-summary` job): currently uses
  `claude-with-auth.sh -p` against the local shumabit-claude repo. A
  routine could do the same — but only if the memory files are pushed
  to GitHub *and* the routine cloud env can write them back. Today the
  memory dir is committed to a repo, so a routine version is feasible;
  the trade-off is loss of local Aqua keychain.
- "Monthly context audit": same story — could run as a routine if all
  inputs (memory files, cron logs) are in GitHub. Cron logs aren't, so
  this stays local.
- A polygram architecture review: clearly fits `/schedule` (you already
  set one up for 2026-05-15).

---

## 6. Gotchas + integration hazards

### 6.1 Duplication risk

You **could** create a routine that does the same thing as a shumabit
job, e.g. "weekly polygram dependency audit" as both a routine and a
launchd job. They wouldn't coordinate; both would run, both would push
PRs. **Mitigation**: keep a one-line discriminator at the top of every
routine prompt — e.g. "this is the cloud routine, NOT the shumabit
version" — and the same in `jobs.yaml` `description:` to prevent future
confusion.

### 6.2 Timezone mismatch

- Shumabit jobs: **Asia/Bangkok** (local Mac TZ); explicit comment in
  `jobs.yaml`. Cron strings are local time.
- Routines: docs say "Times are entered in your local zone and
  converted automatically", and natural-language `/schedule tomorrow at
  9am` resolves against your current local time. Underlying cron is
  stored in UTC.

So **the displayed cron in routines may not match the displayed cron in
`jobs.yaml`** even when both fire at "08:00 your time". When debugging,
always think in wall-clock time, not cron strings.

### 6.3 Cron-syntax subset

Routines accept full cron after `/schedule update`. Shumabit's
scheduler **rejects** lists, ranges, and named months/weekdays — it's a
strict subset. This is in `tools/scheduler/README.md`. So a cron string
that works in `/schedule` won't necessarily port to `jobs.yaml` and
vice-versa.

### 6.4 Network / FS access patterns

- A routine seeing your code = the **GitHub remote**, not your local
  working copy. If you want a routine to act on something you haven't
  pushed, it can't. (Inverse: a shumabit job runs against
  `/Users/shumabit/shumabit-claude` working copy, which can be ahead of
  origin.)
- A routine cannot reach `127.0.0.1`, `~/.config/…`, or any other
  laptop-local resource. If the work needs that, it has to be a
  shumabit job.
- Conversely, a routine *can* reach connectors (Slack, Linear, Jira,
  Google Drive) authenticated to your `claude.ai` account — which a
  shumabit job can't easily do without re-implementing the OAuth
  dance.

### 6.5 Failure visibility gap

Shumabit jobs auto-page you (Telegram via `health-check`). Routines
**don't** — their docs describe no failure notification mechanism. If
you build production-critical workflows on routines, you'll need to
periodically check <https://claude.ai/code/routines> or build your own
failure notifier (e.g. a meta-routine that checks the others, but the
docs don't expose a runs-failed API). **Needs runtime verification.**

### 6.6 Identity confusion for git/PR

A routine PR comes from your `ivanshumkov` GitHub identity; a shumabit
auto-commit comes from whatever `shumabit-claude` git config is set to
(check via `ssh shumabit@127.0.0.1 git -C ~/shumabit-claude config
user.email`). If both fire on the polygram repo (unlikely but
possible), the commit author tells you which.

### 6.7 Cost surprise

A daily routine is N runs/day against your subscription. A subscription
overrun blocks new routine fires until the window resets, **silently**
unless you enabled extra usage. Shumabit jobs cost $0 (Apple Silicon
electricity) except for the subset that calls `claude -p` (which uses
the same shumabit-keychain Anthropic OAuth — counts against
*shumabit's* subscription, not yours).

### 6.8 Sandbox capability

Routines run "autonomously" with **no permission prompts** in a fresh
cloud env. That's fine when the env is locked down; risky if you
inadvertently grant write-access connectors (e.g. a Linear connector
with admin scope) and the prompt is ambiguous. Audit the
**Connectors** tab on each routine before saving.

---

## 7. Open questions / probes I couldn't answer

| Question                                                                    | How to verify                                                                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily routine cap — exact number for your plan?                             | Visit <https://claude.ai/code/routines> or <https://claude.ai/settings/usage>.                                                                            |
| What happens if Anthropic infra is down at fire time? Retry? Drop?          | Set up a test routine that writes a heartbeat file via a connector and look for gaps. Or open a support ticket.                                          |
| Failure notifier surface (webhooks for failed routine runs)?                | Not documented. Probe: trigger a routine that intentionally exits non-zero, see if anything notifies. If not, file a feature request.                    |
| Are routines visible to the underlying Anthropic API key (Claude Platform), or only the claude.ai account? | Docs say "/fire endpoint is available to claude.ai users only and is not part of the Claude Platform API surface." So claude.ai-only.                    |
| Is there a local mirror of routine state under `~/.claude`?                  | Search done — no `routine`/`schedule` files under `~/.claude`. The CLI is a thin remote client. Likely no local cache.                                   |
| Can a routine SSH into shumabit and tail logs?                              | Only if its cloud env has a network policy that permits outbound and you provide creds via env vars. Doable but defeats most of the security model.       |
| Stagger offset is "consistent for each routine" — can it be controlled?      | Docs say it's set automatically. Not user-configurable per the current docs.                                                                              |
| Does `/schedule update` accept full cron (lists, ranges)?                    | Docs imply yes — "set a specific cron expression". Verify with `/schedule update <id>` and a complex expression.                                         |

---

## 8. Recommended mental model

> *Routines are GitHub-native cloud agents tied to your claude.ai
> identity. Shumabit jobs are local cron for the shumabit user.*

When in doubt, ask: **does this work need local files, the local
keychain, the local Telegram bot, or sub-hour cadence?** If yes, it's a
shumabit job. If no — and especially if the work is "open a PR / write
a summary / run a checklist on a repo I have on GitHub" — it's a
routine.

---

## Citations index

- `/Users/ivanshumkov/.claude/cache/changelog.md` — `RemoteTrigger` tool
  reference (action: create/update/list/run/get).
- `/Users/shumabit/shumabit-claude/tools/scheduler/README.md` — scheduler
  CLI overview and cron subset rules.
- `/Users/shumabit/shumabit-claude/tools/scheduler/jobs.yaml` — all 16
  jobs.
- `/Users/shumabit/shumabit-claude/tools/scheduler/bin/jobs` — CLI
  entrypoint.
- `/Users/shumabit/shumabit-claude/tools/scheduler/lib/health.js:18-55`
  — `parseLastRun()`, source of "job last run failed" classification.
- `/Users/shumabit/shumabit-claude/scripts/health-check.js` — every-30
  -min health roll-up; calls `JOBS_BIN health --json`, posts to Ivan
  Telegram DM `68861949`.
- `/Users/shumabit/.shumabit-health-state.json` — dedup state mirroring
  the alert titles seen in the bot's reply.
- `/Users/shumabit/shumabit-crontab` — legacy crontab kept side-by-side.
- `~/Library/LaunchAgents/com.shumabit.jobs.*.plist` (16 plists) —
  rendered output.
- <https://code.claude.com/docs/en/routines> — primary source for all
  `/schedule` claims.
- <https://code.claude.com/docs/en/overview> — confirms "Routines run
  on Anthropic-managed infrastructure, so they keep running even when
  your computer is off."
