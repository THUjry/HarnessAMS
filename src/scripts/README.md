# scripts/

Generic analysis pipeline shipped inside the `dsh-harnessams` package (moved from the SmartAnaSim plugin 2026-11-01, which now ships simulator code only). Spawned by the plugin's model tools via `src/py.js` (`runPython`, fresh system-Python process per call).

- `common/common_collect_results.py` — aggregate `NN/point_meta.json` into `results.json` (sim_analysis collect step)
- `common/common_gen_sweep_report.py` — render `sweep/Round*/top/results.json` into the Plotly HTML dashboard (sim_analysis report=true step)
- `common/common_workspace.py` — harnessams.json discovery + atomic JSON helpers; a byte-identical copy also ships with SmartAnaSim (`scripts/common/` there — the sweep workers import it). Keep all copies identical.

(The former `common/common_trash.py` moved into the JS module `src/trash.js` on 2026-11-09 — the safe_trash tool no longer spawns Python.)

These scripts never run remotely: `batch_submit` uploads the WORKER tree from the workspace `sim_scripts_dir` (the SmartAnaSim plugin's `scripts/`), not this directory. Anything placed here is published with the package tarball — see the `files` whitelist in `package.json` and the must-contain / must-not-contain checks in `PUBLISH.md` at the repo root.
