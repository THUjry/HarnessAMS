# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Added

- System-browser report viewing (2026-11-26): the session Dashboard's Open button launches the report file with the OS default application through the new `POST /api/open-local` route — as a local file, so the report's relative plotly/`SimResults` references resolve offline (the embedded iframe could not serve them past its per-report directory fence and leaned on the CDN fallback). The route is fenced (`src/server/openlocal.js`): viewable-extension whitelist, existing regular file, quoting-safe characters (no `"`/`%`/control chars), plus a same-origin guard on `sec-fetch-site`/`origin` — it is the first route that can trigger an OS process and never accepts executable/script paths. The embedded iframe viewer (iframe + reload + open-in-tab + the stat poll) is retired but fully kept behind the `DASH_SYSTEM_OPEN` flag in `src/client.js` — flip to false to restore it verbatim. Tests 154 → 157 (open-local route/fence/guard suite).

### Fixed

- Session-config write-channel unification (2026-11-26): the first-level tab pills wrote through `mutateConfig`, which PUT the closure snapshot unrebased — clicking a session pill right after `gen_sweep_report` registered a report wiped the injected report (the in-memory snapshot only refreshes while the Dashboard sub-view is open). `mutateConfig` keeps the optimistic local flip but now rides the rebased persist channel (`persistConfig`: GET the latest server entry, re-apply the mutator, PUT, adopt the confirmed entry); the mutator contract stays idempotent (applied once to the optimistic snapshot, once to the fresh base). The first-seen tombstone PUT also re-checks the server first — an entry the second writer created between the hydrate GET and the PUT is adopted instead of tombstoned over.

## [0.1.0] - 2026-11-10

Initial release (stage 1 scope).

### Added

- Top-level console plugin `dsh-harnessams` (`src/`): three-tier client UI inside the DSH Web client — global console page (machines over the dsh-ssh host registry, digital assets, disk usage, display settings, first-run onboarding guide), project tier (project = DSH workspace, task store at `<workspace>/.harnessams/tasks.json`), and a task sidebar tab (project overview / Dashboard / Check params / Sim settings). Remote connectivity is fully delegated to @linxin666/dsh-ssh (alias-based, zero gating; per-alias remote roots live in the workspace `harnessams.json` `remote_machines` section). Bilingual zh/en UI throughout.
- Overview health checks: local items directly, remote items through dsh-ssh's `ssh_exec` straight at the configured alias (no borrowed session); columned result tables; failed checks hand off to a diagnosis session (one click, and automatically for remote failures).
- Per-project settings (`project_settings.json`: run mode / machine / remote dir / scheduler / simulator / compute scripts) and a one-click project self-check that walks the whole pipeline under the current settings with no LLM in the flow — RC testbench through the simulator, or the bundled analytic golden replay without one — with pointwise 1% verification and artifact-driven verdicts.
- Six model tools: `batch_submit`/`batch_poll`/`batch_fetch` (generic remote batch channel — LSF queue or ssh foreground on the target host), `gen-sweep-report` (spec-driven Plotly report with per-chart PNG export and session registration), `sim_progress` (local progress-file window), `safe_trash` (workspace trash with fenced restore/purge; deletion never destroys). The analysis pipeline and trash are pure JS; Python is confined to the three scenario families of decision D-003 (`docs/decisions.md`).
- Simulation progress tool cards for the eight simulation tools (`tool.call.toolview`), with a display toggle and read-only progress endpoints.
- Dashboard report viewer: task-registered local HTML reports served read-only with each report's own directory as the boundary, iframe key/nonce reload, auto-refresh while visible; reports render offline from a single workspace-level Plotly copy seeded from the vendored `src/assets/plotly.min.js` (decision D-013).
- Remote batch idempotency guards (compensating the dsh-ssh broken-connection exec replay): LSF submits carry a `.hams_submitted` marker with flock (read-back on replay, write-on-success only); ssh runs carry a `.hams_ssh_done` marker with flock; every remote command is wrapped in a remote `timeout -s KILL` so the deadline always lands.
- Aggregate bundle `dsh-harnessams-suite` (`install_suite/`): one-command install of the first-party plugins (pure patch package that restates every member row).
- Self-check compute assets: `src/scripts/selfcheck/` (`selfcheck_verify.py` + `.mjs`, one JSON contract) and `src/selfcheck/` (the RC generator plus a 36-file analytic 3×3 psfascii golden dataset).
- Workspace config contract: `harnessams.json` is discovered by walking upward (bare form, or inside `harnessams-workspace/`); relative path fields resolve against the config file's directory.
