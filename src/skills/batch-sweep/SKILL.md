---
name: batch-sweep
description: >
  Generic parameter-sweep methodology: batch_submit with its three schedulers
  (local background workers on this host, direct foreground on the SSH target
  host, LSF queue), batch_poll monitoring with wait_sec and the terminal
  auto-fetch, Sim run-directory naming, remote-first analysis, and the
  gen_sweep_report spec flow. Spectre netlist and config rules live in the
  smart-spectre skill. Trigger on batch simulation, sweep submission,
  monitoring or the sweep report.
---

# batch-sweep — the managed scan flow (HarnessAMS suite)

The scan flow is the plugin tool surface itself — no bundled scripts. Faces:
`batch_submit` (submit), `batch_poll` (monitor + retrieve; the only tool with
a session progress card) and `gen_sweep_report` (report). The worker scripts
ship with the SmartAnaSim package under the project's
`workspace.sim_scripts_dir` (e.g. `spectre/spectre_sweep_worker.py`); the
template*.scs / sweep_config.json rules and the parser CLIs are NOT repeated
here — load the `smart-spectre` skill for them.

## Execution modes

All three schedulers submit the SAME run directory + worker; they differ in
where the worker runs:

| Mode | Selection | Worker host |
|---|---|---|
| local | `batch_submit(scheduler="local")` | this host, background — submit returns immediately, poll with `batch_poll` |
| direct | `batch_submit(scheduler="direct")` | the SSH target host, foreground (bounded by a 600 s tool timeout) — small batches only |
| lsf | `batch_submit(scheduler="lsf")` — default | the SSH target host's cluster via the LSF queue |

`machine_id` (a dsh-ssh alias) and the fencing `remote_root` are required
for the remote modes only.

## Run directory naming: `Sim<N>_<YYYYMMDD>_batch<M>`

Local and remote run directories follow
`<base>/Sim<N>_<YYYYMMDD>_batch<M>/`. `batch_submit` generates the next free
name under `remote_root` automatically when `remote_dir` is omitted — same
`Sim` index continues with `batch<M>+1` on the same day, a new day starts a
new `Sim<N>+1`. Pass `remote_dir` explicitly only to reuse a specific
location. Raw simulation data lives under `RawResults/` (remote
`<remote_root>/RawResults/Sim*` is the batch_submit default; local runs
live under `<project>/RawResults/`), processed compact results in
`<project>/SimResults/`, report figures in `<project>/Figs/`, and the HTML
report at the project root.

## Workflow

1. **Prepare** — create the run directory with `template*.scs` (with
   `@@PARAM@@` placeholders) + `sweep_config.json` (`parameters` dict of
   lists, `sweep_mode` cross_product|zip, ≤100 points per batch). For
   assembly-layer projects the suite's assembly tool generates all three
   from `design_params.json` — prefer it when the project has a gen script
   (see smart-spectre).
2. **Submit** — `batch_submit {run_dir, worker:
   "spectre/spectre_sweep_worker.py", worker_args: ["--config",
   "sweep_config.json", "--max-parallel", "8"], scheduler: "local"|"direct"|"lsf"}`.
   Remote submits upload the run directory plus the whole worker scripts
   tree and write `.batch_job.json` in the local run directory (local
   submits write the same file after spawning the worker on this host).
   `sim_scripts_dir` set to an existing directory replaces the worker
   scripts root (custom or test worker tree).
   `overwrite: true` replaces a batch that already ran in the target
   directory (stale replay markers are cleared first — without it a
   finished dir short-circuits to its old result).
3. **Monitor** — `batch_poll {run_dir, wait_sec}`: bjobs state plus the
   batch's own progress; `wait_sec` (≤600) holds the call and re-polls
   ~every 10 s until the batch settles — the in-flight call is the window
   where the session progress card live-updates. For `scheduler="local"`
   the frame comes from the run directory itself and knows whether the
   worker is still alive: one that died reads `failed` with its stderr tail
   in `errlog_tail` — fix the cause and resubmit, do not keep polling.
   **Timing trap:** judge
   completion by the per-point meta count (the poll's `completed` counts
   exactly those), not by the progress file alone — it may lag or be
   mid-write right after the run ends. The result carries a per-point
   digest (`points[]`: index / status / params) and, on a terminal state,
   auto-fetches `sweep_progress.json` + `errlog.txt` straight into the run
   directory. Raw psf/sp data stays remote by design.
4. **Analyze — REMOTE by default** — run the parsing/metrics ON the host
   that holds the data and pull back only compact results (the put/exec/get
   triple): `ssh_upload` the analyzers (the SmartAnaSim scripts
   `spectre/spectre_psf_parse.py` + `snp/snp_common.py` under the project's
   `sim_scripts_dir`, both pure stdlib — upload them side by side; or your
   own self-contained script), `ssh_exec` it over the remote batch dir (use
   the cluster's full python path), then `ssh_download` the compact JSON
   (per-point params/metrics + only the curve arrays you actually plot,
   complex values already converted to dB where wanted) into
   `<project>/SimResults/`. For local runs (or a debug copy) the same
   parser runs directly with python — the smart-spectre skill documents the
   CLI. For S-parameter matrix CSV dumps and passive-device extraction call
   `snp_guide` first, then `snp_read` / `snp_extract`.
5. **Report** — `gen_sweep_report {spec: <path>}` is a pure renderer: YOU
   process the data (metrics from step 4, dB conversion, multi-batch
   aggregation) and write a small spec JSON into `<project>/SimResults/`
   (`{project_dir?, title?, conclusions?, out?, rounds: [{id, title?,
   points, curves?, note?}]}`; `points`/`curves` inline or `{"$file": …}`
   refs — write big curve arrays to files). Each point is
   `{index?, label?, params, metrics, status?}`; `curves` is
   `{x_signal, signals: [{name, dB?}], points: [{index, label?, x, y}]}`.
   The tool renders the interactive report at
   `<project>/<name>_report.html`, exports one PNG per chart into `Figs/`,
   and registers the report into the calling session's dashboard.

Local runs replace steps 2–3 with `scheduler="local"` + one
`batch_poll {run_dir, wait_sec: 600}`; steps 4–6 are identical (analyze
locally — the run directory already holds everything — then the same spec
flow).

## LSF / cluster gotchas

- The remote write fence is the project's `settings.remote_root`
  (workspace_config.json) — `remote_dir` must stay under it.
- `bjobs` "No unfinished job found" means the job left the queue; completion
  is confirmed by the point count reaching the configured total.
- One template file per run directory (multiple `template*` files are
  rejected at submit).
- Submission is idempotent against connection replays (LSF marker + flock);
  `overwrite: true` deliberately waives the short-circuit for a rerun.
