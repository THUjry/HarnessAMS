# Design Decisions

Design decisions for the `dsh-harnessams` plugin and the HarnessAMS suite, ordered by importance — the top entry is the suite's division of labor. Each entry states what holds: every entry is accepted, and a replaced decision folds into its successor. IDs are stable and cited by external documents. Day-by-day history lives in the root repo's chronicle.

## D-001 — Suite division of labor: SmartAnaSim is a pure standalone tool set, HarnessAMS owns the managed scan flow

- **SmartAnaSim = pure tool set.** Usable on its own, with no other plugin required and zero references to any other plugin's tools in tool descriptions, file headers or skill text. Spectre is template generation + configuration checks (`spectre_assemble`, the assembly layer); the `snp_*` family covers S-parameters end to end (`snp_read` is the single entry for `.sNp`/`sp.sp` data files and writes the lossless `%.17g` params CSV that `snp_extract` consumes). Sweep execution and result parsing are script-face — directly runnable python — because **data processing is not tool-shaped**; the parser has no standalone .sp path. Exactly one bundled skill: `smart-spectre`, the spectre configuration reference (a root page plus named companion pages).
- **HarnessAMS = the standardized, process-oriented scan methodology.** `batch_submit` runs sweeps under three schedulers: `local` (detached background worker on this host; submit returns immediately), `ssh` (run on a node reached over ssh, foreground) and `lsf` (bsub; see D-002 for the per-environment channels). `batch_poll` is the single monitor face and the only progress card: it waits toward a terminal state, then pulls the fixed light result set (`sweep_progress.json` + `errlog.txt`) — raw psf/sp data stays on the executing host by design and deep analysis runs there — and every frame carries a bounded per-point digest. `gen_sweep_report` renders the analysis report from a model-written spec. `overwrite: true` clears the stale replay markers (`.hams_submitted`/`.hams_ssh_done`) under the flock and tags the fresh ones, so a finished batch re-runs while a replay of the same call still short-circuits. Tool faces: 4 (SmartAnaSim) + 5 (HarnessAMS).
- **Skills split along the same line.** Each package carries the skill for its own surface — `batch-sweep` (generic scan methodology) in HarnessAMS, `smart-spectre` (spectre configuration) in SmartAnaSim; the dca skills keep their spectre-language content and sky130 examples in place and point at these two for the mechanics.
- **Scope note.** The requirement repo places "run simulation" wholly under SmartAnaSim and lists the HTML report in its function list; this division knowingly diverges and is reconciled at the v0.1.0 release-notes pass.

## D-002 — Two working environments (in-cluster / out-of-cluster); one shared cluster filesystem

