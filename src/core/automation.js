// Per-project automation store + runner (phase-2 automation feature). Two
// artifacts under <workspace>/.harnessams/:
//   automation.json — the task list: entries { key, name, description,
//     created_at, updated_at, created_by_session, files }, where `files` is an
//     ORDERED list of command-file names (the run order).
//   automation/     — the SHARED command library: plain .txt files, FLAT,
//     deliberately decoupled from tasks — one file may back several tasks
//     (cross-task reuse), and a task's `files` list is just references.
// The store follows the sessions.json discipline (D-003): versionless, LENIENT
// read (invalid entries / command names skipped with surfaced warnings,
// unknown fields ride through), STRICT write (the entry being written is
// fully validated; the merge base is the lenient view so a skipped entry
// self-heals off disk on the next write).
// The automation key is minted at creation: the creating session's id (a
// delegated subagent resolves to its topmost user-visible ancestor,
// src/subagent.js — D-003) plus a yymmddhhmmss local stamp; a same-second
// collision gets a numeric suffix.
// Running is deliberately stateless: NO in-memory registry, NO run records —
// a run reads the entry, reads each command file FROM DISK at run time (an
// edited library file needs no re-registration), and executes them
// SEQUENTIALLY through the dsh-ssh exec funnel (channel/remote.js execRemote)
// on the project's settings.machine_id; the whole result returns with the
// call (both the sidebar's POST /api/automation/run and the run_automation
// tool land here). Abort follows the channel contract: the caller's signal
// races the ssh call and rides the batch input (KILL + channel close
// best-effort) — an aborted remote command may orphan; the affected result
// says the remote state is uncertain (D-029 semantics). Post-run behavior is
// a reserved seam: the result payload below is the extension point — nothing
// acts on it beyond the caller's echo yet.
// (covered by tests/automation.test.mjs)
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseJsonBom, atomicWrite } from '../lib/io.js'
import { readSettingsAt } from './settings.js'
import { ensureAgentsMdTemplate } from './agentsmd.js'
import { execRemote } from '../channel/remote.js'

const STORE_DIR = '.harnessams'
const AUTOMATION_FILE = 'automation.json'
const COMMAND_DIR_NAME = 'automation'

const MAX_NAME = 80
const MAX_DESC = 2000
const MAX_COMMANDS = 64
const MAX_CONTENT = 100_000
// per-command remote budget: execRemote turns it into `timeout -s KILL <N>s
// sh -c <command>` remotely, so exit 137 = the deadline, not a failure
const COMMAND_TIMEOUT_MS = 120_000
// stdout/stderr kept per result (the payload rides tool results and the
// sidebar's run dialog — megabyte dumps help nobody)
const MAX_OUTPUT = 20_000

// One command .txt name: a single printable-ASCII segment ending in .txt.
// The library is FLAT under .harnessams/automation/ — no subdirectories, no
// traversal: the name is both the reference key and the file name.
const COMMAND_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.txt$/

// Automation key: creating session id (SESSION_ID_RE shape) + 12-digit stamp
// + optional numeric collision suffix.
const KEY_RE = /^[\w-]{6,160}$/

const ENTRY_KNOWN = new Set(['key', 'name', 'description', 'created_at', 'updated_at', 'created_by_session', 'files'])

// ---- file locations -----------------------------------------------------------

export function automationPath(workspacePath) {
  return path.join(workspacePath, STORE_DIR, AUTOMATION_FILE)
}

export function commandDirPath(workspacePath) {
  return path.join(workspacePath, STORE_DIR, COMMAND_DIR_NAME)
}

// ---- validation ----------------------------------------------------------------

function commandFileError(name) {
  if (typeof name !== 'string' || !name.trim()) return 'command file name is required'
  if (name.length > 84) return `command file name too long (max 84 chars): ${name}`
  if (!COMMAND_FILE_RE.test(name)) {
    return `command file name must be one printable-ASCII .txt segment (flat under automation/, no path separators, no ".."): ${JSON.stringify(name)}`
  }
  return null
}

