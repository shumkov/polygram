# Decommission the legacy Shumabit runtime owner

Status: REVIEWED v2 — revised after independent feasibility,
simplicity/scope, and operations/security reviews.

Scope: the UMI VPS runtime topology, its Ansible source of truth, and the
operator skills that deploy or control Polygram, Water, and the admin Claude
session.

## 1. Problem

Production has completed the split-runtime cutover:

- `polygram-shumabit.service` owns the Shumabit bot;
- `polygram-umi-assistant.service` owns the UMI Assistant bot;
- `water.service` owns WhatsApp;
- `polygram-tmux.service`, `water-tmux.service`, and
  `shumabit-admin-tmux.service` own three independent tmux servers.

The old `shumabit-sessions.service` is disabled and inactive, but its unit and
`/home/shumabit/start-sessions.sh` remain installed. Ansible still models
`legacy` and `split` as equal topologies, can render and enable the legacy
owner, and carries a migration override. The deploy skill still accepts
`--allow-legacy` and contains a fleet-wide legacy restart. The
`shumabit-control` slash command still describes the deleted local macOS user,
the default tmux server, direct pane injection, and commands that print secret
configuration.

This is now more dangerous than useful. A stale path can restart both bots or
the wrong tmux server, while operators and agents must reason through two
topologies even though production has only one.

## 2. Evidence and constraints

- The live VPS reports the legacy unit disabled/inactive and every split owner
  enabled/active.
- Restarting Shumabit left UMI Assistant, Water, and all tmux-owner PIDs
  unchanged; restarting Water left both bots and all tmux owners unchanged.
- The committed `POLYGRAM_WATER_RUNTIME_ISOLATION_SPEC.md` declares the
  independent-owner topology and supersedes the earlier shared-tmux draft.
- Ansible's `systemd_service` module supports `enabled`, `state`, and
  `daemon_reload`; the `file` module's `state: absent` is the normal idempotent
  way to remove a managed unit or script.
- systemd must reload its manager configuration after a unit file is removed
  before `not-found` is authoritative.
- Personal skills are canonical under `~/.claude/skills/<name>` and symlinked
  from `~/.codex/skills/<name>`.

Safety constraints:

- Never activate split and legacy owners together.
- Never make an ordinary Ansible run stop an active legacy topology
  implicitly. Migration is no longer a supported steady-state path; an
  active/enabled legacy owner is a loud preflight failure.
- Do not restart an application merely because its unit template or operator
  documentation changed.
- Preserve unrelated worktrees and uncommitted files.
- Do not expose bot tokens, OAuth material, access files, settings files, pane
  contents, prompts, or replies in status commands.

## 3. Chosen design

### 3.1 One Ansible topology

Remove `shumabit_session_topology` and `shumabit_topology_migrate`.

Replace `shumabit_enable_sessions_service` with
`shumabit_enable_split_owners`. It controls only the two Polygram and three
tmux/admin owners installed by the Shumabit role. It remains false in role
defaults so a fresh provision does not claim either Telegram bot. The live
`chat` inventory sets it true. Water remains independently enabled by the Water
role and retains its standby-first provisioning contract.

Normal production-owner runs require the complete current matrix before
mutation:

- the legacy unit is `not-found` and inactive;
- both Polygram units, all three tmux units, and Water are enabled and active.

An incomplete production matrix fails loud. Repairing a missing owner is a
separate named operator action followed by rerunning Ansible; the decommission
does not mix repair and deletion.

The role may render inactive split primitives when
`shumabit_enable_split_owners` is false, but it does not start them or assert
that the production owner matrix is running. When true, existing
`enabled: true, state: started` declarations are idempotent ownership
declarations after a passing preflight, not an auto-repair path.

The one-time production removal uses a dedicated
`runtime-owner-decommission` tag. Its task list is limited to:

1. record `InvocationID`, `MainPID`, cgroup membership, and readiness for both
   bots, Water, and all three tmux owners;
2. require the complete healthy split matrix while accepting the legacy unit
   only as `disabled` and inactive;
3. remove `/home/shumabit/start-sessions.sh` first so a stale unit start has no
   executable launcher;
4. remove `/etc/systemd/system/shumabit-sessions.service`;
5. reload systemd directly with `systemd_service: daemon_reload: true`—not a
   notified handler or `meta: flush_handlers`;
6. assert the two files and any legacy drop-ins/enablement links are absent and
   `LoadState=not-found`;
7. revalidate every current owner and prove its recorded `InvocationID` is
   unchanged.

The tag must contain no package checkout/install, application-config render,
`state: restarted`, or handler flush. It does not enable, start, stop, or
restart a current owner. `--list-tasks` is a tested contract. Check mode may
show the planned removals but skips post-mutation live assertions because the
old files still exist.

