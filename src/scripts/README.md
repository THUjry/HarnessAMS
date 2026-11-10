# scripts/

Python assets shipped inside the `dsh-harnessams` package, executed by the plugin's model tools via `src/py.js` (`runPython`, fresh system-Python process per call).

- `selfcheck/` — the project self-check compute twins (`selfcheck_verify.py` + `selfcheck_verify.mjs`), spawned by `src/server/selfcheck.js`.

The former generic analysis pipeline under `common/` became pure JS on 2026-11-10: the collect/report steps live in `src/tools/sim_analysis.js` now (spawned by no one — the tool calls them as functions). The three retired `common_*.py` files stay beside this README renamed with a `_dont_use_` prefix for reference; they are excluded from the npm tarball (`files` whitelist in `package.json`, checked in `PUBLISH.md`). The "byte-identical `common_workspace.py` copy shared with SmartAnaSim" rule died with the rename — the SmartAnaSim copy (`scripts/common/` there) is the single live version and evolves on its own; it is also what `batch_submit` uploads remotely (via the workspace `sim_scripts_dir`), so this directory has never participated in remote runs.

(The former `common/common_trash.py` had already moved into the JS module `src/trash.js` on 2026-11-09.)

Anything placed here is governed by the `files` whitelist in `package.json` and the must-contain / must-not-contain checks in `PUBLISH.md` at the repo root.
