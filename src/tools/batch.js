// Generic batch tools: submit a worker script through LSF (bsub), run it on a
// node over ssh (scheduler=ssh, foreground), or run it on THIS host as a
// detached background process (scheduler=local — batch_poll then reads the
// run directory's own files). Scheduler semantics follow the project's working
// environment (cluster_env, D-002): out-of-cluster every remote operation
// crosses dsh-ssh; in-cluster bsub runs on THIS host (the official ctx.shell
// seam) and file "transfers" are local copies on the shared filesystem —
// scheduler=ssh still executes over ssh, on any other node. Then poll
// (auto-retrieving the light result files on completion) — nothing in this
// file names a simulator; a Spectre run is just a worker choice, and the
// worker tree comes from the workspace sim_scripts_dir (see ../batch.js).
//
// Cluster toolchain pins (D-016): the project settings name the executables
// this channel launches on the cluster side by ABSOLUTE path —
// settings.remote_python (the worker interpreter) and settings.remote_spectre_cmd
// (the spectre executable the bundled worker drives). null = unpinned, the
// bare defaults apply. The pins bind every scheduler the same way, so the
// self-check (which enters through batch_submit) verifies exactly the pair a
// session later runs with.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readJsonIfExists, resolveDir } from '../py.js'
import { callTool, downloadFile, execRemote, resolveMachine, shq, uploadFile } from '../remote.js'
import { execLocal, localCopy } from '../localchannel.js'
import { readRunProgress, totalFromConfig } from '../progress_files.js'
import { findProjectRoot, normalizePin, readSettingsFor } from '../server/settings.js'
import {
  DEFAULT_REMOTE_PYTHON, TERMINAL_POLL_STATES, buildSshCommand, buildSubmitCommand,
  classifyBjobsState, collectRunFiles,
  defaultRemoteScriptsDir, nextSimDir, parseJobId, parsePollOutput, pluginAssets, pluginScripts,
  pollCommand, postSubmitCommand, readJob, remoteJoin,
  resolveRemoteDir, sanitizeRel, submitScriptsRoot, templateUploadPlan, writeJob,
} from '../batch.js'

// The fixed light-result set a terminal poll pulls straight down (2026-11-23:
// poll absorbed fetch — no includes, no archive; raw psf/sp data stays remote
// by design, deep analysis runs on the host that holds it).
const AUTO_FETCH_FILES = ['sweep_progress.json', 'errlog.txt']

// batch_poll wait_sec cadence (D-008): the gap between re-polls of a blocking
// wait. 10 s matches the wait policy's preferred first-backoff step.
const WAIT_GAP_MS = 10_000

// The session-level scan-size ceiling (D-019): the calling session's
// "Max points per scan" field, defaulting to 100. Fail-open — a missing
// session entry or an unreadable store never blocks a submit.
const DEFAULT_MAX_POINTS_PER_SCAN = 100

