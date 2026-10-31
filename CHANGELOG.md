# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Changed

- **Sidebar localized to local projects + columned check results (2026-10-27)**:
  - Remote projects now render **no HarnessAMS sidebar** (they are connection
    anchors; remote files are browsed with dsh-remote itself). The tab body shows a
    one-line bilingual note, the task/check fetches are skipped, and the pinned
    auto-reopen skips remote sessions (`GET /api/project?sessionId=` gained a
    `remote` flag; a freshly switched session that is not yet workspace-associated
    is retried briefly and treated as remote — suppressing once beats opening
    wrongly).
  - The four remote checks moved into the **local project's** Overview as one block
    per machine that has a remote project (`GET /api/checks` now answers
    `machines[]` with identity, remote area, mirror, and the remote project's
    live-session count; `GET /api/checks/run` takes `machineId` and borrows a live
    session of that machine's remote project via `sessionInMirror` — 409 with
    guidance when none is live; `agentForSession` and the remote-project check
    path are gone).
  - Check results render as **columned tables** instead of joined text: load
    (1/5/15 min, procs, CPUs), LSF jobs (job id, stat, exec host, name, submit
    time — column layout read from the bjobs header so variant headers like
    zscheduler's extra FROM_CLUSTER/EXEC_CLUSTER columns parse correctly, capped
    at 30 rows), batch dirs (directory, status, progress with the workspace-scope
    prefix abbreviated to `$ROOT` plus a legend line), and script sync (file,
    state). Unparseable output falls back to the previous raw-text rendering.
- **Report plotly delivery reworked (2026-10-27, D-001 in `docs/decisions.md`)**:
  report generators seed a single workspace-level
  `<workspace_root>/assets/plotly.min.js` from the shipped master copy
  (`src/assets/plotly.min.js`, refreshed on size mismatch) and reference it with a
  workspace-relative `src` — previously each generated report carried its own 4.6 MB
  copy. The CDN remains the last-resort fallback, and the in-app
  `/harnessams/assets/plotly.min.js` route is unchanged.
  `LocalDesignExample/tools/` re-synced accordingly.
- **Business-logic rework (2026-10-26): remote connectivity is delegated entirely to
  dsh-remote.** The Servers feature is gone (nodes.yaml registry + the BatchMode
  OpenSSH fallback channel + their routes), replaced by the remote-project model:
  - **Remote projects** (`src/server/remote.js`): a DSH workspace whose path lies
    inside a dsh-remote local mirror (`~/.dsh/remote-workspaces/<host>-<user>-<port>/
    <ws>`, detected by walking up to the nearest `.dsh-remote-meta.json`). One remote
    project per machine is the recommended setup; tier 1 lists the machines and
    creates their remote projects in one click (`POST /api/remote-project`: ensure
    the mirror via dsh-remote's same-origin `/dsh-remote/mirror` with forwarded
    session credentials, then register the mirror directory through
    `workspaceRegistry`). Sessions of a remote project bind dsh-remote's `rw_*`
    tools to that machine; a local project borrows one through `sessionInMirror`
    (the Overview checks are that path; remote simulation will reuse it). The
    mirror's `remotePath` is
    the scope boundary for every remote command. Remote file browsing/editing is
    deliberately NOT duplicated — dsh-remote's own tools and web surface do it.
  - **Overview health checks (tier 3)**: the check UI moved from the tier-1 Servers
    section into the task sidebar's Overview sub-view, one button per function
    (`GET /api/checks?sessionId=` describes the surface, `GET /api/checks/run`
    runs one). Four remote buttons — **Load** (`/proc/loadavg` + core count),
    **LSF jobs** (`bjobs -a`, bounded by `timeout 10`), **Batch dirs** (work dirs
    carrying a `sweep_progress.json` with status/completed/total, bounded by
    `timeout 15 find -maxdepth 4` + head), and **Script sync** (md5 drift between
    the configured local `sim_scripts_dir` and the remote workspace root — report
    only, nothing uploaded) — plus the local environment report. Checks execute
    through the `rw_exec` tool shell; the agent context is a real live session
    whose cwd sits inside the target machine's mirror (binding without touching
    the global active machine). See the 2026-10-27 entry above for where the
    buttons live now and how results render.
- The console moved from the `/harnessams/ui` page into the DSH client UI as a
  three-tier interface (the page route is gone; every JSON API stays):
  - **Tier 1 — global console page**: a "HarnessAMS" entry in the left sidebar
    (next to Plugins / Automation tasks) opens a full panel with remote projects
    (dsh-remote machine list with mirror and remote-project state, one-click
    creation), digital assets (plotly asset status + the workspace report
    library), and local disk usage. Each section is isolated by an error boundary.
  - **Tier 2 — project = DSH workspace**: a project is nothing more than a DSH
    workspace (a local folder) resolved through `ctx.workspaceRegistry`; per-project
    task data lives at `<workspace>/.harnessams/tasks.json`. Sessions are deliberately
    not modeled — every session of a workspace shares the same task list.
  - **Tier 3 — task sidebar**: a right-sidebar tab (registered via
    `sidebarRightTabs` + the keyed `sidebar.right.pane.tab` slot) with a task tab
    strip per project ("+" to create, × to delete), an in-task sub-navigation
    (Overview with the health-check panel / Dashboard / Sim settings — the latter
    two are placeholders), and a conversation-header button that opens the tab and
    re-opens it on session switches while pinned (📌), so the sidebar follows
    workspace switches instead of collapsing. Verified against DSH 0.2.1-rc.2 web.
