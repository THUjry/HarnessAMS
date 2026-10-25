# LocalDesignExample

A self-contained local simulation environment: everything a fresh clone needs to run
sky130 / ngspice simulations with zero external downloads — binaries, models, report
assets, pipeline scripts, workspace config, and a self-check.

## Quick start

```
python check_environment.py
```

The self-check (1) audits the bundled assets, (2) runs the bundled ngspice on a minimal
sky130 netlist end-to-end, and (3) reads the workspace config. All green = ready.

## Layout

- `ngspice-47-portable/` — ngspice-47 console binary + the 3 runtime DLLs (Windows x64;
  see its README for the original package, what was trimmed, and non-Windows guidance)
- `sky130/` — fossi sky130_fd_pr minimal model closure (`combined_models/` + `cells/`)
  with its Apache-2.0 LICENSE (see its README for the upstream repository and the
  trimming rationale)
- offline report asset: the repo-level `../src/assets/plotly.min.js` (the single shared copy
  for the whole project, shipped inside the `dsh-harnessams` package; the report generator
  discovers it by walking up)
- `tools/` — verbatim copies of the SmartAnaSim pipeline scripts (see `tools/README.md`)
- `harnessams.json` — workspace config; all paths relative to this file
- `demo1/`, `demo2/` — demo project placeholders (content lands with the demo milestones)
- `check_environment.py` — the self-check
- `THIRD_PARTY_NOTICES.md` — bundled components and their licenses

## Using it as a workspace

This directory is a valid HarnessAMS workspace: `harnessams.json` sits at its root, and
both the console plugin and the Python pipeline discover it by walking upward from
wherever they run. Relative path fields resolve against the config file, so the clone
location does not matter. With the DSH plugins installed, a DSH session pointed at a demo
directory here drives the `sim_*` tools against this environment unchanged.

## Licenses

Third-party components and their licenses: see `THIRD_PARTY_NOTICES.md` (ngspice BSD-3,
sky130 Apache-2.0) and `../src/assets/THIRD_PARTY_NOTICES.md` (the shared plotly.min.js, MIT).
The repository's own code is MIT (top-level LICENSE).
