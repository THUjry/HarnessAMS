// Server health checks: local-mode items run directly; remote nodes go through the
// fallback channel — system OpenSSH wrapped in `bash -c`, BatchMode + keys, credentials
// left to the system (never persisted by us). The dsh-remote tool shell is the intended
// main channel once machines are bound; see machines.js for its presence probe.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
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

const REMOTE_CHECKS = [
  { id: 'connect', item: 'Connectivity', cmd: 'echo ok', judge: (out) => out.includes('ok') },
  { id: 'load', item: 'Load', cmd: 'cat /proc/loadavg && nproc', judge: () => true },
  { id: 'mem', item: 'Memory', cmd: 'free -m | head -2', judge: () => true },
  { id: 'disk', item: 'Disk', cmd: 'df -h ${WORKSPACE:-$HOME} | tail -1', judge: () => true },
  { id: 'ws', item: 'Workspace reachable', cmd: 'ls -ld ${WORKSPACE:-$HOME}', judge: (out) => out.trim().startsWith('d') },
  { id: 'ngspice', item: 'ngspice present', cmd: 'which ngspice && ngspice -v 2>&1 | head -1', judge: (out) => out.trim().length > 0 },
  // `timeout 15` keeps the du inside rw_exec's 20 s command cap (and the ssh fallback's
  // 15 s budget) on NFS-scale workspaces: killed du still emits the entries it priced,
  // so the report shows partial data instead of an empty timeout.
  { id: 'du', item: 'Disk usage detail', cmd: 'timeout 15 du -sh ${WORKSPACE:-$HOME}/* 2>/dev/null | sort -rh | head -20', judge: () => true },
]

async function sshRun(node, remoteCmd, timeoutMs = 15000) {
  // Fallback channel: always wrapped in `bash -c` (PATH resolves to the MSYS2 ssh,
  // avoiding System32 9.5p2); BatchMode forbids interactive passwords; keys are left to the system
  // OpenSSH (credentials never persisted).
  const target = node.HOSTNAME ? `${node.HOST}@${node.HOSTNAME}${node.PORT && node.PORT !== 22 ? ' -p ' + node.PORT : ''}`
    : String(node.HOST)
  const cli = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
               '-o', 'StrictHostKeyChecking=accept-new', target, remoteCmd]
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', cli.map(q => `'${String(q).replace(/'/g, `'\\''`)}'`).join(' ')],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
    return { ok: true, stdout, stderr, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: String(e.message ?? e), ms: Date.now() - t0 }
  }
}

export async function runNodeChecks(node, ws) {
  const workspace = node.WORKSPACE || ws?.config?.remote_workspace || '$HOME'
  const results = []
  for (const c of REMOTE_CHECKS) {
    const cmd = c.cmd.replaceAll('${WORKSPACE:-$HOME}', workspace)
    const r = await sshRun(node, cmd)
    const out = (r.stdout || '') + (r.stderr || '')
    results.push({ item: c.item, cmd: `ssh ${node.HOST} ${cmd}`, ok: r.ok && c.judge(out),
                   result: (r.ok ? (r.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' | ') : '').slice(0, 200),
                   detail: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 200), ms: r.ms })
  }
  return results
}

// ---- route A: the same REMOTE_CHECKS through dsh-remote's rw_exec tool shell ----
// rw_exec has no machine parameter — it binds from the calling session's cwd (a local
// mirror resolves to that mirror's machine), or, with no caller context at all, the
// global active machine. So the caller borrows a REAL live session whose cwd sits inside
// the machine's mirror directory and passes it as the agent context (dsh-remote 0.8.51
// bindingFor reads exec.agent.session.header.cwd): the check targets that machine
// without touching the global currentId. A fabricated bare {header:{cwd}} object does
// NOT work — the tool pipeline validates the session against the live session store
// (`session "undefined" is not live in this store`), which is why a real session object
// is required. Coupling points to re-verify when dsh-remote updates: that cwd shape,
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

export async function runMachineChecksViaToolShell(tools, machine, opts = {}) {
  if (!tools?.get?.('rw_exec')) throw new Error('rw_exec tool not registered (dsh-remote not installed?)')
  const channel = opts.agent ? 'dsh-remote (mirror)' : 'dsh-remote (active machine)'
  // The binding context — see the block comment above. The pipeline validates the
  // session object against the live session store (a fabricated bare {header} object
  // is rejected with `session "undefined" is not live in this store`), so the caller
  // passes a REAL live session whose cwd sits inside the machine's mirror; rw_exec then
  // binds that mirror's machine. Without a mirror we send no context at all, which
  // rw_exec resolves to the active machine (only correct for the current machine).
  if (opts.agent !== undefined && typeof opts.agent?.session?.header?.cwd !== 'string') {
    throw new Error('runMachineChecksViaToolShell: opts.agent must wrap a session with header.cwd')
  }
  const agent = opts.agent ?? undefined
  const workspace = opts.mirror?.remotePath || machine.workspace || '$HOME'
  const results = []
  for (const c of REMOTE_CHECKS) {
    const cmd = c.cmd.replaceAll('${WORKSPACE:-$HOME}', workspace)
    const t0 = Date.now()
    let entry = { item: c.item, cmd: `rw_exec ${machine.name || machine.host}: ${cmd}`, channel, ms: 0, ok: false }
    try {
      const r = await tools.execute({
        callId: 'harnessams-check-' + Math.random().toString(36).slice(2, 8),
        name: 'rw_exec',
        arguments: { command: cmd },
        signal: AbortSignal.timeout(30000),
        ...(agent ? { agent } : {}),
      })
      const text = resultText(r)
      if (r?.isError) {
        entry.detail = text.slice(0, 200) || 'rw_exec returned an error'
      } else {
        const p = parseRwExecText(text)
        entry.ok = p.exitCode === 0 && !p.timedOut && c.judge(p.stdout)
        entry.result = (p.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 200)
        if (!entry.ok) entry.detail = (p.timedOut ? 'timed out; ' : '') + (p.stderr || `exit code ${p.exitCode}`).slice(0, 200)
      }
    } catch (e) {
      entry.detail = String(e?.message ?? e).slice(0, 200)
    }
    entry.ms = Date.now() - t0
    results.push(entry)
  }
  return { channel, results }
}
