# HarnessAMS

> HarnessAMS top-level entry repo: plugin index + install guide + compatibility matrix; also hosts the aggregate bundle `dsh-harnessams-suite` and the bundled `LocalDesignExample` simulation environment.
> Mission: an open-source project doing AMS (analog/mixed-signal) design with an LLM harness, built on the DSH (`@deepseek-ai/dsh`) plugin system — "everything is a plugin".
> **Current status**: stage 1 (core entry + pre-layout simulation) in development; plugins are implemented and smoke-tested but **not yet published** — the npm install commands below become usable after the v0.1.0 release; use the dev-mount until then.

## Plugin index

| Plugin | npm package | row id | Responsibility | Stage | Status |
|---|---|---|---|---|---|
| HarnessAMS (top) | `dsh-harnessams` | `harnessams-top` | Three-tier UI + orchestration: global console page (remote projects, digital assets, disk usage), project = DSH workspace, per-project task sidebar with health checks | stage 1 | implemented (this repo, `src/`) |
| HarnessAMS-SmartAnaSim | `dsh-harnessams-smart-ana-sim` | `harnessams-smart-ana-sim` | Simulation: local ngspice channel, code-driven netlist assembly (hard PDK isolation), HTML reports | stage 1 | implemented (separate repo) |
| HarnessAMS-SmartPostLayout | (repo in stage 2) | `harnessams-smart-post-layout` | One-click post-layout simulation | stage 2 | not started |
| HarnessAMS-aligner | (repo in stage 3) | `harnessams-aligner` | Multi-level alignment | stage 3 | not started |

## Repository layout

```
src/                     dsh-harnessams — console plugin package:
                         index.js (host-half routes, plain JS, no build chain),
                         server/ (host-half modules: workspace/checks/disk/project/machines/remote/assets),
                         client.js (browser half — single-file classic script on window.__ModuleLoader__),
                         assets/ (plotly.min.js + the vendored xterm bundle + THIRD_PARTY_NOTICES), scripts/ (shipped developer utilities)
install_suite/           dsh-harnessams-suite — aggregate bundle (pure patch package)
tests/                   unit tests (bare node --test, from the repo root)
docs/                    plugin index, compatibility matrix
LocalDesignExample/      bundled local simulation environment (see below)
CHANGELOG.md / SECURITY.md / PUBLISH.md
```

## The three-tier UI (DSH Web)

The plugin surfaces itself inside the DSH Web client (no separate page URL):

1. **Global console page** — the "HarnessAMS" entry in the left sidebar (next to
   Plugins / Automation tasks) opens a full page with **Remote projects**, **Digital
   assets** (plotly asset status + the workspace report library), and **Disk usage**
   for the local workspace.

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

   **Credential storage** (dsh-remote 0.8.66, source audited 2026-10-31; credential
   logic identical to 0.8.54): for
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
   report compact + scaled to the DSH font-size setting, SmartAnaSim's
   `sim_report(task=…)` registers generated reports straight into a task, and the
   sidebar re-bases its writes on a fresh GET so the two writers never clobber each
   other, **Terminal** as an interactive remote terminal per dsh-remote machine
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
   function. The **Local environment** button runs the local report (python / ngspice
   / sky130 PDK / disk / write probe). Below it, every dsh-remote machine that has a
   remote project gets its own block — machine identity (`user@host:port`, current
   marker, latency, last connection), the remote area path, and the live-session count
   of that remote project — with four buttons: **Load** (`/proc/loadavg` + core
   count), **LSF jobs** (`bjobs -a` queue overview), **Batch dirs** (work dirs
   carrying a `sweep_progress.json`, with their status/progress), and **Script sync**
   (md5 drift between the configured local `sim_scripts_dir` tree and the remote
   scripts root — `remote_scripts_dir` when the workspace config sets it, else the
   remote workspace root; recursive over `scripts/{common,ngspice,spectre,snp}`,
   report only, nothing is uploaded). A run borrows a live session of that
   machine's remote project as the `rw_exec` agent context (its cwd inside the mirror
   is what binds the machine — no global active-machine switching); with no live
   session the buttons stay disabled with guidance. Results render as columned tables
   (job id / stat / exec host / name / submit time; directory / status / progress;
   file / sync state), with the workspace-scope prefix abbreviated to `$ROOT` and a
   legend line expanding it; a check whose output cannot be parsed falls back to its
   raw text. Failing rows offer a one-click agent-diagnosis prompt.

