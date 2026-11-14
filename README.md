# HarnessAMS

> HarnessAMS top-level entry repo: plugin index + install guide + compatibility matrix; also hosts the aggregate bundle `dsh-harnessams-suite`. Mission: an open-source project doing AMS (analog/mixed-signal) design with an LLM harness, built on the DSH (`@deepseek-ai/dsh`) plugin system — "everything is a plugin". **Current status**: stage 1 (core entry + pre-layout simulation) in development; plugins are implemented and smoke-tested but **not yet published** — the npm install commands below become usable after the v0.1.0 release; use the dev-mount until then.

## Plugin index

| Plugin | npm package | row id | Responsibility | Stage | Status |
|---|---|---|---|---|---|
| HarnessAMS (top) | `dsh-harnessams` | `harnessams-top` | Three-tier UI + orchestration: global console page (remote projects, digital assets, disk usage), project = DSH workspace, per-project task sidebar with health checks; the generic remote batch channel (`batch_*`, worker tree from the workspace `sim_scripts_dir`) and the simulator-agnostic analysis tools (`sim_analysis`/`sim_progress`/`safe_trash`) | stage 1 | implemented (this repo, `src/`) |
| HarnessAMS-SmartAnaSim | `dsh-harnessams-smart-ana-sim` | `harnessams-smart-ana-sim` | Simulation: local Spectre channel (code-driven netlist assembly with hard PDK isolation), PSF parsing, S-parameter reading/extraction — simulator-specific code only | stage 1 | implemented (separate repo) |
| HarnessAMS-SmartPostLayout | (repo in stage 2) | `harnessams-smart-post-layout` | One-click post-layout simulation | stage 2 | not started |
| HarnessAMS-aligner | (repo in stage 3) | `harnessams-aligner` | Multi-level alignment | stage 3 | not started |

## Repository layout

```
src/                     dsh-harnessams — console plugin package:
                         index.js (host-half routes + model-tool registration, plain JS, no build chain),
                         server/ (host-half modules: workspace/checks/disk/project/machines/remote/assets/
                                 settings/selfcheck),
                         tools/ + tool.js/py.js/batch.js/remote.js (generic remote batch + analysis/ops
                         model tools),
                         client.js (browser half — single-file classic script on window.__ModuleLoader__),
                         assets/ (plotly.min.js + the vendored xterm bundle + THIRD_PARTY_NOTICES),
                         scripts/ (project self-check compute twins under selfcheck/;
                                 retired _dont_use_* reference copies under common/)
install_suite/           dsh-harnessams-suite — aggregate bundle (pure patch package)
tests/                   unit tests (bare node --test, from the repo root)
docs/                    plugin index, compatibility matrix
CHANGELOG.md / SECURITY.md / PUBLISH.md
```

## The three-tier UI (DSH Web)

The plugin surfaces itself inside the DSH Web client (no separate page URL):

1. **Global console page** — the "HarnessAMS" entry in the left sidebar (next to Plugins / Automation tasks) opens a full page with **Remote projects**, **Digital assets** (plotly asset status + the workspace report library), **Disk usage** for the local workspace, and a **Display settings** block (the session tool-card toggle, on by default).

   Remote connectivity is delegated entirely to the **@linxin666/dsh-ssh** plugin (dsh-remote retired 2026-11-14) — HarnessAMS keeps no server registry and no ssh channel of its own. This page reads the dsh-ssh host registry read-only (via the `ssh_list` tool shell) and shows, per alias, its host line, auth kind and the configured **remote root** — the alias-to-absolute-path map lives in the workspace `harnessams.json` `remote_machines` section, NOT in dsh-ssh; an alias without a root renders the configure-hint instead of a path. Host management (aliases/credentials) and the **interactive SSH terminal stay in dsh-ssh itself** — HarnessAMS deliberately does not duplicate them. Prefer key-based auth with no stored passphrase; passwords in dsh-ssh are plaintext at `~/.dsh/dsh-ssh.json` (0600).
