// Generic batch tools: submit a worker script through LSF (bsub), run it
// directly on the remote host (scheduler=direct, the node-local foreground
// mode), or run it on THIS host as a detached background process
// (scheduler=local — batch_poll then reads the run directory's own files).
// Then poll (auto-retrieving the light result files on completion) — nothing
// in this file names a simulator; a Spectre run is just a worker choice, and
// the worker tree comes from the workspace sim_scripts_dir (see ../batch.js).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readJsonIfExists, resolveDir } from '../py.js'
import { downloadFile, execRemote, resolveMachine, shq, uploadFile } from '../remote.js'
import { readRunProgress, totalFromConfig } from '../progress_files.js'
import {
  DEFAULT_REMOTE_PYTHON, TERMINAL_POLL_STATES, buildDirectCommand, buildSubmitCommand,
  collectRunFiles,
  defaultRemoteScriptsDir, nextSimDir, parseJobId, parsePollOutput, pluginScripts,
  pollCommand, postSubmitCommand, readJob, remoteJoin,
  resolveRemoteDir, sanitizeRel, simScriptsDir, templateUploadPlan, writeJob,
} from '../batch.js'

// The fixed light-result set a terminal poll pulls straight down (2026-11-23:
// poll absorbed fetch — no includes, no archive; raw psf/sp data stays remote
// by design, deep analysis runs on the host that holds it).
const AUTO_FETCH_FILES = ['sweep_progress.json', 'errlog.txt']

// batch_poll wait_sec cadence (D-016): the gap between re-polls of a blocking
// wait. 10 s matches the wait policy's preferred first-backoff step.
const WAIT_GAP_MS = 10_000

function underRoot(root, candidate) {
  return candidate === root || candidate.startsWith(root + '/')
}