## What the npm packages ship (besides the JS)

| Package | Ships beyond the entry JS | Deliberately NOT shipped |
|---|---|---|
| `dsh-harnessams` (`src/`) | `client.js` (browser half, combo-loaded as-is); `server/` (host-half modules); `cordis.patch.yml` (bundle patch); `assets/plotly.min.js` (about 4.6 MB, offline report rendering and `/harnessams/assets/` in-app serving) + the vendored xterm bundle (`assets/xterm.js`/`xterm.css`/`xterm-addon-fit.js`/`xterm-addon-search.js` — @xterm/xterm 5.5.0, served from `/harnessams/assets/` for the task-sidebar remote terminal) + `assets/THIRD_PARTY_NOTICES.md` (Plotly and xterm attributions); `scripts/` (developer utilities shipped with the package — currently a placeholder README) | `LocalDesignExample/` (~21 MB vendored simulation environment), `docs/`, `tests/`, the repo-root README/AGENTS/CHANGELOG |
| `dsh-harnessams-suite` (`install_suite/`) | `cordis.patch.yml` only (pure patch package) | everything else |

The master `plotly.min.js` travels inside the `dsh-harnessams` tarball, so suite
installs get offline reports: report generators seed a single workspace-level copy
from it (see `docs/decisions.md`, D-001). `PUBLISH.md` holds the
must-contain / must-not-contain checks that guard each tarball.

## LocalDesignExample (bundled local simulation environment)

A self-contained environment so a fresh clone can run sky130/ngspice simulations with zero
external downloads:

```
LocalDesignExample/
  ngspice-47-portable/   ngspice_con.exe + runtime DLLs (Windows x64; see its README)
  sky130/                fossi sky130_fd_pr minimal model closure (combined_models + cells) + LICENSE
  tools/                 verbatim copies of the SmartAnaSim pipeline scripts (common/ + ngspice/;
                         keep in sync with the plugin version)
  harnessams.json        workspace config with paths relative to this file (works from any clone location)
  check_environment.py   self-check: runs the bundled ngspice on a minimal sky130 netlist and audits the assets
  demo1/, demo2/         demo project placeholders (content lands with the demo milestones)
```

Offline report rendering uses a single workspace-level copy: the report generator seeds
`<workspace_root>/assets/plotly.min.js` from the master `src/assets/plotly.min.js`
(which ships inside the `dsh-harnessams` tarball and is found by walking up from its own
location, via the workspace `harnessams.json` `plotly_asset` field, or from a sibling
`dsh-harnessams` install under `node_modules/`), and every report references it with a
workspace-relative `src`. The CDN is the last-resort fallback. See `docs/decisions.md`
(D-001). The seeded workspace copy is a runtime artifact (gitignored under
`LocalDesignExample/`).

Run `python check_environment.py` from `LocalDesignExample/` after cloning. Non-Windows
hosts: install ngspice yourself and point `ngspice_cmd` in `harnessams.json` at it (the
bundled binary is Windows x64 only). With the DSH plugins installed, the directory also
works as a regular workspace — the console and the pipeline discover `harnessams.json` by
walking upward from wherever they run.

## Installation (available after the v0.1.0 release)

### Path A (standard, recommended): per-plugin install

```powershell
dsh plugin --profile web add --save-exact dsh-remote@0.8.66    # remote-projects prerequisite — runtime tool-shell consumer, deliberately NOT an npm dependency
dsh plugin --profile web add dsh-harnessams dsh-harnessams-smart-ana-sim
dsh --profile web    # restart the profile after installing: bundle membership is a startup boundary
```

### Path B (convenience): aggregate bundle, one command (first-party plugins only)

```powershell
dsh plugin --profile web add --save-exact dsh-remote@0.8.66    # remote-projects prerequisite — NOT part of the suite bundle
dsh plugin --profile web add dsh-harnessams-suite
dsh --profile web --dump-config    # confirm the layers and rows appear as expected
```

### Dev-time mount (usable now)

Write a `cordis.yml` inside the plugin repo (`name` pointing to the absolute path of the entry source file; forward slashes on Windows), then:

```powershell
dsh --profile web --patch <path-to>\cordis.yml --port 3080 --no-open
```

The web profile must already have dsh-remote exact-pinned for remote projects — `dsh plugin --profile web add --save-exact dsh-remote@0.8.66` (runtime tool-shell consumer, deliberately NOT an npm dependency).

