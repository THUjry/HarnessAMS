// Local workspace disk usage: first-level directories under the configured workspace_root,
// largest first. Remote nodes' du lines come from the check command set in checks.js.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export async function localDiskUsage(ws) {
  const root = ws?.config?.workspace_root
  if (!root || !(await fsp.stat(root).catch(() => null))) return []
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(root, e.name)
    let bytes = 0, files = 0
    const walk = async (d) => {
      let dirs = []
      try {
        for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
          const q = path.join(d, ent.name)
          if (ent.isDirectory()) dirs.push(q)
          else { try { bytes += (await fsp.stat(q)).size; files++ } catch { /* skip */ } }
        }
      } catch { /* permissions etc. */ }
      await Promise.all(dirs.map(walk))
    }
    await walk(p)
    out.push({ name: e.name, bytes, files })
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, 20)
}

// Demo/project directories under the workspace root (sweeps and HTML reports), for the
// console page's report library.
export async function workspaceDirs(ws) {
  const root = ws?.config?.workspace_root
  if (!root || !fs.existsSync(root)) return []
  const demos = []
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const p = path.join(root, e.name)
    demos.push({
      name: e.name,
      has_sweep: fs.existsSync(path.join(p, 'sweep')),
      reports: fs.existsSync(path.join(p, 'Analysis'))
        ? (await fsp.readdir(path.join(p, 'Analysis'))).filter((f) => f.endsWith('.html'))
        : [],
    })
  }
  return demos
}