function commandItemError(item) {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) {
    return 'each command must be an object { file, content? }'
  }
  const ferr = commandFileError(item.file)
  if (ferr) return ferr
  if (item.content != null && (typeof item.content !== 'string' || !item.content.trim())) {
    return `command content must be a non-empty string when present: ${item.file}`
  }
  if (typeof item.content === 'string' && item.content.length > MAX_CONTENT) {
    return `command content too long (max ${MAX_CONTENT} chars): ${item.file}`
  }
  return null
}

// The commands payload of add/update: an ordered list of { file, content? }.
// `content` present = create-or-overwrite the shared file (identical content
// is a no-op); `content` absent = a pure reference — the file must already
// exist (the reuse path). Returns { commands, files } or { error }.
function normalizeCommandsInput(commands) {
  if (!Array.isArray(commands) || commands.length < 1) {
    return { error: 'commands must be a non-empty array of { file, content? } items' }
  }
  if (commands.length > MAX_COMMANDS) return { error: `too many commands (max ${MAX_COMMANDS})` }
  const out = []
  for (const c of commands) {
    const e = commandItemError(c)
    if (e) return { error: e }
    out.push({ file: c.file, content: typeof c.content === 'string' ? c.content : null })
  }
  return { commands: out, files: out.map((c) => c.file) }
}

// STRICT entry validation (the write path): every known field must hold.
// Unknown fields are the caller's business (CRUD copies them from the
// stored entry). Returns { value } or { error }.
function validateEntryInput({ key, name, description, files }) {
  if (key != null && (typeof key !== 'string' || !KEY_RE.test(key))) {
    return { error: `invalid automation key: ${JSON.stringify(key)}` }
  }
  if (name == null || typeof name !== 'string' || !name.trim()) {
    return { error: 'automation name is required (a non-empty string)' }
  }
  if (name.length > MAX_NAME) return { error: `automation name too long (max ${MAX_NAME} chars)` }
  if (description != null && typeof description !== 'string') {
    return { error: 'automation description must be a string' }
  }
  if (description != null && description.length > MAX_DESC) {
    return { error: `automation description too long (max ${MAX_DESC} chars)` }
  }
  if (!Array.isArray(files) || files.length < 1) {
    return { error: 'automation files must be a non-empty array of command file names (the run order)' }
  }
  if (files.length > MAX_COMMANDS) return { error: `too many command references (max ${MAX_COMMANDS})` }
  for (const f of files) {
    const e = commandFileError(f)
    if (e) return { error: e }
  }
  return { value: { key, name: name.trim(), description: String(description ?? '').trim(), files: [...files] } }
}

// ---- store read (LENIENT) ------------------------------------------------------

function restRoot(raw) {
  const rest = {}
  for (const [k, v] of Object.entries(raw)) if (k !== 'automations') rest[k] = v
  return rest
}

function normalizeEntryLenient(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { warning: `automations[${i}]: entry is not an object — skipped` }
  }
  if (typeof raw.key !== 'string' || !KEY_RE.test(raw.key)) {
    return { warning: `automations[${i}]: key does not match the automation key shape — entry skipped` }
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { warning: `automations[${i}]: name is not a non-empty string — entry skipped` }
  }
  const warnings = []
  let files = []
  if (raw.files === undefined || raw.files === null) {
    warnings.push(`automations[${i}]: files is missing — treated as none`)
  } else if (!Array.isArray(raw.files)) {
    warnings.push(`automations[${i}]: files is not an array — treated as none`)
  } else {
    for (const f of raw.files) {
      if (commandFileError(f) == null) files.push(f)
      else warnings.push(`automations[${i}]: bad command file name ${JSON.stringify(String(f))} — dropped`)
    }
  }
  const fallbackStamp = new Date().toISOString()
  const rest = {}
  for (const [k, v] of Object.entries(raw)) if (!ENTRY_KNOWN.has(k)) rest[k] = v
  const entry = {
    ...rest,
    key: raw.key,
    name: raw.name.trim().slice(0, MAX_NAME),
    description: typeof raw.description === 'string' ? raw.description.slice(0, MAX_DESC) : '',
    created_at: typeof raw.created_at === 'string' && raw.created_at ? raw.created_at : fallbackStamp,
    updated_at: typeof raw.updated_at === 'string' && raw.updated_at
      ? raw.updated_at
      : (typeof raw.created_at === 'string' && raw.created_at ? raw.created_at : fallbackStamp),
    ...(typeof raw.created_by_session === 'string' && raw.created_by_session
      ? { created_by_session: raw.created_by_session } : {}),
    files,
  }
  return { entry, warnings }
}