// scheduler=local: spawn the worker on THIS host detached (stdio to
// .batch_local.out/.err inside the run directory), record the same job file,
// and return immediately — the model then batch_poll's the run directory
// (wait_sec for the blocking wait; the session card live-updates off the same
// files). The worker carries its own global budget, so a forgotten run still
// terminates by itself.
function submitLocal(args, runDir) {
  const rawWorker = String(args.worker)
  if (rawWorker.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawWorker)) {
    throw new Error('scheduler=local needs a scripts-root-relative worker (e.g. "spectre/spectre_sweep_worker.py"), not an absolute path')
  }
  const rel = sanitizeRel(rawWorker)
  const workerAbs = path.join(simScriptsDir(args.sim_scripts_dir ?? runDir), ...rel.split('/'))
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

  const workerArgs = (args.worker_args || []).map(String)
  if (!workerArgs.includes('--work-dir')) workerArgs.push('--work-dir', runDir)
  const out = fs.openSync(path.join(runDir, '.batch_local.out'), 'a')
  const err = fs.openSync(path.join(runDir, '.batch_local.err'), 'a')
  let child
  try {
    child = spawn('python', [workerAbs, ...workerArgs], {
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
    remote_python: null,
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
// The per-point digest mirrors the remote poll frames.
function localPollFrame(runDir) {
  const p = readRunProgress(runDir)
  if (!p.local) {
    return { state: 'unknown', job_state: 'local', completed: 0, total: null, points: null }
  }
  const state = p.status === 'completed' ? 'completed'
    : p.status === 'failed' ? 'failed'
      : p.source === 'config' ? 'pending' : 'running'
  let errlog = null
  try {
    errlog = fs.readFileSync(path.join(runDir, 'errlog.txt'), 'utf8').trim().split(/\r?\n/).slice(-5).join('\n') || null
  } catch { /* no errlog yet */ }
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
      description: 'Submit a batch through the suite\'s worker scripts. scheduler="local" (2026-11-23) '
        + 'runs the worker on THIS host as a detached background process and returns immediately — poll with '
        + 'batch_poll (wait_sec for the blocking wait; the session card live-updates off the run directory). '
        + 'scheduler="lsf" (default) uploads the run directory (template + sweep_config.json + metadata) and the '
        + 'worker scripts tree (the workspace sim_scripts_dir) to a dsh-ssh host and runs it under bsub; '
        + 'scheduler="direct" runs it directly on the target host in the foreground. The worker path is '
        + 'scripts-root-relative (e.g. "spectre/spectre_sweep_worker.py") or absolute on the remote; worker_args '
        + 'are passed through. Writes .batch_job.json in the run directory for batch_poll.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Local run directory (holds template and sweep_config.json)' },
        remote_dir: { type: 'string', description: 'Remote batch directory: absolute, or relative to remote_root. '
          + 'Omit to auto-generate the next Sim<N>_<YYYYMMDD>_batch<M> directory under <remote_root>/RawResults '
          + '(the D-012 raw-simulation-data convention; mirror the same name locally under <project>/RawResults). '
          + 'Unused for scheduler="local"' },
        remote_root: { type: 'string', description: 'Absolute remote root that fences remote_dir — the project\'s '
          + 'workspace_config.json settings.remote_root (shown in the AGENTS.md config table). Required unless scheduler="local"' },
        worker: { type: 'string', required: true, description: 'Worker script relative to the scripts root (e.g. spectre/spectre_sweep_worker.py) or an absolute remote path' },
        worker_args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the worker (e.g. --config sweep_config.json --max-parallel 8)' },
        machine_id: { type: 'string', description: 'dsh-ssh host alias (ssh_list / the machine card). Required unless scheduler="local"' },
        remote_python: { type: 'string', description: 'Remote Python executable (default python3; use the full path on clusters)' },
        remote_scripts_dir: { type: 'string', description: 'Remote scripts root (default: <remote_root>/.harnessams/scripts)' },
        sim_scripts_dir: { type: 'string', description: 'Local worker-scripts root override (default: the project\'s workspace_config.json workspace.sim_scripts_dir, found by walking up from run_dir)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Run-dir files to upload (default: top-level regular files)' },
        queue: { type: 'string', description: 'LSF queue (default normal)' },
        scheduler: { type: 'string', enum: ['lsf', 'direct', 'local'],
          description: 'local runs the worker on THIS host in the background; lsf (default) submits it through '
            + 'bsub on the target host; direct runs it directly on the target host (node-local foreground, no LSF) '
            + 'and waits for it to finish' },
        job_name: { type: 'string', description: 'bsub -J name (default hams-<run dir name>)' },
        sync_scripts: { type: 'boolean', description: 'Upload scripts/ to the remote scripts root (default true; pass false after a successful sync)' },
        overwrite: { type: 'boolean', description: 'Allow submitting into a remote directory that already has point_meta.json files. '
          + 'Stale replay markers (.hams_submitted / .hams_direct_done) are cleared first, so a batch that already ran here actually re-runs '
          + '(without this, a completed direct/LSF dir short-circuits to its old result)' },
      },
      async execute(args, exec) {
        const runDir = resolveDir(args.run_dir)
        const scheduler = args.scheduler === 'direct' ? 'direct' : args.scheduler === 'local' ? 'local' : 'lsf'
        if (scheduler === 'local') return submitLocal(args, runDir)
        const target = await resolveMachine(ctx, args.machine_id, args.remote_root)
        let remoteDir
        if (args.remote_dir) {
          remoteDir = resolveRemoteDir(target.remoteRoot, args.remote_dir)
        } else {
          // Auto Sim<N>_<YYYYMMDD>_batch<M> under <remote_root>/RawResults
          // (D-012, 2026-11-21): list once and pick the next free name per the
          // convention. The root itself is probed strictly; a missing
          // RawResults/ subdir is fine (empty list → Sim0_..._batch1, uploads
          // create it); the point_meta probe below still guards collisions.
          const rawBase = `${target.remoteRoot.replace(/\/+$/, '')}/RawResults`
          const ls = await execRemote(ctx, target.alias,
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
          const localWorker = path.join(simScriptsDir(args.sim_scripts_dir ?? runDir), ...workerRel.split('/'))
          if (!fs.existsSync(localWorker)) {
            throw new Error(`worker script not found under the project sim_scripts_dir: ${workerRel} `
              + '(set workspace.sim_scripts_dir in the project\'s .harnessams/workspace_config.json '
              + 'to the SmartAnaSim scripts directory, or pass sim_scripts_dir)')
          }
          remoteWorker = remoteJoin(scriptsRoot, workerRel)
        }

        const probe = await execRemote(ctx, target.alias,
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
          for (const script of pluginScripts(simScriptsDir(args.sim_scripts_dir ?? runDir))) {
            const remote = remoteJoin(scriptsRoot, script.rel)
            const up = await uploadFile(ctx, target.alias, script.local, remote)
            if (!up.ok) throw new Error(`upload failed for ${script.rel}: ${up.text}`)
          }
        }

        for (const file of files) {
          const name = file.uploadName || file.name
          const up = await uploadFile(ctx, target.alias, file.local, remoteJoin(remoteDir, name))
          if (!up.ok) throw new Error(`upload failed for ${name}: ${up.text}`)
        }

        const remotePython = args.remote_python || DEFAULT_REMOTE_PYTHON
        const queue = args.queue || 'normal'
        const jobName = args.job_name || `hams-${path.basename(runDir)}`
        if (scheduler === 'direct') {
          // Node-local foreground mode: no bsub, no queue — run the worker on
          // the machine's login host and wait for it, exactly like an
          // interactive ssh run. poll/fetch still work through the recorded
          // job file (batch_poll scheduler=direct reads the progress files).
          const command = buildDirectCommand({
            remoteDir,
            python: remotePython,
            workerPath: remoteWorker,
            workerArgs: args.worker_args || [],
            overwrite: args.overwrite === true,
          })
          const ran = await execRemote(ctx, target.alias, command, { timeoutMs: 600_000 })
          const jobId = `direct-${Date.now()}`
          const job = {
            machine_id: args.machine_id || target.machine?.id || null,
            machine_name: target.machine?.name || null,
            remote_root: target.remoteRoot,
            remote_dir: remoteDir,
            scripts_dir: scriptsRoot,
            worker: remoteWorker,
            worker_args: args.worker_args || [],
            job_id: jobId,
            queue: null,
            remote_python: remotePython,
            scheduler: 'direct',
            submitted_at: new Date().toISOString(),
            total_points: totalFromConfig(runDir),
          }
          writeJob(runDir, job)
          if (!ran.ok) {
            throw new Error(`direct run failed (exit ${ran.exitCode}): `
              + `${(ran.stderr || ran.stdout || ran.text || '').slice(0, 1200)}`)
          }
          return {
            ok: true,
            job_id: jobId,
            state: 'completed',
            scheduler: 'direct',
            remote_dir: remoteDir,
            scripts_dir: scriptsRoot,
            warnings: [],
            job_file: path.join(runDir, '.batch_job.json'),
            output: (ran.stdout || '').trim().slice(0, 4000),
          }
        }
        const command = buildSubmitCommand({
          remoteDir,
          queue,
          jobName,
          python: remotePython,
          workerPath: remoteWorker,
          workerArgs: args.worker_args || [],
          overwrite: args.overwrite === true,
        })
        const submitted = await execRemote(ctx, target.alias, command, { timeoutMs: 90_000 })
        if (!submitted.ok) {
          throw new Error(`bsub submission failed (exit ${submitted.exitCode}): `
            + `${(submitted.stderr || submitted.stdout || '').slice(0, 1200)}`)
        }
        const jobId = parseJobId(submitted.stdout)
        if (!jobId) {
          throw new Error('bsub did not report a job id: ' + (submitted.stdout || '').slice(0, 800))
        }

        const warnings = []
        const post = await execRemote(ctx, target.alias, postSubmitCommand(remoteDir, jobId),
          { timeoutMs: 30_000 })
        if (!post.ok) warnings.push(`post-submit verification failed: ${(post.stderr || post.text).slice(0, 300)}`)
        if (post.stdout.includes('__ERRLOG__')) {
          warnings.push('remote errlog.txt exists — the worker failed to start (use batch_poll for details)')
        }
        if (!post.stdout.includes('__STARTED__')) {
          warnings.push('no .worker_started marker yet — the job is queued or the worker has not run')
        }

        const job = {
          machine_id: args.machine_id || target.machine?.id || null,
          machine_name: target.machine?.name || null,
          remote_root: target.remoteRoot,
          remote_dir: remoteDir,
          scripts_dir: scriptsRoot,
          worker: remoteWorker,
          worker_args: args.worker_args || [],
          job_id: jobId,
          queue,
          remote_python: remotePython,
          scheduler: 'lsf',
          submitted_at: new Date().toISOString(),
          total_points: totalFromConfig(runDir),
        }
        writeJob(runDir, job)
        return {
          ok: true,
          job_id: jobId,
          state: post.stdout.includes('__STARTED__') ? 'running' : 'submitted',
          remote_dir: remoteDir,
          scripts_dir: scriptsRoot,
          warnings,
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
        + 'errlog.txt) straight into the run directory — no includes, no archive; raw psf/sp data stays remote '
        + 'by design (analyze it there and pull back compact results). The machine, directory and job id default '
        + 'to <run_dir>/.batch_job.json. A local submission (scheduler="local") is polled from the run directory\'s '
        + 'own files, no ssh involved. Pass wait_sec for a bounded blocking wait — the in-flight call is the '
        + 'window where the session progress card live-updates.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Local run directory holding .batch_job.json' },
        machine_id: { type: 'string', description: 'Override the dsh-ssh host alias from the job file' },
        remote_root: { type: 'string', description: 'Override the fencing remote root (default: the job file\'s remote_root)' },
        remote_dir: { type: 'string', description: 'Override the remote batch directory' },
        job_id: { type: 'string', description: 'Override the job id' },
        scheduler: { type: 'string', enum: ['lsf', 'direct', 'local'], description: 'lsf (default) checks bjobs; direct relies on the batch progress files; local reads the run directory itself' },
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
        if (scheduler === 'none') scheduler = 'direct' // 'none' is not a valid scheduler; treat it as direct
        // wait_sec (D-016): 0 keeps the single-snapshot contract; a positive
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
            fetched: [], // everything already lives in the run directory
            ...frame,
          }
        }
        const machineId = args.machine_id || job?.machine_id || undefined
        const target = await resolveMachine(ctx, machineId, args.remote_root || job?.remote_root)
        const remoteDir = resolveRemoteDir(target.remoteRoot, args.remote_dir || job?.remote_dir)
        const command = pollCommand({ remoteDir, jobId, scheduler })
        let parsed
        let stdout = ''
        for (;;) {
          const r = await execRemote(ctx, target.alias, command, { timeoutMs: 30_000 })
          if (!r.ok) throw new Error(`poll failed: ${(r.stderr || r.stdout || r.text).slice(0, 800)}`)
          parsed = parsePollOutput(r.stdout, { total: job?.total_points })
          stdout = r.stdout || ''
          if (!waitSec || TERMINAL_POLL_STATES.has(parsed.state)) break
          const remain = deadline - Date.now()
          if (remain <= 0) break
          await new Promise((res) => setTimeout(res, Math.min(WAIT_GAP_MS, remain)))
        }
        // Terminal state: absorb the old fetch — pull the light result files
        // straight down per file (existence probed once, no archive).
        const fetched = []
        if (TERMINAL_POLL_STATES.has(parsed.state)) {
          const probe = await execRemote(ctx, target.alias,
            `cd ${shq(remoteDir)} && ls -1 ${AUTO_FETCH_FILES.map(shq).join(' ')} 2>/dev/null`,
            { timeoutMs: 30_000 })
          if (probe.ok) {
            for (const name of String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim())) {
              if (!AUTO_FETCH_FILES.includes(name)) continue
              const dl = await downloadFile(ctx, target.alias, remoteJoin(remoteDir, name), path.join(runDir, name))
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
