// Workspace trash (safety by default): deletion never destroys. JS port of the
// former scripts/common/common_trash.py (2026-11-09) with the two sharp edges
// filed down: restore/purge fence the entry name inside the trash root (the
// Python version accepted ../ traversal — and purge is a recursive delete), and
// every entry is now a DIRECTORY holding the item plus .trash_meta.json, so
// trashing a plain file no longer breaks meta writing. Entry layout and the
// list JSON shape stay compatible with entries created by the old script.
import fs from 'node:fs'
import path from 'node:path'
import { readWorkspaceConfig } from './batch.js'

export function trashDir() {
  const { config, dir } = readWorkspaceConfig()
  return config.trash_dir ? path.resolve(config.trash_dir) : path.join(dir, '.trash')
}

function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function movePath(src, dst) {
  try {
    fs.renameSync(src, dst)
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    // cross-device trash (another drive): copy + delete
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

function writeMetaAtomic(entryDir, meta) {
  const final = path.join(entryDir, '.trash_meta.json')
  const tmp = final + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, final)
}

function treeSize(p) {
  try {
    const st = fs.statSync(p)
    if (st.isFile()) return st.size
  } catch { return 0 }
  let total = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, ent.name)
      if (ent.isDirectory()) walk(q)
      else { try { total += fs.statSync(q).size } catch { /* unreadable */ } }
    }
  }
  try { walk(p) } catch { /* unreadable */ }
  return total
}

function rootOf(opts) { return path.resolve(opts?.trashDir ?? trashDir()) }

// Fence a restore/purge target: a single name segment, resolved strictly inside
// the trash root (realpath catches ../, absolute paths, drive letters and
// symlinked escapes alike).
function resolveEntry(trash, name) {
  const n = String(name ?? '')
  if (!n || n === '.' || n === '..' || /[\\/]/.test(n) || /^[A-Za-z]:/.test(n) || n.includes('\0')) {
    throw new Error(`invalid trash entry name: ${JSON.stringify(name)}`)
  }
  let entryReal
  try {
    entryReal = fs.realpathSync(path.join(trash, n))
  } catch {
    throw new Error(`no such trash entry: ${n}`)
  }
  const rootReal = fs.realpathSync(trash)
  if (entryReal !== rootReal && !entryReal.startsWith(rootReal + path.sep)) {
    throw new Error(`trash entry escapes the trash directory: ${n}`)
  }
  return entryReal
}

// Move paths into the trash. Each entry is <trash>/<stamp>_<basename>/ holding
// the moved item (under its own basename) plus .trash_meta.json.
export function trashPaths(paths, opts = {}) {
  const trash = rootOf(opts)
  fs.mkdirSync(trash, { recursive: true })
  const rootReal = fs.realpathSync(trash)
  const lines = []
  for (const raw of paths) {
    const abs = path.resolve(String(raw))
    if (!fs.existsSync(abs)) throw new Error(`path does not exist: ${abs}`)
    const base = path.basename(abs)
    if (!base) throw new Error(`cannot trash a filesystem root: ${abs}`)
    const real = fs.realpathSync(abs)
    if (real === rootReal || real.startsWith(rootReal + path.sep)) {
      throw new Error(`refusing to trash the trash directory itself: ${abs}`)
    }
    const stamp = nowStamp()
    let entry = path.join(trash, `${stamp}_${base}`)
    for (let i = 1; fs.existsSync(entry); i++) entry = path.join(trash, `${stamp}_${base}_x${i}`)
    fs.mkdirSync(entry)
    try {
      movePath(abs, path.join(entry, base))
      writeMetaAtomic(entry, { original_path: abs, trashed_at: stamp })
    } catch (e) {
      try { fs.rmSync(entry, { recursive: true, force: true }) } catch { /* best effort */ }
      throw e
    }
    lines.push(`trashed ${abs} -> ${entry}`)
  }
  return lines
}

