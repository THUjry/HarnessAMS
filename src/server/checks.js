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
  { id: 'du', item: 'Disk usage detail', cmd: 'du -sh ${WORKSPACE:-$HOME}/* 2>/dev/null | sort -rh | head -20', judge: () => true },
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
