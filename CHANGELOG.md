# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Changed — 2026-11-10 (host upgrade re-pin)

- **`engines.dsh` re-pinned `0.2.1-rc.2` → `0.2.2-rc.1`** (src/package.json,
  install_suite/package.json): DSH 0.2.2 enforces the engines check even for
  dev-mount rows, so an exact pin that misses the running host disables the
  plugin row at startup. devDependencies (dsh-host-webserver /
  dsh-client-ui-renderer / dsh-client-locale) move to 0.2.2-rc.1 in step.
  Docs re-pinned along: README (Node >= 24.9 floor, verified-version lines),
  PUBLISH.md, docs/compatibility.md (new 0.2.2-rc.1 row), docs/plugin-index.md,
  and the dsh-remote coupling comments in src/remote.js, src/server/checks.js,
  src/server/machines.js.
- **Verified dsh-remote 0.8.66 → 0.8.83** (profile exact-pin, docs updated):
  pairs with the 0.2.2 host (0.8.74 fixes a DSH-0.2.2-only UI bug); the four
  coupling files (binding / exec-job / http-transport / remote-sandbox) show
  no change to a consumed contract. Tests 97/97 re-run green; dev-mount smoke
  (plugin rows, routes, tools, local APIs) green on the 0.2.2-rc.1 host; the
  six remote regressions (terminal + check buttons against node1) remain
  pending.

### Fixed — 2026-11-09 (code-review follow-ups)

- **Self-check verdict no longer lies in direct mode**: with `scheduler=direct`
  a failed primary submit/poll used to report `remote: "ok"` / `summary.ok:
  true` — finalize forgave primary-attempt failures unconditionally, but
  direct mode has no fallback to do the forgiving. Primary failures now fail
  the verdict unless a fallback actually completed (regression-tested).
- **Trash rewritten in JS (`src/trash.js`)**, replacing
  `scripts/common/common_trash.py`: the old `--restore`/`--purge` accepted
  `../` traversal (and purge is a recursive delete) — entry names are now
  fenced inside the trash root; trashing a plain file no longer breaks meta
  writing after the move; every entry is a directory holding the item plus
  `.trash_meta.json`.
- **Python pipeline output forced to UTF-8** (`PYTHONUTF8=1` in `runPython`):
  Python 3.14 pipes still encode by locale (cp936 on zh-CN Windows) while the
  JS side decodes utf-8 — Chinese paths in tool output used to come back as
  mojibake or crash the writer.

### Changed — 2026-11-09 (batch tool rename)

- **`bsub_submit`/`bsub_poll`/`bsub_fetch` renamed to
  `batch_submit`/`batch_poll`/`batch_fetch`** and the scheduler value `none`
  renamed to `direct` (0.1.0 was never published; no aliases, matching the
  earlier `sim_*` → `spectre_*` precedent). Stored settings with the legacy
  `scheduler: "none"` migrate to `direct` on read; legacy job files are
  normalized in `batch_poll`.
- **The self-check "restore latest run" surface was removed**: the global
  latest run (memory + newest-on-disk scan) bled verdicts across projects —
  project B's Overview displayed and live-polled project A's run. `GET
  /api/selfcheck` now requires an id; the client only polls a run it started.
- Tests: 92 → 97 (a trash module suite ×4 and the direct-mode verdict
  regression; the id-less GET 400 and the scheduler migration assertions fold
  into existing tests).

### Changed — 2026-11-09 (test suite dedup)