async function maxPointsPerScan(runDir, sessionId) {
  try {
    if (!sessionId) return DEFAULT_MAX_POINTS_PER_SCAN
    const root = findProjectRoot(runDir)
    if (!root) return DEFAULT_MAX_POINTS_PER_SCAN
    const { readSessionConfigs } = await import('../server/project.js')
    const store = await readSessionConfigs(root)
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
// (D-016) apply here: the pinned interpreter spawns the worker, the pinned
// spectre rides as --spectre-cmd for the bundled worker.
async function submitLocal(args, runDir, settings) {
  const rawWorker = String(args.worker)
  if (rawWorker.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawWorker)) {
    throw new Error('scheduler=local needs a scripts-root-relative worker (e.g. "spectre/spectre_sweep_worker.py"), not an absolute path')
  }
  const rel = sanitizeRel(rawWorker)
  const workerAbs = path.join(submitScriptsRoot(args.sim_scripts_dir, runDir), ...rel.split('/'))
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
      description: 'Submit a batch through the suite\'s worker scripts under one of three schedulers, with '
        + 'semantics set by the project\'s working environment (read the cluster_env row of the project\'s AGENTS.md '
        + 'config block — .harnessams/ is plugin storage, do not read it). scheduler="local" runs the worker on THIS host detached and returns '
        + 'immediately — poll with batch_poll (in-cluster only; an out-of-cluster host cannot run it). '
        + 'scheduler="lsf" (default) runs it under bsub: in-cluster bsub runs right on this host and the run '
        + 'directory stages as a local copy on the shared filesystem; out-of-cluster the directory and the worker '
        + 'scripts tree (the workspace sim_scripts_dir) upload to a dsh-ssh host and bsub runs there. '
        + 'scheduler="ssh" runs the worker directly on the target host in the foreground and waits for it '
        + '(out-of-cluster: the ssh node itself, a second hop goes through the dsh-ssh proxy config; in-cluster: '
        + 'any other node — files never cross ssh). The worker path is scripts-root-relative (e.g. '
        + '"spectre/spectre_sweep_worker.py") or absolute on the target; worker_args are passed through. Writes '
        + '.batch_job.json in the run directory for batch_poll. Rejects a scan whose total point count (from '
        + 'sweep_config.json) exceeds the calling session\'s Max points per scan field (default 100) — split the '
        + 'grid into multiple batches instead.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Local run directory (holds template and sweep_config.json)' },
        remote_dir: { type: 'string', description: 'Remote batch directory: absolute, or relative to remote_root. '
          + 'Omit to auto-generate the next Sim<N>_<YYYYMMDD>_batch<M> directory under <remote_root>/RawResults '
          + '(the D-006 raw-simulation-data convention; mirror the same name locally under <project>/RawResults). '
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
        sim_scripts_dir: { type: 'string', description: 'Worker scripts root: an existing directory IS the root (override); any other value only anchors the '
          + 'project walk-up (default: the project\'s workspace_config.json workspace.sim_scripts_dir, found by walking up from run_dir)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Run-dir files to upload (default: top-level regular files)' },
        queue: { type: 'string', description: 'LSF queue (default normal)' },
        scheduler: { type: 'string', enum: ['lsf', 'ssh', 'local'],
          description: 'local runs the worker on THIS host in the background (in-cluster only); lsf (default) '
            + 'submits through bsub (locally in-cluster, on the target host out-of-cluster); ssh runs it directly '
            + 'on the target host (foreground, no LSF) and waits for it to finish' },
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
      },
      async execute(args, exec) {
        const runDir = resolveDir(args.run_dir)
        // Session scan-size gate (D-019): reads sweep_config.json and rejects
        // an oversized grid before anything is staged or uploaded. Splits the
        // scan into multiple Sim batches instead of one mega-run.
        const totalScanPoints = totalFromConfig(runDir)
        if (totalScanPoints > 0) {
          const sid = typeof exec?.agent?.id === 'string' && exec.agent.id ? exec.agent.id : null
          const limit = await maxPointsPerScan(runDir, sid)
          if (totalScanPoints > limit) {
            throw new Error(`scan exceeds the session's max points per scan: ${totalScanPoints} > ${limit}`
              + ' — split the parameter grid into multiple batches (auto Sim naming)'
              + " or raise the session's Max points per scan field")
          }
        }
        // Netlist pre-check (D-020): the SmartAnaSim spectre_pre_check tool
        // validates the hand-written run directory before anything is staged —
        // the check families and the check-param chain live there (pure JS, so
        // this path needs no local python). Fail-closed on errors (fix the
        // netlist, or consciously re-submit with no_pre_check: true), fail-open
        // when the tool is not registered, warnings ride along into the result.
        const preCheckWarnings = []
        if (args.no_pre_check !== true) {
          if (!ctx.tools?.get?.('spectre_pre_check')) {
            preCheckWarnings.push('spectre_pre_check is not registered — netlist content checks skipped '
              + '(install/enable the SmartAnaSim plugin)')
          } else {
            const preArgs = { run_dir: args.run_dir }
            const sid = typeof exec?.agent?.id === 'string' && exec.agent.id ? exec.agent.id : null
            if (sid) preArgs.session_id = sid
            const pre = await callTool(ctx, 'spectre_pre_check', preArgs, { timeoutMs: 30_000 })
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
        // Channel matrix (D-002): the project's cluster_env picks the semantics.
        // Out-of-cluster every remote operation crosses dsh-ssh; in-cluster
        // bsub runs on THIS host (the official ctx.shell seam) and "transfers"
        // are local copies on the shared filesystem — scheduler=ssh still
        // executes over ssh, on any other node.
        const settings = readSettingsFor(runDir)
        const inCluster = settings.cluster_env === 'in-cluster'
        if (scheduler === 'local') {
          if (!inCluster) {
            throw new Error('scheduler=local requires cluster_env=in-cluster (an out-of-cluster host cannot run '
              + 'the worker — use scheduler="ssh" or "lsf")')
          }
          const local = await submitLocal(args, runDir, settings)
          local.warnings = [...preCheckWarnings, ...(local.warnings || [])]
          return local
        }
        // Toolchain pins (D-016): resolved and validated BEFORE anything is
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
        const channel = {
          alias: target.alias,
          exec: sshExec
            ? (command, opts) => execRemote(ctx, target.alias, command, opts)
            : (command, opts) => execLocal(ctx, command, opts),
          upload: !inCluster
            ? (localPath, remotePath) => uploadFile(ctx, target.alias, localPath, remotePath)
            : localCopy,
          download: !inCluster
            ? (remotePath, localPath) => downloadFile(ctx, target.alias, remotePath, localPath)
            : localCopy,
        }
        let remoteDir
        if (args.remote_dir) {
          remoteDir = resolveRemoteDir(target.remoteRoot, args.remote_dir)
        } else {
          // Auto Sim<N>_<YYYYMMDD>_batch<M> under <remote_root>/RawResults
          // (D-006, 2026-11-21): list once and pick the next free name per the
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

        const sweepConfig = readJsonIfExists(path.join(runDir, 'sweep_config.json'))
        const files = templateUploadPlan(runDir,
          collectRunFiles(runDir, args.files), sweepConfig)

        if (syncScripts) {
          const scriptsRootLocal = submitScriptsRoot(args.sim_scripts_dir, runDir)
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
          // Foreground mode: no bsub, no queue — run the worker on the target
          // node and wait for it, exactly like an interactive run. The
          // execution crosses ssh; in-cluster the staging itself stayed a
          // local copy (only out-of-cluster uploads over sftp). poll/fetch
          // still work through the recorded job file (batch_poll
          // scheduler=ssh reads the progress files).
          const command = buildSshCommand({
            remoteDir,
            python: remotePython,
            workerPath: remoteWorker,
            workerArgs,
            overwrite: args.overwrite === true,
          })
          const ran = await channel.exec(command, { timeoutMs: 600_000 })
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
          if (!ran.ok) {
            throw new Error(`ssh run failed (exit ${ran.exitCode}): `
              + `${(ran.stderr || ran.stdout || ran.text || '').slice(0, 1200)}`)
          }
          return {
            ok: true,
            job_id: jobId,
            state: 'completed',
            scheduler: 'ssh',
            remote_dir: remoteDir,
            scripts_dir: scriptsRoot,
            warnings: preCheckWarnings,
            job_file: path.join(runDir, '.batch_job.json'),
            output: (ran.stdout || '').trim().slice(0, 4000),
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
        + 'executing side by design (analyze it there and pull back compact results). The machine, directory and '
        + 'job id default to <run_dir>/.batch_job.json. A local submission (scheduler="local") is polled from the '
        + 'run directory\'s own files, no ssh involved — a worker that died reads as failed and carries its stderr '
        + 'tail. An in-cluster LSF submission polls locally (bjobs on this host); everything else polls over ssh. '
        + 'Pass wait_sec for a bounded blocking wait — the in-flight call is the '
        + 'window where the session progress card live-updates.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Local run directory holding .batch_job.json' },
        machine_id: { type: 'string', description: 'Override the dsh-ssh host alias from the job file' },
        remote_root: { type: 'string', description: 'Override the fencing remote root (default: the job file\'s remote_root)' },
        remote_dir: { type: 'string', description: 'Override the remote batch directory' },
        job_id: { type: 'string', description: 'Override the job id' },
        scheduler: { type: 'string', enum: ['lsf', 'ssh', 'local'], description: 'lsf (default) checks bjobs; ssh relies on the batch progress files; local reads the run directory itself' },
        wait_sec: { type: 'integer', description: 'Bounded blocking wait: re-poll (~10 s apart) until a terminal state '
          + '(completed/failed/partial) or this many seconds elapse (capped at 600), then return the last payload. '
          + 'Default 0 = single snapshot, the original contract' },
      },
      async execute(args, exec) {
        const runDir = resolveDir(args.run_dir)
        const job = readJob(runDir)
        const jobId = args.job_id || job?.job_id
        if (!jobId) throw new Error('no job id: pass job_id or run batch_submit first')
        if (!/^[\w.-]+$/.test(jobId)) throw new Error(`invalid job_id ${JSON.stringify(jobId)} (word/dot/dash only — it is joined into local paths)`)
        let scheduler = args.scheduler || job?.scheduler || 'lsf'
        // wait_sec (D-008): 0 keeps the single-snapshot contract; a positive
        // value re-polls every WAIT_GAP_MS until a terminal state or the
        // deadline, returning the LAST payload (shape unchanged). The blocking
        // call is the window where the session card live-updates (the remote
        // progress source polls at 5 s client-side).
        const waitSec = Math.max(0, Math.min(Number(args.wait_sec) || 0, 600))
        const deadline = Date.now() + waitSec * 1000
        if (scheduler === 'local') {
          // Local submission: the run directory IS the truth — read the shared
          // ladder (sweep_progress.json -> .worker_started -> .batch_job.json
          // -> sweep_config.json), same wait loop, no ssh.
          let frame
          for (;;) {
            frame = localPollFrame(runDir)
            if (!waitSec || TERMINAL_POLL_STATES.has(frame.state)) break
            const remain = deadline - Date.now()
            if (remain <= 0) break
            await new Promise((res) => setTimeout(res, Math.min(WAIT_GAP_MS, remain)))
          }
          return {
            ok: true,
            job_id: jobId,
            run_dir: runDir,
            scheduler: 'local',
            fetched: [], // nothing to pull: everything already lives in the run directory
            // ... and say so: an empty list reads as "no result files" otherwise
            fetched_note: 'scheduler=local: no transfer — the result files already live in run_dir',
            ...frame,
          }
        }
        // Remote-side channel mirrors the submit matrix: an in-cluster LSF job
        // (no machine in the job file) polls locally — bjobs and the progress
        // files live on this host's shared filesystem; everything else polls
        // over ssh on the job's machine.
        const settings = readSettingsFor(runDir)
        const inCluster = (job?.cluster_env ?? settings.cluster_env) === 'in-cluster'
        const sshExec = scheduler === 'ssh' || !inCluster
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
        const channel = {
          exec: sshExec
            ? (cmd, opts) => execRemote(ctx, target.alias, cmd, opts)
            : (cmd, opts) => execLocal(ctx, cmd, opts),
          download: !inCluster
            ? (remotePath, localPath) => downloadFile(ctx, target.alias, remotePath, localPath)
            : localCopy,
        }
        const remoteDir = resolveRemoteDir(target.remoteRoot, args.remote_dir || job?.remote_dir)
        const command = pollCommand({ remoteDir, jobId, scheduler })
        let parsed
        let stdout = ''
        for (;;) {
          const r = await channel.exec(command, { timeoutMs: 30_000 })
          if (!r.ok) throw new Error(`poll failed: ${(r.stderr || r.stdout || r.text).slice(0, 800)}`)
          parsed = parsePollOutput(r.stdout, { total: job?.total_points })
          stdout = r.stdout || ''
          if (!waitSec || TERMINAL_POLL_STATES.has(parsed.state)) break
          const remain = deadline - Date.now()
          if (remain <= 0) break
          await new Promise((res) => setTimeout(res, Math.min(WAIT_GAP_MS, remain)))
        }
        // Terminal state: absorb the old fetch — pull the light result files
        // straight down per file (existence probed once, no archive). The
        // probe must tolerate MISSING files: ls exits 2 when any listed name
        // is absent (errlog.txt only exists on a failed run — the green-run
        // norm), and that nonzero exit used to skip the whole fetch, so
        // sweep_progress.json never landed locally on a clean run (found
        // 2026-11-25 while verifying the D-017 telemetry harvest; the
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
        }
      },
    },
  ]
}
