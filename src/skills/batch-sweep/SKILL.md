---
name: batch-sweep
description: >
  Generic parameter-sweep methodology: batch_submit with its three schedulers
  (local workers, ssh, LSF; semantics set by the project's cluster_env
  working environment), batch_poll monitoring with wait_sec and terminal
  auto-fetch, multi-node submission (machine_id, bsub -m lsf_node),
  run-directory naming, remote-first analysis, and the gen_sweep_report
  spec flow. Spectre netlist/config rules live in the smart-spectre
  skill. Trigger on batch simulation, sweep submission, monitoring or
  reports.
---

# batch-sweep — the managed scan flow (HarnessAMS suite)

The scan flow is the plugin tool surface itself — no bundled scripts. Faces: `batch_submit` (submit), `batch_poll` (monitor + retrieve; the only tool with a session progress card) and `gen_sweep_report` (report). The worker scripts live in the project's staged copy under `.harnessams/scripts/` (laid down at project initialization — the sidebar-open moment — with the self-check start as backstop, source: the SmartAnaSim package — e.g. `spectre/spectre_sweep_worker.py`); the template*.scs / sweep_config.json rules and the parser CLIs are NOT repeated here — load the `smart-spectre` skill for them.

## Working environment first (cluster_env)

Read the project AGENTS.md config block before choosing a scheduler: its yaml carries the `cluster_env` / `scheduler` / `remote_root` / `remote_python` / `remote_spectre_cmd` rows and its workflow table names the recommended flow. Both environments share ONE cluster filesystem; they differ in whether the DSH host sits on it. `.harnessams/` is plugin storage — do not read it; the config block is the whole model-facing surface. A green self-check pins the toolchain rows it measured automatically (and remembers them per node plugin-globally, so fresh projects on a known machine start pinned); a null row is the not-yet-measured state — the bare default the self-check verified applies until then.

- **in-cluster** (the DSH host is a cluster node): `local` runs on this host; `ssh` runs on another node (staging is a local copy, only the execution crosses ssh); `lsf` submits bsub LOCALLY (no machine needed, transfers are local copies).
- **out-of-cluster** (the default): everything remote crosses dsh-ssh — `local` is unavailable; `ssh` runs on the ssh node itself (a second hop goes through the dsh-ssh proxy config); `lsf` submits through the ssh node.

## Execution modes

All three schedulers submit the SAME run directory + worker; they differ in where the worker runs (per the environment above):

| Mode | Selection | in-cluster | out-of-cluster |
|---|---|---|---|
| local | `batch_submit(scheduler="local")` | this host, background — poll with `batch_poll` | unavailable (rejected) |
| ssh | `batch_submit(scheduler="ssh")` | another node over ssh, foreground (600 s cap) — small batches only | the ssh node, foreground (600 s cap) — small batches only |
| lsf | `batch_submit(scheduler="lsf")` — default | bsub on this host, bjobs polled locally | the cluster's queue through the ssh node |

`remote_root`, `machine_id` and the toolchain pins resolve from the project config when omitted — the normal case. The pins are the project's absolute paths on the cluster side: `remote_python` (the interpreter that runs the worker) and `remote_spectre_cmd` (the spectre executable the bundled worker drives); a green self-check measures and pins them automatically, and the `cluster-setup` skill is the verification/override face when the automation cannot decide. Pass `machine_id` (a configured dsh-ssh host, any of them works as the target) only to spread a sweep across nodes; pass `remote_root` only as a one-off override.

**Multi-node**: `machine_id` is per call, and `lsf_node` pins an LSF job to a host or host list — `bsub -m "<lsf_node>"` (e.g. node2, or "node2 node3"). Spread one sweep across nodes with repeated submits; the shared filesystem guarantees every node sees the same run directory.

## Run directory naming: `Sim<N>_<YYYYMMDD>_batch<M>`

