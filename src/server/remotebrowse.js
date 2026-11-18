// Remote directory browser for the project-settings working-directory picker
// (2026-11-18): the old free-typed text input is gone; picking a remote work
// dir now walks the machine's real tree through the dsh-ssh exec funnel
// (../remote.js execRemote — alias addressing, timeout-KILL wrapper, error
// attribution). One level per call, directories only, bounded listing.
import { execRemote, shq, resolveMachine } from '../remote.js'

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

// List one remote directory level. dir defaults to the machine's configured
// remote root and must be absolute. Returns { dir, parent, dirs, truncated };
// every failure mode throws with an attributable message (the route maps it
// to a status code).
export async function remoteBrowse(ctx, machineId, dir) {
  const { machine, alias, remoteRoot } = await resolveMachine(ctx, machineId)
  let target = String(dir ?? '').trim().replace(/\\/g, '/')
  if (!target) target = remoteRoot
  if (!target.startsWith('/')) {
    throw new Error(`dir must be an absolute remote path (starts with "/"): ${target || '(empty)'}`)
  }
  if (target.includes('..')) throw new Error('dir must not contain ".."')
  if (target.length > 400) throw new Error('dir too long (max 400 chars)')
  const norm = target.replace(/\/+$/, '') || '/'
  const r = await execRemote(ctx, alias, 'ls -1p ' + shq(norm), { timeoutMs: 20000 })
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
