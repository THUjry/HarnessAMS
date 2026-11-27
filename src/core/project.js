// Tier 2 — project = DSH workspace: the session-to-workspace mapping over
// ctx.workspaceRegistry (a project is nothing more than a DSH workspace, i.e. a
// local folder; HarnessAMS keeps no workspace concept of its own), and the
// per-session config store at <workspace>/.harnessams/sessions.json. The task
// concept was retired (2026-11-19, decisions.md D-005): each DSH session IS the
// work unit and carries its own dashboard reports + confirmed check params.
// The store is VERSIONLESS (D-026): cross-version compatibility is per-field
// validation, not a generation gate — unknown fields ride through reads and
// writes untouched, invalid leaves are SKIPPED with warnings on the read side
// (a next write self-heals them off disk), and the legacy tasks.json file is
// simply never read (a store without a sessions map reads as empty).
import fsp from 'node:fs/promises'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ensureAgentsMdTemplate } from './agentsmd.js'
import { validateCheckParams } from './checkparams.js'
import { atomicWrite } from '../lib/io.js'

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
const MAX_SESSION_ENTRIES = 200
const MAX_NAME = 80
const MAX_REPORTS = 32
const MAX_REPORT_PATH = 400
export const SESSION_ID_RE = /^[\w-]{1,128}$/

// Tool-facing project resolution (D-021 shared helper, extracted from the
// harnessams_selfcheck tool so batch_submit / batch_poll / safe_trash /
// gen_sweep_report anchor the same way): an explicit `project` argument must
// name a registered DSH workspace; otherwise the calling session's mapping
// decides (session_id ≡ exec.agent.id). Errors list the registered candidates
// so the model can self-correct. This is the ONLY project anchor since the
// findProjectRoot walk-ups were deleted — run_dir/spec paths never discover
// the project anymore.
export function resolveProjectTool(registry, sessionId, projectArg) {
  const registered = typeof registry?.list === 'function' ? registry.list() : []
  const candidates = registered.map((w) => w.path).join(', ') || 'none'
  if (projectArg != null) {
    if (typeof projectArg !== 'string' || !projectArg.trim()) {
      return { error: 'project must be a workspace path string' }
    }
    const want = path.resolve(projectArg.trim())
    const hit = registered.find((w) => path.resolve(String(w?.path ?? '')) === want)
    if (!hit) {
      return { error: `project is not a registered workspace: ${projectArg} (registered: ${candidates})` }
    }
    return { project: { id: hit.id, path: hit.path, title: hit.title } }
  }
  const { project, reason } = sessionProject(registry, sessionId)
  if (!project) {
    return { error: `${reason ?? 'no project for session'} (registered: ${candidates})` }
  }
  return { project }
}

// Dashboard reports attached to a session (the sidebar Dashboard sub-view): local
// HTML files picked anywhere on disk via the add-report browser, or registered by
// the report tool. Paths are normalized to absolute here; duplicates by
// path are dropped within a session. STRICT mode (the write path) rejects the
// whole state on the first bad entry ({error}, D-022 PUT contract); LENIENT
// mode (the read path) skips just that entry with a warning. Unknown entry
// fields ride through untouched in BOTH modes — the read-write roundtrip never
// drops future-format fields (D-026 cross-version mechanism).
const REPORT_KNOWN = new Set(['id', 'name', 'path', 'added_at'])

function reportEntryError(r) {
  if (!r || typeof r !== 'object') return 'each report must be an object'
  if (typeof r.path !== 'string' || !r.path.trim()) return 'report path is required'
  if (!path.isAbsolute(r.path)) return `report path must be absolute: ${r.path}`
  const p = path.resolve(r.path)
  if (p.length > MAX_REPORT_PATH) return `report path too long (max ${MAX_REPORT_PATH})`
  if (!/\.html?$/i.test(p)) return `report path must end in .html: ${p}`
  return null
}