- Host half split into `src/server/` modules (`workspace` / `checks` / `disk` /
  `project` / `machines` / `remote` / `assets`); `src/index.js` is now route
  assembly only.
- New routes: `GET /api/project?sessionId=`, `GET|PUT /api/tasks?sessionId=`,
  `GET /api/machines` (dsh-remote machine list via the `rw_machines` tool shell
  with a same-origin HTTP fallback), `GET /api/checks(+/run)?sessionId=` (Overview
  health-check surface), `POST /api/remote-project`, `GET /api/assets`, and the
  static `GET /harnessams/assets/plotly.min.js` (whitelisted, immutable cache) —
  the single shared plotly copy is now servable in-app, not only shipped for
  offline reports.
- Fixed the dsh-remote probe (it always reported "not available" on 2026-10-25
  builds): `tools.execute` requires a `callId` and an `AbortSignal` (the pipeline
  crashes reading `signal.aborted` otherwise — verified against dsh-tools
  0.2.1-rc.2), `rw_machines` answers with a text listing rather than JSON (parsed
  accordingly), the two channels now fail independently instead of the first
  exception hiding the second, and the HTTP fallback forwards the browser's
  cookie/authorization headers because the `/dsh-remote/*` surface sits behind
  the DSH web auth gate. A fabricated `{session:{header:{cwd}}}` agent does not
  survive the tool pipeline (the session is validated against the live store) —
  real sessions from the host `sessions` service are used instead. Coupling points
  locked for the dsh-remote 0.8.51 pin: the `agent.session.header.cwd` binding
  shape, the `rw_machines` text format, and the `rw_exec` result text (stdout +
  `-- stderr --` + `[exit code: N]` / timeout markers).

### Added

- **Bilingual display (zh/en)**: client copy is locale-owned — every console UI
  string moved into a keyed zh/en dictionary in `src/client.js` (`{param}`
  interpolation; lookup order: DSH locale service → browser language → English, so
  a missing key renders English, never the raw key). `apply()` now injects the
  `locale` service and registers the dictionary via `locale.register`/`locale.bind`
  (dsh-remote-style), so the language follows the client's Language setting.
  Plugin-manager metadata is localized through the verified 0.2.1-rc.2 contract:
  `exports["./locale/*.json"]` + `src/locale/en.json`/`zh.json` carrying
  `{ "meta": { "title", "description" } }`; package.json `name`/`description`
  remain the English fallback. Server responses (API errors, check item names)
  and the one-click diagnosis prompt stay English by design (technical /
  model-facing text).

- `src/client.js`: the browser half — a single-file classic script registered on
  `window.__ModuleLoader__` (no build chain; React via the loader's synchronous
  `require`), declared through `dsh.client` + `exports["./client"]`.

### Removed

- The self-contained `UI_HTML` console page and the `/` and `/ui` routes.
- **The Servers feature** (2026-10-26 rework): nodes.yaml CRUD (`PUT|GET
  /api/nodes`, the workspace.js parser/validator/writer), the BatchMode ssh check
  channel (`GET /api/check?node=`, `sshRun`/`runNodeChecks`), `GET
  /api/check-remote?machine=` and `GET /api/check-local` (superseded by
  `/api/checks(+/run)`), the all-commented `LocalDesignExample/nodes.yaml`
  template, and the seven-item remote command set (connect/load/mem/disk/ws/
  ngspice/du) in favor of the four Overview buttons.

### Fixed

- **Terminal sub-tab paint lifecycle (2026-10-31, browser-verified end-to-end
  against node1)**: two defects found in the live run —
  - The default-active machine connected but never painted (typing worked
    remotely, nothing showed): the runtime effects (output polling, resize,
    reopen, search) read `activeIdRef`, which mirrored the raw `activeId` click
    state (null until a machine tab is clicked), while rendering and connecting
    used the fallback-resolved `activeIdSafe`. The ref now mirrors
    `activeIdSafe`, so effects follow the machine the user actually sees.
  - Every sub-tab/session switch duplicated the whole visible buffer: a pooled
    xterm reattaching to its still-live PTY replayed dsh-remote's ring from
    offset 0 without clearing. A same-PTY reattach now keeps the polling offset
    (delta-only append); a different PTY resets the term before replaying its
    ring, and a fresh open on a reused pooled term resets the previous PTY's
    screen. Regression assertions added to `tests/terminal.test.mjs`.
- **Remote Overview checks on dsh-remote 0.8.66 (2026-10-31)**: the borrowed
  session agent now carries `id` alongside `session` (`sessionInMirror`) —
  rw_exec derives the background-job owner from `exec.agent.id`, so the old
  id-less wrapper made the tool shell fail before any command ran. rw_exec is
  now called with `promoteOnTimeout:false` (a borrowed agent has no job
  controller, so a promoted command would be stranded on the remote) and its
  AbortSignal sits 30 s above the requested `timeoutMs`, so the tool's own
  timeout marker surfaces instead of a client-side abort.

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
