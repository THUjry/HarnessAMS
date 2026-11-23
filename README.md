# HarnessAMS

> HarnessAMS top-level entry repo: plugin index + install guide + compatibility matrix; also hosts the aggregate bundle `dsh-harnessams-suite`. Mission: an open-source project doing AMS (analog/mixed-signal) design with an LLM harness, built on the DSH (`@deepseek-ai/dsh`) plugin system — "everything is a plugin". **Current status**: stage 1 (core entry + pre-layout simulation) in development; plugins are implemented and smoke-tested but **not yet published** — the npm install commands below become usable after the v0.1.0 release; use the dev-mount until then.

## Plugin index

| Plugin | npm package | row id | Responsibility | Stage | Status |
|---|---|---|---|---|---|
| HarnessAMS (top) | `dsh-harnessams` | `harnessams-top` | Sidebar UI + orchestration: global console page (machines read-only, digital assets), project = DSH workspace, right-sidebar strip = project overview + session (per-session dashboard + check params; staged project settings/self-check with AGENTS.md config-table sync + dsh-ssh remote-dir picker); the managed scan channel (`batch_submit` with its local/direct/lsf schedulers, worker tree from the project's `sim_scripts_dir`; `batch_poll` monitoring with the terminal auto-fetch and a per-point digest), the simulator-agnostic report/ops tools (`gen_sweep_report`/`safe_trash`; D-005: spec-driven pure report renderer + headless per-chart PNG export + the RawResults/SimResults/Figs/report-at-root layout), the `harnessams_selfcheck` tool — 5 tools — plus three bundled skills (`batch-sweep` the generic scan methodology, `dca-cell-design`, `analysis-cascade-dca`) registered into the host skill catalog (`src/skills/`) | stage 1 | implemented (this repo, `src/`) |
| HarnessAMS-SmartAnaSim | `dsh-harnessams-smart-ana-sim` | `harnessams-smart-ana-sim` | Simulation, pure tool set usable standalone (D-001): Spectre sweep-input assembly (template generation + configuration checks, hard PDK isolation) and S-parameter reading/extraction, plus the directly runnable sweep worker / analysis scripts under `scripts/` and the bundled `smart-spectre` configuration skill | stage 1 | implemented (separate repo) |
| HarnessAMS-SmartPostLayout | (repo in stage 2) | `harnessams-smart-post-layout` | One-click post-layout simulation | stage 2 | not started |
| HarnessAMS-aligner | (repo in stage 3) | `harnessams-aligner` | Multi-level alignment | stage 3 | not started |

## Repository layout

```
src/                     dsh-harnessams — console plugin package:
                         index.js (host-half routes + model-tool registration, plain JS, no build chain),
                         server/ (host-half modules: workspace/checks/project/machines/assets/dashboard/
                                 checkparams/agentsmd/remotebrowse/diagnose/selfcheck/progress/settings/
                                 forkdetect),
                         tools/ + tool.js/py.js/batch.js/remote.js/trash.js (the 5 model tools,
                                 incl. harnessams_selfcheck; progress_files.js holds the shared
                                 run-directory progress ladder),
                         client.js (browser half — single-file classic script on window.__ModuleLoader__),
                         assets/ (plotly.min.js + THIRD_PARTY_NOTICES; the vendored xterm bundle was
                                 retired with the remote terminal, 2026-11-14),
                         scripts/ (project self-check compute twins under selfcheck/;
                                 retired _dont_use_* reference copies under common/)
install_suite/           dsh-harnessams-suite — aggregate bundle (pure patch package)
tests/                   unit tests (bare node --test, from the repo root)
docs/                    plugin index, compatibility matrix
CHANGELOG.md / SECURITY.md / PUBLISH.md
```

## The three-tier UI (DSH Web)

The plugin surfaces itself inside the DSH Web client (no separate page URL):

1. **Global console page** — the "HarnessAMS" entry in the left sidebar (next to Plugins / Automation tasks) opens a full page with the **machine list** (a read-only projection of the dsh-ssh host registry) and **Digital assets** (plotly asset status + the workspace report library), plus a **Display settings** block (the session tool-card toggle, on by default). The disk-usage block and the remote-project section are retired (2026-11-14 dsh-ssh migration; 2026-11-19 D-003 config unification — a per-project disk view is future work).

   Remote connectivity is delegated entirely to the **@linxin666/dsh-ssh** plugin (dsh-remote retired 2026-11-14) — HarnessAMS keeps no server registry and no ssh channel of its own. This page reads the dsh-ssh host registry read-only (via the `ssh_list` tool shell) and shows, per alias, its host line and auth kind — pure registry facts (2026-11-19 D-003): the **remote root is a per-project setting** (`workspace_config.json` settings.remote_root, edited in the project overview settings table), NOT a machine column and NOT dsh-ssh data. Host management (aliases/credentials) and the **interactive SSH terminal stay in dsh-ssh itself** — HarnessAMS deliberately does not duplicate them. Prefer key-based auth with no stored passphrase; passwords in dsh-ssh are plaintext at `~/.dsh/dsh-ssh.json` (0600).
2. **Project = DSH workspace** — a project is nothing more than a DSH workspace (a local folder). Its whole state is the per-project `.harnessams/` store: `workspace_config.json` (the single config: `workspace` install facts + `settings` incl. the remote root), `sessions.json` v2 (every DSH session is a work unit with its own dashboard reports and confirmed check params; a forked session deep-copies the last-active session's entry — deliberately branch-point-independent, detected from the child session log's fork marker), and `selfcheck/` run directories. The task concept is retired (2026-11-19 D-004); legacy `tasks.json` stays on disk unread.
3. **Right-sidebar tab (local projects)** — one plugin tab, **HarnessAMS**, sits in the right-sidebar strip next to the host tabs. Its first-level strip carries exactly two entries (D-004; the task concept is retired): **Project overview** first — the tab's default display, project-scoped (project settings/self-check, detailed below; a module cache re-renders it from the last snapshot on same-project session or strip switches, no blank refetch) — then **this session** with two sub-views: **Dashboard** as an HTML-report viewer (`gen_sweep_report(spec=...)` registers the generated report into the CALLING session — `exec.agent.id` is the SessionId, no `task=` parameter; reports are served read-only from `/harnessams/dash/<sessionId>/<reportId>/…` with each report's own directory as root so their relative `SimResults/*.js` and `Figs/` references keep working; browse the local disk to add existing reports, switch them in a dropdown, reload on demand; the iframe fills the sidebar via a flex height chain and embeds the report compact + scaled to the DSH font-size setting; the sub-view **auto-refreshes** while visible — the session store merges through `PUT /api/session-config` and a regenerated report reloads through `/api/report-stat?sessionId=` mtime+size) and **Check params** as an editable table of the assembly-layer check parameters — the ideal R/C/L plausibility ranges (six numbers) plus the unit-check / bias<Vdd / strict-includes switches — stored PER SESSION in `sessions.json` via `GET/PUT /api/session-config` (unconfirmed drafts show the fallback as gray ghost values with a source line; the effective chain for SmartAnaSim's check library is built-in defaults ← project `check_params.json` fallback ← the session's confirmed table, keyed by the shell-env built-in `DSH_SESSION_ID`, so a confirmed change takes effect on that session's next assembly run). A project that already has a `.harnessams` store auto-opens the sidebar on a session's first sight — brand-new sessions included, ~2 s after creation; an explicit user close always wins. The sidebar **follows session switches when it was open** (the conversation header's `HarnessAMS` button re-opens the tab; a collapsed sidebar stays collapsed), and the strip selection and the sub-view both survive remounts and reloads (module memory + disk). The remote-terminal sub-view was removed with the dsh-remote retirement: the interactive shell is dsh-ssh's own terminal panel, same credentials.

   The **project settings + project self-check** block is the Overview's single entry (the per-machine health-check panel was retired 2026-11-18; its machine facts live on in the AGENTS.md config table). The button row carries, left to right: **Save to AGENTS.md** — rewrites the marked `hams-config` block at the head of `<workspace>/AGENTS.md` with plugin-measured facts (settings snapshot, node/python versions with absolute executables, and the latest finished self-check run's id/time/verdicts; no first-fill instruction survives the rewrite); **One-click self-check** (see below); **List local environment** — display-only rows (connectivity, node, python with absolute executable paths, write probe; the sky130 row is retired); **Check all & save** — runs the self-check, then saves once it lands. All four buttons funnel into the **`harnessams_selfcheck`** tool runner (action `run`/`status`/`env`/`save_agentsmd`) through `POST /api/tool` — and each commits pending table edits first, so the table can never diverge from the file. Conversational agents drive the same tool directly; its optional `settings` object is validated and written BEFORE the action runs — the single config write face in the system (the retired `POST /api/agents-md` / `PUT /api/project-settings` routes answer 404/405 with a pointer). Store creation lays the AGENTS.md block down as an EMPTY yaml table plus a first-fill instruction: the workspace's first session reads it in its instruction baseline, runs the checks, fills the table with measured values, and only then starts the task — the user may explicitly waive the self-check, and the agent judges that itself; the plugin's `apply()` itself never writes. Plugin writes are external writes (no watcher): the block reaches context on the next session or after the next first-party fs call, as an appended instruction delta — prefix cache intact (mechanism: the DSHstudy context-sync note).

   The settings table renders the `workspace_config.json` `settings` (`run_mode` local/remote, `machine_id`, `remote_root`, `remote_dir`, `scheduler` lsf/direct, `simulator` spectre/none, `compute_script_local`/`compute_script_remote` python/js). Columns cascade off the mode/simulator choices (a local project hides machine/scheduler/remote-compute; simulator=none hides the scheduler); a stored relative `remote_dir` resolves against `remote_root`. The one-click **self-check** then walks the whole pipeline under those settings — machine, connection, environment, permissions, tools and compute — with ideal RC low-pass/high-pass testbenches (3×3 parameter grid, no PDK): `simulator=spectre` runs assemble → batch_submit(scheduler=local) → batch_poll → the standalone parser → pointwise verify (locally), or batch submit/poll → remote parse+verify → result download + cross-check (remotely; an LSF failure is diagnosed immediately and retried once with `scheduler=direct`); `simulator=none` skips the simulator entirely and replays a bundled analytic golden dataset through the parser + compute (locally, or upload → remote compute → download + cross-check). Verification compares every frequency point against the analytic RC response (1% tolerance) in the selected compute script — python or js locally (js runs in-process), python or node remotely. Runs land under `<project>/.harnessams/selfcheck/<runId>/`: a clean run's artifacts are deleted at finalize, a diagnosed/failed run keeps its evidence for the diagnosis sessions until the next run cleans history, and finalize unconditionally re-syncs AGENTS.md so `last_selfcheck_*` never goes stale. Failures start diagnosis sessions automatically (through the private session-controller channel, `server/diagnose.js`).
4. **Session tool cards (conversation)** — DSH renders a generic JSON card for every model tool call; HarnessAMS registers the `tool.call.toolview` slot for `batch_poll` alone (2026-11-23, D-001 — the single monitoring face; keyed by exact wire tool name; every other tool call, `batch_submit` included, stays on the DSH generic card). A card shows a status badge, a progress bar with succeeded/failed/pending counts, and the project-level batch aggregate ("3/5 batches done · 120/360 sims · 240 pending"). The first frame is local and immediate (D-007): a 0/N `submitted` from the run dir's `.batch_job.json` — a carded call never shows a dead placeholder, and even a batch that finished between two polls displays its 0/N first frame and then the N/N result. While the call blocks, the card polls `/api/progress-remote` (the batch's own counters ON the remote host, 5 s, workspace-fenced; server-side single-flight cache keeps it to one ssh exec per run dir per ~4 s) with the local ladder each tick; a `scheduler="local"` run reads the run directory's own files at the same cadence; an unreachable remote keeps the last frame plus a dim note. Settled cards fetch the cross-batch summary once from `/api/progress-summary`; the result view adds the per-point digest (index/status/params). An expandable details section keeps the raw args/result JSON; the console-page display settings toggle turns the cards off (browser-local preference; the off state renders the raw shape itself since the occupied key cannot fall back to the DSH generic card). The onboarding guide covers the cards in its sixth section.