- **Shared test scaffolding extracted to `tests/helpers.mjs`** and five
  dedup/relaxation passes over the suite (93 → 92 cases, ~120 net lines
  removed; zero coverage loss, 92/92 green):
  - the `rw_*` text-protocol assertions (parseRwMachinesText /
    parseRwExecText) that ran in both `bsub.test.mjs` and `server.test.mjs`
    now live only in the fuller `server.test.mjs` contract suite;
  - the fake-res + macrotask route driver (dashboard/diagnose/progress/
    selfcheck), the `bash -n` guard (server/selfcheck) and the DSH_HOME
    mirror fixture (bsub/diagnose/selfcheck) are single implementations in
    the helper;
  - the per-key "exactly twice (zh+en)" dictionary loops in diagnose/guide/
    terminal/selfcheck fold into one `assertDictKeys` helper (the full
    key-set equality check stays in entry.test.mjs);
  - statement-level source pins relaxed to semantic anchors (terminal's
    `setInterval(tick, 150)` / same-PTY reattach block, selfcheck's
    `}, 3_000)`); the selfcheck upload-count pin now derives its expectation
    from the shipped golden tree instead of the hardcoded 42;
  - all regression nails (callId/signal, persist chain, promoted job, bjobs
    layouts, LSF exit 255, `api/api` double prefix, ...) are kept verbatim.

### Fixed — 2026-11-09 (project self-check launch verification findings)

- **Corrupted `selfcheck_run.json` under concurrent persists**
  (`src/server/selfcheck.js`): every step queued a fire-and-forget
  `persistRun`, and two overlapping writes shared
  `selfcheck_run.json.tmp` — interleaved writeFile/rename ordering could
  publish a concatenated document (head of one snapshot + tail of the next;
  observed live on 2 of 7 real runs, breaking the restore-from-disk path while
  the in-memory API stayed healthy). Persists now serialize through a per-run
  promise chain (`run._persistChain`), so only one tmp write is ever in
  flight; a failed write cannot stall the queue. Regression test: a golden run
  is hammered with reads while it executes and every published snapshot must
  parse, plus the drained final file must match the run verdict.
- **Settings table could not reach remote mode** (`src/client.js`
  `updateSetting`): the machine column only renders when `run_mode=remote`, so
  switching to remote with no machine selected PUT-400'd
  (`run_mode=remote requires machine_id`) and rolled straight back to local —
  a deadlock that made remote unreachable from the UI. Switching to remote now
  auto-picks the first machine (`machines[0].id`) into the same PUT when
  `machine_id` is unset; the client static contract test pins the guard.

### Added — 2026-11-09 (simulation progress tool cards)

- **Session tool cards** (`tool.call.toolview` — the last open item of milestone
  M3): the eight simulation tools render dedicated progress cards in the
  conversation instead of the generic JSON card — `bsub_submit`/`bsub_poll`/
  `bsub_fetch`, `sim_progress`/`sim_analysis`, `spectre_assemble`/
  `spectre_run_sweep`/`spectre_parse` (`SIM_CARD_TOOLS` in client.js, registered
  as keyed slot entries by exact wire tool name; SmartAnaSim stays client-free —
  keyed matching is by name across plugins). Cards carry a status badge, a
  progress bar plus succeeded/failed/pending counts, a collapsible cross-batch
  aggregate table ("N/M batches done · X/Y sims · Z pending"), and an expandable
  raw-JSON details view. A local sweep in flight polls `/api/progress` every 3 s
  (visibility pause/resume, same discipline as the sidebar polls) so the card
  grows live while the tool call blocks; settled cards fetch the project
  aggregate once from `/api/progress-summary` (local view only — remote batches
  surface after `bsub_fetch`, matching the `sim_progress` dual-window semantics).
- **Read-only progress endpoints** (`src/server/progress.js`): `GET
  /api/progress?runDir=…` normalizes one run directory through a
  sweep_progress.json → .worker_started → sweep_config.json ladder (BOM-tolerant;
  pre-2026-10 progress files without `simulator` accepted). `GET
  /api/progress-summary?runDir=…|projectDir=…` derives the project root from the
  run dir's `sweep/RoundN/top` shape and aggregates `sweep/Round*/top`
  (≤64 batches) into per-batch rows plus totals (batches / done / unplanned,
  sims total / completed / failed / pending). Pure file reads; paths that do not
  exist on this host answer `local:false` and the client omits the block quietly.
