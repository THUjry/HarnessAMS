// Read-only progress surface behind the session tool cards (client.js SimToolCard,
// the tool.call.toolview slot): one run directory's sweep_progress.json
// (/api/progress) and the cross-batch project summary (/api/progress-summary).
// Pure file reads — the sweep worker rewrites sweep_progress.json every ~30 s
// and drops one NN/point_meta.json per finished point; nothing here starts or
// stops a simulation. Paths are fenced (progressFence below, review D-3
// 2026-11-21): the card passes its sessionId (added to the toolview owner via
// the slot register-inject hook), which must resolve to a registered
// workspace, and every caller-supplied path must stay inside it.
//
// Paths may be remote-shaped POSIX strings (a mirror path only gains the
// progress files after a terminal batch_poll pulls them down); anything not
// present on this host answers { local: false } and the client silently omits
// the progress/aggregate block.
import fs from 'node:fs'
import path from 'node:path'
import { sessionProject } from './project.js'
import { readRunProgress, projectRootOf } from '../progress_files.js'

// The single-run ladder readers live in ../progress_files.js (shared with the
// batch tools' local poll branch); re-exported here for the existing consumers.
export { readRunProgress, projectRootOf } from '../progress_files.js'

const MAX_BATCHES = 64

function statDir(p) {
  return fs.statSync(p, { throwIfNoEntry: false })
}

// Cross-batch summary over <project>/sweep/Round*/top plus the Sim-convention
// run directories (2026-11-21: <project>/Sim*/ and <project>/sweep/Sim*/ — the
// run dir IS the batch). Batches without a readable run directory are skipped
// (half-created rounds are noise, not progress).
export function summarizeProject(projectDir) {
  const root = String(projectDir ?? '').trim()
  const sweepDir = path.join(root, 'sweep')
  const empty = { project_dir: root || null, local: false, batches: [],
    totals: { batches: 0, batches_done: 0, batches_unplanned: 0, sims_total: 0, sims_completed: 0, sims_failed: 0, sims_pending: 0 } }
  if (!root) return empty
  const hasSweep = !!statDir(sweepDir)?.isDirectory()
  const batches = []
  const addBatch = (round, runDir) => {
    if (batches.length >= MAX_BATCHES) return
    if (!statDir(runDir)?.isDirectory()) return
    const p = readRunProgress(runDir)
    batches.push({ round, dir: p.run_dir, source: p.source, status: p.status, total: p.total,
      completed: p.completed, succeeded: p.succeeded, failed: p.failed, pending: p.pending,
      simulator: p.simulator, compute_node: p.compute_node, updated_at: p.updated_at })
  }
  if (statDir(sweepDir)?.isDirectory()) {
    const rounds = fs.readdirSync(sweepDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (/^Round/.test(e.name) || /^Sim\d+_\d{8}_batch\d+$/.test(e.name)))
      .map((e) => e.name)
      .sort((a, b) => (parseInt(a.slice(5), 10) || 0) - (parseInt(b.slice(5), 10) || 0) || a.localeCompare(b))
    for (const round of rounds) {
      addBatch(round, /^Round/.test(round) ? path.join(sweepDir, round, 'top') : path.join(sweepDir, round))
    }
  }
  // Sim convention at the project root and under RawResults/ (D-012, 2026-11-21:
  // raw sim data defaults to <project>/RawResults — the remote batch default and
  // the local fetch-back landing; after the sweep/ entries; a same-named dir
  // under several bases counts once — seen-set dedup)
  if (statDir(root)?.isDirectory()) {
    const seen = new Set(batches.map((b) => b.round))
    for (const base of [path.join(root, 'RawResults'), root]) { // RawResults first: the D-012 canonical sighting wins a same-name dedup
      if (!statDir(base)?.isDirectory()) continue
      const sims = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^Sim\d+_\d{8}_batch\d+$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
      for (const name of sims) {
        if (!seen.has(name)) { seen.add(name); addBatch(name, path.join(base, name)) }
      }
    }
  }
  // Old shape contract: a project with neither a sweep/ directory nor any Sim
  // run dir reports local:false so the card omits the aggregate block quietly.
  if (!hasSweep && !batches.length) return empty
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

// Workspace fence for the two progress endpoints (review D-3, 2026-11-21).
// Anchor: the sessionId. The toolview slot owner carries no sessionId (rc.5
// host client: owner = {callId, toolName, ...call, openFile, cwd, home, ...}),
// so the cards register with `inject: (sessionId) => ({ sessionId })` — the
// official ask_user_question precedent — and pass it here; sessionProject maps
// it through the DSH workspace registry, the same mapping every other
// session-scoped route uses, and runDir/projectDir must stay inside that
// project root. Remote-shaped POSIX strings fail containment on a Windows host
// by construction (path.resolve parks them under the current drive, not the
// workspace) — remote batches poll the local mirror paths once a terminal
// batch_poll has pulled the progress files down.
export function progressFence(registry, params) {
  const sessionId = String(params.get('sessionId') ?? '').trim()
  const { project, reason } = sessionProject(registry, sessionId)
  if (!project) return { code: 400, error: reason }
  const runDir = String(params.get('runDir') ?? '').trim()
  const projectDir = String(params.get('projectDir') ?? '').trim()
  if (!runDir && !projectDir) return { code: 400, error: 'runDir or projectDir is required' }
  if (runDir && !insideRoot(project.path, runDir)) return { code: 403, error: 'runDir escapes the session workspace' }
  if (projectDir && !insideRoot(project.path, projectDir)) return { code: 403, error: 'projectDir escapes the session workspace' }
  return { runDir: runDir || null, projectDir: projectDir || null }
}

// Lexical containment (no realpath — the candidates may not exist yet); the
// relative() form absorbs separator and Windows drive-letter case differences.
function insideRoot(root, target) {
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(target)))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
