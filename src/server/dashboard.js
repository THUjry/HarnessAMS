// Sidebar Dashboard: serving the local HTML reports attached to a session (see
// project.js — reports[] in the per-session config store). A report may sit
// anywhere on the local disk; it is served read-only together with its sibling
// files (data/*.js, images) so relative references inside the document keep
// working — the report's own directory is the serving boundary, resolved per
// request through the workspace registry's session stores (the route carries
// no secrets: just opaque session/report ids). The add-report picking surface
// (host folder chooser, native file dialog, one-level listing) lives in
// src/picker.js since 2026-11-26.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readSessionConfigs } from './project.js'

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

// Resolve <sessionId>/<reportId>/<rel> across every registered workspace's
// session store: rel is interpreted against the report file's own directory.
// Returns { abs } on success or { error, code } for the route to translate.
export async function resolveReportFile(registry, sessionId, reportId, rel) {
  if (!registry || typeof registry.list !== 'function') {
    return { error: 'workspaceRegistry service unavailable', code: 503 }
  }
  for (const ws of registry.list()) {
    if (!ws?.path) continue
    const { sessions } = await readSessionConfigs(ws.path).catch(() => ({ sessions: {} }))
    const entry = sessions[sessionId]
    if (!entry) continue
    const report = (entry.reports ?? []).find((r) => r?.id === reportId)
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
  return { error: 'report not found (session or report id unknown, or the report was removed)', code: 404 }
}
