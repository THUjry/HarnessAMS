// Remote projects (2026-10-26 business-logic rework): remote connectivity is delegated
// entirely to dsh-remote — this plugin keeps no server registry and no ssh channel of
// its own. A "remote project" is simply a DSH workspace whose path lies inside a
// dsh-remote local mirror (~/.dsh/remote-workspaces/<host>-<user>-<port>/<ws>, marked
// by a .dsh-remote-meta.json); one remote project per machine is the recommended
// setup, so most users never need more than one. The mirror's remotePath is the scope
// boundary for every remote command this plugin runs (checks interpolate it as
// $WORKSPACE). Remote projects carry no HarnessAMS UI (the sidebar is local-projects
// only, 2026-10-27): their role is to anchor the connection — sessions opened in the
// remote project bind dsh-remote's rw_* tools to that machine, and the local project's
// Overview checks borrow one of those sessions as the agent context. Remote file
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

// The remote-project workspace that belongs to a dsh-remote machine record: a
// registered DSH workspace whose path resolves into a mirror with the same
// host+port+username. Returns { ws, rp } or null. Degrades to null (never throws)
// when the registry service is missing.
export function findRemoteProjectForMachine(ctx, machine, root) {
  const registry = ctx?.workspaceRegistry
  let workspaces = []
  try { workspaces = typeof registry?.list === 'function' ? registry.list() : [] } catch { workspaces = [] }
  for (const w of workspaces) {
    const rp = remoteProjectFor(w?.path, root)
    if (rp && machineForProject([machine], rp)) return { ws: w, rp }
  }
  return null
}

// Machines checkable from a LOCAL project's Overview: every dsh-remote machine that
// HAS a remote project (a registered workspace inside its mirror), with that remote
// project's live-session count and ONE live-session id — checks borrow one of those
// sessions as the rw_* agent context (sessionInMirror in machines.js), and the remote
// terminal sub-tab passes the same id to dsh-remote's /dsh-remote/term/* routes as the
// binding hint so the PTY opens on THAT machine. Machines without a remote project
// are not listed; the tier-1 console offers their creation.
export function checkMachinesForLocal(ctx, machineList, root) {
  const out = []
  for (const m of machineList ?? []) {
    const hit = findRemoteProjectForMachine(ctx, m, root)
    if (!hit) continue
    const live = projectSessions(ctx, hit.ws.path)
    out.push({
      id: m.id,
      name: m.name || m.host,
      host: m.host,
      port: m.port,
      username: m.username ?? '',
      remotePath: hit.rp.remotePath,
      mirrorDir: hit.rp.mirrorDir,
      projectTitle: hit.ws.title || hit.ws.path,
      workspace: m.workspace ?? null,
      current: !!m.current,
      liveSessions: live.length,
      sessionId: live[0]?.id ?? null,
      ...(m.lastConnectedAt ? { lastConnectedAt: String(m.lastConnectedAt) } : {}),
      ...(m.latencyMs != null ? { latencyMs: Number(m.latencyMs) } : {}),
    })
  }
  return out
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

// One-click remote-project creation (tier 1): register a machine's EXISTING dsh-remote
// mirror as a DSH workspace via workspaceRegistry — the mirror itself is never created
// here (the ensure-mirror POST was removed 2026-10-28: sending {machineId} without a
// path is a guaranteed 400 on dsh-remote's /dsh-remote/mirror, so it never worked).
// Mirrors are born when the user picks a remote workspace in dsh-remote itself
// (rw_pick_workspace or its picker UI); a machine without one gets an actionable
// error. One remote project per machine, at the mirror root. Never switches
// dsh-remote's global active machine and never stores credentials.
export async function createRemoteProject(ctx, machine, root = remoteWorkspacesRoot()) {
  if (!machine || (!machine.id && !machine.host)) return { error: 'machine record required' }
  const mirror = findMirrorForMachine(machine, root)
  if (!mirror) {
    return { error: `no local mirror for machine ${machine.name || machine.host} — `
      + `pick a remote workspace in dsh-remote first (rw_pick_workspace or its picker), then retry here` }
  }
  const registry = ctx?.workspaceRegistry
  if (!registry || typeof registry.create !== 'function') return { error: 'workspaceRegistry service unavailable' }
  const existing = (typeof registry.list === 'function' ? registry.list() : []).find((w) => {
    const p = norm(w?.path)
    const m = norm(mirror.mirrorDir)
    return p === m || p.startsWith(m + '/')
  })
  if (existing) {
    return { workspace: { id: existing.id, path: existing.path, title: existing.title }, created: false }
  }
  const w = await registry.create(mirror.mirrorDir, `${machine.name || machine.host} (remote)`)
  return { workspace: { id: w.id, path: w.path, title: w.title }, created: true }
}
