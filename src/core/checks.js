// Local environment checks. The per-machine remote check buttons were retired
// with the Overview health-check panel (2026-11-18): the project-settings +
// self-check block is the Overview's single entry now, and this module feeds
// two consumers — the "list local environment" button and the AGENTS.md
// project-config sync (agentsmd.js localEnvFacts).
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveScriptsSource } from './settings.js'
import { execFileAsync } from '../lib/io.js'

// One python probe: version + absolute executable + the numpy tri-state in a
// single call (sys.executable is the interpreter's own path — no PATH
// guessing, which the old `python --version` row could not provide). The
// numpy leg answers yes / fallback / no (D-002): native `import numpy`; else
// the staged numfallback asset (assetsDir as argv[1]) imports; else neither
// (a python 2 shell where even the pure-stdlib fallback has py3 syntax).
// Falls back to `--version` (path empty, numpy unmeasured) for exotic shells;
// throws only when both probes fail.
const PROBE_CODE = [
  'import sys',
  'print(sys.version.split()[0])',
  'print(sys.executable)',
  'try:',
  '    import numpy',
  '    print("yes")',
  'except Exception:',
  '    try:',
  '        if len(sys.argv) > 1 and sys.argv[1]:',
  '            sys.path.insert(0, sys.argv[1])',
  '        import numfallback',
  '        print("fallback")',
  '    except Exception:',
  '        print("no")',
].join('\n')

async function probePython(assetsDir) {
  try {
    const { stdout } = await execFileAsync('python', ['-c', PROBE_CODE, assetsDir ?? ''], { timeout: 15000 })
    const [version, exe, numpy] = stdout.trim().split(/\r?\n/)
    if (version) {
      return {
        version: version.trim(),
        path: (exe ?? '').trim(),
        numpy: ['yes', 'no', 'fallback'].includes(numpy) ? numpy : null,
      }
    }
  } catch { /* fall through to --version */ }
  const { stdout } = await execFileAsync('python', ['--version'], { timeout: 15000 })
  return { version: stdout.trim().replace(/^Python\s+/i, ''), path: '', numpy: null }
}

// Node + python facts for the AGENTS.md config table, the local-env rows, and
// the finalize-side measurement (persistLocalFacts). Never throws: a missing
// python degrades to empty strings plus .error so one absent interpreter
// cannot fail a config sync. `projectPath` anchors the numfallback probe at
// the assets bucket BESIDE THE RESOLVED SCRIPTS ROOT (2026-11-26
// package-path-first policy: the package layout's own assets/ is the source
// of truth now — a project-local root still carries its own sibling bucket);
// without one the fallback leg is skipped and the numpy answer degrades to
// yes/no.
export async function localEnvFacts(projectPath) {
  const node = { version: process.version, path: process.execPath }
  const assetsDir = typeof projectPath === 'string' && projectPath
    ? path.join(resolveScriptsSource(projectPath), '..', 'assets')
    : null
  const p = await probePython(assetsDir).catch((e) => ({ error: String(e?.message ?? e) }))
  const python = { version: p?.version ?? '', path: p?.path ?? '', numpy: p?.numpy ?? null, error: p?.error ?? '' }
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
    const p = await probePython(path.join(root, '.harnessams', 'assets'))
    return { result: 'Python ' + p.version, detail: (p.path || '(executable path not resolved)')
      + (p.numpy ? `, numpy: ${p.numpy}` : '') }
  })
  await t('Disk capacity (workspace)', async () => {
    const st = await fsp.statfs(root)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!total) throw new Error('statfs returned 0')
    const row = { result: `${(total / 2 ** 30).toFixed(1)} GiB total, ${(free / 2 ** 30).toFixed(1)} GiB free`
      + ` (${(100 * (total - free) / total).toFixed(0)}% used)` }
    // `warn` only when it applies: an own key holding undefined fails the tool
    // registry's lossless-JSON check, so the env rows must stay JSON-clean
    // (they are the harnessams_selfcheck action=env tool result).
    if (free / total < 0.1) row.warn = 'free space < 10%'
    return row
  })
  await t('Workspace writable', async () => {
    const probe = path.join(root, '.write_probe')
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe)
    return { result: 'writable' }
  })
  return results
}
