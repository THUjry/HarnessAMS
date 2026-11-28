// Per-project automation store + runner (phase-2 automation feature). Two
// artifacts under <workspace>/.harnessams/:
//   automation.json — the task list: entries { key, name, description,
//     created_at, updated_at, created_by_session, files, mode }, where `files`
//     is an ORDERED list of command-file names (the run order) and `mode`
//     picks the execution channel ('remote', the default, or 'local').
//   automation/     — the SHARED command library: plain .txt files, FLAT,
//     deliberately decoupled from tasks — one file may back several tasks
//     (cross-task reuse), and a task's `files` list is just references.
// The store follows the sessions.json discipline (D-003): versionless, LENIENT
// read (invalid entries / command names / mode values skipped or defaulted
// with surfaced warnings, unknown fields ride through), STRICT write (the
// entry being written is fully validated; the merge base is the lenient view
// so a skipped entry self-heals off disk on the next write).
// The automation key is minted at creation: the creating session's id (a
// delegated subagent resolves to its topmost user-visible ancestor,
// src/subagent.js — D-003) plus a yymmddhhmmss local stamp; a same-second
// collision gets a numeric suffix.
// Running is deliberately stateless: NO in-memory registry, NO run records —
// a run reads the entry, reads each command file FROM DISK at run time (an
// edited library file needs no re-registration) and executes them
// SEQUENTIALLY in registration order. The channel follows the entry's mode:
//   remote — each file is a shell script through the dsh-ssh exec funnel
//     (channel/remote.js execRemote) on the project's settings.machine_id;
//   local — each non-comment line is ONE tool call, `toolName {json}`,
//     dispatched through the registered tool surface (ctx.tools via callTool)
//     on THIS host, no ssh wrapper; a tool that declares a `project`
//     parameter gets the running task's project path injected so library
//     files stay machine-independent.
// Both the sidebar's POST /api/automation/run and the run_automation tool
// land here. Abort follows the channel contract: the caller's signal races
// each call and rides the batch input (remote: KILL + channel close
// best-effort, an aborted command may orphan — D-029; local: an aborted race
// means the tool call may or may not have taken effect). Post-run behavior is
// a reserved seam: the result payload below is the extension point — nothing
// acts on it beyond the caller's echo yet.
// A command file longer than OVERSIZE_LINES warns wherever its content is
// surfaced (config results, run results, the list view): heavy material
// belongs on the server, referenced by path, not carried through every run.
// A fresh project seeds one demo task (ensureDefaultAutomation) so the list
// is never empty out of the box.
// (covered by tests/automation.test.mjs)
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseJsonBom, atomicWrite } from '../lib/io.js'
import { readSettingsAt } from './settings.js'
import { ensureAgentsMdTemplate } from './agentsmd.js'
import { execRemote, callTool } from '../channel/remote.js'

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
// A command file over this many lines warns: its content rides every run, so
// heavy material belongs on the server and the file just references it.
const OVERSIZE_LINES = 50
// The skill that documents the upload-heavy-content-to-the-server workflow;
// empty = the warning ships without a pointer. A name landing here appends
// "see the <name> skill" to the oversize warning.
const HEAVY_COMMAND_SKILL = ''

// One command .txt name: a single printable-ASCII segment ending in .txt.
// The library is FLAT under .harnessams/automation/ — no subdirectories, no
// traversal: the name is both the reference key and the file name.
const COMMAND_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.txt$/

// Automation key: creating session id (SESSION_ID_RE shape) + 12-digit stamp
// + optional numeric collision suffix.
const KEY_RE = /^[\w-]{6,160}$/

const ENTRY_KNOWN = new Set(['key', 'name', 'description', 'created_at', 'updated_at', 'created_by_session', 'files', 'mode'])

// Line count of a command file's content (CRLF/CR fold to LF first — the same
// fold the runner applies before executing).
function commandLineCount(content) {
  const folded = String(content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '')
  return folded.length === 0 ? 0 : folded.split('\n').length
}

