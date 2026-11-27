// Generic batch tools: the unified submit contract — every scheduler is a
// QUICK LAUNCH (stage the run dir, start the worker, verify startup, record
// the job file, return a non-terminal state) and all monitoring goes through
// batch_poll. Only the launch internals differ: LSF wraps the worker in bsub
// (bjobs verifies it), scheduler=ssh launches the guarded worker detached
// over ssh (nohup + markers + flock; the .worker_started marker verifies it),
// scheduler=local spawns it on THIS host as a detached background process
// (batch_poll then reads the run directory's own files). Scheduler semantics
// follow the project's working environment (cluster_env, D-001): out-of-cluster
// every remote operation crosses dsh-ssh; in-cluster bsub runs on THIS host
// (the official ctx.shell seam) and file "transfers" are local copies on the
// shared filesystem — scheduler=ssh still executes over ssh, on any other
// node. Nothing in this file names a simulator; a Spectre run is just a
// worker choice, and the worker tree comes from the workspace
// sim_scripts_dir (see ../batch.js).
//
// Abort contract (D-004): every remote/local channel call here carries the
// turn's exec.signal (the session stop button), so an aborted call settles
// at once — but an ALREADY LAUNCHED worker is deliberately left alone
// (detached spawn/nohup'd block; markers + flock make re-runs idempotent).
// An aborted submit therefore means the remote state is uncertain; the tool
// descriptions tell the model how to re-verify before re-submitting.
// (covered by tests/batch.test.mjs — the scheduler matrix, wait_sec and abort
// groups)
//
// Cluster toolchain pins (D-006): the project settings name the executables
// this channel launches on the cluster side by ABSOLUTE path —
// settings.remote_python (the worker interpreter) and settings.remote_spectre_cmd
// (the spectre executable the bundled worker drives). null = unpinned, the
// bare defaults apply. The pins bind every scheduler the same way, so the
// self-check (which enters through batch_submit) verifies exactly the pair a
// session later runs with.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveDir } from '../channel/py.js'
import { callTool, resolveMachine, shq, buildChannel } from '../channel/remote.js'
import { readJsonTolerant } from '../lib/io.js'
import { defaultRemoteScriptsDir, remoteJoin, resolveRemoteDir, sanitizeRel } from '../lib/remotepath.js'
import { readRunProgress, totalFromConfig } from '../core/progress_files.js'
import { setPollFrame, deletePollFrame } from '../core/pollframes.js'
import { normalizePin } from '../core/settings.js'
import { overlaySettingsAt } from '../core/reconcile.js'
import { resolveProjectTool } from '../core/project.js'
import { effectiveSessionId } from '../subagent.js'
import {
  DEFAULT_REMOTE_PYTHON, TERMINAL_POLL_STATES, buildSshCommand, buildSubmitCommand,
  classifyBjobsState, collectRunFiles,
  nextSimDir, parseJobId, parsePollOutput, pluginAssets, pluginScripts,
  pollCommand, postSubmitCommand, readJob,
  submitScriptsRoot, templateUploadPlan, writeJob,
} from '../core/batch.js'

// The fixed light-result set a terminal poll pulls straight down (2026-11-23:
// poll absorbed fetch — no includes, no archive; raw psf/sp data stays remote
// by design, deep analysis runs on the host that holds it).
const AUTO_FETCH_FILES = ['sweep_progress.json', 'errlog.txt']

// batch_poll wait_sec cadence (D-004): the gap between re-polls of a blocking
// wait. 5 s keeps the session card's data as fresh as its own polling cadence
// — the card reads this call's published frames (core/pollframes.js), so the
// tick gap IS the card's freshness. The model-facing backoff ladder in the
// tool description (10 s -> 20 s -> 40 s) is the discipline for re-calling
// the tool across turns and stays as it is.
const WAIT_GAP_MS = 5_000

// Abortable gap for the wait loops (D-004): sleeps up to `ms`, but wakes the
// moment `signal` aborts so the tool call settles at once when the session
// stop fires mid-wait (an aborted poll is read-only — nothing to clean up;
// an aborted submit's guidance lives in the tool description).
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (!signal) { setTimeout(resolve, ms); return }
    if (signal.aborted) { resolve(); return }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// The wait_sec loop shared by the local and remote poll branches (D-004):
// re-tick every WAIT_GAP_MS until a terminal state or the deadline, the LAST
// frame winning; a D-004 abort wakes the gaps at once (polling is read-only —
// nothing to clean up). `waitSec` 0 keeps the single-snapshot contract.
async function pollUntilTerminal({ waitSec, signal, isTerminal, tick }) {
  const deadline = Date.now() + waitSec * 1000
  let frame
  for (;;) {
    frame = await tick()
    if (!waitSec || isTerminal(frame)) break
    const remain = deadline - Date.now()
    if (remain <= 0) break
    await sleepAbortable(Math.min(WAIT_GAP_MS, remain), signal)
    if (signal?.aborted) break
  }
  return frame
}

// The session-level scan-size ceiling (D-004): the calling session's
// "Max points per scan" field, defaulting to 100. Fail-open — a missing
// session entry or an unreadable store never blocks a submit. `projectPath`
// is the session-resolved project root (D-008: no walk-up from run_dir).
const DEFAULT_MAX_POINTS_PER_SCAN = 100

async function maxPointsPerScan(projectPath, sessionId) {
  try {
    if (!sessionId) return DEFAULT_MAX_POINTS_PER_SCAN
    if (!projectPath) return DEFAULT_MAX_POINTS_PER_SCAN
    const { readSessionConfigs } = await import('../core/project.js')
    const store = await readSessionConfigs(projectPath)
    const v = store.sessions?.[sessionId]?.max_points_per_scan
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_POINTS_PER_SCAN
  } catch {
    return DEFAULT_MAX_POINTS_PER_SCAN
  }
}

// The suite's own Spectre worker (ships with SmartAnaSim): the only worker
// the remote_spectre_cmd pin is passed to — custom workers keep their own
// argument contract.
const BUNDLED_SPECTRE_WORKER = 'spectre/spectre_sweep_worker.py'

