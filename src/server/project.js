// Tier 2 — project = DSH workspace: the session-to-workspace mapping over
// ctx.workspaceRegistry (a project is nothing more than a DSH workspace, i.e. a local
// folder; HarnessAMS keeps no workspace concept of its own), and the per-project task
// store at <workspace>/.harnessams/tasks.json. Sessions are deliberately NOT modeled:
// every session of the same workspace sees the same task list.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Resolve the workspace (project) a session belongs to. The registry's sessionIds
// projection is canonical-cwd based; the return value mirrors the DSH workspace record.
// Returns { project: { id, path, title } } or { project: null, reason }.
export function sessionProject(registry, sessionId) {
  if (!registry || typeof registry.list !== 'function') {
    return { project: null, reason: 'workspaceRegistry service unavailable' }
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return { project: null, reason: 'missing sessionId' }
  }
  for (const ws of registry.list()) {
    const ids = ws.sessionIds ?? []
    if (ids.includes(sessionId)) {
      return { project: { id: ws.id, path: ws.path, title: ws.title } }
    }
  }
  return { project: null, reason: 'session is not accounted in any workspace (new session?)' }
}

const TASKS_DIR = '.harnessams'
const TASKS_FILE = 'tasks.json'
const MAX_TASKS = 200
const MAX_NAME = 80
const MAX_DESCRIPTION = 4000
const MAX_REPORTS = 32
const MAX_REPORT_PATH = 400
const ID_RE = /^[\w-]{1,64}$/

// Dashboard reports attached to a task (the sidebar Dashboard sub-view): local
// HTML files picked anywhere on disk via the add-report browser. Paths are
// normalized to absolute here; duplicates by path are dropped within a task.
// Ids follow the task-id pattern and are preserved when well-formed.
function normalizeReports(raw) {
  if (raw === undefined || raw === null) return { reports: [] }
  if (!Array.isArray(raw)) return { error: 'task reports must be an array' }
  if (raw.length > MAX_REPORTS) return { error: `too many reports on a task (max ${MAX_REPORTS})` }
  const out = []
  const seenPath = new Set()
  for (const r of raw) {
    if (!r || typeof r !== 'object') return { error: 'each report must be an object' }
    if (typeof r.path !== 'string' || !r.path.trim()) return { error: 'report path is required' }
    if (!path.isAbsolute(r.path)) return { error: `report path must be absolute: ${r.path}` }
    const p = path.resolve(r.path)
    if (p.length > MAX_REPORT_PATH) return { error: `report path too long (max ${MAX_REPORT_PATH})` }
    if (!/\.html?$/i.test(p)) return { error: `report path must end in .html: ${p}` }
    const key = p.toLowerCase()
    if (seenPath.has(key)) continue
    seenPath.add(key)
    let id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : null
    if (!id || out.some((x) => x.id === id)) id = 'r-' + randomUUID().slice(0, 8)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, MAX_NAME) : path.basename(p)
    const added_at = typeof r.added_at === 'string' && r.added_at ? r.added_at : new Date().toISOString()
    out.push({ id, name, path: p, added_at })
  }
  return { reports: out }
}

export function tasksPath(workspacePath) {
  return path.join(workspacePath, TASKS_DIR, TASKS_FILE)
}

// Read a project's task list; a missing store is an empty list, not an error.
export async function readTasks(workspacePath) {
  const p = tasksPath(workspacePath)
  try {
    const raw = JSON.parse(await fsp.readFile(p, 'utf8'))
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : []
    return { version: raw?.version ?? 1, tasks }
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, tasks: [] }
    throw e
  }
}

// Validate and persist a full task list (the sidebar is the single writer, sending the
// complete list on each change). Ids are preserved when well-formed; new tasks without
// an id get one. created_at is stamped server-side for new tasks.
export async function writeTasks(workspacePath, input) {
  if (!Array.isArray(input)) return { error: 'body must be { "tasks": [...] }' }
  if (input.length > MAX_TASKS) return { error: `too many tasks (max ${MAX_TASKS})` }
  const existing = await readTasks(workspacePath)
  const known = new Map(existing.tasks.map((t) => [t.id, t]))
  const tasks = []
  const seen = new Set()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'each task must be an object' }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return { error: 'task name is required' }
    if (name.length > MAX_NAME) return { error: `task name too long (max ${MAX_NAME})` }
    const description = typeof raw.description === 'string' ? raw.description : ''
    if (description.length > MAX_DESCRIPTION) return { error: `task description too long (max ${MAX_DESCRIPTION})` }
    let id = typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : null
    if (id && known.has(id)) id = known.get(id).id // keep original identity
    if (!id) id = 'task-' + randomUUID().slice(0, 8)
    if (seen.has(id)) return { error: `duplicate task id: ${id}` }
    seen.add(id)
    const rn = normalizeReports(raw.reports)
    if (rn.error) return { error: rn.error }
    // dashboard_selected only survives while it points at one of this task's reports
    const sel = typeof raw.dashboard_selected === 'string' && rn.reports.some((x) => x.id === raw.dashboard_selected)
      ? raw.dashboard_selected
      : null
    tasks.push({
      id,
      name,
      description,
      created_at: (id && known.has(id) && known.get(id).created_at) || new Date().toISOString(),
      ...(rn.reports.length ? { reports: rn.reports, dashboard_selected: sel } : {}),
    })
  }
  const dir = path.join(workspacePath, TASKS_DIR)
  const finalPath = tasksPath(workspacePath)
  await fsp.mkdir(dir, { recursive: true })
  // Atomic replace: the store now has two writers (this sidebar PUT channel and
  // sim_report's report injection) — a torn read must never be observable.
  const tmp = finalPath + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, tasks }, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, finalPath)
  return { tasks }
}

// Remove the task store when a project has no tasks left (keep workspaces clean).
export async function clearTasksIfEmpty(workspacePath) {
  const p = tasksPath(workspacePath)
  try {
    const { tasks } = await readTasks(workspacePath)
    if (tasks.length === 0 && fs.existsSync(p)) await fsp.rm(p)
  } catch { /* best effort */ }
}