Ordinary role runs retain application-specific restart handlers. Tmux units
must never gain a generic restart handler. Removing the Jinja topology branches
from `water.service` must render byte-for-byte the same unit as today's split
configuration, so a later ordinary Water role run does not notify a restart
merely because this source was simplified.

The ordinary Polygram handler sequence is:

1. restart Shumabit;
2. retry its cgroup and authenticated IPC-owner readiness;
3. restart UMI Assistant;
4. retry the same cgroup and authenticated IPC-owner readiness for UMI.

Ansible must not report handler success after starting UMI without proving that
the new UMI invocation owns its expected socket and is ready.

Delete the unused legacy unit and startup-script templates. Simplify the
runtime-owner filter to one expected production matrix rather than a topology
parameter. The ordinary preflight requires legacy absence; only the surgical
decommission tag has the transitional disabled/inactive allowance.

### 3.2 Water and monitoring are split-only

Render `water.service` with its tmux dependency, containment launcher,
preflights, `Restart=always`, and the 330-second stop timeout unconditionally.
Remove migration-only handler guards.

Netdata always watches the two bots, Water, and all three tmux owners. The
aggregate Claude-slice alarm is always rendered.

Active infrastructure documentation describes only this owner matrix. Update
the infra `README.md`, `docs/INFRA_SPEC.md`, `docs/MONITORING_SPEC.md`,
actionable stale portions of `docs/WHATSAPP.md`, `~/INFRASTRUCTURE.md`, and the
two operator skills. Add a historical/do-not-execute banner to
`POLYGRAM_SPLIT_UNITS_RUNBOOK.md` and
`POLYGRAM_WATER_RUNTIME_ISOLATION_RUNBOOK.md`; do not rewrite historical
evidence/spec bodies. Unrelated uses of “legacy” (for example compatibility
formats or Water recovery evidence) are out of scope.

The Water bootstrap/recovery service, timer, state directory, evidence helpers,
and one-time bootstrap script are not runtime owners and are not removed or
edited in this change. They remain inactive historical recovery tooling until
separately retired.

### 3.3 Polygram deploy skill is split-only

Normal deploy entrypoints keep a read-only legacy-state probe so a stale or
partially restored host fails before package mutation. They require the legacy
unit to be `not-found` and inactive; disabled-but-installed is configuration
drift. Remove from normal operation:

- `--allow-legacy`;
- legacy topology admission;
- routes to legacy PID snapshots;
- the legacy fleet restart;
- legacy Water restart behavior;
- documentation that presents rollback to the monolith as an available deploy
  path.

The only matrix accepted by normal deploys is:

- legacy `LoadState=not-found` and inactive;
- both Polygram units, all three tmux units, and Water enabled and active.

Polygram releases continue to:

1. query both bot busy summaries;
2. install the package;
3. restart and validate Shumabit;
4. restart and validate UMI Assistant;
5. prove Water and all three tmux owner invocations did not change.

Water releases continue to restart only `water.service` and prove the bots and
tmux owners did not change.

`bootstrap-water.sh` currently sources private topology and legacy-snapshot
helpers from `deploy.sh`. Keep those functions as explicit historical
dependencies so this change does not break the retained bootstrap/recovery
artifact. No normal `deploy.sh` or `deploy-water.sh` control flow may call them.
A split-only admission wrapper owns every normal release path. The bootstrap
script remains out of normal deployment instructions and its existing
legacy-required operations fail before mutation once the unit is absent.
Retiring the script and VPS recovery artifacts is a separate decision.

### 3.4 Shared Shumabit control skill

Create canonical `~/.claude/skills/shumabit-control/SKILL.md` with a
`~/.codex/skills/shumabit-control` symlink. Keep
`~/.claude/commands/shumabit-control.md` only as a small compatibility shim that
routes existing slash-command use to the skill.

The skill targets `shumabit@umi-vps.tail8aaf04.ts.net`, treats systemd as the
sole runtime owner, and uses fixed command/target mappings:

- status: allowlisted `LoadState`, `UnitFileState`, `ActiveState`, `SubState`,
  `MainPID`, `InvocationID`, `NRestarts`, and `ControlGroup`, plus
  authenticated IPC readiness;
- busy: validated integer busy counts for a named application owner;
- restart: only `polygram-shumabit.service`,
  `polygram-umi-assistant.service`, or `water.service`, after bounded quiet
  polling and followed by owner, lifecycle, cgroup, and unchanged-sibling
  validation;
- topology: verify the exact production matrix, legacy unit `not-found`, and
  both legacy files absent.

It does not capture tmux panes, send keystrokes, start bare Claude processes,
print access/settings files, read raw journals, or read secret-bearing
configuration. The three tmux owners are status/readiness-only and can never be
restart targets. There is no arbitrary unit interpolation, `both`, or admin-tmux
restart. Interrupting a busy application requires separate explicit user
authorization. Package release operations delegate to `polygram-deploy`.

## 4. Alternatives rejected

### Keep legacy rollback behind an override