2. **Project = DSH workspace** — a project is nothing more than a DSH workspace (a local folder). Per-project task data lives at `<workspace>/.harnessams/tasks.json`; sessions are deliberately not modeled (every session of a workspace shares the task list).
3. **Right-sidebar task tab (local projects only)** — one plugin tab, **HarnessAMS**, sits in the right-sidebar strip next to the host tabs. Its first-level strip carries the **Project overview** (项目总览) pseudo-capsule first — the tab's default display, project-scoped (the health-check panel + project settings/self-check, detailed below); a module cache re-renders it from the last snapshot on same-project session or strip switches (no blank refetch — switching to a different project clears and refetches) — then one card per task (× to delete) and a **new task** button that opens the create dialog. Selecting a task shows an always-visible task info block (name/date row + the editable description) and an in-task sub-navigation (**Dashboard** as an HTML-report viewer — browse the local disk to add existing reports to the task, switch them in a dropdown, reload them on demand; reports are served read-only from `/harnessams/dash/<taskId>/<reportId>/…` with each report's own directory as root so their relative `data/*.js` references keep working, the iframe fills the sidebar via a flex height chain and embeds the report compact + scaled to the DSH font-size setting, `sim_analysis(report=true, task=…)` registers generated reports straight into a task, the sidebar re-bases its writes on a fresh GET so the two writers never clobber each other, and the sub-view **auto-refreshes** while visible (10 s API polling, paused when the tab is hidden: new/switched registrations appear in the dropdown and a regenerated report document reloads through `/api/report-stat` mtime+size), **Check params** as an editable table of the assembly-layer check parameters — the ideal R/C/L plausibility ranges (six numbers) plus the unit-check / bias<Vdd / strict-includes switches — stored per project at `<workspace>/.harnessams/check_params.json` via `GET/PUT /api/check-params` (one confirmed PUT for the whole object; unconfirmed drafts keep the saved value visible in gray parentheses, and the confirm button stays disabled until something changes; SmartAnaSim's check library reads the same file as its default source, fail-open to the built-in constants, so a confirmed change takes effect on the next assembly run), and **Sim settings** as a placeholder until its milestone lands — the remote-terminal sub-view was removed with the dsh-remote retirement: the interactive shell is dsh-ssh's own terminal panel, same credentials). The strip selection and the sub-view both survive remounts and reloads (module memory + localStorage). The sidebar **follows session switches when it was open**: DSH keeps one right-sidebar layout per session (a fresh session starts collapsed, a reload restores each session's own layout), so only a mid-page switch collapses an open sidebar — the tab body probes its own visibility and the conversation header button (labeled `HarnessAMS`) re-opens the tab on a session change iff the sidebar was visible moments ago (a collapsed sidebar stays collapsed).

   The **Project overview** view's health checks — one button per function. The **Local environment** button runs the local report (python / sky130 PDK / disk / write probe). Below it, every dsh-ssh alias that has a configured remote root gets its own block — identity line (`user@host:port`, auth kind) and the remote root path — with four buttons: **Load** (`/proc/loadavg` + core count), **LSF jobs** (`bjobs -a` queue overview), **Batch dirs** (work dirs carrying a `sweep_progress.json`, with their status/progress), and **Script sync** (md5 drift between the configured local `sim_scripts_dir` tree and the remote scripts root — `remote_scripts_dir` when the workspace config sets it, else the alias's remote root; recursive over `scripts/{common,spectre,snp}`, report only, nothing is uploaded). Checks run `ssh_exec` straight at the alias (zero gating — no borrowed session); an alias without a remote root is listed as unconfigured with guidance instead of a block. Results render as columned tables (job id / stat / exec host / name / submit time; directory / status / progress; file / sync state), with the root prefix abbreviated to `$ROOT` and a legend line expanding it; a check whose output cannot be parsed falls back to its raw text. Failing rows offer a one-click agent-diagnosis prompt.

   The **project settings + project self-check** block sits under the check panel (local projects). Per-project settings live in `<workspace>/.harnessams/project_settings.json` (`run_mode` local/remote, `machine_id`, `remote_dir`, `scheduler` lsf/direct, `simulator` spectre/none, `compute_script_local`/`compute_script_remote` python/js) and render as a two-row table — row 1 = the live settings (dropdown cells, PUT on every change), row 2 = that setting's self-check verdict. Columns cascade off the mode/simulator choices (a local project hides machine/scheduler/remote-compute; simulator=none hides the scheduler), and the working-directory line above the table always shows `local` or the bound remote directory (typed as a path relative to the alias's remote root, or absolute). The one-click **project self-check** then walks the whole pipeline under those settings — machine, connection, environment, permissions, tools and compute — with ideal RC low-pass/high-pass testbenches (3×3 parameter grid, no PDK): `simulator=spectre` runs assemble → run_sweep → parse → pointwise verify (locally), or batch submit/poll → remote parse+verify → fetch + cross-check (remotely; an LSF failure is diagnosed immediately and retried once with `scheduler=direct`); `simulator=none` skips the simulator entirely and replays a bundled analytic golden dataset through parse + compute (locally, or upload → remote compute → download + cross-check). Verification compares every frequency point against the analytic RC response (1% tolerance) in the selected compute script — python or js locally (js runs in-process), python or node remotely (`remote_node` workspace key). Failures start diagnosis sessions automatically (same private session-controller channel as the check buttons).