## Simulation execution modes

A sweep always starts with the same assembly step; only the execution channel differs. All three schedulers submit the SAME run directory + worker through `batch_submit`; they differ in WHERE the worker runs:

| Mode | Selection | Worker host | Channel |
|---|---|---|---|
| local | `batch_submit(scheduler="local")` | the host running DSH itself, background | detached local python spawn (submit returns immediately; poll with `batch_poll`) |
| direct | `batch_submit(scheduler="direct")` | the SSH target host itself, foreground | ssh_upload + `ssh_exec` (no LSF; marker+flock replay guard) |
| lsf | `batch_submit(scheduler="lsf")` (default) | the SSH target host's cluster via the LSF queue | ssh_upload + `bsub`/`bjobs` (marker read-back idempotency) |

`machine_id` (a dsh-ssh alias) and the fencing `remote_root` are required for the remote modes only. The worker scripts upload tree for both remote modes is the project's `sim_scripts_dir` (`workspace_config.json` workspace section; by default the sibling SmartAnaSim package's `scripts/`; env `HARNESSAMS_SIM_SCRIPTS_DIR` overrides). A `sim_scripts_dir` argument to `batch_submit` that names an existing directory replaces that root for any scheduler (a custom or test worker tree); any other value only anchors the project walk-up.

