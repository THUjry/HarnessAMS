// Remote directory browser for the project-settings remote-root picker
// (2026-11-18; merged into the remote root row 2026-11-21): picking the root
// walks the machine's real tree through the dsh-ssh exec funnel
// (../remote.js execRemote — alias addressing, timeout-KILL wrapper, error
// attribution). One level per call, directories only, bounded listing. The
// default root is the project's settings.remote_root (passed by the route);
// with NO root configured yet the listing bootstraps at the machine's $HOME —
// the picker must work before any root is saved (the free-typed input is
// retired, so browsing is the only way to set the first root).
// 2026-11-26: the listing carries each directory's mtime (the picker's age
// column) and the browser gained a create side — remoteMkdir, fenced to one
// validated printable-ASCII segment under the currently listed directory.
import { execRemote, shq, resolveMachine, lookupMachine } from '../channel/remote.js'

const MAX_ENTRIES = 200

// POSIX dirname over a normalized absolute remote path ("/" has no parent).
export function remoteParent(dir) {
  const d = String(dir ?? '').replace(/\/+$/, '')
  if (d === '' || d === '/') return null
  const up = d.slice(0, d.lastIndexOf('/'))
  return up === '' ? '/' : up
}

// Parse the listing stdout into { name, mtime } entries. The primary command
// is `find -L … -printf '%P\t%T@'` (name TAB epoch-seconds); the plain
// `ls -1p` fallback emits `name/` lines with no mtime (→ null — the UI shows
// a dash). Files and anything unparsable are dropped — this picker only
// chooses directories.
export function parseListing(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^(.+)\t(-?\d+(?:\.\d+)?)$/) // greedy: a tab inside a name stays in the name
    if (m) {
      const name = m[1]
      if (name && !name.includes('/')) out.push({ name, mtime: Math.round(Number(m[2])) })
      continue
    }
    if (line.endsWith('/')) {
      const name = line.slice(0, -1)
      if (name && !name.includes('/')) out.push({ name, mtime: null })
    }
  }
  return out
}

// Validate a single directory name for creation through the browser: one
// path segment, printable ASCII only (the mkdir POST is the one write the
// browser offers — keep it quoting-trivial and locale-safe). Trimmed, 1..64
// chars, no "/" (single segment), no leading "." (hidden directories are not
// listed, so creating one would make it invisible in the picker). Every
// message starts with "name " so the route can map them to 400.
export function validateDirName(name) {
  const n = String(name ?? '').trim()
  if (!n) throw new Error('name must not be empty')
  if (n.length > 64) throw new Error('name too long (max 64 chars)')
  if (n.includes('/')) throw new Error('name must not contain "/" (a single path segment)')
  if (n.startsWith('.')) throw new Error('name must not start with "." — hidden directories are not listed by the browser')
  if (!/^[\x20-\x7E]+$/.test(n)) throw new Error('name must be printable ASCII only (0x20-0x7E)')
  return n
}

// Resolve a machineId to an alias through the dsh-ssh registry alone — used
// by the no-root bootstrap and by remoteMkdir, both of which know their
// target path explicitly and need no root fence. The shared registry lookup
// (channel/remote.js lookupMachine) throws the same error shapes everywhere.
async function aliasFromRegistry(ctx, machineId) {
  return (await lookupMachine(ctx, machineId)).id
}

// Shared dir validation for both halves of the browser: absolute, no "..",
// bounded length. Returns the normalized path (trailing slashes collapsed;
// "/" stays "/"). Every message starts with "dir " so the route can map them
// to 400.
function normalizeRemoteDir(dir) {
  const target = String(dir ?? '').trim().replace(/\\/g, '/')
  if (!target.startsWith('/')) {
    throw new Error(`dir must be an absolute remote path (starts with "/"): ${target || '(empty)'}`)
  }
  if (target.includes('..')) throw new Error('dir must not contain ".."')
  if (target.length > 400) throw new Error('dir too long (max 400 chars)')
  return target.replace(/\/+$/, '') || '/'
}

// List one remote directory level. `remoteRoot` (the project's
// settings.remote_root) is the default listing root; dir must be absolute.
// Returns { dir, parent, entries, truncated } where each entry is
// { name, mtime } (mtime = epoch seconds, or null when the plain-ls fallback
// produced the listing); every failure mode throws with an attributable
// message (the route maps it to a status code).
export async function remoteBrowse(ctx, machineId, dir, remoteRoot) {
  const root = typeof remoteRoot === 'string' ? remoteRoot.trim().replace(/\\/g, '/') : ''
  let alias
  let startRoot = ''
  if (root.startsWith('/')) {
    ({ alias } = await resolveMachine(ctx, machineId, root))
    startRoot = root
  } else {
    // no saved root yet: resolve the machine from the registry alone and
    // bootstrap the listing at the remote $HOME
    alias = await aliasFromRegistry(ctx, machineId)
    const r = await execRemote(ctx, alias, 'echo -n "$HOME"', { timeoutMs: 20_000 })
    const home = String(r.stdout ?? '').trim()
    if (!r.ok || !home.startsWith('/')) {
      throw new Error(`cannot determine the home directory on ${machineId} to start browsing — set settings.remote_root first`)
    }
    startRoot = home
  }
  const raw = String(dir ?? '').trim().replace(/\\/g, '/')
  const norm = normalizeRemoteDir(raw || startRoot)
  // -L dereferences symlinks so a symlinked DIRECTORY survives the dirs-only
  // filter (the cluster home keeps its real tree behind a symlink — live
  // finding on node1, 2026-11-21; with browse now the only way to set a root,
  // hiding it would block the machine's data tree). `-printf '%P\t%T@'`
  // carries each directory's epoch mtime for the picker's age column. The
  // plain-listing fallback (no mtime — the UI shows a dash) keeps a stray
  // broken symlink from failing the whole request: find -L exits 1 on those
  // just like ls -L exits 2. `! -name '.*'` mirrors ls's default
  // hidden-entry behavior (find would list dot-dirs unasked).
  const r = await execRemote(ctx, alias,
    `find -L ${shq(norm)} -maxdepth 1 -mindepth 1 -type d ! -name '.*' -printf '%P\\t%T@\\n' 2>/dev/null || ls -1p ${shq(norm)}`, { timeoutMs: 20000 })
  if (!r.ok) {
    throw new Error(`remote listing failed for ${norm}: ${r.timedOut ? 'timed out' : (r.stderr || r.text || `exit code ${r.exitCode}`)}`)
  }
  const entries = parseListing(r.stdout).sort((a, b) => a.name.localeCompare(b.name))
  return {
    dir: norm,
    parent: remoteParent(norm),
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  }
}

// Create one directory under the browser's currently listed dir (POST
// /api/remote-browse/mkdir). Plain `mkdir` on purpose — no -p: an existing
// name errors with "File exists" and surfaces to the user instead of
// silently succeeding, and a vanished parent errors too. Returns
// { path } (the created absolute path); failures throw with the stderr text.
export async function remoteMkdir(ctx, machineId, dir, name) {
  const safe = validateDirName(name)
  const alias = await aliasFromRegistry(ctx, machineId)
  const norm = normalizeRemoteDir(dir)
  const target = norm === '/' ? '/' + safe : norm + '/' + safe
  const r = await execRemote(ctx, alias, `mkdir ${shq(target)}`, { timeoutMs: 20000 })
  if (!r.ok) {
    throw new Error(`remote mkdir failed for ${target}: ${r.timedOut ? 'timed out' : (r.stderr || r.text || `exit code ${r.exitCode}`)}`)
  }
  return { path: target }
}
