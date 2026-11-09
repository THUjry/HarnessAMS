# Publishing the HarnessAMS packages

Two npm packages are published from this repository; the simulation plugin is published
from its own repository.

| Package | Directory |
|---|---|
| `dsh-harnessams` | `src/` |
| `dsh-harnessams-suite` | `install_suite/` |
| `dsh-harnessams-smart-ana-sim` | separate repo `HarnessAMS-SmartAnaSim` |

Checklist (per package, run from the package directory):

1. Version and records
   - Bump `version` in the package `package.json` (semver).
   - Add a `CHANGELOG.md` entry (this file, top level).
   - Confirm `engines.dsh` still matches the verified DSH version. If the DSH version
     changed, re-run the minimal regression first and update `docs/compatibility.md`.
2. Package content check (must-contain AND must-not-contain)
   - `dsh-harnessams` (run in `src/`) must contain exactly: `index.js`, `client.js` (the
     browser half — combo-loaded classic script, single file), `server/` (host-half
     modules), `tools/` + `tool.js`/`py.js`/`bsub.js`/`remote.js`/`trash.js` (the 6 model
     tools: `batch_submit`/`batch_poll`/`batch_fetch` + `sim_analysis`/`sim_progress`/
     `safe_trash`), `cordis.patch.yml`, `assets/` (`plotly.min.js` about 4.6 MB + the vendored
     xterm bundle — `xterm.js`, `xterm.css`, `xterm-addon-fit.js`, `xterm-addon-search.js`
     — + `THIRD_PARTY_NOTICES.md`; the Plotly and xterm attributions travel with the
     assets), `scripts/common/` (3 `.py`: `common_collect_results.py`,
     `common_gen_sweep_report.py` + a byte-identical
     `common_workspace.py` copy), `scripts/selfcheck/` (2 files:
     `selfcheck_verify.py` + `selfcheck_verify.mjs` — the self-check compute twins),
     `selfcheck/` (the RC self-check assets: `script/analysis/gen_selfcheck_rc.py` +
     `golden/` — 36 files, about 386 KB, the analytic 3×3 psfascii golden dataset),
     plus `package.json` (npm always includes it).
   - Must NOT contain: any vendored simulator binaries or PDK model files (the former
     `LocalDesignExample/` bundle was removed from the repo on 2026-11-02 — it must not
     reappear in the tarball), `docs/`, `tests/`, `install_suite/`, `.gitattributes`, or the
     repo-root README/AGENTS/CHANGELOG (running from `src/` keeps them out).
   - `dsh-harnessams-suite` (run in `install_suite/`) must contain exactly `cordis.patch.yml`
     (plus `package.json`); nothing else.
3. Publish
   - `npm publish` from the package directory.
4. Post-publish verification
   - `dsh plugin --profile web add <package>`, restart the profile (`dsh --profile web`),
     confirm the console routes / the 6 tools register (`--dump-config` shows the rows).
   - Verifying the remote-project routes additionally requires dsh-remote exact-pinned in
     the profile: `dsh plugin --profile web add --save-exact dsh-remote@0.8.66`.
5. Suite last
   - `dsh-harnessams-suite` pins the exact published versions of the member plugins;
     bump and publish it only after **both** plugin packages are out.

Dev-time usage without publishing: see the "Dev-time mount" section of the README.
