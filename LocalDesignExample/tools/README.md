# tools/ — bundled pipeline scripts (ngspice channel)

Verbatim copies of the suite plugins' script subsets used by this local example
(version 0.1.0). Two sources since the 2026-11-01 redistribution (the analysis
scripts moved to this repo's `src/scripts/common/`, the simulator code stays in
HarnessAMS-SmartAnaSim):

- from `HarnessAMS/src/scripts/common/` (this repo, the `dsh-harnessams` package):
  - `common/common_workspace.py` — harnessams.json discovery and small JSON helpers
    (a byte-identical copy also ships with SmartAnaSim; keep all copies in sync)
  - `common/common_collect_results.py` — results.json aggregation
  - `common/common_gen_sweep_report.py` — interactive HTML report (workspace-level shared
    Plotly, seeded from the repo-level master copy)
  - `common/common_trash.py` — safety-by-default trash
- from `HarnessAMS-SmartAnaSim/scripts/` (the simulator plugin):
  - `common/common_units.py` — length/frequency/current/count normalization, bias < Vdd
  - `common/common_sweep_engine.py` — combinations, @@PARAM@@, point dirs, progress
  - `ngspice/ngspice_sweep_worker.py` — local ngspice batch sweep worker
  - `ngspice/ngspice_checks.py` — assembly-layer checks (re-exports the unit helpers)

Sync rule: whenever either source `scripts/` tree changes, re-copy the matching
files here and keep them byte-identical. The `sim_scripts_dir` field of the
parent `../harnessams.json` points at this directory (the script-sync check
walks it recursively); a project assembly script imports the check library from
`<sim_scripts_dir>/ngspice/`.
