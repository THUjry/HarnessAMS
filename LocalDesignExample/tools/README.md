# tools/ — bundled pipeline scripts

Verbatim copies of the HarnessAMS-SmartAnaSim plugin's `scripts/` (version 0.1.0):

- `sweep_worker_ngspice.py` — local ngspice batch sweep skeleton
- `checks.py` — assembly-layer checks
- `collect_results.py` — results.json aggregation
- `gen_sweep_report.py` — interactive HTML report (workspace-level shared Plotly, seeded
  from the repo-level master copy)
- `trash.py` — safety-by-default trash

Sync rule: whenever the plugin's `scripts/` change, re-copy them here and keep the two
sets byte-identical. The `sim_scripts_dir` field of the parent `../harnessams.json` and
the demo projects under `../demo1` and `../demo2` point at this directory.