Note: with the npm-installed CLI, `--profile web` already names the profile — do **not** append a positional `web` argument (the launcher rejects it with `too many arguments`); flags after the launcher options (such as `--port` / `--open`) reach the web app. Verified against `@deepseek-ai/dsh@0.2.1-rc.2` installed from npm (2026-10-25).

## Environment

- Node.js >= 22.19 (verified on v24.22.1);
- DSH: `npm i -g @deepseek-ai/dsh` then `dsh --profile web`; **verified version 0.2.1-rc.2** (developer preview — pin the version; before upgrading, check the upstream release notes and rerun the minimal regression);
- dsh-remote: `dsh plugin --profile web add --save-exact dsh-remote@0.8.66` — required at runtime for remote projects/checks (consumed via the DSH tool shell, not a package dependency); **verified version 0.8.66** (2026-10-31, source-audited; before upgrading, check the upstream release notes and rerun the minimal regression);
- Beware: npm hosts an unrelated same-name package `dsh`; remove it first with `npm rm -g dsh` if present;
- Simulation environment (SmartAnaSim): ngspice-47 portable + sky130 fossi `combined_models` — a ready-to-run bundle of both ships in this repo under `LocalDesignExample/` (the full sky130/ngspice gotcha list lives in the SmartAnaSim repo).

## Documentation

- `docs/plugin-index.md`: plugin index (spec/deps/permission boundaries/verified DSH versions);
- `docs/compatibility.md`: DSH version × plugin version compatibility matrix;
- `CHANGELOG.md` / `SECURITY.md` / `PUBLISH.md`: release records, security boundaries, publishing runbook;
- Each plugin repo carries its own README and AGENTS.md.

## Workspace layout (runtime convention)

Simulation runs against a **workspace** directory (created by the user, outside any repo — `LocalDesignExample/` being the checked-in exception) with a `harnessams.json` at its root providing fixed paths: `ngspice_cmd` (portable ngspice), `pdk_lib` (sky130 model-library entry), `trash_dir`. Relative values resolve against the config file's directory. Demo projects live as subdirectories (`<workspace>/<demo>/cells/<cell>/script/design_params.json`, `script/analysis/gen_*.py`, generated `sweep/Round*/top/`, reports in `Analysis/`). The console plugin and the Python scripts locate the workspace by walking upward for `harnessams.json` (bare form, or inside `harnessams-workspace/`).

## Customizing the plugin code — no build chain, edit in place

Everything ships as plain source: the plugin entries are plain-JS ESM loaded directly by DSH, and the pipeline logic is plain Python — nothing is transpiled, bundled, or compiled. **Both layers can be edited in place on the running machine**; they differ only in when an edit takes effect:

| Kind | Location | Edit takes effect |
|---|---|---|
| Per-project assembly/analysis scripts (yours to own) | workspace: `<workspace>/<demo>/script/analysis/*.py` (e.g. `gen_ota5t.py`) | next run |
| Framework scripts shipped with the plugin | SmartAnaSim package dir, e.g. `~/.dsh/profiles/web/node_modules/dsh-harnessams-smart-ana-sim/scripts/` (`sweep_worker_ngspice.py`, `checks.py`, `collect_results.py`, `gen_sweep_report.py`, `trash.py`) | next run |
| Bundled example copies | this repo: `LocalDesignExample/tools/{common,ngspice}/*.py` — verbatim copies of the plugin scripts above; re-sync when the plugin updates | next run |
| Plugin JS entries (`src/index.js` + `src/client.js` here, `src/index.js` in SmartAnaSim) | dev-mount: the repo's own `src/` (your edit is the source); installed: `node_modules/<package>/src/` | after restarting that DSH instance |

Why the difference: every tool invocation spawns a fresh `python <script>` process (system Python from `PATH`) that reads the file from disk again — no rebuild, no reinstall, no DSH restart (a sweep already in progress keeps the copy it loaded). The JS entry, in contrast, is loaded once via ESM at startup and cached by the module system, so it needs a restart of that instance; other instances are separate processes and keep running unaffected.

Tune check thresholds, adjust report wording, or add your own adjudication rules by editing the local files directly. Two caveats: keep durable customization in the **workspace** scripts — anything inside the installed package directory (the Python scripts *and* `index.js`) is overwritten when the plugin is upgraded; and the in-package path above follows DSH's profile layout as observed with `dsh plugin --profile web add` — confirm your install location with `dsh plugin --profile web list` if it differs.

## License

[MIT](LICENSE)