- **Display toggle + guide section**: the console page gains a Display settings
  block switching the cards off (default on; localStorage `hams-toolview`; a
  custom event flips already mounted cards without a reload — the off state
  renders the raw shape itself because an occupied key cannot fall back to the
  DSH generic card), and the onboarding guide gets a sixth section covering the
  cards. The zh/en dictionary key sets are now pinned equal by a test.
- Tests: `tests/progress.test.mjs` (4 cases — root derivation, the progress
  ladder incl. BOM, the project summary totals, both endpoints) and
  entry-test extensions (toolview slot + the eight exact keys against the
  model-facing tool surface, toggle/guide markers, zh/en key-set parity).
  `tests/selfcheck.test.mjs` probes its 404 through an explicit unknown run id
  now, so real self-check runs on disk no longer break the no-run assertion
  (hermeticity; the checked contract is unchanged).

### Added — 2026-11-08 (project settings + one-click project self-check)

- **Per-project settings** at `<workspace>/.harnessams/project_settings.json`
  (`run_mode` local/remote, `machine_id`, `remote_dir`, `scheduler` lsf/none,
  `simulator` spectre/none, `compute_script_local`/`compute_script_remote`
  python/js; `src/server/settings.js` validates and persists atomically;
  `GET`/`PUT /api/project-settings`). The Overview renders them as a two-row
  table — row 1 = the live settings (dropdown cells, PUT on every change), row 2
  = that setting's self-check verdict — with columns cascading off the
  mode/simulator choices (local hides machine/scheduler/remote-compute;
  simulator=none hides the scheduler) and a working-directory line above the
  table that always shows `local` or the bound remote directory (browse-picked
  through the machine's local mirror via `/api/browse`, converted back to a
  remote path; manual input accepted).
- **Project self-check** (`POST`/`GET /api/selfcheck`, orchestrator in
  `src/server/selfcheck.js`): one button walks the whole pipeline under the
  CURRENT settings to verify machine, connection, environment, permissions,
  tools and compute — plain server code, no LLM in the flow. With
  `simulator=spectre` it runs the ideal-component RC low-pass/high-pass
  testbench (3×3 r×c grid, no PDK; `spectre_assemble` → `spectre_run_sweep` →
  `spectre_parse` → pointwise verify; remotely via `bsub_submit`/`bsub_poll` →
  remote parse+verify → `bsub_fetch` + local cross-check, an LSF failure is
  diagnosed immediately and retried once with `scheduler=none`, verdict
  `ok-via-fallback`). With `simulator=none` no simulation runs: the bundled
  analytic golden dataset (`src/selfcheck/golden/`, 36 psfascii files,
  regenerable byte-identically by `tests/golden_gen.py`) replays parse + compute
  locally, or upload → remote compute → download + cross-check remotely.
  Verification is pointwise (every frequency sample vs the analytic RC response,
  1% tolerance) implemented twice with one contract — `selfcheck_verify.py` and
  `selfcheck_verify.mjs` (the local js channel imports it in-process; the remote
  js channel needs `node` on the remote host, `remote_node` workspace key).
  Verdicts are artifact-driven (sweep_progress.json / psf_index.json /
  .bsub_job.json), each step tagged with a `settingColumn` that feeds the
  settings table's result row, and failures start diagnosis sessions
  automatically (the scheduler cluster immediately, the rest at run end).
- Tests: `tests/selfcheck.test.mjs` (18 cases — settings, gen/golden/verify
  assets incl. a byte-stability regen and a three-channel parity check, all four
  mode quadrants as flows against a mocked dsh-remote tool shell with real bsub
  tools and real python/js verify, fallback + diagnosis coverage, route guards,
  client static contracts).

### Removed — 2026-11-02 (ngspice channel)

- **The bundled `LocalDesignExample/` environment was deleted** (user decision):
  the portable ngspice-47 binary, the sky130 spice model closure (340 files),
  the pipeline-script mirrors, the demo placeholders, `harnessams.json` and
  `check_environment.py`. Its only purpose was the ngspice local closed loop;
  sky130 runs in Spectre after model transcription and ngspice carried only
  simple demo value. The `ngspice present` local check, the `ngspice_cmd`
  workspace config key, the `.spi → ngspice` simulator inference and the
  ngspice wording in the onboarding guide went with it. The pre-removal state
  is preserved in this repo's `ngspice` branch (cut at ac50f0f).

