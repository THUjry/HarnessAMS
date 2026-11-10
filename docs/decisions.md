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

## D-003 — remoteExecGate: tiered gate for model-initiated remote command execution

- Status: Accepted as a design (2026-10-31, recorded here 2026-11-10); **not implemented** — implementation work is tracked in the top-level repo `dev/todo/remoteExecGate.md`.
- Context: in the default DSH deployment the approval axis idles (the pre-execute waterfall defaults to allow; no `kind:"ask"` producers in the default bundle), so a workspace-write remote session lets the model run `rw_exec` with no human gate before execution — the model's blast radius equals the SSH account's filesystem permissions. Static analysis cannot bound a command's effects (Rice's theorem; trivial evasion via variable indirection, command substitution, cd+relative paths, pipes, in-tree binaries, symlinks), so lexical gating is only sound for fixed, argument-free commands. Upstream takes the same position (dsh-remote `lib/remote-sandbox.js`: "a command's effects cannot be bounded lexically… pretending to confine it would be worse than saying we do not").
- Decision: the plugin may register a `ctx.on('tools/pre-execute')` listener gated by a plugin config field `remoteExecGate` with three tiers. `off` (default) — no listener registered; `rw_exec` ungated (status quo; post-hoc audit remains). `whitelist` (recommended) — allow-listed commands pass silently; every other model-initiated `rw_exec` returns `{kind:'ask', reason, displayReason:{en,zh}}` → approval chain → Web UI prompt; whitelist discipline: fixed argument-free commands only, anchored to the whole command string (no prefix/substring match — blocks `known-cmd; payload` appends), zero write capability (`>`, `tee`, `sed -i`, pipes, `$()`, `;`, `&&` excluded), commands with dynamic paths stay out (they fall through to ask). `ask-all` — every model-initiated `rw_exec` prompts (untrusted deployments/demos; highest friction). A hard-lockdown tier needs no plugin: set the session read-only and the dsh-remote fence rejects `rw_exec` outright. Self-calls are exempt in every tier: the plugin's own check commands (callId prefix `harnessams-check-`, the four Overview buttons ride the same waterfall) and `rw_upload`/`rw_download` pass through untouched. Interaction with the approval policy: under the default `ask` policy the gate's asks surface as UI prompts; under `never` (including the `danger-full-access` preset) asks are deterministically rejected — i.e. "outside the whitelist = denied", a coherent unattended posture.
- Consequences: one ~20-line integration point with `dsh-experimental-auto-review` as the in-tree precedent; no user-visible change in the default `off` tier. Until implemented, remote command execution has no pre-execution human gate in any tier. End-to-end behavior is unverified (listener receives model-initiated calls; ask → UI prompt on both approve/deny paths; zero disturbance to the check buttons and the batch chain) — the spike checklist lives with the implementation todo.