Local and remote run directories follow `<base>/Sim<N>_<YYYYMMDD>_batch<M>/`. `batch_submit` generates the next free name under `remote_root` automatically when `remote_dir` is omitted — same `Sim` index continues with `batch<M>+1` on the same day, a new day starts a new `Sim<N>+1`. Pass `remote_dir` explicitly only to reuse a specific location. Raw simulation data lives under `RawResults/` (remote `<remote_root>/RawResults/Sim*` is the batch_submit default; local runs live under `<project>/RawResults/`), processed compact results in `<project>/SimResults/`, report figures in `<project>/Figs/` (the session's **Report figures** option), and the HTML report at the project root.

## Workflow

1. **Prepare** — create the run directory with `template*.scs` + `sweep_config.json` (the authoring rules live in the `smart-spectre` / dca-cell-design skills — load them). Projects that prefer scripted assembly may keep a `gen_*.py` and run it directly — the optional legacy path (see smart-spectre).
2. **Submit** — `batch_submit {run_dir, worker: "spectre/spectre_sweep_worker.py", worker_args: ["--config", "sweep_config.json", "--max-parallel", "8"], scheduler: "local"|"ssh"|"lsf", lsf_node?: "node2"}`. Out-of-cluster submits upload the run directory plus the whole worker scripts tree over ssh; in-cluster the staging is a local copy on the shared filesystem. Both write `.batch_job.json` in the local run directory (local submits write the same file after spawning the worker on this host). `sim_scripts_dir` set to an existing directory replaces the worker scripts root (custom or test worker tree). `overwrite: true` replaces a batch that already ran in the target directory (stale replay markers are cleared first — without it a finished dir short-circuits to its old result).
3. **Monitor** — `batch_poll {run_dir, wait_sec}`: bjobs state plus the batch's own progress; `wait_sec` (≤600) holds the call and re-polls ~every 5 s until the batch settles. For `scheduler="local"` the frame comes from the run directory itself and knows whether the worker is still alive: one that died reads `failed` with its stderr tail in `errlog_tail` — fix the cause and resubmit, do not keep polling. **Timing trap:** judge completion by the per-point meta count (the poll's `completed` counts exactly those), not by the progress file alone — it may lag or be mid-write right after the run ends. The result carries a per-point digest (`points[]`: index / status / params) and, on a terminal state, auto-fetches the light result files into the run directory. Raw psf/sp data stays remote by design.
4. **Analyze — REMOTE by default** — run the parsing/metrics ON the host that holds the data and pull back only compact results (the put/exec/get triple) into `<project>/SimResults/`: `ssh_exec` the staged analyzers (or your own self-contained script) over the remote batch dir, then `ssh_download` the compact JSON. For local runs (or a debug copy) the same parser runs directly with python — the smart-spectre skill documents the CLI. For S-parameter matrix CSV dumps and passive-device extraction call `snp_guide` first, then `snp_read` / `snp_extract`.
5. **Report** — `gen_sweep_report {spec: <path>}` is a pure renderer: YOU process the data (dB conversion, multi-batch aggregation) and write a small spec JSON into `<project>/SimResults/`, then call it — the report lands at `<project>/<out>` and registers into the calling session's dashboard. Pass `register: false` to render without attaching; `register_report {report_path: <file>}` then attaches any local HTML (external pages included) into the calling session's dashboard.

Local runs replace steps 2–3 with `scheduler="local"` + one `batch_poll {run_dir, wait_sec: 600}`; steps 4–5 are identical (analyze locally — the run directory already holds everything — then the same spec flow).

## LSF / cluster gotchas

- The remote write fence is the project's configured `remote_root` (mirrored in the AGENTS.md config block) — `remote_dir` must stay under it.
- `bjobs` "No unfinished job found" means the job left the queue; completion is confirmed by the point count reaching the configured total.
- One template file per run directory (multiple `template*` files are rejected at submit).
- Submission is idempotent against connection replays (LSF marker + flock); `overwrite: true` deliberately waives the short-circuit for a rerun.