### Added — 2026-11-01 (onboarding guide & digital assets, branch guide-onboarding)

- **First-run onboarding on the console page (tier 1)**: an unseen
  `hams-guide-seen` localStorage flag renders ConsolePage as a centered guide
  entry (`.hams-guidecenter`); afterwards a persistent 使用引导/Guide button
  sits at the title row. `GuideView` is a five-section plain-text view — how
  local vs remote projects work, how to submit jobs (slurm explicitly not
  supported yet), where the workspace lives, the SmartAnaSim 14-tool simulator
  suite, and a daily-entry cheat sheet — fully bilingual (`guide.*` keys, zh/en
  sets kept identical); the guide task-card description was upgraded to match.
- **Digital-assets section reworked**: instead of the old scanned-report
  listing, it now enumerates exactly the four bundled `.js` assets
  (plotly/xterm/xterm-fit/xterm-search — MIT license, bundled copy path/size,
  serving route, plus workspace-scattered copies) found by a bounded
  `scanCopies` sweep in `assetsStatus(wsRoot)` (maxDepth 6 / maxDirs 4000 /
  maxCopies 100, skipping dot directories and node_modules). The `/api/dirs`
  route is kept but no longer consumed by the client.

### Added — 2026-11-01 (check-failure diagnosis sessions, branch check-diagnose-session)

- **Failed checks hand off to a newly created DSH session** (the private
  replacement of the old copy-to-clipboard diagnose button): a run-level
  「起会话分析」 button bundles every failed entry of the current run into
  `POST /api/checks/analyze`; the host assembles an English prompt (context +
  verbatim failed entries, READ-ONLY instructions) ending with an
  answer-language line following the effective UI language
  (`Answer in Chinese.` / `Answer in English.`), then drives the DSH session
  controller (`ctx.get('sessionController')`, lazy-degrading like the
  `sessions` service): `create({workspaceId})` attaches the session to the
  target workspace, `prompt(request, signal)` delivers the first turn
  (the signal argument is REQUIRED on 0.2.1-rc.2 — `signal.throwIfAborted()`
  is unconditional), `rename` titles it `HarnessAMS diagnosis: …` (best
  effort). Remote checks anchor the session to the machine's remote-project
  workspace, so the diagnosis agent's cwd binds dsh-remote's rw_* tools to
  that machine and it can verify on the cluster; local checks anchor to the
  current project's workspace. **AUTO_ANALYZE_REMOTE** (constant, future
  settings card): a REMOTE check that ends with failed entries fires the same
  handoff automatically — local failures stay button-only. Deliberately
  private: no ctx service key and no model tool is registered for it.
  Verified live against 0.2.1-rc.2 (instance on :3197, node1): the diagnosis
  agent reproduced `bjobs` on the machine, traced the cold-channel PATH root
  cause and answered in Chinese per the directive.

### Fixed — 2026-11-01 (sub-view persistence)

- **Task-sidebar sub-view survives host remounts**: the DSH host remounts the
  sidebar slot body while rendering agent tool cards, which reset the React
  state and snapped the sub-view back to 概览 mid-conversation. The selection
  now lives outside the component — module memory plus localStorage
  (`hams-task-view`) — so a remount (same page) and a full page reload both
  reopen the same sub-view. Browser-verified end to end: switch to Dashboard →
  run a tool round (view held) → reload (view restored).

### Added — 2026-11-01 (Dashboard auto-refresh, 方案B)

