# Publishing the HarnessAMS packages

Two npm packages are published from this repository; the simulation plugin is published from its own repository.

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
     modules), `tools/` + `tool.js`/`py.js`/`batch.js`/`remote.js`/`trash.js`/`skills.js`/
     `report_render.js`/`figs_export.js` (the 7 model tools: `batch_submit`/
     `batch_poll`/`batch_fetch` + `gen-sweep-report`/`sim_progress`/`safe_trash` +
     `harnessams_selfcheck`; skills.js registers the bundled skills; report_render
     holds the shared chart-spec/HTML templates, figs_export the headless PNG
     pipeline with its jsdom/@napi-rs/canvas/@resvg/resvg-js runtime deps), `skills/` (the
     three bundled skills: `smart-spectre/SKILL.md`; `dca-cell-design/` — SKILL.md,
     `scripts/` ×3 calc scripts, `sky130_examples/` (template ×3 sky130 ATT netlists +
     `sky130_fd_pr__nfet_01v8_lvt.scs` + `nfet_switch.json`); `analysis-cascade-dca/` —
     SKILL.md, `scripts/gen_cascade_report.py`, `example/` (4 cell netlists + cascade
     netlist + real-simulation results JSON + report HTML); all ASCII/English, scrubbed),
     `icon.png` (the plugin-manager display icon),
     `cordis.patch.yml`,
     `assets/` (`plotly.min.js` about 4.6 MB + `THIRD_PARTY_NOTICES.md`; the Plotly
     attribution travels with the assets — the vendored xterm bundle was removed
     2026-11-14 and the notices file carries its removal note), `scripts/selfcheck/` (2 files:
     `selfcheck_verify.py` + `selfcheck_verify.mjs` — the self-check compute twins),
     `selfcheck/` (the RC self-check assets: `script/analysis/gen_selfcheck_rc.py` +
     `golden/` — 36 files, about 386 KB, the analytic 3×3 psfascii golden dataset),
     plus `package.json` (npm always includes it).
   - Must NOT contain: `scripts/common/` (the `_dont_use_*` retired reference copies —
     the `files` whitelist excludes the directory), any vendored simulator binaries or
     PDK model files (exception: the bundled sky130 example model
     `skills/dca-cell-design/sky130_examples/sky130_fd_pr__nfet_01v8_lvt.scs` —
     MIT-licensed, from the open sky130-spectre-models transcription repo, part of the
     self-contained example set), `docs/`, `tests/`,
     `install_suite/`, `.gitattributes`, or the repo-root README/AGENTS/CHANGELOG
     (running from `src/` keeps them out).
   - `dsh-harnessams-suite` (run in `install_suite/`) must contain exactly `icon.png`
     (the plugin-manager display icon) and `cordis.patch.yml` (plus `package.json`);
     nothing else.
3. Publish
   - `npm publish` from the package directory.
4. Post-publish verification
   - `dsh plugin --profile web add <package>`, restart the profile (`dsh --profile web`),
     confirm the console routes / the 7 tools register (`--dump-config` shows the rows).
     A clean first add auto-activates the bundle (CLI reconcile appends every new
     dependency that declares `dsh.bundle.patch` to `dsh.profile.bundles`); if an
     earlier add attempt failed mid-install, the dependency is no longer "new" and
     `dsh.profile.bundles` must be patched by hand (the @linxin666/dsh-ssh case — its
     ssh2 native build is always blocked once by pnpm 12 approve-builds).
   - Verifying the remote routes additionally requires @linxin666/dsh-ssh exact-pinned in
     the profile: `dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.18`.
5. Suite last
   - `dsh-harnessams-suite` pins the exact published versions of the member plugins;
     bump and publish it only after **both** plugin packages are out.

Dev-time usage without publishing: see the "Dev-time mount" section of the README.
