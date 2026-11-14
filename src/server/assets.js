// Digital assets: the single shared plotly.min.js, served from the plugin package
// under /harnessams/assets/. Whitelist-by-lookup (no path traversal), immutable
// caching with a size-based ETag — files never change in place (they ship in the
// tarball), so content-addressed busting on upgrade happens via the package
// version instead.
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

// The vendored .js packages the plugin ships, with their licenses — the console's
// asset area lists exactly these plus where each copy lives. Keep in sync with the
// ALLOWED whitelist and THIRD_PARTY_NOTICES.md. (The vendored xterm bundle was
// removed with the dsh-remote terminal — see THIRD_PARTY_NOTICES.md.)
const VENDORED = [
  { file: 'plotly.min.js', label: 'plotly.js', license: 'MIT' },
]
const COPY_NAMES = new Set(VENDORED.map((v) => v.file))
const SCAN = { maxDepth: 6, maxDirs: 4000, maxCopies: 100 }

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

// Status for the console's asset area: the package copies (always), plus — when a
// workspace root is given — a bounded scan for stray copies of the vendored files
// inside the workspace.
export function assetsStatus(wsRoot = null) {
  const plotlyPath = ALLOWED.get('plotly.min.js')
  let available = false, bytes = 0
  try {
    const st = fs.statSync(plotlyPath)
    available = true
    bytes = st.size
  } catch { /* shipped file missing */ }
  const found = wsRoot ? scanCopies(wsRoot) : new Map()
  const packages = VENDORED.map((v) => {
    const abs = ALLOWED.get(v.file)
    let pkg = null
    try { pkg = { path: abs, bytes: fs.statSync(abs).size } } catch { /* shipped file missing */ }
    return { ...v, url: '/harnessams/assets/' + v.file, pkg, copies: found.get(v.file) ?? [] }
  })
  return {
    plotly: {
      available,
      bytes,
      url: '/harnessams/assets/plotly.min.js',
      notes_url: '/harnessams/assets/THIRD_PARTY_NOTICES.md',
    },
    packages,
  }
}

// Bounded workspace walk for copies of the vendored files: depth-capped, skips dot
// directories and node_modules (recycle bin included via its dot name), stat-only —
// never reads file bodies. The package's own copies live in ASSET_DIR, outside the
// workspace, so every hit is a workspace copy by construction.
function scanCopies(root) {
  const found = new Map()
  let dirs = 0
  const push = (name, p) => {
    const list = found.get(name) ?? []
    if (list.length >= SCAN.maxCopies) return
    try { list.push({ path: p, bytes: fs.statSync(p).size }); found.set(name, list) } catch { /* raced away */ }
  }
  const walk = (dir, depth) => {
    if (depth > SCAN.maxDepth || dirs >= SCAN.maxDirs) return
    dirs++
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return /* unreadable: skip */ }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        walk(p, depth + 1)
      } else if (e.isFile() && COPY_NAMES.has(e.name)) {
        push(e.name, p)
      }
    }
  }
  walk(root, 0)
  return found
}