### Mode 1 — local (the DSH host runs Spectre itself)

Spectre must be installed on the DSH host. The submit spawns the worker as a detached background process (stdio to `.batch_local.out`/`.err` in the run directory, `--work-dir` appended) and returns immediately; the worker carries its own global budget, so a forgotten run still terminates by itself. The poll reads the run directory and checks the worker's pid: a worker that died (bad arguments, a crash) reads `failed` with its stderr tail in `errlog_tail` instead of `running` until `wait_sec` runs out, and a spawn that cannot start (no python on PATH) rejects the submit.

spectre_assemble(project_dir=...)                     # design_params.json -> template*.scs + sweep_config.json (+ checks)
batch_submit(run_dir=..., worker="spectre/spectre_sweep_worker.py", scheduler="local")
batch_poll(run_dir=..., wait_sec=600)                 # bounded blocking wait — the live card window
python <sim_scripts_dir>/spectre/spectre_psf_parse.py --work-dir <run_dir> --format csv   # script-face parsing
gen_sweep_report(spec=...)                            # after your own analysis

Everything lands in the local run directory — analyze immediately, no retrieval step.

### Mode 2 — remote, direct (the target node's local foreground, no LSF)

Same worker, but executed on the SSH target node's own host as a foreground process. Requires the target machine's dsh-ssh alias (`machine_id`) and the project's `remote_root`.

