// Read-only progress surface behind the session tool cards (client.js SimToolCard,
// the tool.call.toolview slot): one run directory's sweep_progress.json
// (/api/progress) and the cross-batch project summary (/api/progress-summary).
// Pure file reads — the sweep worker rewrites sweep_progress.json every ~30 s
// and drops one NN/point_meta.json per finished point; nothing here starts or
// stops a simulation and nothing is session-scoped (the run dir comes from the
// tool arguments the card already shows).
//
// Paths may be remote-shaped POSIX strings (a mirror path only syncs progress
// files after batch_fetch); anything not present on this host answers
// { local: false } and the client silently omits the progress/aggregate block.
import fs from 'node:fs'
import path from 'node:path'

const MAX_BATCHES = 64

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

function statDir(p) {
  return fs.statSync(p, { throwIfNoEntry: false })
}

// Planned point count from sweep_config.json — the same cross-product rule as
// tools/batch.js totalFromConfig, kept local so the server layer never imports
// the tools layer.
function totalFromConfig(runDir) {
  const cfg = readJsonTolerant(path.join(runDir, 'sweep_config.json'))
  const params = cfg?.parameters
  if (!params || typeof params !== 'object') return null
  const lists = Object.values(params).filter(Array.isArray)
  if (!lists.length) return null
  if (cfg.sweep_mode === 'zip') return lists[0]?.length ?? null
  return lists.reduce((n, l) => n * l.length, 1)
}

// Project root from a run-dir string ("<root>/sweep/RoundN/top"), null when the
// shape does not match. String-level like tools/sim_analysis.js deriveProjectDir, so
// POSIX remote paths derive identically (existence is checked separately).
export function projectRootOf(p) {
  const norm = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const m = /(.+)\/sweep\/Round[^/]+\/top$/.exec(norm)
  return m ? m[1] : null
}

// One run directory, normalized for the card. Source ladder: sweep_progress.json
// (live counters, may lack `simulator` in pre-2026-10 files) → .worker_started
// (worker announced total_points, first progress tick still ~30 s out) →
// sweep_config.json (assembled but never run) → nothing readable.
export function readRunProgress(runDir) {
  const dir = String(runDir ?? '').trim()
  const st = dir ? statDir(dir) : undefined
  if (!st?.isDirectory()) return { local: false, run_dir: dir || null }
  const prog = readJsonTolerant(path.join(dir, 'sweep_progress.json'))
  if (prog && typeof prog === 'object') {
    const total = Number(prog.total_points) || 0
    const completed = Number(prog.completed) || 0
    return {
      local: true,
      run_dir: dir,
      source: 'progress',
      status: prog.status ?? null,
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
  const started = readJsonTolerant(path.join(dir, '.worker_started'))
  const total = (started && Number(started.total_points)) || totalFromConfig(dir)
  return {
    local: true,
    run_dir: dir,
    source: started ? 'worker_started' : 'config',
    status: started ? 'running' : (total ? 'pending' : null),
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

// Cross-batch summary over <project>/sweep/Round*/top. Batches without a `top`
// run directory are skipped (half-created rounds are noise, not progress).
export function summarizeProject(projectDir) {
  const root = String(projectDir ?? '').trim()
  const sweepDir = path.join(root, 'sweep')
  const empty = { project_dir: root || null, local: false, batches: [],
    totals: { batches: 0, batches_done: 0, batches_unplanned: 0, sims_total: 0, sims_completed: 0, sims_failed: 0, sims_pending: 0 } }
  if (!root || !statDir(sweepDir)?.isDirectory()) return empty
  const rounds = fs.readdirSync(sweepDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^Round/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (parseInt(a.slice(5), 10) || 0) - (parseInt(b.slice(5), 10) || 0) || a.localeCompare(b))
  const batches = []
  for (const round of rounds) {
    if (batches.length >= MAX_BATCHES) break
    const runDir = path.join(sweepDir, round, 'top')
    if (!statDir(runDir)?.isDirectory()) continue
    const p = readRunProgress(runDir)
    batches.push({ round, dir: p.run_dir, source: p.source, status: p.status, total: p.total,
      completed: p.completed, succeeded: p.succeeded, failed: p.failed, pending: p.pending,
      simulator: p.simulator, compute_node: p.compute_node, updated_at: p.updated_at })
  }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
  const totals = {
    batches: batches.length,
    batches_done: batches.filter((b) => b.status === 'completed').length,
    batches_unplanned: batches.filter((b) => b.total == null).length,
    sims_total: batches.reduce((n, b) => n + num(b.total), 0),
    sims_completed: batches.reduce((n, b) => n + num(b.completed), 0),
    sims_failed: batches.reduce((n, b) => n + num(b.failed), 0),
    sims_pending: batches.reduce((n, b) => n + num(b.pending), 0),
  }
  return { project_dir: root, local: true, batches, totals }
}

// Route payloads (index.js wires them to the two GET endpoints).
export function progressPayload(runDir) {
  return readRunProgress(runDir)
}

export function progressSummaryPayload({ runDir, projectDir }) {
  const root = projectDir || (runDir ? projectRootOf(runDir) : null)
  if (!root) {
    // Shape does not match sweep/RoundN/top and no explicit project dir — the
    // card omits the aggregate block rather than guessing.
    return { project_dir: null, local: false, batches: [],
      totals: { batches: 0, batches_done: 0, batches_unplanned: 0, sims_total: 0, sims_completed: 0, sims_failed: 0, sims_pending: 0 } }
  }
  return summarizeProject(root)
}