- **The Dashboard sub-view auto-refreshes while visible** (session_04b668d1
  option B): the parent task view polls `/api/tasks` every 10 s while the
  Dashboard sub-view is open (skipping persist-in-flight ticks, only touching
  state on an actual diff, paused on `document.hidden` with a visibilitychange
  catch-up), so externally registered reports (`sim_analysis(report=true,
  task=…)`) appear in the dropdown — including a switched `dashboard_selected`.
  `TaskDashboard` additionally polls the current report's new
  `GET /api/report-stat?taskId&reportId` (`src/server/dashboard.js` resolution
  + `fs.stat`; the generator rewrites the HTML every run, so mtime+size is a
  sufficient freshness token) and reloads the iframe through the existing
  key/nonce when it changes. Zero new UI strings; the manual ↻ stays.

### Changed — 2026-11-01 (analysis tool merge)

- **`sim_collect` + `sim_report` merged into `sim_analysis`**; `sim_trash`
  renamed **`safe_trash`** (user decision). `sim_analysis(run_dir, …)` always
  aggregates `NN/point_meta.json` into `results.json` and only renders the HTML
  dashboard when `report=true` (project root derived from run_dir's
  `sweep/RoundN/top` structure, or passed as `project_dir`; `round`/`task`
  apply to the report step; a custom `out` combined with `report=true` is
  rejected early — the generator reads the canonical location).
  `sim_progress` stays a separate LOCAL progress-file window; its description
  now records the dual-window timing: remote batches poll `bsub_poll` while
  running (LSF queue state) and switch to `sim_progress`/`sim_analysis` after
  `bsub_fetch`. Tool count 7 → 6.

### Added — 2026-11-01 (tool redistribution)

- **Model tools moved in from SmartAnaSim** (that plugin is now simulator-only):
  `apply()` registers 7 tools in a second `ctx.effect` — the generic remote batch
  channel `bsub_submit`/`bsub_poll`/`bsub_fetch` (code moved verbatim:
  `src/tools/bsub.js` + `src/bsub.js` + `src/remote.js` + the `src/tool.js` schema
  compiler) and the simulator-agnostic analysis tools
  `sim_collect`/`sim_progress`/`sim_report`/`sim_trash` (`src/tools/shared.js`).
  The worker upload tree / worker lookup root switched from the plugin's own
  `scripts/` to the workspace `sim_scripts_dir` (points at the SmartAnaSim
  package; `HARNESSAMS_SIM_SCRIPTS_DIR` overrides discovery, with guidance
  errors) — cross-package npm resolution is never required under dev-mount.
  Analysis Python ships here now (`src/scripts/common/`: collect/report/trash +
  a byte-identical `common_workspace.py` copy); `sim_report`'s guarded
  tasks.json injection became a same-package second writer beside
  `server/project.js`. `LocalDesignExample/tools/common/` re-synced from the new
  source (trash unchanged — identical bytes). Archive extraction (`extractArchive`)
  now runs tar with a relative archive operand (cwd=runDir): GNU tar on PATH
  parses absolute `C:\...` operands as `host:path`.

### Added

- **Dashboard report viewer + report-injection coordination (2026-10-30/11-01)**:
  the task sidebar's Dashboard sub-view shows the task's registered local HTML
  reports (browse-to-add via a one-level `/api/browse` picker or a manual
  absolute path, dropdown switch persisted as `dashboard_selected`, `↻` hard
  reload via the iframe key/nonce, `↗` open-in-tab, `×` unregister). Reports are
  served read-only from `/harnessams/dash/<taskId>/<reportId>/…` with the
  report's own directory as the boundary (`src/server/dashboard.js`; MIME by
  extension — the old blanket `text/html` on `/reports/` silently killed report
  data scripts). Sizing pass: the sidebar height chain is flex all the way down
  (`.hams-body` → sub-view → iframe/terminal wrap), killing the
  `calc(100vh - Npx)` dead zones; the iframe injects a compact style into the
  same-origin report and scales it by the DSH font-size ratio so a report tracks
  the user's font setting inside the sidebar. `sim_report(task=…)` (SmartAnaSim)
  registers generated reports straight into a task's dashboard; to survive that
  second writer the sidebar's full-list PUT is re-based on a fresh GET, the
  Dashboard sub-view refetches on activation, and both writers now replace
  `tasks.json` atomically (tmp + rename).

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
