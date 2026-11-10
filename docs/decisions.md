# Design Decisions

Persistent, append-only record of design decisions for the `dsh-harnessams` plugin and the HarnessAMS suite. One numbered entry per decision (`D-001`, `D-002`, ...); entries are never rewritten — a decision that changes is superseded by a new entry naming its predecessor. New entries go at the bottom.

Entry template:

```markdown
## D-NNN — <title>

- Status: Accepted | Proposed | Superseded by D-MMM (date)
- Context: why the question existed
- Decision: what we do
- Consequences: what this implies, including the costs
- Alternatives considered: what else was on the table and why it lost
```

## D-001 — Plotly delivery for generated sweep reports

- Status: Accepted (2026-10-27)
- Context: sweep reports (`<project>/Analysis/<project>_report.html`) are interactive Plotly pages opened offline by double-click and also linked from the plugin web UI (`/harnessams/reports/`). Plotly.js is a 4.6 MB asset; the `dsh-harnessams` package ships the master copy (`src/assets/plotly.min.js`, also served in-app at `/harnessams/assets/plotly.min.js`). Report generators need a single, stable, relative way to load it — without per-report duplication, without requiring network access at view time, and without depending on a specific install layout.
- Decision: one copy per workspace at `<workspace_root>/assets/plotly.min.js` (workspace root = the directory holding `harnessams.json`). The report generator seeds it on demand from the best local source — an explicit `--plotly` path, an ancestor-probed copy (package-local `assets/`, `src/assets/`, an installed `node_modules/dsh-harnessams` sibling, or a `dsh-harnessams/` directory under a `node_modules` ancestor), or the workspace `plotly_asset` config field — refreshing it when the file size differs (plotly version bump). Every report references it with a workspace-relative `src` (`../../assets/plotly.min.js`), which is always same-drive and survives folder moves within the machine. A one-line `window.Plotly` check falls back to the in-app `/harnessams/assets/plotly.min.js` route when the page is viewed through the plugin's reports route. The CDN (`https://cdn.plot.ly/plotly-3.0.1.min.js`) remains the last-resort fallback when no local source exists (`--plotly-cdn` forces it).
- Consequences: reports are offline-capable by default; exactly one 4.6 MB copy per workspace instead of one per report; the workspace `assets/` directory is a runtime artifact and is not committed (gitignored where a workspace lives inside a repo). Reports only render charts when the workspace tree travels with them.
- Alternatives considered:
  - CDN-only reference: needs network at view time; fails offline and behind
    firewalls.
  - Per-report copy beside each HTML (the previous behavior): self-contained, but
    duplicates 4.6 MB into every `Analysis/` directory.
  - Machine-level shared copy under `$USERHOME/.dsh/profiles/web/node_modules/`:
    relative references cannot cross Windows drive boundaries, and the npm profile
    tree belongs to package lifecycle operations.
  - Direct reference into the installed `dsh-harnessams` package: same cross-drive
    problem, and the reference dies when the package is uninstalled or cleaned.

## D-002 — Plotly source selection at plugin initialization

- Status: Proposed (2026-10-27, deferred)
- Context: D-001 fixed the default delivery (local-first, CDN fallback). A future plugin-initialization step should let the user choose the Plotly source explicitly (CDN vs local copy) instead of the current silent local-first ordering.
- Decision: defer. When implemented, plugin initialization offers the CDN-vs-local choice and persists it (likely as a `harnessams.json` field superseding `plotly_asset`).
- Consequences: none yet; D-001 behavior stands until this lands.