spectre_assemble(project_dir=...)
batch_submit(run_dir=..., machine_id=..., remote_root=...,   # remote_dir optional: omitted ->
             worker="spectre/spectre_sweep_worker.py", scheduler="direct")  # next Sim<N>_<date>_batch<M>
batch_poll(run_dir=..., wait_sec=0) # progress files, not bjobs; terminal poll auto-fetches sweep_progress.json
                                     # + errlog.txt; wait_sec>0 = bounded blocking wait (cap 600)
gen_sweep_report(spec=SimResults/<name>_spec.json)   # after your own (remote-first) analysis

Gotchas: the whole worker must finish inside the 600 s direct deadline (the exec funnel wraps every command in a remote `timeout -s KILL`; long sweeps belong on lsf); raw psf/sp artifacts stay remote — analyze them there; `overwrite: true` clears the stale replay markers so a finished dir actually re-runs.

### Mode 3 — remote, LSF (the target cluster's queue)

The default scheduler. No wall-clock cap — queue wait and execution are both visible through bjobs, so arbitrarily long sweeps are fine.

spectre_assemble(project_dir=...)
batch_submit(run_dir=..., machine_id=..., remote_root=...,   # remote_dir optional: omitted ->
             worker="spectre/spectre_sweep_worker.py")   # next Sim<N>_<date>_batch<M>; lsf default
batch_poll(run_dir=..., wait_sec=600)  # bjobs state + point count; "No job found" with full count = completed;
                                       # terminal poll auto-fetches the light result files; the session card
                                       # live-updates through the whole wait
gen_sweep_report(spec=...)             # analysis ran remotely (put/exec/get); local parsing only when debugging


## What the npm packages ship (besides the JS)