function normalizeReports(raw, { lenient = false } = {}) {
  if (raw === undefined || raw === null) return { reports: [] }
  if (!Array.isArray(raw)) {
    return lenient
      ? { reports: [], warnings: ['session reports must be an array — treated as none'] }
      : { error: 'session reports must be an array' }
  }
  const out = []
  const warnings = []
  const seenPath = new Set()
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    const err = reportEntryError(r)
    if (err) {
      if (!lenient) return { error: err }
      warnings.push(`reports[${i}]: ${err} — entry skipped`)
      continue
    }
    const p = path.resolve(r.path)
    const key = p.toLowerCase()
    if (seenPath.has(key)) continue // same-path duplicates are policy, not corruption
    seenPath.add(key)
    let id = typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : null
    if (!id || out.some((x) => x.id === id)) id = 'r-' + randomUUID().slice(0, 8)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, MAX_NAME) : path.basename(p)
    const added_at = typeof r.added_at === 'string' && r.added_at ? r.added_at : new Date().toISOString()
    const rest = {}
    for (const [k, v] of Object.entries(r)) if (!REPORT_KNOWN.has(k)) rest[k] = v
    out.push({ ...rest, id, name, path: p, added_at })
  }
  // count after the path dedupe, matching the writer in tools/gen_report.js
  if (out.length > MAX_REPORTS) {
    if (!lenient) return { error: `too many reports on a session (max ${MAX_REPORTS})` }
    out.length = MAX_REPORTS
    warnings.push(`too many reports on a session (max ${MAX_REPORTS}) — extras skipped`)
  }
  return lenient ? { reports: out, warnings } : { reports: out }
}

// Validate one session's config state — the WRITE-path contract: returns
// { state } or { error }; a known-field violation rejects the write (the
// D-022 PUT 400 face). The read path goes through the same core in lenient
// mode instead (see normalizeSessionState). The check_params object is
// validated with the same rules as the retired project-level writer
// (checkparams.js); it is stored only when confirmed. report_figs is the
// session's own option (the gen_sweep_report PNG gate).
export function validateSessionState(state) {
  const v = normalizeSessionState(state, { lenient: false })
  if (v.warnings && v.warnings.length) return { error: v.warnings[0] }
  return { state: v.state }
}

const SESSION_KNOWN = new Set(['display', 'reports', 'dashboard_selected', 'report_figs', 'max_points_per_scan', 'check_params'])

// Core normalization behind validateSessionState. STRICT mode: the first
// known-field violation becomes the whole-state {error} (via the wrapper).
// LENIENT mode (the read path): invalid LEAVES are dropped with warnings —
// one bad report entry or a stale-shape check_params no longer hides the
// session's other data. Unknown fields ride through both modes untouched
// (D-026). Returns { state, warnings } — warnings is [] in strict mode.
function normalizeSessionState(state, { lenient = false } = {}) {
  if (state == null) return { state: null }
  if (typeof state !== 'object' || Array.isArray(state)) {
    return { warnings: ['state must be an object or null'] }
  }
  const warnings = []
  const display = state.display === 'session' || state.display === 'overview' ? state.display : 'overview'
  const rn = normalizeReports(state.reports, { lenient })
  if (rn.error) return { warnings: [rn.error] }
  if (rn.warnings) warnings.push(...rn.warnings)
  // dashboard_selected only survives while it points at one of this session's reports
  const dashboard_selected = typeof state.dashboard_selected === 'string'
    && rn.reports.some((x) => x.id === state.dashboard_selected)
    ? state.dashboard_selected
    : null
  let check_params = undefined
  if (state.check_params != null) {
    const v = validateCheckParams(state.check_params)
    if (v.error) {
      if (!lenient) return { warnings: [v.error] }
      warnings.push(`check_params: ${v.error} — dropped`)
    } else {
      check_params = v.params
    }
  }
  // the session's "Report figures" option (the gen_sweep_report PNG gate):
  // strictly boolean, stored only when on — absent means off
  if (state.report_figs != null && typeof state.report_figs !== 'boolean') {
    if (!lenient) return { warnings: ['report_figs must be a boolean (on/off switch)'] }
    warnings.push('report_figs must be a boolean (on/off switch) — dropped')
  }
  const report_figs = state.report_figs === true
  // the session's "Max points per scan" option (the batch_submit point-count
  // gate, D-019): positive integer; absent means the built-in default (100)
  if (state.max_points_per_scan != null
      && !(Number.isInteger(state.max_points_per_scan) && state.max_points_per_scan > 0)) {
    if (!lenient) return { warnings: ['max_points_per_scan must be a positive integer'] }
    warnings.push('max_points_per_scan must be a positive integer — dropped')
  }
  const max_points = Number.isInteger(state.max_points_per_scan)
    && state.max_points_per_scan > 0 ? state.max_points_per_scan : null
  const rest = {}
  for (const [k, v] of Object.entries(state)) if (!SESSION_KNOWN.has(k)) rest[k] = v
  return {
    state: {
      display, reports: rn.reports, dashboard_selected,
      ...rest,
      ...(report_figs ? { report_figs: true } : {}),
      ...(max_points ? { max_points_per_scan: max_points } : {}),
      ...(check_params ? { check_params } : {}),
    },
    warnings,
  }
}