4. **Session tool cards (conversation)** — DSH renders a generic JSON card for every model tool call; HarnessAMS registers the `tool.call.toolview` slot for the eight simulation tools (`batch_submit`/`batch_poll`/`batch_fetch`, `sim_progress`/`sim_analysis`, `spectre_assemble`/`spectre_run_sweep`/ `spectre_parse` — keyed by exact wire tool name, one renderer covers both plugins; SmartAnaSim ships no client half). A card shows a status badge, a progress bar with succeeded/failed/pending counts, and the project-level batch aggregate ("3/5 batches done · 120/360 sims · 240 pending"): a local sweep in flight polls `/api/progress` live (3 s, paused while the tab is hidden) so the bar grows while the tool call blocks, and settled cards fetch the cross-batch summary once from `/api/progress-summary` (a local view — remote batches surface after `batch_fetch` brings the progress files back, the same dual-window semantics as the `sim_progress` tool). An expandable details section keeps the raw args/result JSON; the console-page display settings toggle turns the cards off (browser-local preference; the off state renders the raw shape itself since the occupied key cannot fall back to the DSH generic card). The onboarding guide covers the cards in its sixth section.

## Simulation execution modes

A sweep always starts with the same assembly step; only the execution channel differs. Three modes exist, defined by WHERE the worker actually runs:

| Mode | Selection | Worker host | Channel |
|---|---|---|---|
| local | `spectre_run_sweep` (no scheduler involved) | the host running DSH itself | in-process Python spawn |
| direct | `batch_submit(scheduler="direct")` | the SSH target host itself, foreground | ssh_upload + `ssh_exec` (no LSF; marker+flock replay guard) |
| lsf | `batch_submit(scheduler="lsf")` (default) | the SSH target host's cluster via the LSF queue | ssh_upload + `bsub`/`bjobs` (marker read-back idempotency) |

### Mode 1 — local (the DSH host runs Spectre itself)

Needs ONLY the SmartAnaSim plugin (`dsh-harnessams-smart-ana-sim`): the three `spectre_*` tools all live there, so this path runs with the top-level plugin absent. AMS adds `sim_analysis` (HTML report + sidebar injection) and the `batch_*` remote channel — neither is required here. Spectre must be installed on the DSH host; the whole call is bounded by `timeout_sec` (default 1200 s).

spectre_assemble(project_dir=...)   # design_params.json -> template.scs + sweep_config.json (+ format/unit/bias checks)
spectre_run_sweep(run_dir=...)      # per-point NN/netlist.scs (@@PARAM@@ substitution) + psfascii raw + point_meta.json
spectre_parse(work_dir=...)         # raw psfascii -> per-point JSON curves + psf_index.json (optional long CSV)

Results land in the local run directory — analyze immediately, no fetch step.

### Mode 2 — remote, direct (the target node's local foreground, no LSF)

Same worker, but executed on the SSH target node's own host as a foreground process. Requires a live session in that machine's remote project (`machine_id`, or a calling session already inside the mirror).

spectre_assemble(project_dir=...)
batch_submit(run_dir=..., machine_id=..., remote_dir=...,
             worker="spectre/spectre_sweep_worker.py", scheduler="direct")
batch_poll(run_dir=...)             # reads progress files (job file carries scheduler=direct), not bjobs
batch_fetch(run_dir=...)            # tar over dsh-ssh (ssh_download of the single tgz), extracted into the local run_dir
sim_analysis(run_dir=...) / spectre_parse(work_dir=...)

Gotchas: the whole worker must finish inside the 600 s direct deadline (the exec funnel wraps every command in a remote `timeout -s KILL`; long sweeps belong on lsf); artifacts stay on the remote until `batch_fetch` brings them back; a `direct-<timestamp>` job id plus the run's coordinates are recorded in `<run_dir>/.batch_job.json` for poll/fetch.

### Mode 3 — remote, LSF (the target cluster's queue)