// List entries: same JSON shape the Python script printed
// ([{name, original_path, trashed_at, size_bytes}]).
export function listTrash(opts = {}) {
  const trash = rootOf(opts)
  if (!fs.existsSync(trash)) return []
  const items = []
  for (const name of fs.readdirSync(trash).sort()) {
    const p = path.join(trash, name)
    let meta = {}
    try {
      meta = JSON.parse(fs.readFileSync(path.join(p, '.trash_meta.json'), 'utf8'))
    } catch { /* missing/unreadable meta (legacy file entries have none) */ }
    items.push({
      name,
      original_path: meta.original_path ?? null,
      trashed_at: meta.trashed_at ?? null,
      size_bytes: treeSize(p),
    })
  }
  return items
}

// Restore an entry back into destDir. New entries hold the item under its own
// basename inside the entry; legacy Python entries moved the item AS the entry
// (its children sit at the top level), so anything else restores the whole
// entry directory. The destination name strips the leading <date>_<time> stamp
// (the old script cut at the FIRST underscore, leaving 'HHMMSS_name' behind).
export function restoreEntry(name, destDir = '.', opts = {}) {
  const trash = rootOf(opts)
  if (!fs.existsSync(trash)) throw new Error(`no such trash entry: ${name}`)
  const entry = resolveEntry(trash, name)
  const dest = path.resolve(String(destDir ?? '.'))
  const stripped = /^\d{8}_\d{6}_(.+)$/.exec(name)?.[1]
    ?? (name.includes('_') ? name.split('_').slice(1).join('_') : name)
  const inner = fs.readdirSync(entry)
    .filter((f) => f !== '.trash_meta.json' && f !== '.trash_meta.json.tmp')
  let src, target
  if (inner.length === 1 && inner[0] === stripped) {
    src = path.join(entry, inner[0])
    target = path.join(dest, inner[0])
  } else {
    src = entry
    target = path.join(dest, stripped)
  }
  if (fs.existsSync(target)) throw new Error(`restore target already exists: ${target}`)
  fs.mkdirSync(dest, { recursive: true })
  movePath(src, target)
  if (src !== entry) fs.rmSync(entry, { recursive: true, force: true })
  return `restored -> ${target}`
}

// Really destroy one entry (explicit; there is no purge-all). resolveEntry
// fences the recursive delete inside the trash root.
export function purgeEntry(name, opts = {}) {
  const trash = rootOf(opts)
  if (!fs.existsSync(trash)) throw new Error(`no such trash entry: ${name}`)
  const entry = resolveEntry(trash, name)
  fs.rmSync(entry, { recursive: true, force: true })
  return `purged ${name}`
}

// Model-facing safe_trash tool (definition moved here from tools/shared.js on
// 2026-11-10 — it belongs with the mechanics it routes to).
export function safeTrashTool() {
  return {
    name: 'safe_trash',
    description: 'Workspace trash (safety by default): move paths into <workspace>/.trash instead of deleting, '
      + 'then list, restore, or explicitly purge an entry (restore/purge take an entry name exactly as list '
      + 'reports it; names are fenced inside the trash directory).',
    parameters: {
      action: { type: 'string', required: true, enum: ['trash', 'list', 'restore', 'purge'],
        description: 'trash | list | restore | purge' },
      path: { type: 'string', description: 'trash: path to move; restore/purge: trash entry name (from list)' },
      dest: { type: 'string', description: 'restore destination directory' },
    },
    async execute(args) {
      if (args.action === 'list') {
        const entries = listTrash()
        return { ok: true, entries, output: JSON.stringify(entries, null, 2) }
      }
      if (args.action === 'restore') {
        if (!args.path) return { ok: false, error: 'restore requires path=<trash entry name from list>' }
        return { ok: true, output: restoreEntry(String(args.path), args.dest ? String(args.dest) : '.') }
      }
      if (args.action === 'purge') {
        if (!args.path) return { ok: false, error: 'purge requires path=<trash entry name from list>' }
        return { ok: true, output: purgeEntry(String(args.path)) }
      }
      if (args.action === 'trash') {
        if (!args.path) return { ok: false, error: 'trash requires path=<file or directory>' }
        return { ok: true, output: trashPaths([String(args.path)]).join('\n') }
      }
      return { ok: false, error: `unknown action: ${args.action}` }
    },
  }
}
