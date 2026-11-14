// Health checks. Local items run directly on this machine. Remote items are the
// Overview button set, each an independent one-click check executed through the
// dsh-ssh tool shell (ssh_exec by alias — zero gating, no borrowed session).
// Successful outputs are parsed into rows (string[][]) so the client renders proper
// columned tables; when a parser declines, the entry keeps its raw text and the
// client falls back to plain-text rendering.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { execRemote, shq } from '../remote.js'

const execFileAsync = promisify(execFile)

export async function runLocalChecks(ws) {
  const results = []
  const t = async (name, fn) => {
    const t0 = Date.now()
    try { results.push({ item: name, ...(await fn()), ms: Date.now() - t0, ok: true }) }
    catch (e) { results.push({ item: name, ok: false, detail: String(e.message ?? e), ms: Date.now() - t0 }) }
  }
  await t('Connectivity (local)', async () => ({ result: 'local', detail: os.hostname() }))
  await t('Node', async () => ({ result: process.version }))
  await t('Python', async () => {
    const { stdout } = await execFileAsync('python', ['--version'], { timeout: 15000 })
    return { result: stdout.trim() }
  })
  await t('sky130 PDK present', async () => {
    const lib = ws?.config?.pdk_lib
    if (!lib || !fs.existsSync(lib)) throw new Error(`missing or not configured: ${lib ?? '(none)'}`)
    const dir = path.dirname(lib) // the combined_models directory (real footprint)
    let bytes = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name)
        if (e.isDirectory()) walk(q)
        else bytes += fs.statSync(q).size
      }
    }
    walk(dir)
    return { result: `fossi combined_models, entry ${path.basename(lib)} (directory totals ${(bytes / 1024 / 1024).toFixed(1)} MB)` }
  })
  await t('Disk capacity (workspace)', async () => {
    const st = await fsp.statfs(ws?.config?.workspace_root ?? process.cwd())
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!total) throw new Error('statfs returned 0')
    return { result: `${(total / 2 ** 30).toFixed(1)} GiB total, ${(free / 2 ** 30).toFixed(1)} GiB free`
             + ` (${(100 * (total - free) / total).toFixed(0)}% used)`,
             warn: free / total < 0.1 ? 'free space < 10%' : undefined }
  })
  await t('Workspace writable', async () => {
    const probe = path.join(ws?.config?.workspace_root ?? process.cwd(), '.write_probe')
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe)
    return { result: 'writable' }
  })
  return results
}

// ---- remote check buttons (Overview, one button per function) ----
// The button surface exposed to the client; commands are built in runRemoteCheckButton.
export const REMOTE_CHECK_BUTTONS = [
  { id: 'load', item: 'Load' },
  { id: 'jobs', item: 'LSF jobs' },
  { id: 'batches', item: 'Batch dirs' },
  { id: 'scripts', item: 'Script sync' },
]

// ssh_exec by alias through the execRemote funnel (../remote.js): the command
// is wrapped in a remote `timeout -s KILL` there, structured results come back
// as { stdout, stderr, exitCode, timedOut }, and channel-open failures carry a
// suspected-MaxSessions annotation. Per-command budget: REMOTE_EXEC_TIMEOUT_MS.
const REMOTE_EXEC_TIMEOUT_MS = 40000

// One ssh_exec call → one result entry. opts.raw keeps the full stdout on the
// entry (stdoutRaw) for callers that parse the output themselves.
async function execViaToolShell(ctx, alias, item, cmd, channel, { maxLines = 3, maxChars = 200, judge, raw = false } = {}) {
  const t0 = Date.now()
  const entry = { item, cmd, channel, ms: 0, ok: false }
  const r = await execRemote(ctx, alias, cmd, { timeoutMs: REMOTE_EXEC_TIMEOUT_MS })
  entry.ok = r.ok && (!judge || judge(r.stdout))
  if (raw) entry.stdoutRaw = (r.stdout || '').slice(0, 8000)
  entry.result = (r.stdout || '').trim().split(/\r?\n/).slice(0, maxLines).join(' | ').slice(0, maxChars)
  if (!entry.ok) {
    entry.detail = (r.timedOut ? 'timed out; ' : '') + (r.stderr || `exit code ${r.exitCode}`)
    entry.detail = String(entry.detail).slice(0, 300)
  }
  entry.ms = Date.now() - t0
  return entry
}

