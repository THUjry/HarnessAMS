// Sidebar Dashboard: serving the local HTML reports attached to a task (see
// project.js — reports[] in the task store) and the one-level directory listing
// behind the add-report browser dialog. A report may sit anywhere on the local
// disk; it is served read-only together with its sibling files (data/*.js,
// images) so relative references inside the document keep working — the
// report's own directory is the serving boundary, resolved per request through
// the workspace registry's task stores (the route carries no secrets: just
// opaque task/report ids).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readTasks } from './project.js'

// Reports load scripts next to themselves (gen_sweep_report emits
// data/Round<N>.js); a wrong MIME silently kills them, so types are by
// extension — never a blanket text/html.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function mimeFor(absPath) {
  return MIME_TYPES[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream'
}

// Resolve <taskId>/<reportId>/<rel> across every registered workspace's task
// store: rel is interpreted against the report file's own directory. Returns
// { abs } on success or { error, code } for the route to translate.
export async function resolveReportFile(registry, taskId, reportId, rel) {
  if (!registry || typeof registry.list !== 'function') {
    return { error: 'workspaceRegistry service unavailable', code: 503 }
  }
  for (const ws of registry.list()) {
    if (!ws?.path) continue
    const { tasks } = await readTasks(ws.path).catch(() => ({ tasks: [] }))
    const task = tasks.find((t) => t?.id === taskId)
    if (!task) continue
    const report = (task.reports ?? []).find((r) => r?.id === reportId)
    if (!report) continue
    const base = path.dirname(path.resolve(report.path))
    // empty rel = the report document itself (the iframe's trailing-slash URL);
    // anything else resolves against the report's own directory
    const abs = rel ? path.resolve(base, rel) : path.resolve(report.path)
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      return { error: 'forbidden', code: 403 }
    }
    return { abs }
  }
  return { error: 'report not found (task or report id unknown, or the report was removed)', code: 404 }
}

// One-level listing for the add-report dialog: subdirectories plus *.html
// files with sizes. Any readable local path is acceptable — this dialog is how
// a user points the dashboard at a report anywhere on disk. Dot-directories
// (.git, .harnessams, …) are hidden as picker noise.
export async function browseDir(target, fallback) {
  const raw = typeof target === 'string' && target.trim() ? target.trim() : (fallback ?? '.')
  const p = path.resolve(raw)
  let entries
  try {
    entries = await fsp.readdir(p, { withFileTypes: true })
  } catch (e) {
    return { error: `cannot list ${p}: ${e.code ?? e.message}` }
  }
  const dirs = []
  const htmls = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      dirs.push(e.name)
    } else if (e.isFile() && /\.html?$/i.test(e.name)) {
      const st = await fsp.stat(path.join(p, e.name)).catch(() => null)
      htmls.push({ name: e.name, bytes: st?.size ?? 0 })
    }
  }
  dirs.sort((a, b) => a.localeCompare(b))
  htmls.sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(p)
  return { path: p, parent: parent !== p ? parent : null, dirs, htmls }
}
