// Local environment checks. The per-machine remote check buttons were retired
// with the Overview health-check panel (2026-11-18): the project-settings +
// self-check block is the Overview's single entry now, and this module feeds
// two consumers — the "list local environment" button and the AGENTS.md
// project-config sync (agentsmd.js localEnvFacts).
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// One python probe: version + absolute executable in a single call
// (sys.executable is the interpreter's own path — no PATH guessing, which the
// old `python --version` row could not provide). Falls back to `--version`
// (path stays empty) for exotic shells; throws only when both probes fail.
async function probePython() {
  try {
    const { stdout } = await execFileAsync('python',
      ['-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)'], { timeout: 15000 })
    const [version, exe] = stdout.trim().split(/\r?\n/)
    if (version) return { version: version.trim(), path: (exe ?? '').trim() }
  } catch { /* fall through to --version */ }
  const { stdout } = await execFileAsync('python', ['--version'], { timeout: 15000 })
  return { version: stdout.trim().replace(/^Python\s+/i, ''), path: '' }
}

// Node + python facts ({ version, path } each) for the AGENTS.md config table
// and the local-env rows. Never throws: a missing python degrades to empty
// strings plus .error so one absent interpreter cannot fail a config sync.
export async function localEnvFacts() {
  const node = { version: process.version, path: process.execPath }
  const p = await probePython().catch((e) => ({ error: String(e?.message ?? e) }))
  const python = { version: p?.version ?? '', path: p?.path ?? '', error: p?.error ?? '' }
  return { node, python }
}

// `rootPath` anchors the disk-capacity and writability rows — the project root
// (the family workspace_root config is retired; the Overview passes the
// session's project path).
export async function runLocalChecks(rootPath) {
  const root = typeof rootPath === 'string' && rootPath ? rootPath : process.cwd()
  const results = []
  const t = async (name, fn) => {
    const t0 = Date.now()
    try { results.push({ item: name, ...(await fn()), ms: Date.now() - t0, ok: true }) }
    catch (e) { results.push({ item: name, ok: false, detail: String(e.message ?? e), ms: Date.now() - t0 }) }
  }
  await t('Connectivity (local)', async () => ({ result: 'local', detail: os.hostname() }))
  // Node/Python carry the absolute executable path in .detail — the AGENTS.md
  // config table stores version + path, and the row keeps the same facts.
  await t('Node', async () => ({ result: process.version, detail: process.execPath }))
  await t('Python', async () => {
    const p = await probePython()
    return { result: 'Python ' + p.version, detail: p.path || '(executable path not resolved)' }
  })
  await t('Disk capacity (workspace)', async () => {
    const st = await fsp.statfs(root)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!total) throw new Error('statfs returned 0')
    return { result: `${(total / 2 ** 30).toFixed(1)} GiB total, ${(free / 2 ** 30).toFixed(1)} GiB free`
             + ` (${(100 * (total - free) / total).toFixed(0)}% used)`,
             warn: free / total < 0.1 ? 'free space < 10%' : undefined }
  })
  await t('Workspace writable', async () => {
    const probe = path.join(root, '.write_probe')
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe)
    return { result: 'writable' }
  })
  return results
}
