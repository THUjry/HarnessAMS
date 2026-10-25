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
     modules), `cordis.patch.yml`, `assets/` (`plotly.min.js` about 4.6 MB +
     `THIRD_PARTY_NOTICES.md` — the Plotly MIT attribution travels with the asset),
     `scripts/` (currently a placeholder README only), plus `package.json` (npm always
     includes it).
   - Must NOT contain: `LocalDesignExample/` (the ~21 MB vendored simulation environment —
     the biggest leak risk), `docs/`, `tests/`, `install_suite/`, `.gitattributes`, or the
     repo-root README/AGENTS/CHANGELOG (running from `src/` keeps them out).
   - `dsh-harnessams-suite` (run in `install_suite/`) must contain exactly `cordis.patch.yml`
     (plus `package.json`); nothing else.
3. Publish
   - `npm publish` from the package directory.
4. Post-publish verification
   - `dsh plugin --profile web add <package>`, restart the profile (`dsh --profile web`),
     confirm the console routes / tools register (`--dump-config` shows the rows).
5. Suite last
   - `dsh-harnessams-suite` pins the exact published versions of the member plugins;
     bump and publish it only after **both** plugin packages are out.

Dev-time usage without publishing: see the "Dev-time mount" section of the README.