// The >OVERSIZE_LINES warning text: heavy content should live on the server,
// the command file referencing it by path.
function oversizeWarning(name, lines) {
  return `command file ${name} is ${lines} lines (> ${OVERSIZE_LINES}) — prefer uploading heavy `
    + `content to the server and referencing it by path`
    + (HEAVY_COMMAND_SKILL ? ` (see the ${HEAVY_COMMAND_SKILL} skill)` : '')
}

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
function validateEntryInput({ key, name, description, files, mode }) {
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
  if (mode != null && mode !== 'remote' && mode !== 'local') {
    return { error: `mode must be 'remote' or 'local': ${JSON.stringify(mode)}` }
  }
  if (!Array.isArray(files) || files.length < 1) {
    return { error: 'automation files must be a non-empty array of command file names (the run order)' }
  }
  if (files.length > MAX_COMMANDS) return { error: `too many command references (max ${MAX_COMMANDS})` }
  for (const f of files) {
    const e = commandFileError(f)
    if (e) return { error: e }
  }
  return { value: { key, name: name.trim(), description: String(description ?? '').trim(), files: [...files], mode: mode === 'local' ? 'local' : 'remote' } }
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
  // mode: 'local' | 'remote' (absent = remote); anything else warns and reads
  // back as remote (the entry itself stays, only the channel defaults)
  let mode = 'remote'
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode === 'local' || raw.mode === 'remote') mode = raw.mode
    else warnings.push(`automations[${i}]: mode is not 'remote' or 'local' — treated as remote`)
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
    mode,
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
// the new content on its next run. An oversize (>OVERSIZE_LINES) file warns in
// the result either way — the warning rides config results and the list/run
// views. Returns { file, written, warnings? } or { error }.
export async function writeCommandFile(workspacePath, name, content) {
  const e = commandFileError(name)
  if (e) return { error: e }
  if (typeof content !== 'string' || !content.trim()) return { error: `command content must be a non-empty string: ${name}` }
  if (content.length > MAX_CONTENT) return { error: `command content too long (max ${MAX_CONTENT} chars): ${name}` }
  const lines = commandLineCount(content)
  const warnings = lines > OVERSIZE_LINES ? [oversizeWarning(name, lines)] : []
  const dir = commandDirPath(workspacePath)
  const target = path.join(dir, name)
  let written = true
  try {
    const cur = await fsp.readFile(target, 'utf8')
    if (cur === content) written = false
  } catch { /* missing — written below */ }
  if (written) {
    await fsp.mkdir(dir, { recursive: true })
    await atomicWrite(target, content)
  }
  return { file: name, written, ...(warnings.length ? { warnings } : {}) }
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
// registered — a failed write leaves no half-registered task. Oversize
// warnings from the content items ride along. Returns { files, warnings? }
// or { error }.
async function layCommands(workspacePath, commands) {
  const warnings = []
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
      if (w.warnings) warnings.push(...w.warnings)
    }
  }
  return { files: commands.map((c) => c.file), ...(warnings.length ? { warnings } : {}) }
}

