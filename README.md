# HarnessAMS

> HarnessAMS top-level entry repo: plugin index + install guide + compatibility matrix; also hosts the aggregate bundle `dsh-harnessams-suite`.
> Mission: an open-source project doing AMS (analog/mixed-signal) design with an LLM harness, built on the DSH (`@deepseek-ai/dsh`) plugin system — "everything is a plugin".
> **Current status**: stage 1 (core entry + pre-layout simulation) in development; plugins are implemented and smoke-tested but **not yet published** — the npm install commands below become usable after the v0.1.0 release; use the dev-mount until then.

## Plugin index

| Plugin | npm package | row id | Responsibility | Stage | Status |
|---|---|---|---|---|---|
| HarnessAMS (top) | `dsh-harnessams` | `harnessams-top` | Three-tier UI + orchestration: global console page (remote projects, digital assets, disk usage), project = DSH workspace, per-project task sidebar with health checks; the generic remote batch channel (`bsub_*`, worker tree from the workspace `sim_scripts_dir`) and the simulator-agnostic analysis tools (`sim_analysis`/`sim_progress`/`safe_trash`) | stage 1 | implemented (this repo, `src/`) |
| HarnessAMS-SmartAnaSim | `dsh-harnessams-smart-ana-sim` | `harnessams-smart-ana-sim` | Simulation: local Spectre channel (code-driven netlist assembly with hard PDK isolation), PSF parsing, S-parameter reading/extraction — simulator-specific code only | stage 1 | implemented (separate repo) |
| HarnessAMS-SmartPostLayout | (repo in stage 2) | `harnessams-smart-post-layout` | One-click post-layout simulation | stage 2 | not started |
| HarnessAMS-aligner | (repo in stage 3) | `harnessams-aligner` | Multi-level alignment | stage 3 | not started |

## Repository layout

```
src/                     dsh-harnessams — console plugin package:
                         index.js (host-half routes + model-tool registration, plain JS, no build chain),
                         server/ (host-half modules: workspace/checks/disk/project/machines/remote/assets/
                                 settings/selfcheck),
                         tools/ + tool.js/py.js/bsub.js/remote.js (generic batch + analysis model
                         tools, moved from SmartAnaSim 2026-11-01),
                         client.js (browser half — single-file classic script on window.__ModuleLoader__),
                         assets/ (plotly.min.js + the vendored xterm bundle + THIRD_PARTY_NOTICES),
                         scripts/ (generic analysis Python: collect/report/trash under common/)
install_suite/           dsh-harnessams-suite — aggregate bundle (pure patch package)
tests/                   unit tests (bare node --test, from the repo root)
docs/                    plugin index, compatibility matrix
CHANGELOG.md / SECURITY.md / PUBLISH.md
```

## The three-tier UI (DSH Web)

The plugin surfaces itself inside the DSH Web client (no separate page URL):

1. **Global console page** — the "HarnessAMS" entry in the left sidebar (next to
   Plugins / Automation tasks) opens a full page with **Remote projects**, **Digital
   assets** (plotly asset status + the workspace report library), **Disk usage**
   for the local workspace, and a **Display settings** block (the session
   tool-card toggle, on by default).

   Remote connectivity is delegated entirely to the dsh-remote plugin — HarnessAMS
   keeps no server registry and no ssh channel of its own. This page reads
   dsh-remote's machine registry (read-only, via the `rw_machines` tool shell with a
   same-origin HTTP fallback) and shows, per machine, its remote workspace, local
   mirror, and remote project. A **remote project** is simply a DSH workspace opened
   inside a machine's local mirror
   (`~/.dsh/remote-workspaces/<host>-<user>-<port>/<ws>`) — one per machine is the
   recommended setup, and the page creates it in one click by registering the
   machine's EXISTING mirror directory as a DSH workspace — mirrors are never
   created here: pick the remote workspace once in dsh-remote (rw_pick_workspace
   or its picker) so the mirror exists; machines without one get an actionable
   error. Sessions of a
   remote project are what bind dsh-remote's `rw_*` tools to that machine; a local
   project that needs to run a remote simulation borrows one of them. Machine
   management (add/remove/credentials) and **remote file browsing/editing stay in
   dsh-remote itself** — HarnessAMS deliberately does not duplicate them.

   **Credential storage** (dsh-remote 0.8.83 as of 2026-11-10; credential logic
   source-audited at 0.8.66 on 2026-10-31, identical to 0.8.54; the 0.8.67→0.8.83
   sync study found no credential-path changes): for
   security, tick "encrypt saved password" when saving a machine — the password then
   lives in the OS credential store (Windows DPAPI / macOS keychain / libsecret) and
   never in a plaintext file, and since 0.8.54 a failed keychain write refuses to
   save rather than silently downgrading to plaintext. If the keychain genuinely does
   not work in your environment, plaintext storage stays available: without the tick
   (the form default), or with `credentialFallback: plain` as the failure fallback —
   in `~/.dsh/remote-workspaces/machines.json`.
