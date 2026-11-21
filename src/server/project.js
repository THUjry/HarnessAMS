// Tier 2 — project = DSH workspace: the session-to-workspace mapping over
// ctx.workspaceRegistry (a project is nothing more than a DSH workspace, i.e. a
// local folder; HarnessAMS keeps no workspace concept of its own), and the
// per-session config store at <workspace>/.harnessams/sessions.json. The task
// concept was retired (2026-11-19, decisions.md D-008): each DSH session IS the
// work unit and carries its own dashboard reports + confirmed check params.
// The legacy tasks.json file (and its v1 sessions.json shape) is deliberately
// left on disk but never read — a v1 store parses as empty (clean break).
import fsp from 'node:fs/promises'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ensureAgentsMdTemplate } from './agentsmd.js'
import { validateCheckParams } from './checkparams.js'

// Resolve the workspace (project) a session belongs to. The registry's sessionIds
// projection is canonical-cwd based; the return value mirrors the DSH workspace record,
// plus `initialized` = the workspace already has a .harnessams store (sessions/
// settings) — the client's sidebar default-open policy keys off it.
// Returns { project: { id, path, title, initialized } } or { project: null, reason }.
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
      let initialized = false
      try { initialized = !!ws.path && fs.existsSync(path.join(ws.path, STORE_DIR)) } catch { initialized = false }
      return { project: { id: ws.id, path: ws.path, title: ws.title, initialized } }
    }
  }
  return { project: null, reason: 'session is not accounted in any workspace (new session?)' }
}

const STORE_DIR = '.harnessams'
const SESSIONS_FILE = 'sessions.json'
const SESSIONS_VERSION = 2
const MAX_SESSION_ENTRIES = 200
const MAX_NAME = 80
const MAX_REPORTS = 32
const MAX_REPORT_PATH = 400
export const SESSION_ID_RE = /^[\w-]{1,128}$/

// Dashboard reports attached to a session (the sidebar Dashboard sub-view): local
// HTML files picked anywhere on disk via the add-report browser, or registered by
// the report tool. Paths are normalized to absolute here; duplicates by
// path are dropped within a session.
function normalizeReports(raw) {
  if (raw === undefined || raw === null) return { reports: [] }
  if (!Array.isArray(raw)) return { error: 'session reports must be an array' }
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
    let id = typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : null
    if (!id || out.some((x) => x.id === id)) id = 'r-' + randomUUID().slice(0, 8)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, MAX_NAME) : path.basename(p)
    const added_at = typeof r.added_at === 'string' && r.added_at ? r.added_at : new Date().toISOString()
    out.push({ id, name, path: p, added_at })
  }
  // count after the path dedupe, matching the writer in tools/gen_report.js
  if (out.length > MAX_REPORTS) return { error: `too many reports on a session (max ${MAX_REPORTS})` }
  return { reports: out }
}

// Validate one session's config state. Returns { state } or { error }. The
// check_params object is validated with the same rules as the retired
// project-level writer (checkparams.js); it is stored only when confirmed.
export function validateSessionState(state) {
  if (state == null) return { state: null }
  if (typeof state !== 'object' || Array.isArray(state)) return { error: 'state must be an object or null' }
  const display = state.display === 'session' || state.display === 'overview' ? state.display : 'overview'
  const rn = normalizeReports(state.reports)
  if (rn.error) return { error: rn.error }
  // dashboard_selected only survives while it points at one of this session's reports
  const dashboard_selected = typeof state.dashboard_selected === 'string'
    && rn.reports.some((x) => x.id === state.dashboard_selected)
    ? state.dashboard_selected
    : null
  let check_params = undefined
  if (state.check_params != null) {
    const v = validateCheckParams(state.check_params)
    if (v.error) return { error: v.error }
    check_params = v.params
  }
  return { state: { display, reports: rn.reports, dashboard_selected, ...(check_params ? { check_params } : {}) } }
}

export function sessionConfigsPath(workspacePath) {
  return path.join(workspacePath, STORE_DIR, SESSIONS_FILE)
}

// Read the per-session config store. A missing file, a corrupt file, or a v1
// store (the task-era {active, display} shape) all parse as empty — v1 entries
// reference task ids that no longer exist, so they are discarded wholesale.
export async function readSessionConfigs(workspacePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(sessionConfigsPath(workspacePath), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== SESSIONS_VERSION) {
      return { sessions: {} }
    }
    const sessions = raw.sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {} }
    const out = {}
    for (const [sid, st] of Object.entries(sessions)) {
      if (!SESSION_ID_RE.test(sid) || !st || typeof st !== 'object') continue
      const v = validateSessionState(st)
      if (v.error) continue // entry-level fail-open: drop malformed siblings
      out[sid] = v.state
    }
    return { sessions: out }
  } catch { return { sessions: {} } } // missing / corrupt -> empty, never throw
}

// Read-modify-write of ONE session's entry (single UI writer, but a stale
// full-file PUT from an old tab would clobber sibling sessions — merge instead).
export async function writeSessionConfig(workspacePath, sessionId, state) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { error: 'bad sessionId' }
  const v = validateSessionState(state)
  if (v.error) return { error: v.error }
  const cur = await readSessionConfigs(workspacePath)
  const sessions = { ...cur.sessions }
  delete sessions[sessionId] // re-insert at the end: insertion order doubles as recency for pruning
  if (v.state != null) sessions[sessionId] = v.state
  let entries = Object.entries(sessions)
  while (entries.length > MAX_SESSION_ENTRIES) entries = entries.slice(1)
  const dir = path.join(workspacePath, STORE_DIR)
  const fresh = !fs.existsSync(dir)
  try {
    await fsp.mkdir(dir, { recursive: true })
    // .harnessams creation moment: lay down the AGENTS.md config-table template
    // (empty table + first-fill instruction; idempotent, never throws).
    if (fresh) await ensureAgentsMdTemplate(workspacePath)
    const tmp = sessionConfigsPath(workspacePath) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify({ version: SESSIONS_VERSION, sessions: Object.fromEntries(entries) }, null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, sessionConfigsPath(workspacePath))
  } catch (e) {
    return { error: 'sessions.json write failed: ' + String(e?.message ?? e) }
  }
  return { sessions: Object.fromEntries(entries) }
}