- `settings.cluster_env` selects the working environment: `in-cluster` (the DSH host itself is a cluster node) or `out-of-cluster` (the default: the host sits outside the cluster).
- Both environments assume ONE filesystem shared by all cluster nodes; they differ only in whether the DSH host sits on it. In-cluster, staging writes the shared paths directly and no file ever crosses ssh; out-of-cluster, files cross only the host-to-cluster boundary through dsh-ssh upload/download, never node-to-node.
- Scheduler semantics follow the environment: `local` runs on the host itself (in-cluster only; `batch_submit` rejects it out-of-cluster); `ssh` runs the sweep on a node reached over ssh — out-of-cluster that is the ssh node itself (a second hop is the dsh-ssh proxy config's business), in-cluster any other node; `lsf` submits through bsub — locally from the host when in-cluster, through the ssh node when out-of-cluster.
- The project AGENTS.md block states which environment holds (the yaml `cluster_env` row; the workflow table follows it). Batch submission resolves the configured machine when `machine_id` is omitted — a per-call `machine_id` (or LSF `bsub -m`) is only for spreading across nodes. dsh-ssh aliases never appear in the block: the remote side is stated as paths only (`remote_root`, `remote_dir`, `remote_scripts_dir`), and the dsh-ssh host list remains the node inventory behind the settings table.

## D-003 — JS single implementation inside the plugins; Python only in three scenario families

- JS is the single implementation for everything inside the plugins: tool definitions, server routes, analysis/report/trash logic, progress reading (the run-directory ladder in `src/progress_files.js`, shared by the endpoints and the batch tools) and self-check orchestration.
- Python is confined to three families: (1) sweep workers that must run where Node cannot be assumed (cluster nodes) — e.g. `spectre_sweep_worker.py`; (2) S-parameter numeric computing in the numpy/complex-matrix domain — e.g. `snp_extract.py`; (3) per-project user-authored assembly scripts, whose existence as plain project-side scripts is itself the architecture — e.g. `gen_selfcheck_rc.py`. A new Python family needs its own decision entry.
- Grandfathered exception: the self-check verify twins (`selfcheck_verify.py`/`.mjs`). A port re-baselines its regressions, tolerance-style where floating point differs.

## D-004 — One config file per project; `harnessams_selfcheck` is the single config write face; self-check artifact cleanup

- Config lives in `<project>/.harnessams/workspace_config.json`: `{ version, workspace: { sim_scripts_dir, plotly_asset, trash_dir }, settings: { cluster_env, run_mode, machine_id, remote_root, remote_dir, scheduler, simulator, compute_script_local, compute_script_remote } }`. The workspace section is laid down once with resolved defaults (fresh projects stage a project-local scripts copy at `<project>/.harnessams/scripts` and point `sim_scripts_dir` there — D-015; existing explicit values are never migrated); env `HARNESSAMS_SIM_SCRIPTS_DIR` overrides. No state migration: legacy state is archived `*_old`, never read; unknown enum values fall back to the defaults.
- `settings.remote_root` fences every remote `remote_dir`.
- `harnessams_selfcheck` — actions run/status/stop/env/save_agentsmd plus an optional `settings` object written before the action — is the single config write face; the UI buttons ride it through `POST /api/tool`.
- Self-check runs live under `<project>/.harnessams/selfcheck/<runId>` with project-fenced reads. A clean run's artifacts are deleted at finalize; failed runs keep evidence; the next run cleans history; finalize re-syncs AGENTS.md unconditionally. Check params stay out of the config file (D-005).

## D-005 — Every session is a work unit; fork copies are branch-point-independent

- The task concept is retired: there is no task creation/deletion surface. The sidebar strip is exactly project overview + this session (Dashboard + Checks sub-views).
- Per-session store `<workspace>/.harnessams/sessions.json` v2 — `{ display, reports[], dashboard_selected, check_params? }` per session — written by single-session merge writes with 200-entry pruning. New sessions start empty.
- Session identity: `exec.agent.id` is the SessionId, and `DSH_SESSION_ID` is a shell-env built-in; tools thread it through runPython's env-merge so per-session check params resolve in every worker. Check-param chain: built-ins ← project `check_params.json` ← session table.
- Fork detection: rc forks carry no parentSession; the only durable signal is the inherited end-seed marker in the child's zstd session log (`server/forkdetect.js`). A fork copy takes the currently-last-active session's current snapshot — deliberately independent of the branch point — and is served only while the asking session has no entry. Subagents are their own sessions.

## D-006 — `gen_sweep_report` is a pure report renderer; RawResults/SimResults/Figs layout; remote-first analysis

- Raw-data processing belongs to the model; the tool only draws. Input = a model-written spec JSON `{project_dir?, title?, conclusions?, out?, rounds:[{id, title?, points, curves?, note?}]}` with points/curves inline or `{"$file"}` references (`project_dir` derives when the spec sits in `<project>/SimResults/`; table columns = the union across points).
- Output: the report at the project root, the data JS in `SimResults/`; chart PNGs in `Figs/` only when the workspace setting `report_figs` is on (Overview toggle, default off — disk; headless jsdom + bundled plotly + `Plotly.toImage(svg)` + resvg rasterization; deps ship prebuilt, export is fail-open). The report registers into the calling session's dashboard.
- Charts are curve charts only: one trace per parameter combination (one design point per curve); scalar metrics render in the table and summary cards, never as charts. Cross-highlight keys on trace-order indices (`sp.indices`), never on label matching; a DOM hit-test fallback covers hosts where `plotly_click` never fires. The in-report batch dropdown lists rounds newest-first (natural id order); the sidebar dashboard orders its report list newest-first by `added_at` and embeds reports 1:1 (no in-document padding/zoom injection).
- Layout, same names on both sides: batch runs are auto-named `<remote_root>/RawResults/Sim*`, raw local data lands in `<project>/RawResults/`, compact results go to `<project>/SimResults/` via `ssh_download`.
- Remote-first analysis = the put/exec/get triple over dsh-ssh (upload the parser scripts or a self-written analyzer, exec with the cluster's python, download the compact JSON); the batch-sweep skill documents it as the default.

## D-007 — Bundled skills; the `template*.scs` family; the Sim run-dir convention; the dca method

- Skills ride the official host registry: `ctx.skills.register` per packaged `skills/<name>/SKILL.md` — name/description catalog lines only, bodies load on demand through the host `skill` tool; `resourceBase` = the skill directory; registration is fail-open; `inject` carries `skills`.
- `template*.scs` family: the file uploads under its own name and `sweep_config.netlist_template` must match it exactly (a mismatch, an undeclared or a declared-but-missing template fails at submit).
- Sim naming: `Sim<N>_<YYYYMMDD>_batch<M>` — same index with batch+1 on the same day, otherwise index+1 batch 1. `batch_submit.remote_dir` is optional: the next free name under `<remote_root>/RawResults` is picked automatically. The progress layer recognizes `<project>/Sim*/` and `sweep/Sim*/` beside legacy `sweep/RoundN/top`.
- dca method: the shunt-arm total comes from ideal formulas; switch Ron is a direct input (1/3..1/5 of the arm total); ZTC is retired; ideal R/C with real sky130 switches; simulation is authoritative over analytic predictions.

## D-008 — Live progress cards: instant first frame + the remote poll endpoint

- A carded call shows content the moment it is invoked (zero-ssh first frame); a batch finishing between polls still shows both frames.
- `readRunProgress` ladder: progress → `.worker_started` → job (`.batch_job.json`) → config. A submitted-but-unmirrored run dir answers an instant 0/N frame.
- `GET /api/progress-remote`: same session fence; machine/dir/job resolved server-side from the job file; the batch poll command runs through execRemote (10 s); failures answer `200 {unreachable}` so the card keeps its last frame; a 4 s TTL single-flight per runDir bounds ssh pressure.
- `batch_poll` carries `wait_sec` (default 0 = snapshot; re-poll ~10 s until terminal or ≤600 s, last payload wins) — the blocking call is the live-card window. The client card fetches the remote source at the 5 s wait-policy cadence plus the local ladder on every tick.
- Custom workers must accept `--work-dir` and write progress atomically WITH a trailing newline.

## D-009 — Browse-only remote root; self-check stop; the system-prompt waiting policy

- `remote_root` is set only through the dsh-ssh browse picker — no free-typed row. No saved root → bootstrap at the machine's `$HOME`; a plain-listing fallback keeps symlinked directories visible.
- The settings table marks each out-of-sync row (draft vs settings) and follows external writes with a 1 s poll, so fresh sessions never paint red.
- `harnessams_selfcheck` action `stop` flips the cancel flag, aborts in-flight tool calls, bkills LSF jobs best-effort and finalizes `cancelled` with evidence kept — it never enters `last_selfcheck_*`.
- Self-check submit-step details are failure-first (stale job records demote to annotations); poll steps stream live counts into their step row.
- Execution-safety guidance lives in the system prompt: `ctx.systemPrompt.section('harnessams:remote-wait-policy', order 5500)` — safety core only (ask-first on a broken chain, no improvised fallbacks, dsh-ssh tools only, never raw shell ssh); operational cadence (poll intervals, backoff steps, card refresh) lives in the project AGENTS.md workflow table and the batch-sweep skill. Static English, KV-stable. `inject` must declare `systemPrompt` (cordis throws on undeclared ctx access; optional chaining cannot save it).

## D-010 — The AGENTS.md config block: core constraints + yaml + the recommended-workflow table

- The block is tables and bullets only, NO prose paragraphs: (1) core-constraints bullets — ask the user when design constraints are unclear (never guess), execute through the SAS/HA plugin tools and consult the user on failure (no hand-rolled workarounds), `.harnessams/` is plugin storage a model does not read in normal work; (2) the yaml table mirroring workspace_config.json plus measured env facts and the latest self-check verdict — machine aliases are absent, remote facts are paths only (`remote_root`, `remote_dir`, `remote_scripts_dir`); (3) the recommended-workflow table (`server/selfcheckWorkflow.js` `workflowTable`) — one row per step (Assemble/Submit/Monitor/Analyze/Report), each naming the tool and ONLY the parameters the model fills; values the yaml already states are deliberately absent.
- The scheduler and analyze cells fork on `cluster_env`; the monitor cell carries the polling cadence (10 s -> 20 s -> 40 s backoff, 5 s card refresh, no blind sleeps).
- The block is English + ASCII; unknown settings normalize to defaults. Rendered on VALUES builds only (the first-fill template carries constraints + an empty yaml, no table); both save paths (save_agentsmd and the finalize auto-sync) share one change point.
- When the workflow or tool parameter surface changes, `workflowTable` changes in the same commit: those strings are what agents read in the project AGENTS.md, and a silent drift misleads them.

## D-011 — dca-design split into dca-cell-design + dca-cascade-analysis; the AsymATT generator absorbed; scrub rules for the skills tree

- `dca-cell-design/` holds unit-cell design (calculators, sky130 example set) — its SKILL.md method text carries no concrete frequency limits or device values; `dca-cascade-analysis` holds cascade analysis plus the absorbed generator: asymmetry removed, ideal RC + switch l/w/nf vocabulary, `--run-dir` mode where NN is the binary control word and the width is the max index's `bit_length`.
- The sky130 example set splits in two: `sky130proc/` (the runnable process kit — templates with the bare `sp` analysis name, the transcribed switch model per PUBLISH's no-PDK-models carve-out, lvt switch FOM data, plain-nfet Ron/Coff characterization csv) and the verified example layer (`Example.md` + `ST1/T4/Pi8/` per-design `design.json` + two-state raw `sp_ref.sp`/`sp_att.sp`, renamed only); the 4-bit cascade example comes from real sky130 simulations (16 control words) and is carried as cell netlists + results + report only.
- Skills-tree scrub rules: no asymmetric vocabulary, no dates (two TMTT citations excepted), no machine paths, accounts or IPs (pre-commit hook enforced).
- The cascade report keeps its own `Analysis/` + CDN-plotly convention, separate from `gen_sweep_report`'s layout.

## D-012 — remoteExecGate: a tiered gate for model-initiated remote command execution

- A `ctx.on('tools/pre-execute')` listener gated by the plugin config `remoteExecGate`, in three tiers: `off` (default), `whitelist` (recommended: fixed argument-free allow-listed commands anchored to the whole command string, zero write capability; everything else asks; under a `never` approval policy "outside the whitelist = denied"), `ask-all`. Self-calls are exempt in every tier (the plugin's own check/self-check funnel and the transfer tools).
- Why tiers and not static analysis: in the default DSH deployment the approval axis idles (pre-execute defaults to allow), and a command's effects cannot be bounded statically — lexical gating is sound only for fixed, argument-free commands. A hard lockdown needs no plugin: set the session read-only.
- Implementation: not built yet — tracked in the root repo `dev/todo/remoteExecGate.md`.

## D-013 — Plotly delivery for generated reports

- One copy per workspace at `<workspace_root>/assets/plotly.min.js`, seeded on demand from an explicit `--plotly` path, an ancestor-probed package copy, or the workspace `plotly_asset` field (refreshed on size change). The copy is a runtime artifact, never committed.
- Reports reference it workspace-relatively, with the in-app `/harnessams/assets/plotly.min.js` fallback when viewed through the dashboard route and the CDN as the last resort (`--plotly-cdn` forces it). Reports are offline-capable by default and render charts only when the workspace tree travels with them.
- Scope: delivery only. Source selection is not decided here; the default source is the workspace `plotly_asset` field (D-004).

## D-014 — UI layout & session-surface rules

- Width: every plugin surface fits the window width. The tab's `.hams-body` is the only scroll container (the console page scrolls itself: `.hams-page { height:100%; overflow-y:auto }`); `table-layout: fixed` plus capped select widths; `overflow-wrap: anywhere` on roots, cells and pre.
- Long text: read-only text over 8 rendered lines auto-collapses (ClampText with a measured toggle); tables wrap instead.
- Sidebar default-open: opens on first sight of a session in an initialized project (untouched-host-layout gate + workspace mapping retry); blank sessions open via the localStorage layout-key poll about 1 s after creation; an explicit user close wins until another session is entered. The open-state probe requires viewport intersection AND non-hidden visibility.
- Theming: native selects theme via `color-scheme` + canvas colors; state colors use `light-dark()` pairs.

## D-015 — One-time project script staging: what the self-check exercises stays usable afterwards

- Every project keeps its own reusable copy of the simulation scripts: `<project>/script/analysis/gen_selfcheck_rc.py` (the assembly example — without it `spectre_assemble` is contractually unusable) and `<project>/.harnessams/scripts/` + the sibling `<project>/.harnessams/assets/` (the worker tree and the numfallback bucket; snp_common resolves `assets/` as a sibling of the scripts root, so the local layout and the remote upload layout — `<remote_root>/.harnessams/{scripts,assets}` — share one shape).
- Staging is copy-if-missing per file (user-edited copies are never clobbered, partial trees complete, up-to-date projects no-op) and runs at two moments: `.harnessams` creation (writeSettings fresh) and every self-check start. Source: `HARNESSAMS_SIM_SCRIPTS_DIR` -> the configured `sim_scripts_dir` (pre-flip) -> the dev-sibling default (`server/scriptStage.js`).
- The self-check's `spectre_assemble` step runs against the REAL project root (the staged gen script), never a throwaway run-dir copy — a passing check must not outlive its scripts.
- `batch_submit` uploads the scripts tree plus the sibling assets bucket (`pluginAssets`) on every sync; `machine_id`/`remote_root` omitted from a call resolve from the project settings.