// Recursively hash a local pipeline-scripts tree: relative POSIX path -> md5.
// Bounded (50 files, skips __pycache__/*.pyc) because the remote listing is capped
// the same way; the pipeline keeps the scripts/{common,spectre,snp} layout.
function collectScriptFiles(dir, limit = 50) {
  const out = new Map()
  const walk = (d, prefix) => {
    if (out.size >= limit) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      if (out.size >= limit) return
      if (ent.name === '__pycache__' || ent.name.endsWith('.pyc')) continue
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const abs = path.join(d, ent.name)
      if (ent.isDirectory()) { walk(abs, rel); continue }
      if (!ent.name.endsWith('.py')) continue
      try {
        out.set(rel, crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex'))
      } catch { /* unreadable file — skip */ }
    }
  }
  walk(dir, '')
  return out
}

// Run one Overview button. opts: { machine, ws } where machine is a listMachines
// record (alias + configured workspace root). Returns
// { channel, results: [entry...] } — results is an array so every button renders in
// the same results table.
export async function runRemoteCheckButton(ctx, id, opts = {}) {
  if (!ctx?.tools?.get?.('ssh_exec')) throw new Error('ssh_exec tool not registered (@linxin666/dsh-ssh not installed?)')
  const alias = opts.machine?.alias ?? opts.machine?.id
  if (!alias) throw new Error('runRemoteCheckButton: opts.machine (a dsh-ssh host record) is required')
  const channel = `dsh-ssh (${alias})`
  const wsPath = opts.machine?.workspace || '$HOME'
  const wsq = shq(wsPath)

  if (id === 'load') {
    const e = await execViaToolShell(ctx, alias, 'Load', 'cat /proc/loadavg && nproc', channel,
      { maxLines: 2, maxChars: 120, judge: (o) => o.trim().length > 0, raw: true })
    const row = parseLoadRow(e.stdoutRaw)
    delete e.stdoutRaw
    if (e.ok && row) { e.rows = [row]; e.result = `load ${row[0]} / ${row[4]} cpu` }
    return { channel, results: [e] }
  }

  if (id === 'jobs') {
    // No head cap on the pipe: it would mask bjobs' own exit code (127 missing
    // binary, 255 empty queue) behind head's 0. The 8000-char stdoutRaw cap bounds
    // the parse instead; totals undercount past it and the entry is marked truncated.
    const e = await execViaToolShell(ctx, alias, 'LSF jobs', 'timeout 10 bjobs -a 2>&1', channel,
      { maxLines: 14, maxChars: 900, judge: (o) => o.trim().length > 0, raw: true })
    // LSF's bjobs exits 255 with "No job found" when the queue is simply empty —
    // a healthy state, not a check failure (verified live).
    if (!e.ok && /No (unfinished )?job found/i.test(e.result ?? '')) { e.ok = true; e.detail = undefined }
    const parsed = e.ok ? parseBjobsRows(e.stdoutRaw) : null
    delete e.stdoutRaw
    if (parsed) {
      e.rows = parsed.rows
      e.rowsRaw = parsed.raw
      e.truncated = parsed.truncated || String(parsed.rawTextLen ?? 0) >= 8000
      if (parsed.total > 0) e.result = `${parsed.total} job(s)`
    }
    return { channel, results: [e] }
  }

  if (id === 'batches') {
    // Sweep progress files are the pipeline's own convention: every work dir with a
    // sweep_progress.json is one batch, and the file's top level carries a summary
    // (status / total_points / completed). `timeout 15` + head keep the walk bounded
    // on NFS-scale workspaces (du on huge trees is slow — never call it here).
    const cmd = 'timeout 15 find ' + wsq + ' -maxdepth 4 -name sweep_progress.json 2>/dev/null'
      + ' | sort | head -50 | while IFS= read -r f; do d=$(dirname "$f");'
      + ` st=$(grep -o '"status": *"[a-z]*"' "$f" 2>/dev/null | head -1 | sed 's/.*"\\([a-z]*\\)"$/\\1/');`
      + ` tot=$(grep -o '"total_points": *[0-9]*' "$f" 2>/dev/null | head -1 | grep -o '[0-9]*$');`
      + ` com=$(grep -o '"completed": *[0-9]*' "$f" 2>/dev/null | head -1 | grep -o '[0-9]*$');`
      + ` printf '%s  [%s] %s/%s\\n' "$d" "\${st:-?}" "\${com:-?}" "\${tot:-?}";`
      + ' done'
    const e = await execViaToolShell(ctx, alias, 'Batch dirs', cmd, channel,
      { maxLines: 15, maxChars: 1200, judge: () => true, raw: true })
    const rows = parseBatchRows(e.stdoutRaw, wsPath)
    delete e.stdoutRaw
    if (e.ok && rows.length) { e.rows = rows; e.result = `${rows.length} batch dir(s)` }
    else if (e.ok && !e.result) e.result = 'no sweep_progress.json found (depth <= 4)'
    return { channel, results: [e] }
  }

  if (id === 'scripts') {
    // Drift check between the configured local pipeline-scripts directory and the
    // remote scripts root, by md5 — report only, nothing is uploaded. The local
    // tree is walked recursively (scripts/{common,spectre,snp}) and keys are
    // relative POSIX paths; the remote root comes from the optional
    // harnessams.json `remote_scripts_dir` (a remote absolute path, never resolved
    // locally) and falls back to the remote workspace root for flat layouts.
    const dir = opts.ws?.config?.sim_scripts_dir
    const hashes = dir && fs.existsSync(dir) ? collectScriptFiles(dir) : new Map()
    if (!hashes.size) {
      return { channel, results: [{ item: 'Script sync', cmd: '(local sim_scripts_dir)', channel, ms: 0, ok: false,
        detail: 'sim_scripts_dir not configured or has no files (harnessams.json)' }] }
    }
    const names = [...hashes.keys()]
    const remoteBase = opts.ws?.config?.remote_scripts_dir || wsPath
    const cmd = 'cd ' + shq(remoteBase) + ' && md5sum ' + names.map(shq).join(' ') + ' 2>/dev/null'
      + '; echo __REMOTE_PY__; find . -maxdepth 4 -name \'*.py\' -not -path \'*/__pycache__/*\''
      + ' | sed \'s|^\\./||\' | sort | head -50'
    const e = await execViaToolShell(ctx, alias, 'Script sync', cmd, channel, { raw: true })
    if (!e.ok) { delete e.stdoutRaw; return { channel, results: [e] } }
    const rawOut = e.stdoutRaw ?? ''
    delete e.stdoutRaw
    const markerAt = rawOut.indexOf('__REMOTE_PY__')
    const md5Part = markerAt >= 0 ? rawOut.slice(0, markerAt) : rawOut
    const remotePy = (markerAt >= 0 ? rawOut.slice(markerAt + '__REMOTE_PY__'.length) : '')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const remote = new Map()
    for (const line of md5Part.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{32})\s+(\S+)$/)
      if (m) remote.set(m[2], m[1])
    }
    const rows = []
    for (const [name, h] of hashes) {
      const r = remote.get(name)
      rows.push({ file: name, state: r === undefined ? 'only-local' : r === h ? 'in-sync' : 'differs' })
    }
    for (const p of remotePy) if (!hashes.has(p)) rows.push({ file: p, state: 'only-remote' })
    const n = (s) => rows.filter((r) => r.state === s).length
    e.result = `${n('in-sync')} in sync, ${n('differs')} differ, ${n('only-local')} only local, ${n('only-remote')} only remote`
    e.rows = rows.slice(0, 50).map((r) => [r.file, r.state])
    e.truncated = rows.length > 50
    // plain-text variant kept as the diagnose/fallback surface
    e.detail = rows.filter((r) => r.state !== 'in-sync').map((r) => `${r.file} — ${r.state}`).slice(0, 30).join('\n') || undefined
    if (n('differs') || n('only-local')) e.warn = 'local/remote script drift detected'
    return { channel, results: [e] }
  }

  throw new Error(`unknown check button: ${id}`)
}

