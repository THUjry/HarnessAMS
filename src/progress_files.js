// Run-directory progress readers shared by the server progress endpoints
// (server/progress.js) and the batch tools' local poll branch (tools/batch.js)
// — the single implementation of the sweep_progress.json / .worker_started /
// .batch_job.json / sweep_config.json reading ladder (D-002 single-copy rule).
// Pure file reads — nothing here starts or stops a simulation.
import fs from 'node:fs'
import path from 'node:path'

// Tolerant JSON read: strip a UTF-8 BOM before parsing. The worker writes these
// files atomically without a BOM, but hand-copied fixtures may carry one.
function readJsonTolerant(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
}

// Planned point count from sweep_config.json — the same cross-product rule as
// the worker's combination generator (zip takes the first list's length).
export function totalFromConfig(runDir) {
  const cfg = readJsonTolerant(path.join(runDir, 'sweep_config.json'))
  const params = cfg?.parameters
  if (!params || typeof params !== 'object') return null
  const lists = Object.values(params).filter(Array.isArray)
  if (!lists.length) return null
  if (cfg.sweep_mode === 'zip') return lists[0]?.length ?? null
  return lists.reduce((n, l) => n * l.length, 1)
}

// Project root from a run-dir string ("<root>/sweep/RoundN/top" or the Sim
// convention "<root>[.../sweep|/RawResults]/Sim<N>_<date>_batch<M>"), null when
// the shape does not match. String-level, so POSIX remote paths derive
// identically (existence is checked separately).
export function projectRootOf(p) {
  const norm = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const m = /(.+)\/sweep\/Round[^/]+\/top$/.exec(norm)
  if (m) return m[1]
  const s = /(.+)\/Sim\d+_\d{8}_batch\d+$/.exec(norm)
  if (s) {
    let cut = s[1]
    for (const base of ['/sweep', '/RawResults']) {
      if (cut.endsWith(base)) cut = cut.slice(0, -base.length)
    }
    return cut || null
  }
  return null
}

// Liveness of a scheduler=local worker (tools/batch.js submitLocal records the
// spawned pid in the job file): true while the process exists, false once it
// is gone, null when there is nothing to check (no local job / no pid).
function localWorkerAlive(dir) {
  const job = readJsonTolerant(path.join(dir, '.batch_job.json'))
  if (!job || job.scheduler !== 'local') return null
  const pid = Number.isInteger(job.pid) && job.pid > 0 ? job.pid : null
  if (!pid) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM' ? true : false
  }
}

// Point directories that already hold a point_meta.json — the completion rule
// the remote poll applies (every point meta present == done).
function countPointMetas(dir) {
  let n = 0
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      try {
        if (fs.statSync(path.join(dir, ent.name, 'point_meta.json')).isFile()) n += 1
      } catch { /* no meta in this directory */ }
    }
  } catch { /* unreadable directory */ }
  return n
}

// One run directory, normalized for the card / the local poll branch. Source
// ladder: sweep_progress.json (live counters, may lack `simulator` in
// pre-2026-10 files) -> .worker_started (worker announced total_points, first
// progress tick still ~30 s out) -> .batch_job.json (a batch was submitted for
// this run dir — the immediate 0/N first frame while everything still lives
// elsewhere, D-007) -> sweep_config.json (assembled but never run) -> nothing
// readable.
//
// A scheduler=local worker is checked for liveness at every level below the
// progress file: it writes its final tick BEFORE exiting, so a dead process
// behind "running"/"submitted" means it died (mid-run / at startup) and the
// ladder says failed instead of reporting motion forever — a blocking poll
// would otherwise burn its whole wait_sec on a corpse (2026-11-23 instance
// check). Remote batches carry no pid and keep the file-only reading.
export function readRunProgress(runDir) {
  const dir = String(runDir ?? '').trim()
  const st = dir ? fs.statSync(dir, { throwIfNoEntry: false }) : undefined
  if (!st?.isDirectory()) return { local: false, run_dir: dir || null }
  const alive = localWorkerAlive(dir)
  const prog = readJsonTolerant(path.join(dir, 'sweep_progress.json'))
  if (prog && typeof prog === 'object') {
    const total = Number(prog.total_points) || 0
    const completed = Number(prog.completed) || 0
    let status = prog.status ?? null
    if (status === 'running' && alive === false) status = 'failed'
    return {
      local: true,
      run_dir: dir,
      source: 'progress',
      status,
      total,
      completed,
      succeeded: Number(prog.succeeded) || 0,
      failed: Number(prog.failed) || 0,
      pending: Math.max(total - completed, 0),
      simulator: prog.simulator ?? null,
      compute_node: prog.compute_node ?? null,
      updated_at: prog.updated_at ?? null,
    }
  }
  // The worker's own startup-error log (config/template/simulator classes):
  // wherever it exists below the progress file, the run failed — the same
  // rule the remote poll applies.
  const errlogged = fs.existsSync(path.join(dir, 'errlog.txt'))
  const started = readJsonTolerant(path.join(dir, '.worker_started'))
  if (started) {
    const total = Number(started.total_points) || totalFromConfig(dir)
    return {
      local: true,
      run_dir: dir,
      source: 'worker_started',
      status: alive === false || errlogged ? 'failed' : 'running',
      total: total ?? null,
      completed: 0,
      succeeded: 0,
      failed: 0,
      pending: total ?? null,
      simulator: null,
      compute_node: started?.host ?? null,
      updated_at: started?.started_at ?? null,
    }
  }
  // A submitted batch, nothing mirrored locally yet: the job file the submit
  // wrote carries total_points + submitted_at — an immediate 0/N submitted
  // frame with zero transfer cost. A fetched sweep_progress.json (level 1)
  // outranks this, so a mirror never regresses to "submitted".
  const job = readJsonTolerant(path.join(dir, '.batch_job.json'))
  if (job) {
    const total = Number(job.total_points) || totalFromConfig(dir) || null
    let status = 'submitted'
    let completed = 0
    let failed = 0
    if (alive === false) {
      // Gone before anything readable landed: a startup death (bad arguments,
      // a missing dependency) — unless a worker outside the progress protocol
      // still produced every point meta (completed, by the point_meta rule).
      const metas = countPointMetas(dir)
      if (total && metas >= total) { status = 'completed'; completed = metas } else {
        status = 'failed'
        failed = Math.max(Number(total) || 0, 0)
      }
    } else if (errlogged) {
      status = 'failed'
    }
    return {
      local: true,
      run_dir: dir,
      source: 'job',
      status,
      total,
      completed,
      succeeded: completed,
      failed,
      pending: total == null ? null : Math.max(total - completed - failed, 0),
      simulator: null,
      compute_node: null,
      updated_at: job.submitted_at ?? null,
    }
  }
  const cfgTotal = totalFromConfig(dir)
  return {
    local: true,
    run_dir: dir,
    source: 'config',
    status: cfgTotal ? 'pending' : null,
    total: cfgTotal ?? null,
    completed: 0,
    succeeded: 0,
    failed: 0,
    pending: cfgTotal ?? null,
    simulator: null,
    compute_node: null,
    updated_at: null,
  }
}