// The interpreter that runs one worker: a per-call remote_python (which must
// be an absolute path too — a bare name resolves through whatever PATH the
// shell startup chain left behind, the 2026-11-24 incident) > the project's
// remote_python pin > the bare `fallback` (python3 remote, python locally).
function resolvePython(argValue, settings, fallback) {
  if (argValue != null && argValue !== '') {
    const p = normalizePin(String(argValue), 'remote_python')
    if (p.error) throw new Error(p.error)
    return p.value
  }
  return settings.remote_python || fallback
}

// The pinned spectre reaches the BUNDLED worker as `--spectre-cmd` (its own
// argument contract); a worker_args entry the caller wrote always wins.
function withSpectrePin(workerRel, workerArgs, settings) {
  const args = (workerArgs || []).map(String)
  if (!workerRel || workerRel !== BUNDLED_SPECTRE_WORKER || !settings.remote_spectre_cmd) return args
  if (args.some((a) => a === '--spectre-cmd' || a.startsWith('--spectre-cmd='))) return args
  return [...args, '--spectre-cmd', settings.remote_spectre_cmd]
}

function underRoot(root, candidate) {
  return candidate === root || candidate.startsWith(root + '/')
}

// scheduler=local: spawn the worker on THIS host detached (stdio to
// .batch_local.out/.err inside the run directory), record the same job file,
// and return immediately — the model then batch_poll's the run directory
// (wait_sec for the blocking wait; the session card live-updates off the same
// files). The worker carries its own global budget, so a forgotten run still
// terminates by itself. The same toolchain pins as the remote schedulers
// (D-006) apply here: the pinned interpreter spawns the worker, the pinned
// spectre rides as --spectre-cmd for the bundled worker.
async function submitLocal(args, runDir, settings, projectPath, signal) {
  // D-004: abort before the spawn cancels the launch; once spawned the
  // worker is a detached orphan by design (same ruling as the ssh nohup
  // launch) — the job file still lands so a later poll can attach.
  if (signal?.aborted) throw new Error('aborted before the local worker was spawned')
  const rawWorker = String(args.worker)
  if (rawWorker.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawWorker)) {
    throw new Error('scheduler=local needs a scripts-root-relative worker (e.g. "spectre/spectre_sweep_worker.py"), not an absolute path')
  }
  const rel = sanitizeRel(rawWorker)
  const workerAbs = path.join(submitScriptsRoot(args.sim_scripts_dir, projectPath), ...rel.split('/'))
  if (!fs.existsSync(workerAbs)) {
    throw new Error(`worker script not found under the project sim_scripts_dir: ${rel} `
      + '(set workspace.sim_scripts_dir in the project\'s .harnessams/workspace_config.json '
      + 'to the SmartAnaSim scripts directory, or pass sim_scripts_dir)')
  }
  // Pre-flight the same template/config contract the remote uploader checks —
  // nothing is uploaded, but a bad run directory should fail before a worker
  // process ever starts.
  let sweepConfig = null
  try { sweepConfig = JSON.parse(fs.readFileSync(path.join(runDir, 'sweep_config.json'), 'utf8')) } catch { sweepConfig = null }
  templateUploadPlan(runDir, collectRunFiles(runDir, args.files), sweepConfig)

  const python = resolvePython(args.remote_python, settings, 'python')
  const workerArgs = withSpectrePin(rel, args.worker_args, settings)
  if (!workerArgs.includes('--work-dir')) workerArgs.push('--work-dir', runDir)
  const out = fs.openSync(path.join(runDir, '.batch_local.out'), 'a')
  const err = fs.openSync(path.join(runDir, '.batch_local.err'), 'a')
  let child
  try {
    child = spawn(python, [workerAbs, ...workerArgs], {
      cwd: runDir,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, PYTHONUTF8: '1' },
      windowsHide: true,
    })
  } finally {
    fs.closeSync(out)
    fs.closeSync(err)
  }
  // A process that cannot even be spawned (no python on PATH) reports through
  // an asynchronous 'error' event — without a listener that event is an
  // uncaught exception in the host. Settle it here and fail the submit before
  // any job file exists for a poll to read.
  const spawnError = await new Promise((resolve) => {
    child.once('error', resolve)
    child.once('spawn', () => resolve(null))
  })
  if (spawnError) throw new Error(`cannot start the local worker (interpreter ${python}): ${spawnError.message}`)
  child.unref()
  const job = {
    machine_id: null,
    machine_name: null,
    remote_root: null,
    remote_dir: null,
    scripts_dir: null,
    worker: workerAbs,
    worker_args: workerArgs,
    job_id: `local-${Date.now()}`,
    queue: null,
    remote_python: python,
    scheduler: 'local',
    pid: child.pid ?? null,
    submitted_at: new Date().toISOString(),
    total_points: totalFromConfig(runDir),
  }
  writeJob(runDir, job)
  return {
    ok: true,
    job_id: job.job_id,
    state: 'running',
    scheduler: 'local',
    run_dir: runDir,
    pid: job.pid,
    warnings: [],
    job_file: path.join(runDir, '.batch_job.json'),
    output: '',
  }
}

// One local poll frame from the run directory's own files (the shared ladder
// in progress_files.js). No ssh: local runs write everything into run_dir.
// The per-point digest mirrors the remote poll frames. The ladder also knows
// whether the local worker is still alive — a dead one is a FAILED frame
// (startup death / mid-run), so a blocking wait never spends wait_sec on a
// corpse.
function localPollFrame(runDir) {
  const p = readRunProgress(runDir)
  if (!p.local) {
    return { state: 'unknown', job_state: 'local', completed: 0, total: null, points: null }
  }
  const state = p.status === 'completed' ? 'completed'
    : p.status === 'failed' ? 'failed'
      : p.source === 'config' ? 'pending' : 'running'
  // Failure detail: the worker's own errlog.txt (its startup-error classes),
  // else — on a failed frame — the spawn-level stderr .batch_local.err (bad
  // arguments, a missing import, a traceback), so a dead worker explains
  // itself in the payload instead of leaving "running" behind.
  const tail = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-5).join('\n') || null
    } catch { return null /* not written yet */ }
  }
  const errlog = tail(path.join(runDir, 'errlog.txt')) || (state === 'failed' ? tail(path.join(runDir, '.batch_local.err')) : null)
  let points = null
  try {
    points = trimLocalPoints(JSON.parse(fs.readFileSync(path.join(runDir, 'sweep_progress.json'), 'utf8'))?.points)
  } catch { /* not written yet */ }
  return {
    state,
    job_state: 'local',
    completed: p.completed,
    total: p.total,
    succeeded: p.succeeded,
    failed: p.failed,
    pending: p.pending,
    simulator: p.simulator,
    compute_node: p.compute_node,
    updated_at: p.updated_at,
    errlog_tail: errlog,
    points,
  }
}

