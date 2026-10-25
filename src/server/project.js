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
    tasks.push({
      id,
      name,
      description,
      created_at: (id && known.has(id) && known.get(id).created_at) || new Date().toISOString(),
    })
  }
  const dir = path.join(workspacePath, TASKS_DIR)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(tasksPath(workspacePath), JSON.stringify({ version: 1, tasks }, null, 2) + '\n', 'utf8')
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
