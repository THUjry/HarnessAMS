// Remote projects (2026-10-26 business-logic rework): remote connectivity is delegated
// entirely to dsh-remote — this plugin keeps no server registry and no ssh channel of
// its own. A "remote project" is simply a DSH workspace whose path lies inside a
// dsh-remote local mirror (~/.dsh/remote-workspaces/<host>-<user>-<port>/<ws>, marked
// by a .dsh-remote-meta.json); one remote project per machine is the recommended
// setup, so most users never need more than one. The mirror's remotePath is the scope
// boundary for every remote command this plugin runs (checks interpolate it as
// $WORKSPACE). Sessions opened in the remote project are what bind dsh-remote's rw_*
// tools to that machine — the health checks pass the sidebar's own session as the
// agent context, so no cross-project session borrowing is involved. Remote file
// browsing/editing is deliberately NOT duplicated here: use dsh-remote's own file
// tools and web surface for that.
import fs from 'node:fs'
import path from 'node:path'
import { remoteWorkspacesRoot, findMirrorForMachine } from './machines.js'

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// Classify a DSH workspace: walk up from its path to the nearest
// .dsh-remote-meta.json (deepest mirror wins, matching dsh-remote's resolveMirror).
// Returns { mirrorDir, host, port, username, remotePath } or null for a local project.
export function remoteProjectFor(workspacePath, root = remoteWorkspacesRoot()) {
  if (!workspacePath || typeof workspacePath !== 'string') return null
  const rootNorm = path.resolve(root)
  const insideRoot = (p) => {
    const rel = path.relative(rootNorm, p)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  let dir = path.resolve(workspacePath)
  while (insideRoot(dir)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-remote-meta.json'), 'utf8'))
      if (meta?.host) {
        return {
          mirrorDir: dir,
          host: String(meta.host),
          port: Number(meta.port) || 22,
          username: String(meta.username ?? ''),
          remotePath: String(meta.remotePath ?? ''),
        }
      }
    } catch { /* no meta at this level — keep walking up */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// Match the dsh-remote machine record (from fetchMachines) that a remote project's
// mirror belongs to — identity is host + port + username, like findMirrorForMachine.
export function machineForProject(machineList, rp) {
  if (!rp) return null
  for (const m of machineList ?? []) {
    if (String(m.host ?? '').toLowerCase() !== String(rp.host).toLowerCase()) continue
    if ((Number(m.port) || 22) !== rp.port) continue
    const mu = String(m.username ?? '').toLowerCase()
    if (mu && rp.username && mu !== rp.username.toLowerCase()) continue
    return m
  }
  return null
}

// The agent context for the rw_* tool shell, taken from a REAL live session — the
// tool pipeline validates the session object against the live store (a fabricated
// {header} object is rejected), so only sessions.get() results work. For checks this
// is the sidebar's own session; its cwd already sits inside the project's mirror,
// which is what binds rw_exec to the project's machine.
export function agentForSession(ctx, sessionId) {
  const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : null
  if (!sessions || typeof sessions.get !== 'function') return null
  let s = null
  try { s = sessions.get(sessionId) } catch { return null }
  if (!s || typeof s?.header?.cwd !== 'string') return null
  return { agent: { session: s } }
}

// Live sessions whose cwd sits inside one workspace path (the remote project's own
// sessions — the "connection keepers" in the remote-project model).
export function projectSessions(ctx, workspacePath) {
  const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : null
  if (!sessions || typeof sessions.list !== 'function') return []
  let live = []
  try { live = sessions.list() } catch { return [] }
  const root = norm(workspacePath)
  if (!root) return []
  return live.filter((s) => {
    const cwd = norm(s?.header?.cwd)
    return cwd && (cwd === root || cwd.startsWith(root + '/'))
  })
}

// One-click remote-project creation (tier 1): ensure the machine has a local mirror
// (dsh-remote's own POST /dsh-remote/mirror, reached same-origin with the browser's
// credentials forwarded), then register the mirror directory as a DSH workspace via
// workspaceRegistry — one remote project per machine, at the mirror root. Never
// switches dsh-remote's global active machine and never stores credentials.
export async function createRemoteProject(ctx, machine, req, fetchImpl = fetch, root = remoteWorkspacesRoot()) {
  if (!machine || (!machine.id && !machine.host)) return { error: 'machine record required' }
  let mirror = findMirrorForMachine(machine, root)
  let createdMirror = false
  if (!mirror) {
    const host = req?.headers?.host ?? '127.0.0.1:3080'
    const headers = { 'content-type': 'application/json' }
    if (req?.headers?.cookie) headers.cookie = req.headers.cookie
    if (req?.headers?.authorization) headers.authorization = req.headers.authorization
    let res = null
    try {
      res = await fetchImpl(`http://${host}/dsh-remote/mirror`, {
        method: 'POST', headers, body: JSON.stringify({ machineId: machine.id }),
        signal: AbortSignal.timeout(20000),
      })
    } catch { res = null }
    if (!res?.ok) {
      return { error: `dsh-remote mirror creation failed (HTTP ${res?.status ?? 'network error'}) — `
        + `pick a remote workspace once in dsh-remote (rw_pick_workspace) so the machine has a local mirror` }
    }
    mirror = findMirrorForMachine(machine, root)
    if (!mirror) return { error: 'mirror route responded OK but no mirror was found afterwards' }
    createdMirror = true
  }
  const registry = ctx?.workspaceRegistry
  if (!registry || typeof registry.create !== 'function') return { error: 'workspaceRegistry service unavailable' }
  const existing = (typeof registry.list === 'function' ? registry.list() : []).find((w) => {
    const p = norm(w?.path)
    const m = norm(mirror.mirrorDir)
    return p === m || p.startsWith(m + '/')
  })
  if (existing) {
    return { workspace: { id: existing.id, path: existing.path, title: existing.title }, created: false, createdMirror }
  }
  const w = await registry.create(mirror.mirrorDir, `${machine.name || machine.host} (remote)`)
  return { workspace: { id: w.id, path: w.path, title: w.title }, created: true, createdMirror }
}