2. **Project = DSH workspace** — a project is nothing more than a DSH workspace (a
   local folder). Per-project task data lives at `<workspace>/.harnessams/tasks.json`;
   sessions are deliberately not modeled (every session of a workspace shares the task
   list). A workspace inside a dsh-remote mirror is that machine's remote project.
3. **Task sidebar (local projects only)** — the right-sidebar "HarnessAMS" tab manages
   the active project's tasks: a tab strip (one card per task, "+" to create, × to
   delete), an in-task sub-navigation (**Overview** with the health-check panel and the
   editable description, **Dashboard** as an HTML-report viewer — browse the local disk
   to add existing reports to the task, switch them in a dropdown, reload them on
   demand; reports are served read-only from `/harnessams/dash/<taskId>/<reportId>/…`
   with each report's own directory as root so their relative `data/*.js` references
   keep working, the iframe fills the sidebar via a flex height chain and embeds the
   report compact + scaled to the DSH font-size setting, `sim_analysis(report=true,
   task=…)` registers generated reports straight into a task, the sidebar re-bases
   its writes on a fresh GET so the two writers never clobber each other, and the
   sub-view **auto-refreshes** while visible (10 s API polling, paused when the tab
   is hidden: new/switched registrations appear in the dropdown and a regenerated
   report document reloads through `/api/report-stat` mtime+size), **Terminal** as an interactive remote terminal per dsh-remote machine
   (xterm.js over dsh-remote's own `/dsh-remote/term/*` polling PTY routes — no SSH
   layer of our own; a fresh session lands in the machine's remote project root, and
   targeting works by passing one of that machine's live remote-project sessions as
   the binding hint, so the machine needs a live session, same precondition as the
   check buttons; search / font zoom / copy-on-select / theme follow / pooled
   scrollback across tab and page switches are built in), and **Sim settings** as a
   placeholder until its milestone lands), and
   a conversation header button that opens the tab and — while
   pinned 📌 — re-opens it on every session switch, so the sidebar follows workspace
   switches instead of collapsing. **Remote projects get no sidebar at all** (their
   role is anchoring the connection — remote files are browsed with dsh-remote
   itself): the tab body shows a one-line note, and the pinned auto-reopen skips
   remote sessions entirely.

   The **Overview health checks** live in the local project's sidebar, one button per
   function. The **Local environment** button runs the local report (python
   / sky130 PDK / disk / write probe). Below it, every dsh-remote machine that has a
   remote project gets its own block — machine identity (`user@host:port`, current
   marker, latency, last connection), the remote area path, and the live-session count
   of that remote project — with four buttons: **Load** (`/proc/loadavg` + core
   count), **LSF jobs** (`bjobs -a` queue overview), **Batch dirs** (work dirs
   carrying a `sweep_progress.json`, with their status/progress), and **Script sync**
   (md5 drift between the configured local `sim_scripts_dir` tree and the remote
   scripts root — `remote_scripts_dir` when the workspace config sets it, else the
   remote workspace root; recursive over `scripts/{common,spectre,snp}`,
   report only, nothing is uploaded). A run borrows a live session of that
   machine's remote project as the `rw_exec` agent context (its cwd inside the mirror
   is what binds the machine — no global active-machine switching); with no live
   session the buttons stay disabled with guidance. Results render as columned tables
   (job id / stat / exec host / name / submit time; directory / status / progress;
   file / sync state), with the workspace-scope prefix abbreviated to `$ROOT` and a
   legend line expanding it; a check whose output cannot be parsed falls back to its
   raw text. Failing rows offer a one-click agent-diagnosis prompt.

   The **project settings + project self-check** block sits under the check panel
   (local projects). Per-project settings live in
   `<workspace>/.harnessams/project_settings.json` (`run_mode` local/remote,
   `machine_id`, `remote_dir`, `scheduler` lsf/direct, `simulator` spectre/none,
   `compute_script_local`/`compute_script_remote` python/js) and render as a
   two-row table — row 1 = the live settings (dropdown cells, PUT on every
   change), row 2 = that setting's self-check verdict. Columns cascade off the
   mode/simulator choices (a local project hides machine/scheduler/remote-compute;
   simulator=none hides the scheduler), and the working-directory line above the
   table always shows `local` or the bound remote directory (pickable by browsing
   the machine's local mirror, converted back to a remote path). The one-click
   **project self-check** then walks the whole pipeline under those settings —
   machine, connection, environment, permissions, tools and compute — with ideal
   RC low-pass/high-pass testbenches (3×3 parameter grid, no PDK):
   `simulator=spectre` runs assemble → run_sweep → parse → pointwise verify
   (locally), or batch submit/poll → remote parse+verify → fetch + cross-check
   (remotely; an LSF failure is diagnosed immediately and retried once with
   `scheduler=direct`); `simulator=none` skips the simulator entirely and replays a
   bundled analytic golden dataset through parse + compute (locally, or
   upload → remote compute → download + cross-check). Verification compares every
   frequency point against the analytic RC response (1% tolerance) in the selected
   compute script — python or js locally (js runs in-process), python or node
   remotely (`remote_node` workspace key). Failures start diagnosis sessions
   automatically (same private session-controller channel as the check buttons).
4. **Session tool cards (conversation)** — DSH renders a generic JSON card for
   every model tool call; HarnessAMS registers the `tool.call.toolview` slot for
   the eight simulation tools (`batch_submit`/`batch_poll`/`batch_fetch`,
   `sim_progress`/`sim_analysis`, `spectre_assemble`/`spectre_run_sweep`/
   `spectre_parse` — keyed by exact wire tool name, one renderer covers both
   plugins; SmartAnaSim ships no client half). A card shows a status badge, a
   progress bar with succeeded/failed/pending counts, and the project-level
   batch aggregate ("3/5 batches done · 120/360 sims · 240 pending"): a local
   sweep in flight polls `/api/progress` live (3 s, paused while the tab is
   hidden) so the bar grows while the tool call blocks, and settled cards fetch
   the cross-batch summary once from `/api/progress-summary` (a local view —
   remote batches surface after `batch_fetch` brings the progress files back,
   the same dual-window semantics as the `sim_progress` tool). An expandable
   details section keeps the raw args/result JSON; the console-page display
   settings toggle turns the cards off (browser-local preference; the off state
   renders the raw shape itself since the occupied key cannot fall back to the
   DSH generic card). The onboarding guide covers the cards in its sixth section.

## What the npm packages ship (besides the JS)

| Package | Ships beyond the entry JS | Deliberately NOT shipped |
|---|---|---|
| `dsh-harnessams` (`src/`) | `client.js` (browser half, combo-loaded as-is); `server/` (host-half modules); `tools/` + `tool.js`/`py.js`/`bsub.js`/`remote.js`/`trash.js` (the 6 model tools: `batch_submit`/`batch_poll`/`batch_fetch` + `sim_analysis`/`sim_progress`/`safe_trash`; trash is a JS module since 2026-11-09); `cordis.patch.yml` (bundle patch); `assets/plotly.min.js` (about 4.6 MB, offline report rendering and `/harnessams/assets/` in-app serving) + the vendored xterm bundle (`assets/xterm.js`/`xterm.css`/`xterm-addon-fit.js`/`xterm-addon-search.js` — @xterm/xterm 5.5.0, served from `/harnessams/assets/` for the task-sidebar remote terminal) + `assets/THIRD_PARTY_NOTICES.md` (Plotly and xterm attributions); `scripts/common/` (3 `.py`: the analysis pipeline collect/report + a byte-identical `common_workspace.py` copy); `scripts/selfcheck/` (`selfcheck_verify.py` + `selfcheck_verify.mjs`, the self-check compute twins — same JSON contract); `selfcheck/` (the RC self-check assets: `script/analysis/gen_selfcheck_rc.py` + `golden/`, a 36-file analytic 3×3 psfascii dataset that replays the pipeline without a simulator) | `docs/`, `tests/`, the repo-root README/AGENTS/CHANGELOG |
| `dsh-harnessams-suite` (`install_suite/`) | `cordis.patch.yml` only (pure patch package) | everything else |

The master `plotly.min.js` travels inside the `dsh-harnessams` tarball, so suite
installs get offline reports: report generators seed a single workspace-level copy
from it (see `docs/decisions.md`, D-001). `PUBLISH.md` holds the
must-contain / must-not-contain checks that guard each tarball.

## Installation (available after the v0.1.0 release)

### Path A (standard, recommended): per-plugin install

```powershell
dsh plugin --profile web add --save-exact dsh-remote@0.8.83    # remote-projects prerequisite — runtime tool-shell consumer, deliberately NOT an npm dependency
dsh plugin --profile web add dsh-harnessams dsh-harnessams-smart-ana-sim
dsh --profile web    # restart the profile after installing: bundle membership is a startup boundary
```

### Path B (convenience): aggregate bundle, one command (first-party plugins only)

```powershell
dsh plugin --profile web add --save-exact dsh-remote@0.8.83    # remote-projects prerequisite — NOT part of the suite bundle
dsh plugin --profile web add dsh-harnessams-suite
dsh --profile web --dump-config    # confirm the layers and rows appear as expected
```

### Dev-time mount (usable now)

Write a `cordis.yml` inside the plugin repo (`name` pointing to the absolute path of the entry source file; forward slashes on Windows), then:

```powershell
dsh --profile web --patch <path-to>\cordis.yml --port 3080 --no-open
```

The web profile must already have dsh-remote exact-pinned for remote projects — `dsh plugin --profile web add --save-exact dsh-remote@0.8.83` (runtime tool-shell consumer, deliberately NOT an npm dependency).

Note: with the npm-installed CLI, `--profile web` already names the profile — do **not** append a positional `web` argument (the launcher rejects it with `too many arguments`); flags after the launcher options (such as `--port` / `--open`) reach the web app. Verified against `@deepseek-ai/dsh@0.2.1-rc.2` installed from npm (2026-10-25); re-verified on 0.2.2-rc.1 (2026-11-10).

## Environment

- Node.js >= 24.9 (DSH 0.2.2 floor; verified on v24.22.1);
- DSH: `npm i -g @deepseek-ai/dsh` then `dsh --profile web`; **verified version 0.2.2-rc.1** (2026-11-10; previously 0.2.1-rc.2, 2026-10-25; developer preview — pin the version; before upgrading, check the upstream release notes and rerun the minimal regression);
- dsh-remote: `dsh plugin --profile web add --save-exact dsh-remote@0.8.83` — required at runtime for remote projects/checks (consumed via the DSH tool shell, not a package dependency); **verified version 0.8.83** (2026-11-10; previously 0.8.66, 2026-10-31, source-audited; before upgrading, check the upstream release notes and rerun the minimal regression);
- Beware: npm hosts an unrelated same-name package `dsh`; remove it first with `npm rm -g dsh` if present;
- Simulation environment (SmartAnaSim): a local Spectre install is required for the `spectre_*` tools (commercial software, not bundled). The former ngspice + sky130 bundle (`LocalDesignExample/`) was removed on 2026-11-02 — restore it from this repo's `ngspice` branch if needed.

## Documentation

- `docs/plugin-index.md`: plugin index (spec/deps/permission boundaries/verified DSH versions);
- `docs/compatibility.md`: DSH version × plugin version compatibility matrix;
- `CHANGELOG.md` / `SECURITY.md` / `PUBLISH.md`: release records, security boundaries, publishing runbook;
- Each plugin repo carries its own README and AGENTS.md.

## Workspace layout (runtime convention)

Simulation runs against a **workspace** directory (created by the user, outside any repo) with a `harnessams.json` at its root providing fixed paths: `pdk_lib` (model-library entry), `trash_dir`. Relative values resolve against the config file's directory. Demo projects live as subdirectories (`<workspace>/<demo>/cells/<cell>/script/design_params.json`, `script/analysis/gen_*.py`, generated `sweep/Round*/top/`, reports in `Analysis/`). The console plugin and the Python scripts locate the workspace by walking upward for `harnessams.json` (bare form, or inside `harnessams-workspace/`).

## Customizing the plugin code — no build chain, edit in place

Everything ships as plain source: the plugin entries are plain-JS ESM loaded directly by DSH, and the pipeline logic is plain Python — nothing is transpiled, bundled, or compiled. **Both layers can be edited in place on the running machine**; they differ only in when an edit takes effect:

| Kind | Location | Edit takes effect |
|---|---|---|
| Per-project assembly/analysis scripts (yours to own) | workspace: `<workspace>/<demo>/script/analysis/*.py` (e.g. `gen_ota5t.py`) | next run |
| Framework scripts shipped with the plugins | simulator scripts: SmartAnaSim package dir `scripts/` (or the workspace `sim_scripts_dir`); analysis scripts (collect/report/trash): this package's `src/scripts/common/` | next run |
| Plugin JS entries (`src/index.js` + `src/client.js` here, `src/index.js` in SmartAnaSim) | dev-mount: the repo's own `src/` (your edit is the source); installed: `node_modules/<package>/src/` | after restarting that DSH instance |

Why the difference: every tool invocation spawns a fresh `python <script>` process (system Python from `PATH`) that reads the file from disk again — no rebuild, no reinstall, no DSH restart (a sweep already in progress keeps the copy it loaded). The JS entry, in contrast, is loaded once via ESM at startup and cached by the module system, so it needs a restart of that instance; other instances are separate processes and keep running unaffected.

Tune check thresholds, adjust report wording, or add your own adjudication rules by editing the local files directly. Two caveats: keep durable customization in the **workspace** scripts — anything inside the installed package directory (the Python scripts *and* `index.js`) is overwritten when the plugin is upgraded; and the in-package path above follows DSH's profile layout as observed with `dsh plugin --profile web add` — confirm your install location with `dsh plugin --profile web list` if it differs.

## License

[MIT](LICENSE)