The default scheduler. No wall-clock cap — queue wait and execution are both visible through bjobs, so arbitrarily long sweeps are fine.

spectre_assemble(project_dir=...)
batch_submit(run_dir=..., machine_id=..., remote_dir=...,
             worker="spectre/spectre_sweep_worker.py")   # scheduler="lsf" is the default
batch_poll(run_dir=...)             # bjobs state + point_meta count; "No job found" with full meta = completed
batch_fetch(run_dir=...)            # bsub.out / bsub.err (LSF's own outputs) are in the default includes
sim_analysis(run_dir=...) / spectre_parse(work_dir=...)

The worker scripts upload tree for both remote modes is the workspace `sim_scripts_dir` (normally the SmartAnaSim package's `scripts/`).

## What the npm packages ship (besides the JS)

| Package | Ships beyond the entry JS | Deliberately NOT shipped |
|---|---|---|
| `dsh-harnessams` (`src/`) | `client.js` (browser half, combo-loaded as-is); `server/` (host-half modules); `tools/` + `tool.js`/`py.js`/`batch.js`/`remote.js`/`trash.js` (the 6 model tools: `batch_submit`/`batch_poll`/`batch_fetch` + `sim_analysis`/`sim_progress`/`safe_trash`; the analysis pipeline and trash are pure JS); `cordis.patch.yml` (bundle patch); `assets/plotly.min.js` (about 4.6 MB, offline report rendering and `/harnessams/assets/` in-app serving) + the vendored xterm bundle (`assets/xterm.js`/`xterm.css`/`xterm-addon-fit.js`/`xterm-addon-search.js` — @xterm/xterm 5.5.0, served from `/harnessams/assets/` for the task-sidebar remote terminal) + `assets/THIRD_PARTY_NOTICES.md` (Plotly and xterm attributions); `scripts/selfcheck/` (`selfcheck_verify.py` + `selfcheck_verify.mjs`, the self-check compute twins — same JSON contract); `selfcheck/` (the RC self-check assets: `script/analysis/gen_selfcheck_rc.py` + `golden/`, a 36-file analytic 3×3 psfascii dataset that replays the pipeline without a simulator) | `scripts/common/` (`_dont_use_*` retired reference copies — never executed), `docs/`, `tests/`, the repo-root README/AGENTS/CHANGELOG |
| `dsh-harnessams-suite` (`install_suite/`) | `cordis.patch.yml` only (pure patch package) | everything else |

The master `plotly.min.js` travels inside the `dsh-harnessams` tarball, so suite installs get offline reports: report generators seed a single workspace-level copy from it (see `docs/decisions.md`, D-001). `PUBLISH.md` holds the must-contain / must-not-contain checks that guard each tarball.

## Installation (available after the v0.1.0 release)

### Path A (standard, recommended): per-plugin install

```powershell
dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.18    # remote channel — runtime tool-shell consumer, deliberately NOT an npm dependency; pnpm 12 asks to approve the ssh2/cpu-features build scripts (`pnpm approve-builds ssh2 cpu-features --yes`)
dsh plugin --profile web add dsh-harnessams dsh-harnessams-smart-ana-sim
dsh --profile web    # restart the profile after installing: bundle membership is a startup boundary
```

### Path B (convenience): aggregate bundle, one command (first-party plugins only)

```powershell
dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.18    # remote channel — NOT part of the suite bundle
dsh plugin --profile web add dsh-harnessams-suite
dsh --profile web --dump-config    # confirm the layers and rows appear as expected
```

### Dev-time mount (usable now)

Write a `cordis.yml` inside the plugin repo (`name` pointing to the absolute path of the entry source file; forward slashes on Windows), then:

```powershell
dsh --profile web --patch <path-to>\cordis.yml --port 3080 --no-open
```

The web profile must already have @linxin666/dsh-ssh exact-pinned for the remote channel — `dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.18` (runtime tool-shell consumer, deliberately NOT an npm dependency). Configure host aliases in dsh-ssh's own panel and map each alias to its remote root under `remote_machines` in the workspace `harnessams.json`.

Note: with the npm-installed CLI, `--profile web` already names the profile — do **not** append a positional `web` argument (the launcher rejects it with `too many arguments`); flags after the launcher options (such as `--port` / `--open`) reach the web app. Verified against `@deepseek-ai/dsh@0.2.1-rc.2` installed from npm (2026-10-25); re-verified on 0.2.2-rc.1 (2026-11-10).

## Environment

- Node.js >= 24.9 (DSH 0.2.2 floor; verified on v24.22.1);
- DSH: `npm i -g @deepseek-ai/dsh` then `dsh --profile web`; **verified version 0.2.2-rc.3** (2026-11-14; previously 0.2.2-rc.1, 2026-11-10, and 0.2.1-rc.2, 2026-10-25; developer preview — pin the version; before upgrading, check the upstream release notes and rerun the minimal regression; both plugins' `engines.dsh` is exact-pinned to the same version);
- @linxin666/dsh-ssh: `dsh plugin --profile web add --save-exact @linxin666/dsh-ssh@0.4.18` — required at runtime for remote checks/batches (consumed via the DSH tool shell, not a package dependency); **verified version 0.4.18** (2026-11-14; contract re-verified against the installed package's src/tools.ts). Its peerDeps require dsh >= 0.2.2-rc.2 — hence the rc.3 host. Deployment notes: telemetry is ON by default (opt out with localStorage `dsh-web-ui-telemetry-opt-out=1` or DNT); there is no host-key verification (prefer a restricted account + key auth); a lost connection replays a non-idempotent exec up to 3 times — the batch layer guards with marker+flock idempotency (see the root repo's dependency-check doc §2).
- Beware: npm hosts an unrelated same-name package `dsh`; remove it first with `npm rm -g dsh` if present;
- Simulation environment (SmartAnaSim): a local Spectre install is required for the `spectre_*` tools (commercial software, not bundled).

## Documentation

- `docs/plugin-index.md`: plugin index (spec/deps/permission boundaries/verified DSH versions);
- `docs/compatibility.md`: DSH version × plugin version compatibility matrix;
- `CHANGELOG.md` / `SECURITY.md` / `PUBLISH.md`: release records, security boundaries, publishing runbook;
- Each plugin repo carries its own README and AGENTS.md.

## Workspace layout (runtime convention)

Simulation runs against a **workspace** directory (created by the user, outside any repo) with a `harnessams.json` at its root providing fixed paths: `pdk_lib` (model-library entry), `trash_dir`. Relative values resolve against the config file's directory. Demo projects live as subdirectories (`<workspace>/<demo>/cells/<cell>/script/design_params.json`, `script/analysis/gen_*.py`, generated `sweep/Round*/top/`, reports in `Analysis/`). The console plugin and the Python scripts locate the workspace by walking upward for `harnessams.json` (bare form, or inside `harnessams-workspace/`).

## Customizing the plugin code — no build chain, edit in place

Everything ships as plain source: the plugin entries are plain-JS ESM loaded directly by DSH, and the simulator pipeline logic is plain Python — nothing is transpiled, bundled, or compiled. **Both layers can be edited in place on the running machine**; they differ only in when an edit takes effect:

| Kind | Location | Edit takes effect |
|---|---|---|
| Per-project assembly/analysis scripts (yours to own) | workspace: `<workspace>/<demo>/script/analysis/*.py` (e.g. `gen_ota5t.py`) | next run |
| Framework scripts shipped with the plugins | simulator scripts: SmartAnaSim package dir `scripts/` (or the workspace `sim_scripts_dir`); self-check scripts: this package's `src/scripts/selfcheck/` (the analysis pipeline collect/report is plain JS in `src/tools/sim_analysis.js` — edits follow the JS row below) | next run |
| Plugin JS entries (`src/index.js` + `src/client.js` here, `src/index.js` in SmartAnaSim) | dev-mount: the repo's own `src/` (your edit is the source); installed: `node_modules/<package>/src/` | after restarting that DSH instance |

Why the difference: every tool invocation spawns a fresh `python <script>` process (system Python from `PATH`) that reads the file from disk again — no rebuild, no reinstall, no DSH restart (a sweep already in progress keeps the copy it loaded). The JS entry, in contrast, is loaded once via ESM at startup and cached by the module system, so it needs a restart of that instance; other instances are separate processes and keep running unaffected.

Tune check thresholds, adjust report wording, or add your own adjudication rules by editing the local files directly. Two caveats: keep durable customization in the **workspace** scripts — anything inside the installed package directory (the Python scripts *and* `index.js`) is overwritten when the plugin is upgraded; and the in-package path above follows DSH's profile layout as observed with `dsh plugin --profile web add` — confirm your install location with `dsh plugin --profile web list` if it differs.

## License

[MIT](LICENSE)