export function sessionConfigsPath(workspacePath) {
  return path.join(workspacePath, STORE_DIR, SESSIONS_FILE)
}

// Read the per-session config store — LENIENT (D-026). A missing file is the
// first-run normal (silent); anything unreadable/unparsable reads as empty
// WITH a warning; a legacy `version` key is ignored either way (the store is
// versionless — the task-era shape has no sessions map and reads as empty);
// invalid session keys, entries, and leaves are SKIPPED with warnings instead
// of silently dropped (a skipped entry self-heals off disk on the next write,
// after the warning has been surfaced). Returns { sessions, warnings } —
// consumers destructuring { sessions } are unaffected.
export async function readSessionConfigs(workspacePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(sessionConfigsPath(workspacePath), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { sessions: {}, warnings: ['sessions.json: root is not an object — treated as empty'] }
    }
    const sessions = raw.sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      return { sessions: {}, warnings: ['sessions.json: no sessions map — treated as empty (legacy task-era shape?)'] }
    }
    const out = {}
    const warnings = []
    for (const [sid, st] of Object.entries(sessions)) {
      if (!SESSION_ID_RE.test(sid)) {
        warnings.push(`sessions[${sid}]: key does not match the session id shape — entry skipped`)
        continue
      }
      if (!st || typeof st !== 'object') {
        warnings.push(`sessions[${sid}]: entry is not an object — skipped`)
        continue
      }
      const v = normalizeSessionState(st, { lenient: true })
      for (const w of v.warnings ?? []) warnings.push(`sessions[${sid}]: ${w}`)
      out[sid] = v.state
    }
    return { sessions: out, warnings }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { sessions: {} } // missing store = first-run normal, silent
    return { sessions: {}, warnings: ['sessions.json is not readable or not valid JSON — treated as empty ('
      + String(e?.code ?? e?.message ?? e) + ')'] }
  }
}

// Read-modify-write of ONE session's entry (single UI writer, but a stale
// full-file PUT from an old tab would clobber sibling sessions — merge
// instead). The file is written VERSIONLESS ({ sessions } only, D-026); the
// merge base is the lenient read view, so a skipped entry self-heals off disk
// here and unknown fields survive the roundtrip.
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
    await atomicWrite(sessionConfigsPath(workspacePath),
      JSON.stringify({ sessions: Object.fromEntries(entries) }, null, 2) + '\n')
  } catch (e) {
    return { error: 'sessions.json write failed: ' + String(e?.message ?? e) }
  }
  return { sessions: Object.fromEntries(entries) }
}