| Package | Ships beyond the entry JS | Deliberately NOT shipped |
|---|---|---|
| `dsh-harnessams` (`src/`) | `client.js` (browser half, combo-loaded as-is); `server/` (host-half modules); `tools/` + `tool.js`/`py.js`/`batch.js`/`remote.js`/`trash.js`/`report_render.js`/`figs_export.js`/`progress_files.js` (the 5 model tools: `batch_submit` (local/direct/lsf) + `batch_poll` (monitor + terminal auto-fetch) + `gen_sweep_report` + `safe_trash` + `harnessams_selfcheck`; the report pipeline and trash are pure JS; figs_export adds jsdom + @napi-rs/canvas + @resvg/resvg-js runtime deps — all prebuilt, zero install scripts); `cordis.patch.yml` (bundle patch); `assets/plotly.min.js` (about 4.6 MB, offline report rendering and `/harnessams/assets/` in-app serving) + `assets/THIRD_PARTY_NOTICES.md` (Plotly attribution; the vendored xterm bundle was removed with the 2026-11-14 remote-terminal retirement and the notices file carries its removal note); `scripts/selfcheck/` (`selfcheck_verify.py` + `selfcheck_verify.mjs`, the self-check compute twins — same JSON contract); `selfcheck/` (the RC self-check assets: `script/analysis/gen_selfcheck_rc.py` + `golden/`, a 36-file analytic 3×3 psfascii dataset that replays the pipeline without a simulator) | `scripts/common/` (`_dont_use_*` retired reference copies — never executed), `docs/`, `tests/`, the repo-root README/AGENTS/CHANGELOG |
| `dsh-harnessams-suite` (`install_suite/`) | `cordis.patch.yml` only (pure patch package) | everything else |

The master `plotly.min.js` travels inside the `dsh-harnessams` tarball, so suite installs get offline reports: report generators seed a single workspace-level copy from it (see `docs/decisions.md`, D-012). `PUBLISH.md` holds the must-contain / must-not-contain checks that guard each tarball.

## Installation (available after the v0.1.0 release)

### Path A (standard, recommended): per-plugin install

```powershell
dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.20    # remote channel — runtime tool-shell consumer, deliberately NOT an npm dependency; pnpm 12 asks to approve the ssh2/cpu-features build scripts (`pnpm approve-builds ssh2 cpu-features --yes`; after an in-place upgrade run `pnpm rebuild ssh2` to (re)build the native binding)
dsh plugin --profile web add dsh-harnessams dsh-harnessams-smart-ana-sim
dsh --profile web    # restart the profile after installing: bundle membership is a startup boundary
```

### Path B (convenience): aggregate bundle, one command (first-party plugins only)

```powershell
dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.20    # remote channel — NOT part of the suite bundle
dsh plugin --profile web add dsh-harnessams-suite
dsh --profile web --dump-config    # confirm the layers and rows appear as expected
```

### Dev-time mount (usable now)

Write a `cordis.yml` inside the plugin repo (`name` pointing to the absolute path of the entry source file; forward slashes on Windows), then:

```powershell
dsh --profile web --patch <path-to>\cordis.yml --port 3080 --no-open
```

The web profile must already have @linxin666/dsh-ssh exact-pinned for the remote channel — `dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.20` (runtime tool-shell consumer, deliberately NOT an npm dependency). Configure host aliases in dsh-ssh's own panel; each project sets its own remote root (`remote_root`) in `<project>/.harnessams/workspace_config.json` — the project overview settings table's confirm button is the write face.

Note: with the npm-installed CLI, `--profile web` already names the profile — do **not** append a positional `web` argument (the launcher rejects it with `too many arguments`); flags after the launcher options (such as `--port` / `--open`) reach the web app. Verified against `@deepseek-ai/dsh@0.2.1-rc.2` installed from npm (2026-10-25); re-verified on 0.2.2-rc.1 (2026-11-10) and 0.2.2-rc.3 (2026-11-14).

## Environment

