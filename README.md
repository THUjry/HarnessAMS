# HarnessAMS

> HarnessAMS top-level entry repo: plugin index + install guide + compatibility matrix; also hosts the aggregate bundle `dsh-harnessams-suite` and the bundled `LocalDesignExample` simulation environment.
> Mission: an open-source project doing AMS (analog/mixed-signal) design with an LLM harness, built on the DSH (`@deepseek-ai/dsh`) plugin system — "everything is a plugin".
> **Current status**: stage 1 (core entry + pre-layout simulation) in development; plugins are implemented and smoke-tested but **not yet published** — the npm install commands below become usable after the v0.1.0 release; use the dev-mount until then.

## Plugin index

| Plugin | npm package | row id | Responsibility | Stage | Status |
|---|---|---|---|---|---|
| HarnessAMS (top) | `dsh-harnessams` | `harnessams-top` | Console and orchestration: server health checks, disk usage/capacity, workspace directory management | stage 1 | implemented (this repo, `src/`) |
| HarnessAMS-SmartAnaSim | `dsh-harnessams-smart-ana-sim` | `harnessams-smart-ana-sim` | Simulation: local ngspice channel, code-driven netlist assembly (hard PDK isolation), HTML reports | stage 1 | implemented (separate repo) |
| HarnessAMS-SmartPostLayout | (repo in stage 2) | `harnessams-smart-post-layout` | One-click post-layout simulation | stage 2 | not started |
| HarnessAMS-aligner | (repo in stage 3) | `harnessams-aligner` | Multi-level alignment | stage 3 | not started |

## Repository layout

```
src/                     dsh-harnessams — console plugin package:
                         index.js (plain JS, no build chain), assets/ (plotly.min.js +
                         THIRD_PARTY_NOTICES), scripts/ (shipped developer utilities)
install_suite/           dsh-harnessams-suite — aggregate bundle (pure patch package)
tests/                   starter unit tests (bare node --test, from the repo root)
docs/                    plugin index, compatibility matrix
LocalDesignExample/      bundled local simulation environment (see below)
CHANGELOG.md / SECURITY.md / PUBLISH.md
```

## What the npm packages ship (besides the JS)

| Package | Ships beyond the entry JS | Deliberately NOT shipped |
|---|---|---|
| `dsh-harnessams` (`src/`) | `cordis.patch.yml` (bundle patch); `assets/plotly.min.js` (about 4.6 MB, offline report rendering) + `assets/THIRD_PARTY_NOTICES.md` (Plotly MIT attribution); `scripts/` (developer utilities shipped with the package — currently a placeholder README) | `LocalDesignExample/` (~21 MB vendored simulation environment), `docs/`, `tests/`, the repo-root README/AGENTS/CHANGELOG |
| `dsh-harnessams-suite` (`install_suite/`) | `cordis.patch.yml` only (pure patch package) | everything else |

The single shared `plotly.min.js` travels inside the `dsh-harnessams` tarball, so suite
installs get offline reports without a second copy anywhere. `PUBLISH.md` holds the
must-contain / must-not-contain checks that guard each tarball.

## LocalDesignExample (bundled local simulation environment)

A self-contained environment so a fresh clone can run sky130/ngspice simulations with zero
external downloads:

```
LocalDesignExample/
  ngspice-47-portable/   ngspice_con.exe + runtime DLLs (Windows x64; see its README)
  sky130/                fossi sky130_fd_pr minimal model closure (combined_models + cells) + LICENSE
  tools/                 verbatim copies of the SmartAnaSim pipeline scripts (keep in sync with the plugin version)
  harnessams.json        workspace config with paths relative to this file (works from any clone location)
  nodes.yaml             all-commented remote-node template
  check_environment.py   self-check: runs the bundled ngspice on a minimal sky130 netlist and audits the assets
  demo1/, demo2/         demo project placeholders (content lands with the demo milestones)
```

Offline report rendering uses `src/assets/plotly.min.js` (the single shared copy for the
whole project tree — never duplicated elsewhere; it ships inside the `dsh-harnessams`
tarball). The report generator finds it by walking up from its own location, via the
workspace `harnessams.json` `plotly_asset` field, or from a sibling `dsh-harnessams`
install under `node_modules/`.

Run `python check_environment.py` from `LocalDesignExample/` after cloning. Non-Windows
hosts: install ngspice yourself and point `ngspice_cmd` in `harnessams.json` at it (the
bundled binary is Windows x64 only). With the DSH plugins installed, the directory also
works as a regular workspace — the console and the pipeline discover `harnessams.json` by
walking upward from wherever they run.

## Installation (available after the v0.1.0 release)

### Path A (standard, recommended): per-plugin install

```powershell
dsh plugin --profile web add dsh-harnessams dsh-harnessams-smart-ana-sim
dsh --profile web    # restart the profile after installing: bundle membership is a startup boundary
```

### Path B (convenience): aggregate bundle, one command (first-party plugins only)

```powershell
dsh plugin --profile web add dsh-harnessams-suite
dsh --profile web --dump-config    # confirm the layers and rows appear as expected
```

### Dev-time mount (usable now)

Write a `cordis.yml` inside the plugin repo (`name` pointing to the absolute path of the entry source file; forward slashes on Windows), then:

```powershell
dsh --profile web --patch <path-to>\cordis.yml --port 3080 --no-open
```

Note: with the npm-installed CLI, `--profile web` already names the profile — do **not** append a positional `web` argument (the launcher rejects it with `too many arguments`); flags after the launcher options (such as `--port` / `--open`) reach the web app. Verified against `@deepseek-ai/dsh@0.2.1-rc.2` installed from npm (2026-10-25).

## Environment

- Node.js >= 22.19 (verified on v24.22.1);
- DSH: `npm i -g @deepseek-ai/dsh` then `dsh --profile web`; **verified version 0.2.1-rc.2** (developer preview — pin the version; before upgrading, check the upstream release notes and rerun the minimal regression);
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
| Bundled example copies | this repo: `LocalDesignExample/tools/*.py` — verbatim copies of the plugin scripts above; re-sync when the plugin updates | next run |
| Plugin JS entries (`src/index.js` in both plugin repos) | dev-mount: the repo's own `src/index.js` (your edit is the source); installed: `node_modules/<package>/src/index.js` | after restarting that DSH instance |

Why the difference: every tool invocation spawns a fresh `python <script>` process (system Python from `PATH`) that reads the file from disk again — no rebuild, no reinstall, no DSH restart (a sweep already in progress keeps the copy it loaded). The JS entry, in contrast, is loaded once via ESM at startup and cached by the module system, so it needs a restart of that instance; other instances are separate processes and keep running unaffected.

Tune check thresholds, adjust report wording, or add your own adjudication rules by editing the local files directly. Two caveats: keep durable customization in the **workspace** scripts — anything inside the installed package directory (the Python scripts *and* `index.js`) is overwritten when the plugin is upgraded; and the in-package path above follows DSH's profile layout as observed with `dsh plugin --profile web add` — confirm your install location with `dsh plugin --profile web list` if it differs.

## License

[MIT](LICENSE)
