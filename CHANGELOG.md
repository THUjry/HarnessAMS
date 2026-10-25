# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.1.0] - 2026-10-25

First release (stage 1 scope; not yet published to npm).

### Added

- Top-level console plugin `dsh-harnessams` (`src/`): self-contained HTML
  console plus JSON APIs under `/harnessams` — server health checks (local items directly,
  remote nodes through a fixed command set over BatchMode ssh), local disk usage and
  capacity, workspace directory management, and embedded read-only static report serving.
- Aggregate bundle `dsh-harnessams-suite` (`install_suite/`): one-command install of the
  first-party plugins (pure patch package that restates every member row).
- `src/assets/plotly.min.js`: the single shared plotly.js v3.0.1 copy for the whole project
  tree (offline report rendering; never duplicated elsewhere) plus its third-party notice —
  shipped inside the `dsh-harnessams` tarball.
- `src/scripts/` (developer utilities shipped with the package; currently a placeholder) and
  `tests/` (starter unit tests, bare `node --test` from the repo root: plugin metadata +
  prefix-route registration via mock ctx).
- `LocalDesignExample/`: a self-contained local simulation environment checked into the
  repo — ngspice-47 portable (console binary + runtime DLLs), sky130 fossi minimal model
  closure, verbatim copies of the SmartAnaSim pipeline scripts, an example
  `harnessams.json` with relative paths, an all-commented `nodes.yaml` template, and an
  environment self-check (`check_environment.py`).
  Demo project directories (`demo1/`, `demo2/`) are placeholders; their content lands with
  the demo milestones.
- Workspace config contract: `harnessams.json` is discovered by walking upward (bare form,
  or inside `harnessams-workspace/`); relative path fields resolve against the config
  file's directory.