Rejected. The rollback unit is exactly the source of the shared restart blast
radius, and retaining it preserves every dual-topology branch indefinitely.
Version rollback within the split owners remains available without restoring
the monolith.

### Delete every Water bootstrap/recovery artifact now

Rejected as unrelated expansion. Those artifacts do not own the current
runtime and may still explain or recover the completed one-time handoff. Their
retirement needs its own evidence check.

### Keep the old `shumabit-control` command and edit hostnames

Rejected. Its operating model is not merely stale routing: it directly owns
tmux, types into panes, launches obsolete channel plugins, and prints secrets.
A small shared skill is safer and makes Claude and Codex use the same contract.

### Let Ansible auto-migrate an active legacy host

Rejected. Stopping the monolith is session-destructive and requires explicit
cutover evidence. The role should fail loud if a host has regressed, not perform
another implicit migration.

## 5. Failure modes

| Failure | Required behavior |
|---|---|
| legacy unit active or enabled | fail before rendering/removing/restarting |
| legacy unit disabled but installed after decommission | normal Ansible, deploy, and control paths reject the drift |
| mixed or incomplete split matrix | fail before removal and report the exact owner state |
| unit removal without manager reload | explicit daemon reload, then assert `not-found` |
| split owner missing on enabled host | no deletion or package mutation; repair through a separate named action |
| handler fires during migration | no migration flag exists; no tmux restart handler is introduced |
| stale deploy helper meets legacy host | fail before npm/package mutation |
| stale slash-command invocation | compatibility shim routes to the shared skill |
| status request could expose secrets or pane contents | report only allowlisted systemd/IPC metadata; refuse raw logs and secret dumps |
| request names a tmux/admin or arbitrary restart target | reject before SSH or mutation |

## 6. Verification

### Static and unit tests

- Runtime topology tests accept only the exact split matrix and reject every
  mixed/legacy matrix.
- Ansible source tests prove legacy templates and variables are gone, removal
  tasks exist, daemon reload precedes the final assertion, and tmux services are
  never restarted by a generic handler.
- Handler-order tests prove restart Shumabit → validate Shumabit → restart UMI
  → validate UMI.
- `--list-tasks --tags runtime-owner-decommission` proves the one-time apply
  contains no package/config mutation, current-owner state change, restart, or
  handler flush.
- Water unit tests prove the isolated environment and 330-second timeout are
  unconditional and render byte-identically to today's split unit.
- Netdata tests prove only split owners are watched.
- Deploy-skill topology truth-table tests accept only split and reject
  legacy disabled-but-installed, mixed, or missing owners before mutation.
- Deploy contract/evidence tests prove owner-specific restarts and unchanged
  sibling invocations.
- Skill validation checks frontmatter, canonical/symlink layout, fixed restart
  targets, and the absence of pane capture, raw journals, raw settings/access
  reads, tokens, arbitrary unit interpolation, or legacy startup commands.

### Staging/apply checks

Before apply, record enabled/active states and invocation IDs for both bots,
Water, and all three tmux owners.

Apply only:

```text
ansible-playbook site.yml --tags runtime-owner-decommission
```

The site role condition and list-task tests make that tag a complete,
standalone transaction. Then require:

- `/etc/systemd/system/shumabit-sessions.service` absent;
- `/home/shumabit/start-sessions.sh` absent;
- `systemctl show shumabit-sessions.service -p LoadState` reports `not-found`;
- no legacy drop-in or enablement symlink remains;
- all six current application/tmux owners remain enabled and active;
- both Polygram IPC checks and Water IPC/health checks pass;
- every pre-apply invocation ID is unchanged.

Run the updated control skill's topology/status path and both deploy helpers'
non-mutating topology checks.

The isolation restart checks already passed during the split cutover. This
decommission does not repeat production restarts. It uses the existing
unit/contract tests plus non-mutating readiness and unchanged-invocation
evidence. Any new forced restart requires a separate explicit request.

## 7. Rollback

Rollback is fix-forward or selective restoration of the prior split templates
and skill behavior. It must preserve legacy `not-found` and must never restore
the legacy unit, startup script, or normal-deploy legacy control flow. Do not
apply a whole-commit revert that would reinstall the retired owner.

If a split application release is bad, install the previous Polygram or Water
version and restart only its owning unit. If an infrastructure template is bad,
restore the previous split template and daemon-reload. Restoring
`shumabit-sessions.service` requires a new explicit migration decision because
it reintroduces the blast radius this change removes.

## 8. Success criteria

- The VPS has no legacy unit file or startup script.
- Ansible has one runtime topology and cannot render or enable the monolith.
- Normal Polygram and Water deploy paths cannot select a legacy restart.
- Claude and Codex share one current Shumabit control skill.
- Active documentation no longer tells an operator to use the default tmux
  server or the deleted local user.
- Production owners and sessions remain isolated through unchanged-invocation
  and readiness verification.
