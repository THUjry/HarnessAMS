# scripts/

Python assets shipped inside the `dsh-harnessams` package, executed by the plugin's model tools via `src/py.js` (`runPython`, fresh system-Python process per call).

- `selfcheck/` — the project self-check compute twins (`selfcheck_verify.py` + `selfcheck_verify.mjs`), spawned by `src/server/selfcheck.js`.
- `common/` — retired reference copies of the analysis pipeline, prefixed `_dont_use_`: never executed and excluded from the npm tarball (`files` whitelist in `package.json`, checked in `PUBLISH.md`). The live analysis pipeline is pure JS (`src/tools/sim_analysis.js`, collect/report) and trash is the JS module `src/trash.js`. The single live `common_workspace.py` is the SmartAnaSim package's own `scripts/common/` copy — it is what `batch_submit` uploads remotely (via the workspace `sim_scripts_dir`), so this directory does not participate in remote runs.

Anything placed here is governed by the `files` whitelist in `package.json` and the must-contain / must-not-contain checks in `PUBLISH.md` at the repo root.
