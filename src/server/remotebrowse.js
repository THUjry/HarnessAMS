// Remote directory browser for the project-settings remote-root picker
// (2026-11-18; merged into the remote root row 2026-11-21): picking the root
// walks the machine's real tree through the dsh-ssh exec funnel
// (../remote.js execRemote — alias addressing, timeout-KILL wrapper, error
// attribution). One level per call, directories only, bounded listing. The
// default root is the project's settings.remote_root (passed by the route);
// with NO root configured yet the listing bootstraps at the machine's $HOME —
// the picker must work before any root is saved (the free-typed input is
// retired, so browsing is the only way to set the first root).
import { execRemote, shq, resolveMachine, listMachines } from '../remote.js'

const MAX_ENTRIES = 200

// POSIX dirname over a normalized absolute remote path ("/" has no parent).
export function remoteParent(dir) {
  const d = String(dir ?? '').replace(/\/+$/, '')
  if (d === '' || d === '/') return null
  const up = d.slice(0, d.lastIndexOf('/'))
  return up === '' ? '/' : up
}

// Parse `ls -1p` output into directory names (entries end in '/'; files and
// anything unparsable are dropped — this picker only chooses directories).
export function parseLsDirs(stdout) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.endsWith('/')) continue
    const name = line.slice(0, -1)
    if (name && !name.includes('/')) out.push(name)
  }
  return out
}

// List one remote directory level. `remoteRoot` (the project's
// settings.remote_root) is the default listing root; dir must be absolute.
// Returns { dir, parent, dirs, truncated }; every failure mode throws with an
// attributable message (the route maps it to a status code).
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
    const list = await listMachines(ctx)
    if (!list.ok) throw new Error(`dsh-ssh hosts unavailable: ${list.reason}`)
    const machine = list.machines.find((m) => m.id === machineId || m.name === machineId)
    if (!machine) throw new Error(`no such dsh-ssh host: ${machineId} (known: ${list.machines.map((m) => m.id).join(', ') || 'none'})`)
    alias = machine.id
    const r = await execRemote(ctx, alias, 'echo -n "$HOME"', { timeoutMs: 20_000 })
    const home = String(r.stdout ?? '').trim()
    if (!r.ok || !home.startsWith('/')) {
      throw new Error(`cannot determine the home directory on ${machineId} to start browsing — set settings.remote_root first`)
    }
    startRoot = home
  }
  let target = String(dir ?? '').trim().replace(/\\/g, '/')
  if (!target) target = startRoot
  if (!target.startsWith('/')) {
    throw new Error(`dir must be an absolute remote path (starts with "/"): ${target || '(empty)'}`)
  }
  if (target.includes('..')) throw new Error('dir must not contain ".."')
  if (target.length > 400) throw new Error('dir too long (max 400 chars)')
  const norm = target.replace(/\/+$/, '') || '/'
  // -L dereferences symlinks so a symlinked DIRECTORY lists with the trailing
  // '/' and survives the dirs-only filter (the cluster home keeps its real
  // tree behind a symlink — live finding on node1, 2026-11-21; with browse now
  // the only way to set a root, hiding it would block the machine's data
  // tree). The plain-listing fallback keeps a stray broken symlink from
  // failing the whole request (ls -L exits 2 on those).
  const r = await execRemote(ctx, alias,
    `ls -1pL ${shq(norm)} 2>/dev/null || ls -1p ${shq(norm)}`, { timeoutMs: 20000 })
  if (!r.ok) {
    throw new Error(`remote listing failed for ${norm}: ${r.timedOut ? 'timed out' : (r.stderr || r.text || `exit code ${r.exitCode}`)}`)
  }
  const names = parseLsDirs(r.stdout).sort((a, b) => a.localeCompare(b))
  return {
    dir: norm,
    parent: remoteParent(norm),
    dirs: names.slice(0, MAX_ENTRIES),
    truncated: names.length > MAX_ENTRIES,
  }
}
