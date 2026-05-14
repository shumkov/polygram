# tmux-spike — 0.10.0 Phase 0 verification scripts

Throwaway. Lives on the `0.10.0-spike` branch. Per `docs/0.10.0-process-manager-abstraction-plan.md` §7.0.

Each script verifies one or more gates (G1-G18). Output:
`docs/0.10.0-phase0-spike-findings.md` with PASS/FAIL/DEFER + measured
numbers per gate.

## Layout

```
scripts/tmux-spike/
├── README.md                 (this file)
├── runner.js                 (shared tmux wrapper used by all spike scripts)
├── g1-g2-launch-resume.js    (G1 + G2)
├── g3-keychain.js            (G3 — needs production-like launchd context)
├── g4-g6-control-flow.js     (G4 + G5 + G5b + G6 — turn boundary detection)
├── g7-g18-events.js          (G7 + G18 — event channel)
├── g8-inject-protocol.js     (G8 — 8 mid-turn scenarios — most expensive)
├── g9-g12-slash-lifecycle.js (G9-G12 — slash commands + visual)
├── g13-hook-ipc.js           (G13 — PreToolUse hook → mock polygram)
└── g14-g17-misc.js           (G14-G17 — orphan / parse / model / paste)
```

## Convention

- Each script exits 0 on PASS, 1 on FAIL, 2 on DEFER.
- All scripts emit JSON-Lines to stdout: `{"gate":"G1","status":"PASS","detail":{...}}`.
- All scripts clean up their tmux sessions on exit (tagged `spike-*` so easy to grep).
- Real claude calls cost real Anthropic credits — run sparingly. Each script reports its expected cost in the header comment.

## Run

```bash
# Run one gate:
node scripts/tmux-spike/g1-g2-launch-resume.js

# Run all (in dependency order):
for f in scripts/tmux-spike/g*.js; do node "$f" || break; done
```

## Findings doc

Each gate's outcome lands in `docs/0.10.0-phase0-spike-findings.md` as
either:
- PASS — proceed per spec
- FAIL — recovery path per §11 decision tree
- DEFER — measured, but the design choice it informs can be made later