function trimLocalPoints(points) {
  if (!Array.isArray(points)) return null
  return points.slice(0, 100).map((q) => (q && typeof q === 'object') ? {
    index: q.index ?? null,
    point_name: q.point_name ?? null,
    status: q.status ?? null,
    params: q.params ?? null,
    error: q.error ?? null,
  } : null)
}

export function batchTools(ctx) {
  return [
    {
      name: 'batch_submit',
      description: 'Submit a batch through the suite\'s worker scripts. ONE unified contract across the three '
        + 'schedulers (working-environment semantics still apply — read the cluster_env row of the project\'s '
        + 'AGENTS.md config block): every submit is a QUICK LAUNCH — it stages the run directory plus the worker '
        + 'scripts tree, starts the worker, verifies startup, writes .batch_job.json in the run directory, and '
        + 'returns a non-terminal state (running/submitted/queued, or completed when a done-marker replay '
        + 'short-circuits); ALL monitoring and light-result retrieval go through batch_poll. Only the launch '
        + 'internals differ. scheduler="local": the worker spawns on THIS host detached (in-cluster only; an '
        + 'out-of-cluster host cannot run it). scheduler="lsf" (default): the worker runs under bsub — '
        + 'in-cluster bsub runs right on this host and the run directory stages as a local copy on the shared '
        + 'filesystem; out-of-cluster the directory and the scripts tree (the workspace sim_scripts_dir) upload '
        + 'to a dsh-ssh host and bsub runs there. scheduler="ssh": the guarded worker launches DETACHED on the '
        + 'target host (nohup — it survives the ssh channel closing; stdout/stderr land in ssh_worker.log in the '
        + 'run dir; startup is verified against the worker\'s own .worker_started marker; out-of-cluster: the '
        + 'ssh node itself, a second hop goes through the dsh-ssh proxy config; in-cluster: any other node — '
        + 'files never cross ssh). There is no per-run ssh deadline: the worker\'s own global budget is the only '
        + 'run-level deadline. The worker path is scripts-root-relative (e.g. '
        + '"spectre/spectre_sweep_worker.py") or absolute on the target; worker_args are passed through. '
        + 'Rejects a scan whose total point count (from sweep_config.json) exceeds the calling session\'s Max '
        + 'points per scan field (default 100) — split the grid into multiple batches instead. ABORT BEHAVIOR: '
        + 'the session stop settles this call immediately, but an ALREADY LAUNCHED worker is deliberately left '
        + 'running (orphaned by design — replay markers + flock make re-submits idempotent), so an aborted '
        + 'submit means the remote state is UNCERTAIN: re-verify before re-submitting (batch_poll once a job '
        + 'file exists, or ssh_exec the run dir for sweep_progress.json / .worker_started / .hams_ssh_done). '
        + 'The project config resolves from the calling session\'s workspace '
        + 'with the AGENTS.md yaml block overlaid (D-002: hand-edits of that block take effect immediately at '
        + 'this read; an invalid row keeps the stored value and warns in the result).',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Local run directory (holds template and sweep_config.json) — by convention inside the design folder, e.g. <project>/<design>/run1' },
        remote_dir: { type: 'string', description: 'Remote batch directory: absolute, or relative to remote_root. '
          + 'Omit to auto-generate the next Sim<N>_<YYYYMMDD>_batch<M> directory under <remote_root>/RawResults '
          + '(the D-004 raw-simulation-data convention; mirror the same name locally under <design>/RawResults). '
          + 'Unused for scheduler="local"' },
        remote_root: { type: 'string', description: 'Absolute run root that fences remote_dir — a shared-filesystem '
          + 'path in-cluster, the ssh host\'s path out-of-cluster. Omit to use the project\'s configured remote_root '
          + '(mirrored in the AGENTS.md config block); explicit values are for one-off overrides' },
        worker: { type: 'string', required: true, description: 'Worker script relative to the scripts root (e.g. spectre/spectre_sweep_worker.py) or an absolute remote path' },
        worker_args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the worker (e.g. --config sweep_config.json --max-parallel 8). '
          + 'The project\'s remote_spectre_cmd pin is appended as --spectre-cmd for the bundled spectre worker unless these already name one' },
        machine_id: { type: 'string', description: 'dsh-ssh host alias to run on — omit to use the project\'s '
          + 'configured machine (the normal case; pass one only to spread a sweep across nodes, together with '
          + 'repeated submits). Unused by in-cluster lsf (bsub runs on this host)' },
        remote_python: { type: 'string', description: 'Interpreter that runs the worker on the target. Omit it: the project\'s remote_python pin '
          + 'applies (the AGENTS.md yaml row; null = bare python3). An explicit value must be an ABSOLUTE path — bare names are rejected, '
          + 'they resolve to whichever tool python comes first on PATH (the cluster-setup skill harvests and verifies real paths)' },
        remote_scripts_dir: { type: 'string', description: 'Remote scripts root (default: <remote_root>/.harnessams/scripts)' },
        sim_scripts_dir: { type: 'string', description: 'Worker scripts root: an existing directory IS the root (override); any other value is ignored — '
          + 'the session project\'s workspace.sim_scripts_dir applies (D-002: resolved from the calling session, not from run_dir)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Run-dir files to upload (default: top-level regular files)' },
        queue: { type: 'string', description: 'LSF queue (default normal)' },
        scheduler: { type: 'string', enum: ['lsf', 'ssh', 'local'],
          description: 'local runs the worker on THIS host in the background (in-cluster only); lsf (default) '
            + 'submits through bsub (locally in-cluster, on the target host out-of-cluster); ssh launches the '
            + 'worker detached on the target host (nohup, no LSF) and returns after startup verification — '
            + 'monitor with batch_poll exactly like the other schedulers' },
        lsf_node: { type: 'string', description: 'LSF only: pin the job to a host or host list — bsub -m "<lsf_node>" '
          + '(e.g. node2, or "node2 node3" to spread). Combine with repeated submits to run one sweep on several nodes' },
        job_name: { type: 'string', description: 'bsub -J name (default hams-<run dir name>)' },
        sync_scripts: { type: 'boolean', description: 'Upload scripts/ to the remote scripts root (default true; pass false after a successful sync)' },
        overwrite: { type: 'boolean', description: 'Allow submitting into a remote directory that already has point_meta.json files. '
          + 'Stale replay markers (.hams_submitted / .hams_ssh_done) are cleared first, so a batch that already ran here actually re-runs '
          + '(without this, a completed ssh/LSF dir short-circuits to its old result)' },
        no_pre_check: { type: 'boolean', description: 'Skip the built-in spectre netlist pre-check (the SmartAnaSim spectre_pre_check '
          + 'tool that runs automatically before anything is staged). Pass true ONLY after reviewing a failed pre-check report — the '
          + 'waiver exists for consciously accepted netlist quirks, not for unexamined errors' },
        project: { type: 'string', description: 'Optional explicit workspace path (default: the calling session\'s workspace)' },
      },
      async execute(args, exec) {
        const runDir = resolveDir(args.run_dir)
        // D-004: the turn's abort signal (set by the host before the body
        // runs; fires when the session stop is pressed). It rides EVERY
        // channel call below (exec/upload/download), settling the call at
        // once — an already-launched worker is deliberately left alone.
        const turnSignal = exec?.signal ?? null
        // D-002 project anchoring: the calling session (or an explicit `project`
        // argument) — NOT a path walk-up from run_dir — decides which project's
        // config this submission resolves. The AGENTS.md yaml block overlays at
        // this READ (reconcile at read AND write, user ruling 2026-11-25): a
        // hand-edited row takes effect immediately; an invalid row keeps the
        // json value and surfaces as a warning riding the result. A subagent
        // caller anchors on its topmost user-visible ancestor (src/subagent.js).
        const sid = effectiveSessionId(ctx, exec?.agent)
        const p = resolveProjectTool(ctx.workspaceRegistry, sid, args.project)
        if (p.error) throw new Error(p.error)
        const projectPath = p.project.path
        const { settings, warnings: overlayWarnings } = overlaySettingsAt(projectPath)
        // Session scan-size gate (D-004): reads sweep_config.json and rejects
        // an oversized grid before anything is staged or uploaded. Splits the
        // scan into multiple Sim batches instead of one mega-run.
        const totalScanPoints = totalFromConfig(runDir)
        if (totalScanPoints > 0) {
          const limit = await maxPointsPerScan(projectPath, sid)
          if (totalScanPoints > limit) {
            throw new Error(`scan exceeds the session's max points per scan: ${totalScanPoints} > ${limit}`
              + ' — split the parameter grid into multiple batches (auto Sim naming)'
              + " or raise the session's Max points per scan field")
          }
        }
        // Netlist pre-check (D-005): the SmartAnaSim spectre_pre_check tool
        // validates the hand-written run directory before anything is staged —
        // the check families and the check-param chain live there (pure JS, so
        // this path needs no local python). Fail-closed on errors (fix the
        // netlist, or consciously re-submit with no_pre_check: true), fail-open
        // when the tool is not registered, warnings ride along into the result.
        // (covered by tests/batch.test.mjs — the pre-check gate group; the engine
        // itself by tests/precheck.test.mjs in the SmartAnaSim repo)
        const preCheckWarnings = [...overlayWarnings]
        if (args.no_pre_check !== true) {
          if (!ctx.tools?.get?.('spectre_pre_check')) {
            preCheckWarnings.push('spectre_pre_check is not registered — netlist content checks skipped '
              + '(install/enable the SmartAnaSim plugin)')
          } else {
            const preArgs = { run_dir: args.run_dir }
            if (sid) preArgs.session_id = sid
            const pre = await callTool(ctx, 'spectre_pre_check', preArgs, { timeoutMs: 30_000, signal: turnSignal })
            if (pre.isError || pre.value?.ok === false) {
              const detail = (Array.isArray(pre.value?.errors) && pre.value.errors.length
                ? pre.value.errors : [pre.text || 'no details']).map(String).join('\n')
              throw new Error('spectre pre-check failed — fix the netlist, or re-submit with '
                + 'no_pre_check: true to waive it after review:\n' + detail)
            }
            preCheckWarnings.push(...(Array.isArray(pre.value?.warnings) ? pre.value.warnings.map(String) : []))
          }
        }
        const scheduler = args.scheduler === 'ssh' ? 'ssh' : args.scheduler === 'local' ? 'local' : 'lsf'
        // Channel matrix (D-001): the project's cluster_env picks the semantics.
        // Out-of-cluster every remote operation crosses dsh-ssh; in-cluster
        // bsub runs on THIS host (the official ctx.shell seam) and "transfers"
        // are local copies on the shared filesystem — scheduler=ssh still
        // executes over ssh, on any other node.
        const inCluster = settings.cluster_env === 'in-cluster'
        if (scheduler === 'local') {
          if (!inCluster) {
            throw new Error('scheduler=local requires cluster_env=in-cluster (an out-of-cluster host cannot run '
              + 'the worker — use scheduler="ssh" or "lsf")')
          }
          const local = await submitLocal(args, runDir, settings, projectPath, turnSignal)
          local.warnings = [...preCheckWarnings, ...(local.warnings || [])]
          return local
        }
        // Toolchain pins (D-006): resolved and validated BEFORE anything is
        // staged — a bare remote_python fails here, not after the uploads.
        const remotePython = resolvePython(args.remote_python, settings, DEFAULT_REMOTE_PYTHON)
        if (args.lsf_node != null && scheduler !== 'lsf') {
          throw new Error('lsf_node applies to scheduler="lsf" only')
        }
        if (args.lsf_node != null && !/^[A-Za-z0-9][A-Za-z0-9._-]*( [A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(String(args.lsf_node))) {
          throw new Error(`invalid lsf_node ${JSON.stringify(args.lsf_node)} (a host name or a space-separated host list — it is passed to bsub -m)`)
        }
        const remoteRootArg = args.remote_root || settings.remote_root || undefined
        const sshExec = scheduler === 'ssh' || !inCluster
        let target
        if (!sshExec) {
          // in-cluster LSF: no ssh hop, no machine — bsub runs right here
          const root = typeof remoteRootArg === 'string' ? remoteRootArg.trim().replace(/\\/g, '/') : ''
          if (!root || !root.startsWith('/')) {
            throw new Error('remote_root is required (the absolute shared-filesystem root that fences remote_dir '
              + '— the project\'s settings.remote_root)')
          }
          target = { machine: null, alias: null, remoteRoot: root }
        } else {
          target = await resolveMachine(ctx, args.machine_id || settings.machine_id, remoteRootArg)
        }
        // D-004: turnSignal rides every channel call — exec-shaped calls get
        // the dsh-ssh KILL+close path (or the ctx.shell kill in-cluster) plus
        // the callTool race; transfers get the race (sftp has no abort path —
        // the orphaned upload is harmless, re-staging is idempotent).
        const channel = buildChannel(ctx, { alias: target.alias, inCluster, signal: turnSignal })
        if (sshExec && Array.isArray(target.machine?.proxyJump) && target.machine.proxyJump.length === 0) {
          // 2026-11-26 ruling: a dsh-ssh entry without ProxyJump (the second
          // hop) still runs — DIRECT, never blocked — but the submit result
          // says so, because a compute node that is only reachable through a
          // login host will burn the connect budget instead of working. An
          // alias entirely absent from the registry still fails up front in
          // resolveMachine (that half stays an error).
          preCheckWarnings.push(`machine_id ${target.machine.id} has no ProxyJump (second hop) configured in dsh-ssh — `
            + 'running a direct connection; add the jump chain in the dsh-ssh panel if this host is not directly reachable')
        }
        let remoteDir
        if (args.remote_dir) {
          remoteDir = resolveRemoteDir(target.remoteRoot, args.remote_dir)
        } else {
          // Auto Sim<N>_<YYYYMMDD>_batch<M> under <remote_root>/RawResults
          // (D-004, 2026-11-21): list once and pick the next free name per the
          // convention. The root itself is probed strictly; a missing
          // RawResults/ subdir is fine (empty list → Sim0_..._batch1, uploads
          // create it); the point_meta probe below still guards collisions.
          const rawBase = `${target.remoteRoot.replace(/\/+$/, '')}/RawResults`
          const ls = await channel.exec(
            `ls -1d ${shq(target.remoteRoot)} >/dev/null 2>&1 || echo __NOROOT__; `
            + `ls -1 ${shq(rawBase)} 2>/dev/null || true`, { timeoutMs: 30_000 })
          if (!ls.ok || String(ls.stdout ?? '').includes('__NOROOT__')) {
            throw new Error(`remote_root listing failed (cannot auto-name the batch dir): `
              + `${(ls.stderr || ls.stdout || ls.text || '').slice(0, 300)}`)
          }
          const now = new Date()
          const p2 = (n) => String(n).padStart(2, '0')
          const today = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`
          remoteDir = resolveRemoteDir(rawBase,
            nextSimDir(String(ls.stdout ?? '').split(/\r?\n/), today))
        }
        const syncScripts = args.sync_scripts !== false
        const rawScripts = args.remote_scripts_dir
          || defaultRemoteScriptsDir(target.remoteRoot)
        const scriptsRoot = rawScripts.startsWith('/') ? rawScripts.replace(/\/+$/, '')
          : resolveRemoteDir(target.remoteRoot, rawScripts)
        if (syncScripts && !underRoot(target.remoteRoot, scriptsRoot)) {
          throw new Error(`remote_scripts_dir must be under the remote workspace when syncing scripts: ${scriptsRoot}`)
        }

        let remoteWorker
        let workerRel = null
        const workerRaw = String(args.worker)
        if (workerRaw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(workerRaw)) {
          remoteWorker = workerRaw.replace(/\\/g, '/')
        } else {
          workerRel = sanitizeRel(workerRaw)
          const localWorker = path.join(submitScriptsRoot(args.sim_scripts_dir, runDir), ...workerRel.split('/'))
          if (!fs.existsSync(localWorker)) {
            throw new Error(`worker script not found under the project sim_scripts_dir: ${workerRel} `
              + '(fix the worker scripts root in the project settings table — the Overview settings UI or the '
              + 'harnessams_selfcheck settings argument — or pass sim_scripts_dir)')
          }
          remoteWorker = remoteJoin(scriptsRoot, workerRel)
        }
        const workerArgs = withSpectrePin(workerRel, args.worker_args, settings)

        const probe = await channel.exec(
          `ls -1 ${shq(remoteDir)}/*/point_meta.json 2>/dev/null | wc -l`, { timeoutMs: 30_000 })
        const existing = Number(String(probe.stdout ?? '').trim()) || 0
        if (existing > 0 && !args.overwrite) {
          throw new Error(`remote_dir already holds ${existing} point_meta.json file(s): ${remoteDir} `
            + '(pass overwrite=true only if replacing that batch is intended)')
        }

        const sweepConfig = readJsonTolerant(path.join(runDir, 'sweep_config.json'))
        const files = templateUploadPlan(runDir,
          collectRunFiles(runDir, args.files), sweepConfig)

        if (syncScripts) {
          const scriptsRootLocal = submitScriptsRoot(args.sim_scripts_dir, projectPath)
          for (const script of pluginScripts(scriptsRootLocal)) {
            const remote = remoteJoin(scriptsRoot, script.rel)
            const up = await channel.upload(script.local, remote)
            if (!up.ok) throw new Error(`upload failed for ${script.rel}: ${up.text}`)
          }
          // sibling assets bucket (numfallback): lands at <scripts root>/../assets
          // so snp_common's here.parents[1]/assets resolution finds it remotely
          for (const asset of pluginAssets(scriptsRootLocal)) {
            const remote = remoteJoin(scriptsRoot, '..', 'assets', asset.rel)
            if (!underRoot(target.remoteRoot, remote)) {
              throw new Error(`assets upload escapes the remote workspace: ${remote}`)
            }
            const up = await channel.upload(asset.local, remote)
            if (!up.ok) throw new Error(`upload failed for assets/${asset.rel}: ${up.text}`)
          }
        }

        for (const file of files) {
          const name = file.uploadName || file.name
          const up = await channel.upload(file.local, remoteJoin(remoteDir, name))
          if (!up.ok) throw new Error(`upload failed for ${name}: ${up.text}`)
        }

        const queue = args.queue || 'normal'
        const jobName = args.job_name || `hams-${path.basename(runDir)}`
        if (scheduler === 'ssh') {
          // Detached launch (the unified submit contract, D-004): staging is
          // shared above; this branch launches the guarded worker in the
          // BACKGROUND over ssh, verifies startup, records the job file, and
          // returns a NON-TERMINAL state — monitoring is batch_poll's job
          // (scheduler=ssh reads the remote progress files; only the launch
          // internals differ from bsub/local). The exec budget is
          // launch-scale (the command itself waits ~20 s for the worker's
          // .worker_started marker); the worker's own global budget is the
          // only run-level deadline. An aborted call settles here at once
          // (turnSignal rides the channel) while an already-launched worker
          // is deliberately left alone (D-004) — re-submitting is safe
          // (markers + flock).
          const command = buildSshCommand({
            remoteDir,
            python: remotePython,
            workerPath: remoteWorker,
            workerArgs,
            overwrite: args.overwrite === true,
          })
          const ran = await channel.exec(command, { timeoutMs: 60_000 })
          if (!ran.ok) {
            throw new Error(`ssh launch failed (exit ${ran.exitCode}): `
              + `${(ran.stderr || ran.stdout || ran.text || '').slice(0, 1200)}`)
          }
          const jobId = `ssh-${Date.now()}`
          const job = {
            machine_id: args.machine_id || target.machine?.id || null,
            machine_name: target.machine?.name || null,
            remote_root: target.remoteRoot,
            remote_dir: remoteDir,
            scripts_dir: scriptsRoot,
            worker: remoteWorker,
            worker_args: workerArgs,
            job_id: jobId,
            queue: null,
            remote_python: remotePython,
            scheduler: 'ssh',
            cluster_env: inCluster ? 'in-cluster' : 'out-of-cluster',
            submitted_at: new Date().toISOString(),
            total_points: totalFromConfig(runDir),
          }
          writeJob(runDir, job)
          // Launch-verification mapping: a done-marker replay short-circuits
          // in the foreground (already completed); __STARTED__ = the worker's
          // own .worker_started marker was read back (running); anything
          // else = detached but unconfirmed (submitted + a warning — a slow
          // NFS start or a replay queued behind a running flock; poll
          // decides). The worker's stdout now lands in ssh_worker.log in the
          // run dir instead of this result's output field.
          const launchOut = (ran.stdout || '').trim()
          const replayDone = launchOut.includes('already completed')
          const started = launchOut.includes('__STARTED__')
          const warnings = [...preCheckWarnings]
          if (!started && !replayDone) {
            warnings.push('worker detached but the .worker_started marker was not seen within the launch window '
              + '(slow start or a replay queued behind a running batch) — poll to confirm')
          }
          return {
            ok: true,
            job_id: jobId,
            state: replayDone ? 'completed' : started ? 'running' : 'submitted',
            scheduler: 'ssh',
            remote_dir: remoteDir,
            scripts_dir: scriptsRoot,
            warnings,
            job_file: path.join(runDir, '.batch_job.json'),
            output: launchOut.slice(0, 2000),
          }
        }
        const command = buildSubmitCommand({
          remoteDir,
          queue,
          jobName,
          node: args.lsf_node != null ? String(args.lsf_node) : null,
          python: remotePython,
          workerPath: remoteWorker,
          workerArgs,
          overwrite: args.overwrite === true,
        })
        const submitted = await channel.exec(command, { timeoutMs: 90_000 })
        if (!submitted.ok) {
          throw new Error(`bsub submission failed (exit ${submitted.exitCode}): `
            + `${(submitted.stderr || submitted.stdout || '').slice(0, 1200)}`)
        }
        const jobId = parseJobId(submitted.stdout)
        if (!jobId) {
          throw new Error('bsub did not report a job id: ' + (submitted.stdout || '').slice(0, 800))
        }

        const warnings = []
        const post = await channel.exec(postSubmitCommand(remoteDir, jobId),
          { timeoutMs: 30_000 })
        // PEND right after bsub is the expected state, not a failure: the
        // bjobs block decides which "no marker yet" cases are worth a word.
        const jobState = classifyBjobsState(post.stdout || '')
        if (!post.ok) {
          warnings.push(`post-submit check could not run: ${(post.stderr || post.text).slice(0, 300)}`)
        }
        if (post.stdout.includes('__ERRLOG__')) {
          warnings.push('remote errlog.txt exists — the worker failed to start (use batch_poll for details)')
        }
        if (jobState === 'failed') {
          warnings.push('the job is already EXIT/ZOMBI per bjobs — poll for details')
        }
        if (!post.stdout.includes('__STARTED__') && jobState !== 'queued') {
          if (jobState === 'running') {
            warnings.push('job is RUN but the .worker_started marker is not there yet — poll to confirm')
          } else if (jobState === 'done') {
            warnings.push('job already finished (DONE) before verification — poll to fetch')
          } else if (jobState !== 'failed' && post.ok) {
            warnings.push('job state unknown after submit — poll to confirm')
          }
        }

        const job = {
          machine_id: args.machine_id || target.machine?.id || null,
          machine_name: target.machine?.name || null,
          remote_root: target.remoteRoot,
          remote_dir: remoteDir,
          scripts_dir: scriptsRoot,
          worker: remoteWorker,
          worker_args: workerArgs,
          job_id: jobId,
          queue,
          remote_python: remotePython,
          scheduler: 'lsf',
          cluster_env: inCluster ? 'in-cluster' : 'out-of-cluster',
          lsf_node: args.lsf_node != null ? String(args.lsf_node) : null,
          submitted_at: new Date().toISOString(),
          total_points: totalFromConfig(runDir),
        }
        writeJob(runDir, job)
        return {
          ok: true,
          job_id: jobId,
          state: post.stdout.includes('__STARTED__') ? 'running'
            : jobState === 'queued' ? 'queued'
            : jobState === 'failed' ? 'failed'
            : 'submitted',
          remote_dir: remoteDir,
          scripts_dir: scriptsRoot,
          warnings: [...preCheckWarnings, ...warnings],
          job_file: path.join(runDir, '.batch_job.json'),
          output: (submitted.stdout || '').trim().slice(0, 2000),
        }
      },
    },
    {
      name: 'batch_poll',
      description: 'Poll a batch submitted by batch_submit: bjobs state plus the batch\'s own progress '
        + '(point_meta.json count, sweep_progress.json summary, errlog tail) and a per-point digest (index/name/'
        + 'status/params). On a terminal state it auto-fetches the light result files (sweep_progress.json, '
        + 'errlog.txt) straight into the run directory — no includes, no archive; raw psf/sp data stays on the '
        + 'executing side by design. The machine, directory and '
        + 'job id default to <run_dir>/.batch_job.json. A local submission (scheduler="local") is polled from the '
        + 'run directory\'s own files, no ssh involved — a worker that died reads as failed and carries its stderr '
        + 'tail. An in-cluster LSF submission polls locally (bjobs on this host); everything else polls over ssh. '
        + 'Pass wait_sec for a bounded blocking wait — the in-flight call is the '
        + 'window where the session progress card live-updates. Polling discipline (D-002, moved here from the '
        + 'AGENTS.md workflow table): poll, never blind-sleep — re-check after each bounded wait, back off '
        + '10 s -> 20 s -> 40 s with the ETA computed from completed over total; while a progress card is up, '
        + 'refresh it at least every 5 s. ABORT BEHAVIOR: polling is read-only, so the session stop settles a '
        + 'blocking poll at once with no side effects — but if the SUBMIT that created the batch was aborted, '
        + 'no job file may exist (the "no job record" error) and the remote state is UNCERTAIN: verify it '
        + 'directly with ssh_exec (cat sweep_progress.json / .worker_started / .hams_ssh_done, tail errlog.txt) '
        + 'before drawing conclusions. Analysis recipe after a terminal state (raw data stays where it '
        + 'executed): in-cluster run the parsers on the host that holds the data (shared filesystem) with the '
        + 'interpreter named by the remote_python row of the project\'s AGENTS.md yaml (null = the bare default '
        + 'the self-check verified — python for the in-cluster local chain, python3 otherwise) — '
        + '<workspace_root>/.harnessams/scripts/spectre/spectre_psf_parse.py --work-dir <run dir> --format csv, '
        + 'the snp tools for S-parameters; out-of-cluster go remote-first — the parsers are already staged under '
        + '<remote_root>/.harnessams/scripts, ssh_exec them with the same interpreter rule (never bare python, '
        + 'it is 2.x on many hosts) and ssh_download only the compact JSON into <design>/SimResults/.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Local run directory holding .batch_job.json' },
        machine_id: { type: 'string', description: 'Override the dsh-ssh host alias from the job file' },
        remote_root: { type: 'string', description: 'Override the fencing remote root (default: the job file\'s remote_root)' },
        remote_dir: { type: 'string', description: 'Override the remote batch directory' },
        job_id: { type: 'string', description: 'Override the job id' },
        scheduler: { type: 'string', enum: ['lsf', 'ssh', 'local'], description: 'lsf (default) checks bjobs; ssh relies on the batch progress files; local reads the run directory itself' },
        wait_sec: { type: 'integer', description: 'Bounded blocking wait: re-poll (~5 s apart) until a terminal state '
          + '(completed/failed/partial) or this many seconds elapse (capped at 600), then return the last payload. '
          + 'Default 0 = single snapshot, the original contract' },
        project: { type: 'string', description: 'Optional explicit workspace path (default: the calling session\'s workspace)' },
      },
      async execute(args, exec) {
        const runDir = resolveDir(args.run_dir)
        // D-004: the turn's abort signal — rides every channel call and wakes
        // the wait_sec gaps, so the session stop settles a blocking poll at
        // once (polling is read-only: an aborted poll leaves nothing behind).
        const turnSignal = exec?.signal ?? null
        // D-002 anchoring: the calling session's project (or an explicit
        // `project` argument) — no walk-up from run_dir; a subagent caller
        // resolves to its topmost user-visible ancestor (src/subagent.js). The
        // AGENTS.md yaml overlay applies to the cluster_env fallback below;
        // invalid rows keep the json value and warn into the result.
        const sid = effectiveSessionId(ctx, exec?.agent)
        const p = resolveProjectTool(ctx.workspaceRegistry, sid, args.project)
        if (p.error) throw new Error(p.error)
        const { settings, warnings: overlayWarnings } = overlaySettingsAt(p.project.path)
        const job = readJob(runDir)
        const jobId = args.job_id || job?.job_id
        if (!jobId) throw new Error('no job record: <run_dir>/.batch_job.json is absent and no job_id was passed '
          + '— the batch state is UNCERTAIN (the submit may have been aborted before the job file was written, '
          + 'or this run dir was never submitted from this machine). Verify the remote state directly first '
          + '(ssh_exec the run dir: cat sweep_progress.json / .worker_started / .hams_ssh_done, tail errlog.txt), '
          + 'or pass job_id')
        if (!/^[\w.-]+$/.test(jobId)) throw new Error(`invalid job_id ${JSON.stringify(jobId)} (word/dot/dash only — it is joined into local paths)`)
        let scheduler = args.scheduler || job?.scheduler || 'lsf'
        // wait_sec (D-004): 0 keeps the single-snapshot contract; a positive
        // value re-polls every WAIT_GAP_MS until a terminal state or the
        // deadline, returning the LAST payload (shape unchanged). The blocking
        // call is the window where the session card live-updates: the card
        // polls this call's published frames (core/pollframes.js) at its 5 s
        // client cadence, so the tick gap IS the card's freshness.
        const waitSec = Math.max(0, Math.min(Number(args.wait_sec) || 0, 600))
        if (scheduler === 'local') {
          // Local submission: the run directory IS the truth — read the shared
          // ladder (sweep_progress.json -> .worker_started -> .batch_job.json
          // -> sweep_config.json), same wait loop, no ssh.
          const frame = await pollUntilTerminal({
            waitSec, signal: turnSignal,
            isTerminal: (f) => TERMINAL_POLL_STATES.has(f.state),
            tick: () => localPollFrame(runDir),
          })
          return {
            ok: true,
            job_id: jobId,
            run_dir: runDir,
            scheduler: 'local',
            fetched: [], // nothing to pull: everything already lives in the run directory
            // ... and say so: an empty list reads as "no result files" otherwise
            fetched_note: 'scheduler=local: no transfer — the result files already live in run_dir',
            ...(overlayWarnings.length ? { warnings: overlayWarnings } : {}),
            ...frame,
          }
        }
        // Remote-side channel mirrors the submit matrix: an in-cluster LSF job
        // (no machine in the job file) polls locally — bjobs and the progress
        // files live on this host's shared filesystem; everything else polls
        // over ssh on the job's machine. cluster_env falls back to the
        // session-project settings (AGENTS.md-overlaid, D-002).
        const inCluster = (job?.cluster_env ?? settings.cluster_env) === 'in-cluster'
        const sshExec = scheduler === 'ssh' || !inCluster
        // D-004 shared source: while this call ticks, the session card polls
        // /api/progress-remote with this call's exec.callId and is served the
        // frames published below straight from memory (core/pollframes.js) —
        // one poller, every reader. The entry lives exactly as long as the
        // call (the finally deletes it whatever the outcome), so a settled or
        // replayed card misses and falls back to the endpoint's own poll; a
        // host that hands down no callId skips the store entirely — same
        // fallback, the feature degrades without a trace.
        const callId = exec?.callId ?? null
        try {
          if (callId) {
            // Seed at dispatch, before the first tick: the 0/N submitted frame
            // off the job record (the job-file ladder's own total source), so
            // the card's first fetch — milliseconds in — already hits memory.
            setPollFrame(callId, runDir, {
              state: 'submitted', job_state: 'submitted',
              total: Number(job?.total_points) || totalFromConfig(runDir) || 0,
              completed: 0, succeeded: 0, failed: 0,
            })
          }
          let target
          if (!sshExec) {
            const root = String(args.remote_root || job?.remote_root || '').trim().replace(/\\/g, '/')
            if (!root || !root.startsWith('/')) {
              throw new Error('remote_root is required (the absolute shared-filesystem root — pass it or re-submit so the job file records it)')
            }
            target = { alias: null, remoteRoot: root }
          } else {
            const machineId = args.machine_id || job?.machine_id || undefined
            target = await resolveMachine(ctx, machineId, args.remote_root || job?.remote_root)
          }
          // D-004: turnSignal rides the poll execs and the terminal fetch —
          // read-only calls, so an abort settles at once and leaves nothing.
          const channel = buildChannel(ctx, { alias: target.alias, inCluster, signal: turnSignal })
          const remoteDir = resolveRemoteDir(target.remoteRoot, args.remote_dir || job?.remote_dir)
          const command = pollCommand({ remoteDir, jobId, scheduler })
          let stdout = ''
          const parsed = await pollUntilTerminal({
            waitSec, signal: turnSignal,
            isTerminal: (p) => TERMINAL_POLL_STATES.has(p.state),
            tick: async () => {
              const r = await channel.exec(command, { timeoutMs: 30_000 })
              if (!r.ok) throw new Error(`poll failed: ${(r.stderr || r.stdout || r.text).slice(0, 800)}`)
              stdout = r.stdout || ''
              const frame = parsePollOutput(r.stdout, { total: job?.total_points })
              // publish the fresh frame for the card's zero-exec reads
              if (callId) setPollFrame(callId, runDir, frame)
              return frame
            },
          })
          // Terminal state: absorb the old fetch — pull the light result files
          // straight down per file (existence probed once, no archive). The
          // probe must tolerate MISSING files: ls exits 2 when any listed name
          // is absent (errlog.txt only exists on a failed run — the green-run
          // norm), and that nonzero exit used to skip the whole fetch, so
          // sweep_progress.json never landed locally on a clean run (found
          // 2026-11-25 while verifying the D-003 telemetry harvest; the
          // trailing true keeps the exit code 0, stdout still lists only what
          // exists).
          const fetched = []
          if (TERMINAL_POLL_STATES.has(parsed.state)) {
            const probe = await channel.exec(
              `cd ${shq(remoteDir)} && ls -1 ${AUTO_FETCH_FILES.map(shq).join(' ')} 2>/dev/null; true`,
              { timeoutMs: 30_000 })
            if (probe.ok) {
              for (const name of String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim())) {
                if (!AUTO_FETCH_FILES.includes(name)) continue
                const dl = await channel.download(remoteJoin(remoteDir, name), path.join(runDir, name))
                if (dl.ok) fetched.push(name)
              }
            }
          }
          return {
            ok: true,
            job_id: jobId,
            remote_dir: remoteDir,
            scheduler,
            ...parsed,
            fetched,
            output: (stdout || '').trim().slice(0, 1500),
            ...(overlayWarnings.length ? { warnings: overlayWarnings } : {}),
          }
        } finally {
          // the store entry dies with the call: settled cards fall back to
          // the endpoint's own poll
          if (callId) deletePollFrame(callId)
        }
      },
    },
  ]
}