// Read the automation list — LENIENT. A missing file is the no-automations
// normal (silent); unreadable/unparsable reads as empty WITH a warning;
// invalid entries and command names are skipped with surfaced warnings (a
// next write self-heals them off disk); unknown root and entry fields ride
// through. Returns { automations, warnings, rest } — consumers destructuring
// { automations, warnings } are unaffected.
export async function readAutomations(workspacePath) {
  let raw
  try {
    raw = parseJsonBom(await fsp.readFile(automationPath(workspacePath), 'utf8'))
  } catch (e) {
    if (e && e.code === 'ENOENT') return { automations: [], warnings: [] }
    return { automations: [], warnings: ['automation.json is not readable or not valid JSON — treated as empty ('
      + String(e?.code ?? e?.message ?? e) + ')'] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { automations: [], warnings: ['automation.json: root is not an object — treated as empty'] }
  }
  if (raw.automations === undefined || raw.automations === null) {
    return { automations: [], warnings: [], rest: restRoot(raw) }
  }
  if (!Array.isArray(raw.automations)) {
    return { automations: [], warnings: ['automation.json: automations is not an array — treated as empty'], rest: restRoot(raw) }
  }
  const out = []
  const warnings = []
  const seen = new Set()
  for (let i = 0; i < raw.automations.length; i++) {
    const n = normalizeEntryLenient(raw.automations[i], i)
    if (n.warning) { warnings.push(n.warning); continue }
    if (seen.has(n.entry.key)) {
      warnings.push(`automations[${i}]: duplicate key ${n.entry.key} — entry skipped`)
      continue
    }
    seen.add(n.entry.key)
    out.push(n.entry)
    for (const w of n.warnings) warnings.push(w)
  }
  return { automations: out, warnings, rest: restRoot(raw) }
}

// ---- store write + command files ------------------------------------------------

// Write the whole automations array (read-modify-write from the lenient
// view; unknown root fields survive the roundtrip). The .harnessams creation
// moment also lays the AGENTS.md config-table template (same as
// writeSessionConfig — idempotent, never throws).
async function writeStore(workspacePath, automations, rest = {}) {
  const dir = path.join(workspacePath, STORE_DIR)
  const fresh = !fs.existsSync(dir)
  await fsp.mkdir(dir, { recursive: true })
  if (fresh) await ensureAgentsMdTemplate(workspacePath)
  await atomicWrite(automationPath(workspacePath),
    JSON.stringify({ ...rest, automations }, null, 2) + '\n')
}

// Write one shared command file. Idempotent: identical content is a no-op
// (a file referenced by several tasks is not "re-created"); different content
// OVERWRITES — the shared-library edit semantics: every referencing task sees
// the new content on its next run. Returns { file, written } or { error }.
export async function writeCommandFile(workspacePath, name, content) {
  const e = commandFileError(name)
  if (e) return { error: e }
  if (typeof content !== 'string' || !content.trim()) return { error: `command content must be a non-empty string: ${name}` }
  if (content.length > MAX_CONTENT) return { error: `command content too long (max ${MAX_CONTENT} chars): ${name}` }
  const dir = commandDirPath(workspacePath)
  const target = path.join(dir, name)
  try {
    const cur = await fsp.readFile(target, 'utf8')
    if (cur === content) return { file: name, written: false }
  } catch { /* missing — written below */ }
  await fsp.mkdir(dir, { recursive: true })
  await atomicWrite(target, content)
  return { file: name, written: true }
}

// ---- key minting -----------------------------------------------------------------

function stampYYMMDDHHMMSS(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  return `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}

// sessionId + yymmddhhmmss; a same-second collision in one workspace gets a
// numeric suffix (the stamp alone cannot distinguish two adds in one second).
// Exported for tests (the suffix path needs a controlled taken-set/clock).
export function makeAutomationKey(sessionId, taken, now = new Date()) {
  const sid = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'noagent'
  const base = `${sid}-${stampYYMMDDHHMMSS(now)}`
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const k = `${base}-${i}`
    if (!taken.has(k)) return k
  }
  throw new Error('cannot derive a unique automation key (same-second collision)')
}

// ---- CRUD (the config_automation tool's back end) --------------------------------

// Lay the commands payload down: content items create/overwrite their shared
// file, reference items require the file to exist. Runs BEFORE the entry is
// registered — a failed write leaves no half-registered task. Returns
// { files } or { error }.
async function layCommands(workspacePath, commands) {
  for (const c of commands) {
    if (c.content == null) {
      try {
        await fsp.access(path.join(commandDirPath(workspacePath), c.file))
      } catch {
        return { error: `command file does not exist (reference-only item, no content to create it): ${c.file}` }
      }
    } else {
      const w = await writeCommandFile(workspacePath, c.file, c.content)
      if (w.error) return { error: w.error }
    }
  }
  return { files: commands.map((c) => c.file) }
}

export async function addAutomation(workspacePath, { sessionId, name, description, commands }) {
  const cn = normalizeCommandsInput(commands)
  if (cn.error) return { error: cn.error, code: 400 }
  const v = validateEntryInput({ name, description, files: cn.files })
  if (v.error) return { error: v.error, code: 400 }
  const laid = await layCommands(workspacePath, cn.commands)
  if (laid.error) return { error: laid.error, code: 400 }
  const store = await readAutomations(workspacePath)
  const key = makeAutomationKey(sessionId, new Set(store.automations.map((a) => a.key)))
  const now = new Date().toISOString()
  const entry = {
    ...v.value,
    key,
    created_at: now,
    updated_at: now,
    created_by_session: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'noagent',
  }
  await writeStore(workspacePath, [...store.automations, entry], store.rest)
  return {
    ok: true, key, name: entry.name, files: entry.files,
    ...(store.warnings.length ? { warnings: [...store.warnings] } : {}),
  }
}

export async function updateAutomation(workspacePath, { key, name, description, commands }) {
  if (typeof key !== 'string' || !key.trim()) return { error: 'key is required for action=update', code: 400 }
  const k = key.trim()
  const store = await readAutomations(workspacePath)
  const idx = store.automations.findIndex((a) => a.key === k)
  if (idx < 0) return { error: `no such automation in this project: ${k}`, code: 404 }
  const cur = store.automations[idx]
  let files = cur.files
  if (commands != null) {
    const cn = normalizeCommandsInput(commands)
    if (cn.error) return { error: cn.error, code: 400 }
    const laid = await layCommands(workspacePath, cn.commands)
    if (laid.error) return { error: laid.error, code: 400 }
    files = laid.files
  }
  const v = validateEntryInput({
    key: k,
    name: name != null ? name : cur.name,
    description: description != null ? description : cur.description,
    files,
  })
  if (v.error) return { error: v.error, code: 400 }
  // unknown fields of the stored entry ride through the update (D-003)
  const entry = { ...cur, ...v.value, updated_at: new Date().toISOString() }
  const automations = [...store.automations]
  automations[idx] = entry
  await writeStore(workspacePath, automations, store.rest)
  return {
    ok: true, key: k, name: entry.name, files: entry.files,
    ...(store.warnings.length ? { warnings: [...store.warnings] } : {}),
  }
}

// Deleting a task NEVER touches the command files — they are the shared
// library and may back other tasks; an orphan nobody references anymore is
// removable through safe_trash like any other file.
export async function deleteAutomation(workspacePath, { key }) {
  if (typeof key !== 'string' || !key.trim()) return { error: 'key is required for action=delete', code: 400 }
  const k = key.trim()
  const store = await readAutomations(workspacePath)
  const cur = store.automations.find((a) => a.key === k)
  if (!cur) return { error: `no such automation in this project: ${k}`, code: 404 }
  await writeStore(workspacePath, store.automations.filter((a) => a.key !== k), store.rest)
  return {
    ok: true, key: k, files_kept: cur.files,
    ...(store.warnings.length ? { warnings: [...store.warnings] } : {}),
  }
}

// ---- the run (stateless, sequential) ----------------------------------------------

function capOutput(s) {
  const t = String(s ?? '')
  if (t.length <= MAX_OUTPUT) return t
  return t.slice(0, MAX_OUTPUT) + `\n…[truncated ${t.length - MAX_OUTPUT} chars]`
}

// Run ONE automation by key. No registry, no run records: reads the entry,
// then executes its files' contents sequentially, each read from disk at run
// time, on the project's settings.machine_id through the dsh-ssh exec
// funnel. Every command reports independently — a failure does not stop the
// rest (the overall status just fails). The caller's `signal` (a tool turn's
// exec.signal or the UI route's request-abort controller) races each ssh
// call and rides the batch input: KILL + channel close best-effort, the
// remote command may orphan (D-029) — an aborted race is reported as such,
// never as a clean failure.
// Post-run behavior is the reserved seam: this payload is the extension
// point; nothing acts on it beyond the caller's echo yet.
export async function runAutomation(ctx, { project, key, signal }) {
  if (typeof key !== 'string' || !key.trim()) return { error: 'automation key is required', code: 400 }
  const k = key.trim()
  const store = await readAutomations(project.path)
  const entry = store.automations.find((a) => a.key === k)
  if (!entry) return { error: `no such automation in this project: ${k}`, code: 404 }
  const settings = readSettingsAt(project.path)
  if (!settings.machine_id) {
    return {
      error: 'machine_id is not configured — pick a dsh-ssh host alias in the project settings table (Overview) before running automations',
      code: 400,
    }
  }
  const startedAt = new Date().toISOString()
  const results = []
  for (const file of entry.files) {
    const rec = { file }
    const t0 = Date.now()
    let command
    try {
      // executed from disk at run time: CRLF folds to LF so a stray Windows
      // editor cannot break the remote sh -c (storage itself stays verbatim)
      command = (await fsp.readFile(path.join(commandDirPath(project.path), file), 'utf8')).replace(/\r\n/g, '\n')
    } catch (e) {
      rec.ok = false
      rec.error = `command file unreadable: ${String(e?.code ?? e?.message ?? e)}`
      results.push(rec)
      continue
    }
    const r = await execRemote(ctx, settings.machine_id, command, { timeoutMs: COMMAND_TIMEOUT_MS, signal })
    rec.ok = !!r.ok
    rec.exitCode = r.exitCode
    rec.stdout = capOutput(r.stdout)
    rec.stderr = capOutput(r.stderr)
    rec.timedOut = !!r.timedOut
    if (r.isError) {
      // the aborted-race / channel-error face: the remote outcome is uncertain
      rec.error = capOutput(r.text)
      if (signal?.aborted === true) rec.aborted = true
    } else if (!r.ok) {
      rec.error = r.timedOut
        ? `remote timeout after ${COMMAND_TIMEOUT_MS / 1000}s (exit 137)`
        : (capOutput(r.stderr) || capOutput(r.text) || `exit ${r.exitCode}`)
    }
    rec.duration_ms = Date.now() - t0
    results.push(rec)
  }
  const status = signal?.aborted === true
    ? 'aborted'
    : (results.length > 0 && results.every((x) => x.ok) ? 'done' : 'failed')
  return {
    ok: status === 'done',
    key: k,
    name: entry.name,
    machine: settings.machine_id,
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results,
    ...(store.warnings.length ? { warnings: [...store.warnings] } : {}),
  }
}