- Node.js >= 24.9 (DSH 0.2.2 floor; verified on v24.22.1);
- DSH: `npm i -g @deepseek-ai/dsh` then `dsh --profile web`; **verified version 0.2.2-rc.5** (2026-11-21; previously 0.2.2-rc.3, 2026-11-14, 0.2.2-rc.1, 2026-11-10, and 0.2.1-rc.2, 2026-10-25; developer preview — pin the version; before upgrading, check the upstream release notes and rerun the minimal regression; both plugins' `engines.dsh` is exact-pinned to the same version);
- @linxin666/dsh-ssh: `dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.20` — required at runtime for remote checks/batches (consumed via the DSH tool shell, not a package dependency); **verified version 0.4.20** (2026-11-21 upgrade from 0.4.18, 2026-11-14; tarball diff confirms `src/tools.ts` unchanged, so the ssh_* contract anchors carry over verbatim). Its peerDeps require dsh >= 0.2.2-rc.3 (0.4.18 required >= 0.2.2-rc.2). Deployment notes: telemetry is ON by default (opt out with localStorage `dsh-web-ui-telemetry-opt-out=1` or DNT); there is no host-key verification (prefer a restricted account + key auth); a lost connection replays a non-idempotent exec up to 3 times — the batch layer guards with marker+flock idempotency (see the root repo's dependency-check doc §2).
- Beware: npm hosts an unrelated same-name package `dsh`; remove it first with `npm rm -g dsh` if present;
- Simulation environment (SmartAnaSim): a local Spectre install is required for spectre sweeps — the assembly tool and the snp_* tools run without it (commercial software, not bundled).

## Documentation

- `docs/plugin-index.md`: plugin index (spec/deps/permission boundaries/verified DSH versions);
- `docs/compatibility.md`: DSH version × plugin version compatibility matrix;
- `CHANGELOG.md` / `SECURITY.md` / `PUBLISH.md`: release records, security boundaries, publishing runbook;
- Each plugin repo carries its own README and AGENTS.md.

## Workspace layout (runtime convention)

Simulation runs against a **project** directory (a DSH workspace, created by the user outside any repo). Each project carries its own single config at `<project>/.harnessams/workspace_config.json`: `workspace` (sim_scripts_dir / plotly_asset / trash_dir — install-level facts, default-filled at creation) and `settings` (run_mode / machine_id / remote_root / remote_dir / scheduler / simulator / compute scripts — the overview table's staged + confirmed values). Demo projects live as subdirectories (`<project>/cells/<cell>/script/design_params.json`, `script/analysis/gen_*.py`, generated `sweep/Round*/top/`, reports in `Analysis/`); self-check runs under `<project>/.harnessams/selfcheck/<runId>/` (artifacts cleaned after runs). Batch tools and scripts anchor to the project by walking up from the run directory for a `.harnessams` store. The family-level `harnessams.json` is retired (2026-11-19 D-003).

## Customizing the plugin code — no build chain, edit in place

Everything ships as plain source: the plugin entries are plain-JS ESM loaded directly by DSH, and the simulator pipeline logic is plain Python — nothing is transpiled, bundled, or compiled. **Both layers can be edited in place on the running machine**; they differ only in when an edit takes effect:

| Kind | Location | Edit takes effect |
|---|---|---|
| Per-project assembly/analysis scripts (yours to own) | workspace: `<workspace>/<demo>/script/analysis/*.py` (e.g. `gen_ota5t.py`) | next run |
| Framework scripts shipped with the plugins | simulator scripts: SmartAnaSim package dir `scripts/` (or the workspace `sim_scripts_dir`); self-check scripts: this package's `src/scripts/selfcheck/` (the report render is plain JS in `src/tools/gen_report.js` + `src/report_render.js` — edits follow the JS row below) | next run |
| Plugin JS entries (`src/index.js` + `src/client.js` here, `src/index.js` in SmartAnaSim) | dev-mount: the repo's own `src/` (your edit is the source); installed: `node_modules/<package>/src/` | after restarting that DSH instance |

Why the difference: every tool invocation spawns a fresh `python <script>` process (system Python from `PATH`) that reads the file from disk again — no rebuild, no reinstall, no DSH restart (a sweep already in progress keeps the copy it loaded). The JS entry, in contrast, is loaded once via ESM at startup and cached by the module system, so it needs a restart of that instance; other instances are separate processes and keep running unaffected.

Tune check thresholds, adjust report wording, or add your own adjudication rules by editing the local files directly. Two caveats: keep durable customization in the **workspace** scripts — anything inside the installed package directory (the Python scripts *and* `index.js`) is overwritten when the plugin is upgraded; and the in-package path above follows DSH's profile layout as observed with `dsh plugin --profile web add` — confirm your install location with `dsh plugin --profile web list` if it differs.

## License

[MIT](LICENSE)