export async function addAutomation(workspacePath, { sessionId, name, description, commands, mode }) {
  const cn = normalizeCommandsInput(commands)
  if (cn.error) return { error: cn.error, code: 400 }
  const v = validateEntryInput({ name, description, files: cn.files, mode })
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
  const warnings = [...store.warnings, ...(laid.warnings ?? [])]
  return {
    ok: true, key, name: entry.name, files: entry.files, mode: entry.mode,
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function updateAutomation(workspacePath, { key, name, description, commands, mode }) {
  if (typeof key !== 'string' || !key.trim()) return { error: 'key is required for action=update', code: 400 }
  const k = key.trim()
  const store = await readAutomations(workspacePath)
  const idx = store.automations.findIndex((a) => a.key === k)
  if (idx < 0) return { error: `no such automation in this project: ${k}`, code: 404 }
  const cur = store.automations[idx]
  let files = cur.files
  let laidWarnings = []
  if (commands != null) {
    const cn = normalizeCommandsInput(commands)
    if (cn.error) return { error: cn.error, code: 400 }
    const laid = await layCommands(workspacePath, cn.commands)
    if (laid.error) return { error: laid.error, code: 400 }
    files = laid.files
    laidWarnings = laid.warnings ?? []
  }
  const v = validateEntryInput({
    key: k,
    name: name != null ? name : cur.name,
    description: description != null ? description : cur.description,
    files,
    // mode follows the update-merge semantics: pass it to switch, omit to keep
    mode: mode != null ? mode : (cur.mode ?? 'remote'),
  })
  if (v.error) return { error: v.error, code: 400 }
  // unknown fields of the stored entry ride through the update (D-003)
  const entry = { ...cur, ...v.value, updated_at: new Date().toISOString() }
  const automations = [...store.automations]
  automations[idx] = entry
  await writeStore(workspacePath, automations, store.rest)
  const warnings = [...store.warnings, ...laidWarnings]
  return {
    ok: true, key: k, name: entry.name, files: entry.files, mode: entry.mode,
    ...(warnings.length ? { warnings } : {}),
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

// Does the registered tool declare a `project` parameter? Only such tools get
// the running task's project path injected — a `project` field must never
// land on a tool whose schema does not know it.
function declaresProjectParam(ctx, name) {
  try {
    const def = ctx?.tools?.get?.(name)
    return def?.parameters?.properties ? Object.hasOwn(def.parameters.properties, 'project') : false
  } catch {
    return false
  }
}

// One LOCAL-mode command file: each non-comment line is ONE tool call,
// `toolName {json-args}` — dispatched through the registered tool surface
// (callTool, the same programmatic path the self-check uses for batch_poll),
// so a local task can drive any tool without the ssh wrapper. Blank lines and
// `#` comments are skipped; a bad line reports independently and the rest
// still run. The project injection keeps library files machine-independent;
// a line's own `project` value always wins.
async function runLocalCommandFile(ctx, project, file, content, meta, signal) {
  const recs = []
  const rows = content.split('\n')
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].trim()
    if (!line || line.startsWith('#')) continue
    const rec = { file, line: i + 1, ...meta }
    const t0 = Date.now()
    const m = /^(\S+)[ \t]+(.+)$/.exec(line)
    let args = null
    if (!m) {
      rec.ok = false
      rec.error = 'a local command line is "toolName {json-args}" — no arguments found'
    } else {
      rec.tool = m[1]
      try {
        const parsed = JSON.parse(m[2])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
        else { rec.ok = false; rec.error = 'local command arguments must be a JSON object' }
      } catch (e) {
        rec.ok = false
        rec.error = `local command arguments are not valid JSON: ${String(e?.message ?? e)}`
      }
    }
    if (args) {
      if (!('project' in args) && declaresProjectParam(ctx, rec.tool)) {
        args = { ...args, project: project.path }
      }
      const r = await callTool(ctx, rec.tool, args, { timeoutMs: COMMAND_TIMEOUT_MS, signal })
      rec.ok = !r.isError
      if (r.isError) {
        if (signal?.aborted === true) {
          // the race cut the call off mid-flight: unlike the remote KILL, a
          // local tool call either happened or it did not — say exactly that
          rec.aborted = true
          rec.error = 'aborted before the call settled — the tool call may or may not have taken effect'
        } else {
          rec.error = capOutput(r.text)
        }
      } else {
        const text = r.text || (r.value != null ? JSON.stringify(r.value, null, 2) : '')
        if (text) rec.text = capOutput(text)
      }
    }
    rec.duration_ms = Date.now() - t0
    recs.push(rec)
  }
  return recs
}

// One REMOTE-mode command file: the whole content is a shell script through
// the dsh-ssh exec funnel on the project's machine_id.
async function runRemoteCommand(ctx, machine, file, command, meta, signal) {
  const rec = { file, ...meta }
  const t0 = Date.now()
  const r = await execRemote(ctx, machine, command, { timeoutMs: COMMAND_TIMEOUT_MS, signal })
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
  return rec
}

// Run ONE automation by key. No registry, no run records: reads the entry,
// then executes its files' contents sequentially, each read from disk at run
// time, on the channel the entry's `mode` picks (remote: the dsh-ssh exec
// funnel on settings.machine_id — unconfigured refuses up front; local: tool
// calls on this host, no machine needed). Every command reports
// independently — a failure does not stop the rest (the overall status just
// fails). The caller's `signal` (a tool turn's exec.signal or the UI route's
// request-abort controller) races each call and rides the batch input.
// Post-run behavior is the reserved seam: this payload is the extension
// point; nothing acts on it beyond the caller's echo yet.
export async function runAutomation(ctx, { project, key, signal }) {
  if (typeof key !== 'string' || !key.trim()) return { error: 'automation key is required', code: 400 }
  const k = key.trim()
  const store = await readAutomations(project.path)
  const entry = store.automations.find((a) => a.key === k)
  if (!entry) return { error: `no such automation in this project: ${k}`, code: 404 }
  const isLocal = entry.mode === 'local'
  let machine = null
  if (!isLocal) {
    const settings = readSettingsAt(project.path)
    if (!settings.machine_id) {
      return {
        error: 'machine_id is not configured — pick a dsh-ssh host alias in the project settings table (Overview) before running automations',
        code: 400,
      }
    }
    machine = settings.machine_id
  }
  const startedAt = new Date().toISOString()
  const results = []
  for (const file of entry.files) {
    let content
    try {
      // executed from disk at run time: CRLF folds to LF so a stray Windows
      // editor cannot break the remote sh -c (storage itself stays verbatim)
      content = (await fsp.readFile(path.join(commandDirPath(project.path), file), 'utf8')).replace(/\r\n/g, '\n')
    } catch (e) {
      results.push({ file, ok: false, error: `command file unreadable: ${String(e?.code ?? e?.message ?? e)}` })
      continue
    }
    const lines = commandLineCount(content)
    const meta = { lines, ...(lines > OVERSIZE_LINES ? { oversize: true } : {}) }
    if (isLocal) {
      results.push(...await runLocalCommandFile(ctx, project, file, content, meta, signal))
    } else {
      results.push(await runRemoteCommand(ctx, machine, file, content, meta, signal))
    }
  }
  const status = signal?.aborted === true
    ? 'aborted'
    : (results.length > 0 && results.every((x) => x.ok) ? 'done' : 'failed')
  return {
    ok: status === 'done',
    key: k,
    name: entry.name,
    mode: isLocal ? 'local' : 'remote',
    machine,
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results,
    ...(store.warnings.length ? { warnings: [...store.warnings] } : {}),
  }
}

// ---- the list view's per-file metadata ---------------------------------------------

// Line metadata of one command file for the list view (the oversize hint's
// data); null = unreadable.
export async function commandFileMeta(workspacePath, name) {
  try {
    const content = await fsp.readFile(path.join(commandDirPath(workspacePath), name), 'utf8')
    const lines = commandLineCount(content)
    return { lines, oversize: lines > OVERSIZE_LINES }
  } catch {
    return null
  }
}

// ---- the default demo task ---------------------------------------------------------

// The task every project starts with (the automation list is never empty out
// of the box): one local-mode line calling safe_trash with action=empty —
// purging every entry of the project's trash. Seeded exactly when
// automation.json does not exist yet (the project-init moment); deleting the
// task (the store file then exists) does not resurrect it.
const DEFAULT_COMMAND_FILE = 'empty-trash.txt'
const DEFAULT_COMMAND_CONTENT = 'safe_trash {"action":"empty"}'

export async function ensureDefaultAutomation(workspacePath) {
  try {
    await fsp.access(automationPath(workspacePath))
    return { ok: true, created: false }
  } catch { /* absent — seed below */ }
  const w = await writeCommandFile(workspacePath, DEFAULT_COMMAND_FILE, DEFAULT_COMMAND_CONTENT)
  if (w.error) return { ok: false, error: w.error }
  const now = new Date().toISOString()
  const entry = {
    key: makeAutomationKey('seed', new Set()),
    name: 'Empty project trash',
    description: 'Demo task: runs the safe_trash tool with action=empty — purges every entry in '
      + 'this project\'s trash directory. Local mode: each command line is a tool call executed '
      + 'on this host, no ssh wrapper.',
    created_at: now,
    updated_at: now,
    created_by_session: 'seed',
    files: [DEFAULT_COMMAND_FILE],
    mode: 'local',
  }
  await writeStore(workspacePath, [entry])
  return { ok: true, created: true, key: entry.key }
}
