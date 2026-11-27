# scripts/

Python assets shipped inside the `dsh-harnessams` package, executed by the plugin's model tools via `src/channel/py.js` (`runPython`, fresh system-Python process per call).

- `selfcheck/` — the project self-check compute twins (`selfcheck_verify.py` + `selfcheck_verify.mjs`), spawned by `src/core/selfcheck.js`.

The retired `_dont_use_*` reference copies that used to sit under `common/` were deleted (2026-11-27): never executed, excluded from the npm tarball, and drifted from the SmartAnaSim live tree. The live `common_workspace.py` is the SmartAnaSim package's own `scripts/common/` copy — it is what `batch_submit` uploads remotely (via the workspace `sim_scripts_dir`); the report pipeline is pure JS (`src/tools/gen_report.js`) and trash is the JS module `src/tools/trash.js`.

Anything placed here is governed by the `files` whitelist in `package.json` and the must-contain / must-not-contain checks in `PUBLISH.md` at the repo root.
