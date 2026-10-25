# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Changed

- The console moved from the `/harnessams/ui` page into the DSH client UI as a
  three-tier interface (the page route is gone; every JSON API stays):
  - **Tier 1 — global console page**: a "HarnessAMS" entry in the left sidebar
    (next to Plugins / Automation tasks) opens a full panel with server management
    (nodes.yaml CRUD with whole-file rewrite on save, per-node health checks with the
    one-click agent-diagnosis prompt, and dsh-remote alignment showing the machine
    registry and which node HOSTs are known there), digital assets (plotly asset
    status + the workspace report library), and local disk usage. Each section is
    isolated by an error boundary.
  - **Tier 2 — project = DSH workspace**: a project is nothing more than a DSH
    workspace (a local folder) resolved through `ctx.workspaceRegistry`; per-project
    task data lives at `<workspace>/.harnessams/tasks.json`. Sessions are deliberately
    not modeled — every session of a workspace shares the same task list.
  - **Tier 3 — task sidebar**: a right-sidebar tab (registered via
    `sidebarRightTabs` + the keyed `sidebar.right.pane.tab` slot) with a task tab
    strip per project ("+" to create, × to delete), an in-task sub-navigation
    (Overview / Dashboard / Sim settings — the latter two are placeholders), and a
    conversation-header button that opens the tab and re-opens it on session
    switches while pinned (📌), so the sidebar follows workspace switches instead
    of collapsing. Verified against DSH 0.2.1-rc.2 web.
- Host half split into `src/server/` modules (`workspace` / `checks` / `disk` /
  `project` / `machines` / `assets`); `src/index.js` is now route assembly only.
- New routes: `GET /api/project?sessionId=`, `GET|PUT /api/tasks?sessionId=`,
  `GET /api/machines` (dsh-remote presence via the `rw_machines` tool shell with a
  same-origin HTTP fallback), `GET /api/assets`, and the static
  `GET /harnessams/assets/plotly.min.js` (whitelisted, immutable cache) — the
  single shared plotly copy is now servable in-app, not only shipped for offline
  reports.

### Added

- `src/client.js`: the browser half — a single-file classic script registered on
  `window.__ModuleLoader__` (no build chain; React via the loader's synchronous
  `require`), declared through `dsh.client` + `exports["./client"]`.

### Removed

- The self-contained `UI_HTML` console page and the `/` and `/ui` routes.

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
