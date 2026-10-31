# tools/ — bundled pipeline scripts (ngspice channel)

Verbatim copies of the HarnessAMS-SmartAnaSim plugin's `scripts/` subset used by
this local example (version 0.1.0). The plugin keeps the same
`scripts/{common,ngspice,spectre,snp}/` layout; this directory mirrors the
`common/` + `ngspice/` part needed by a local ngspice run:

- `common/common_workspace.py` — harnessams.json discovery and small JSON helpers
- `common/common_units.py` — length/frequency/current/count normalization, bias < Vdd
- `common/common_sweep_engine.py` — combinations, @@PARAM@@, point dirs, progress, bestPoints
- `common/common_collect_results.py` — results.json aggregation
- `common/common_gen_sweep_report.py` — interactive HTML report (workspace-level shared
  Plotly, seeded from the repo-level master copy)
- `common/common_trash.py` — safety-by-default trash
- `ngspice/ngspice_sweep_worker.py` — local ngspice batch sweep worker
- `ngspice/ngspice_checks.py` — assembly-layer checks (re-exports the unit helpers)

Sync rule: whenever the plugin's `scripts/` change, re-copy the matching files here
and keep them byte-identical. The `sim_scripts_dir` field of the parent
`../harnessams.json` points at this directory (the script-sync check walks it
recursively); a project assembly script imports the check library from
`<sim_scripts_dir>/ngspice/`.
