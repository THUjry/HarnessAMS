// Health checks. Local items run directly on this machine. Remote items are the
// Overview button set, each an independent one-click check executed through
// dsh-remote's rw_exec tool shell — there is no ssh channel of our own anymore
// (2026-10-26 rework; the former BatchMode fallback died with the nodes.yaml registry).
// The agent context is the calling session of a REMOTE PROJECT (a DSH workspace inside
// a dsh-remote mirror) — its cwd binds rw_exec to that machine, so checks never borrow
// sessions across projects and never switch the global active machine.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resultText } from './machines.js'

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
  await t('ngspice present', async () => {
    const cmd = ws?.config?.ngspice_cmd
    if (!cmd || !fs.existsSync(cmd)) throw new Error(`missing or not configured: ${cmd ?? '(none)'}`)
    const { stdout } = await execFileAsync(cmd, ['-v'], { timeout: 20000 })
    const line = stdout.split(/\r?\n/).find((l) => /version|ngspice/i.test(l) && /\d/.test(l))
    return { result: (line || stdout.split(/\r?\n/)[0] || 'ngspice').trim().slice(0, 80) }
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

// rw_exec has no machine parameter — it binds from the calling session's cwd (a cwd
// inside a local mirror resolves to that mirror's machine). The caller passes the
// remote project's OWN live session as the agent context (dsh-remote 0.8.51 bindingFor
// reads exec.agent.session.header.cwd). A fabricated bare {header:{cwd}} object does
// NOT work — the tool pipeline validates the session against the live session store
// (`session "undefined" is not live in this store`), which is why a real session object
// is required. Coupling points to re-verify when dsh-remote updates: that cwd shape
// and the rw_exec result text format parsed below. Per-command budget: the tool caps
// itself at dsh-remote's commandTimeoutMs (default 20 s) and reports it in-band; our
// AbortSignal sits above that so the tool's own timeout marker surfaces first.
export function parseRwExecText(text) {
  let raw = String(text ?? '')
  // rw_exec appends the trailing markers to the END of the joined text — after the
  // stderr section — so strip them before splitting stdout from stderr.
  const timedOut = /\[command timed out after \d+ms\]/.test(raw)
  raw = raw.replace(/\[command timed out after \d+ms\]\s*$/, '').replace(/\[cancelled[^\]]*\]\s*$/, '')
  let exitCode = 0
  const m = raw.match(/\[exit code: (-?\d+)\]\s*$/)
  if (m) { exitCode = Number(m[1]); raw = raw.slice(0, m.index) }
  else if (/\[exit code:/.test(raw)) exitCode = 1 // marker present but malformed — treat as failure
  let stdout = raw, stderr = ''
  const errAt = stdout.indexOf('-- stderr --')
  if (errAt >= 0) { stderr = stdout.slice(errAt + '-- stderr --'.length).trim(); stdout = stdout.slice(0, errAt) }
  return { stdout: stdout.trimEnd(), stderr, exitCode, timedOut }
}

// One rw_exec call → one result entry. opts.raw keeps the full stdout on the entry
// (stdoutRaw) for callers that parse the output themselves.
async function execViaToolShell(tools, agent, item, cmd, channel, { maxLines = 3, maxChars = 200, judge, raw = false } = {}) {
  const t0 = Date.now()
  const entry = { item, cmd, channel, ms: 0, ok: false }
  try {
    const r = await tools.execute({
      callId: 'harnessams-check-' + Math.random().toString(36).slice(2, 8),
      name: 'rw_exec',
      arguments: { command: cmd },
      signal: AbortSignal.timeout(40000),
      ...(agent ? { agent } : {}),
    })
    const text = resultText(r)
    if (r?.isError) {
      entry.detail = text.slice(0, 400) || 'rw_exec returned an error'
      return entry
    }
    const p = parseRwExecText(text)
    entry.ok = p.exitCode === 0 && !p.timedOut && (!judge || judge(p.stdout))
    if (raw) entry.stdoutRaw = p.stdout.slice(0, 8000)
    entry.result = (p.stdout || '').trim().split(/\r?\n/).slice(0, maxLines).join(' | ').slice(0, maxChars)
    if (!entry.ok) entry.detail = (p.timedOut ? 'timed out; ' : '') + (p.stderr || `exit code ${p.exitCode}`).slice(0, 300)
  } catch (e) {
    entry.detail = String(e?.message ?? e).slice(0, 300)
  }
  entry.ms = Date.now() - t0
  return entry
}

// Double-quote a shell word (remote paths/files): escape the characters bash treats
// specially inside double quotes.
function shq(s) {
  return '"' + String(s ?? '').replace(/([$"\\`])/g, '\\$1') + '"'
}

// Run one Overview button. opts: { agent, remotePath, machine, ws }. Returns
// { channel, results: [entry...] } — results is an array so every button renders in
// the same results table.
export async function runRemoteCheckButton(tools, id, opts = {}) {
  if (!tools?.get?.('rw_exec')) throw new Error('rw_exec tool not registered (dsh-remote not installed?)')
  if (opts.agent !== undefined && typeof opts.agent?.session?.header?.cwd !== 'string') {
    throw new Error('runRemoteCheckButton: opts.agent must wrap a session with header.cwd')
  }
  const agent = opts.agent ?? undefined
  const channel = agent ? 'dsh-remote (project session)' : 'dsh-remote (active machine)'
  const wsPath = opts.remotePath || opts.machine?.workspace || '$HOME'
  const wsq = shq(wsPath)

  if (id === 'load') {
    const e = await execViaToolShell(tools, agent, 'Load', 'cat /proc/loadavg && nproc', channel,
      { maxLines: 2, maxChars: 120, judge: (o) => o.trim().length > 0 })
    return { channel, results: [e] }
  }

  if (id === 'jobs') {
    const e = await execViaToolShell(tools, agent, 'LSF jobs', 'timeout 10 bjobs -a 2>&1', channel,
      { maxLines: 12, maxChars: 900, judge: (o) => o.trim().length > 0 })
    // LSF's bjobs exits 255 with "No job found" when the queue is simply empty —
    // a healthy state, not a check failure (verified live 2026-10-26).
    if (!e.ok && /No (unfinished )?job found/i.test(e.result ?? '')) { e.ok = true; e.detail = undefined }
    return { channel, results: [e] }
  }

  if (id === 'batches') {
    // Sweep progress files are the pipeline's own convention: every work dir with a
    // sweep_progress.json is one batch, and the file's top level carries a summary
    // (status / total_points / completed). `timeout 15` + head keep the walk bounded
    // on NFS-scale workspaces (the du lesson from 2026-10-25).
    const cmd = 'timeout 15 find ' + wsq + ' -maxdepth 4 -name sweep_progress.json 2>/dev/null'
      + ' | sort | head -50 | while IFS= read -r f; do d=$(dirname "$f");'
      + ` st=$(grep -o '"status": *"[a-z]*"' "$f" 2>/dev/null | head -1 | sed 's/.*"\\([a-z]*\\)"$/\\1/');`
      + ` tot=$(grep -o '"total_points": *[0-9]*' "$f" 2>/dev/null | head -1 | grep -o '[0-9]*$');`
      + ` com=$(grep -o '"completed": *[0-9]*' "$f" 2>/dev/null | head -1 | grep -o '[0-9]*$');`
      + ` printf '%s  [%s] %s/%s\\n' "$d" "\${st:-?}" "\${com:-?}" "\${tot:-?}";`
      + ' done'
    const e = await execViaToolShell(tools, agent, 'Batch dirs', cmd, channel,
      { maxLines: 15, maxChars: 1200, judge: () => true })
    if (e.ok && !e.result) e.result = 'no sweep_progress.json found (depth <= 4)'
    return { channel, results: [e] }
  }

  if (id === 'scripts') {
    // Drift check between the configured local pipeline-scripts directory and the
    // remote workspace root, by md5 — report only, nothing is uploaded.
    const dir = opts.ws?.config?.sim_scripts_dir
    const hashes = new Map()
    if (dir && fs.existsSync(dir)) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue
        try {
          hashes.set(ent.name, crypto.createHash('md5').update(fs.readFileSync(path.join(dir, ent.name))).digest('hex'))
        } catch { /* unreadable file — skip */ }
        if (hashes.size >= 50) break
      }
    }
    if (!hashes.size) {
      return { channel, results: [{ item: 'Script sync', cmd: '(local sim_scripts_dir)', channel, ms: 0, ok: false,
        detail: 'sim_scripts_dir not configured or has no files (harnessams.json)' }] }
    }
    const names = [...hashes.keys()]
    const cmd = 'cd ' + wsq + ' && md5sum ' + names.map(shq).join(' ') + ' 2>/dev/null'
      + '; echo __REMOTE_PY__; ls -1 *.py 2>/dev/null | head -50'
    const e = await execViaToolShell(tools, agent, 'Script sync', cmd, channel, { raw: true })
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
    e.detail = rows.filter((r) => r.state !== 'in-sync').map((r) => `${r.file} — ${r.state}`).slice(0, 30).join('\n') || undefined
    if (n('differs') || n('only-local')) e.warn = 'local/remote script drift detected'
    return { channel, results: [e] }
  }

  throw new Error(`unknown check button: ${id}`)
}
