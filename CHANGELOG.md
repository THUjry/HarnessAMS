# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.1.0] - 2026-11-10

Initial release (stage 1 scope).

### Added

- Top-level console plugin `dsh-harnessams` (`src/`): three-tier client UI inside the DSH Web client — global console page (remote projects, digital assets, disk usage, display settings, first-run onboarding guide), project tier (project = DSH workspace, task store at `<workspace>/.harnessams/tasks.json`), and a task sidebar tab (Overview / Dashboard / Sim settings) for local projects. Remote projects live inside dsh-remote mirrors (one-click creation from a machine's existing mirror; connectivity is fully delegated to dsh-remote). Bilingual zh/en UI throughout.
- Overview health checks: local items directly, remote items through dsh-remote's `rw_exec` tool shell borrowing a live session of the machine's remote project; columned result tables; failed checks hand off to a diagnosis session (one click, and automatically for remote failures).
- Per-project settings (`project_settings.json`: run mode / machine / remote dir / scheduler / simulator / compute scripts) and a one-click project self-check that walks the whole pipeline under the current settings with no LLM in the flow — RC testbench through the simulator, or the bundled analytic golden replay without one — with pointwise 1% verification and artifact-driven verdicts.
- Six model tools: `batch_submit`/`batch_poll`/`batch_fetch` (generic remote batch channel — LSF queue or direct foreground on the target host), `sim_analysis` (collect + optional Plotly report dashboard with task-store injection), `sim_progress` (local progress-file window), `safe_trash` (workspace trash with fenced restore/purge; deletion never destroys). The analysis pipeline and trash are pure JS; Python is confined to the three scenario families of decision D-004 (`docs/decisions.md`).
- Simulation progress tool cards for the eight simulation tools (`tool.call.toolview`), with a display toggle and read-only progress endpoints.
- Dashboard report viewer: task-registered local HTML reports served read-only with each report's own directory as the boundary, iframe key/nonce reload, auto-refresh while visible; reports render offline from a single workspace-level Plotly copy seeded from the vendored `src/assets/plotly.min.js` (decision D-001).
- Remote terminal: pooled xterm sub-tab over dsh-remote's own `/dsh-remote/term/*` polling PTY routes (vendored @xterm/xterm 5.5.0 bundle served from `/harnessams/assets/`).
- Aggregate bundle `dsh-harnessams-suite` (`install_suite/`): one-command install of the first-party plugins (pure patch package that restates every member row).
- Self-check compute assets: `src/scripts/selfcheck/` (`selfcheck_verify.py` + `.mjs`, one JSON contract) and `src/selfcheck/` (the RC generator plus a 36-file analytic 3×3 psfascii golden dataset).
- Workspace config contract: `harnessams.json` is discovered by walking upward (bare form, or inside `harnessams-workspace/`); relative path fields resolve against the config file's directory.