// ---- output parsers (structured rows for the client's columned tables) ----
// Each returns null (or [] for batches) when the output does not match — callers
// keep the raw text and the client renders that instead of a broken table.

// /proc/loadavg + nproc → one row [1m, 5m, 15m, runnable/total, CPUs]. loadavg's
// trailing last-pid field is dropped (noise for a load check).
export function parseLoadRow(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return null
  const f = lines[0].trim().split(/\s+/)
  const cpus = lines[1].trim()
  const num = /^\d+(\.\d+)?$/
  if (f.length < 4 || !num.test(f[0]) || !num.test(f[1]) || !num.test(f[2]) || !/^\d+\/\d+$/.test(f[3]) || !/^\d+$/.test(cpus)) return null
  return [f[0], f[1], f[2], f[3], cpus]
}

// bjobs -a listing → { rows: [jobid, stat, execHost, name, submitTime][], raw (full
// lines for tooltips), total, truncated }. Column layout comes from the header line
// when present — bjobs variants add columns (the target cluster's zscheduler prints
// FROM_CLUSTER/EXEC_CLUSTER too) — with the standard 6-column prefix as fallback.
// USER/QUEUE/FROM_* are parsed but not displayed; the tail past JOB_NAME is split
// into job name + submit time by peeling date/time tokens off the end (LSF formats
// vary: "Oct 26 21:04", "Feb 12 2025", …). An EMPTY exec-host cell (PEND rows)
// collapses under whitespace splitting; the parser recovers it from the all-time
// tail and the full line always rides along as the row tooltip so nothing is hidden.
export function parseBjobsRows(text, maxRows = 30) {
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return null
  if (/^No (unfinished )?job found/i.test(lines[0])) return { rows: [], raw: [], total: 0, truncated: false }
  let statIdx = 2, execIdx = 5, nameIdx = 6
  if (/^JOBID\b/.test(lines[0])) {
    const h = lines[0].split(/\s+/)
    const si = h.indexOf('STAT'), ei = h.indexOf('EXEC_HOST'), ni = h.indexOf('JOB_NAME')
    if (si > 0 && ei > si && ni > ei) { statIdx = si; execIdx = ei; nameIdx = ni }
  }
  const rows = []
  const raw = []
  const MONTHS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
  const timeTok = /^\d{1,2}:\d{2}(:\d{2})?$/
  const dayTok = /^\d{1,2}$/
  const yearTok = /^\d{4}$/
  const dateLike = (x) => timeTok.test(x) || dayTok.test(x) || yearTok.test(x) || MONTHS.has(x)
  for (const line of lines) {
    if (/^JOBID\b/.test(line)) continue
    const t = line.split(/\s+/)
    if (t.length < nameIdx + 1) continue
    const tail = t.slice(nameIdx)
    let k = tail.length
    let peeled = 0
    while (k > 0 && peeled < 4 && dateLike(tail[k - 1])) { k--; peeled++ }
    const tailToks = tail.slice(k)
    const isTime = peeled >= 2 && (tailToks.some((x) => timeTok.test(x)) || tailToks.some((x) => MONTHS.has(x)))
    const submit = isTime ? tailToks.join(' ') : ''
    let name = isTime ? tail.slice(0, k).join(' ') : tail.join(' ')
    let execHost = t[execIdx] ?? ''
    if (!name) {
      // an empty EXEC_HOST cell collapses under whitespace splitting: the job name
      // lands in the exec column and the whole tail parses as the submit time —
      // take the exec cell back as the name (the raw line rides along as tooltip)
      if (isTime) { name = t[execIdx] ?? ''; execHost = '' }
      else continue
    }
    rows.push([t[0], t[statIdx] ?? '', execHost, name, submit])
    raw.push(line)
  }
  if (!rows.length) return null
  return {
    rows: rows.slice(0, maxRows),
    raw: raw.slice(0, maxRows),
    total: rows.length,
    truncated: rows.length > maxRows,
    rawTextLen: String(text ?? '').length,
  }
}

// Batch-dir lines from the remote one-liner (`<dir>  [<status>] <done>/<total>`) →
// rows [dir, status, progress], with the workspace-scope prefix collapsed to $ROOT
// (the client shows the legend `$ROOT = <remotePath>`). Always lower-cases nothing —
// paths pass through verbatim apart from the prefix swap.
export function parseBatchRows(text, remotePath) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+\[([^\]]*)\]\s+(\S+)\/(\S+)$/)
    if (!m) continue
    rows.push([rootize(m[1], remotePath), m[2], m[3] + '/' + m[4]])
  }
  return rows
}

// Collapse the workspace-scope prefix: /home/x/sim/AutoAnalog/b1 → $ROOT/b1 (an
// exact match becomes a bare $ROOT). Anything outside the scope passes through.
export function rootize(dir, remotePath) {
  const d = String(dir ?? '')
  const rp = String(remotePath ?? '')
  if (!rp) return d
  if (d === rp) return '$ROOT'
  if (d.startsWith(rp.endsWith('/') ? rp : rp + '/')) return '$ROOT' + d.slice(rp.length)
  return d
}
