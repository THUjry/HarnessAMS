// Digital assets: the single shared plotly.min.js served from the plugin package under
// /harnessams/assets/. Whitelist-by-lookup (no path traversal), immutable caching with a
// size-based ETag — the file never changes in place (it ships in the tarball), so
// content-addressed busting on upgrade happens via the package version instead.
import fs from 'node:fs'
import path from 'node:path'

const ASSET_DIR = path.resolve(import.meta.dirname ?? '.', '../assets')
const ALLOWED = new Map([
  ['plotly.min.js', path.join(ASSET_DIR, 'plotly.min.js')],
  ['THIRD_PARTY_NOTICES.md', path.join(ASSET_DIR, 'THIRD_PARTY_NOTICES.md')],
])
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}
const cache = new Map()

function load(name) {
  if (cache.has(name)) return cache.get(name)
  const body = fs.readFileSync(ALLOWED.get(name))
  const entry = { body, type: TYPES[path.extname(name)] ?? 'application/octet-stream', size: body.length }
  cache.set(name, entry)
  return entry
}

// GET/HEAD handler for /harnessams/assets/<name>; responds itself.
export function serveAsset(req, res, name) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return
  }
  const decoded = decodeURIComponent(name)
  if (!ALLOWED.has(decoded)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown asset' })); return }
  let entry
  try { entry = load(decoded) } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e?.message ?? e) })); return
  }
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': entry.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': '"' + entry.size + '"',
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(entry.body)
}

// Status for the console's asset area.
export function assetsStatus() {
  const plotlyPath = ALLOWED.get('plotly.min.js')
  let available = false, bytes = 0
  try {
    const st = fs.statSync(plotlyPath)
    available = true
    bytes = st.size
  } catch { /* shipped file missing */ }
  return {
    plotly: {
      available,
      bytes,
      url: '/harnessams/assets/plotly.min.js',
      notes_url: '/harnessams/assets/THIRD_PARTY_NOTICES.md',
    },
  }
}
