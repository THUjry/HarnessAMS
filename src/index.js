// HarnessAMS top-level plugin host half: the /harnessams/* API surface backing the
// three-tier client UI (see client.js for the UI itself):
//   tier 1 (global console page) — remote projects (dsh-remote machines, mirrors,
//            one-click remote-project creation), digital assets, disk usage;
//   tier 2 (project = DSH workspace) — session-to-workspace mapping + per-project task
//            store at <workspace>/.harnessams/tasks.json; a workspace inside a
//            dsh-remote mirror is a REMOTE PROJECT (remote.js) and gets NO sidebar;
//   tier 3 (task sidebar, local projects only) — the task store API plus the Overview
//            health-check buttons, consumed per active session.
// Routes are not token-gated by the DSH web server (verified 2026-10-25): only local
// management reads/writes live here — no credentials, no remote-execution passthrough.
// Remote connectivity is delegated entirely to dsh-remote: remote checks run from a
// LOCAL project's Overview through the rw_exec tool shell, borrowing a live session
// of the target machine's remote project as the agent context (no global-machine
// switching). Remote file browsing/editing is NOT proxied here — dsh-remote's own
// tools and web surface do it.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findWorkspaceConfig } from './server/workspace.js'
import { runLocalChecks, runRemoteCheckButton, REMOTE_CHECK_BUTTONS } from './server/checks.js'
import { localDiskUsage, workspaceDirs } from './server/disk.js'
import { sessionProject, readTasks, writeTasks, clearTasksIfEmpty } from './server/project.js'
import { remoteMachinesStatus, fetchMachines, sessionInMirror } from './server/machines.js'
import { remoteProjectFor, checkMachinesForLocal, findRemoteProjectForMachine, createRemoteProject } from './server/remote.js'
import { serveAsset, assetsStatus } from './server/assets.js'

export const name = 'dsh-harnessams'
// workspaceRegistry/tools are required on the web composition (both ship with dsh-base);
// the handlers still guard against undefined so degraded embeds fail soft, not loud.
export const inject = ['webServer', 'workspaceRegistry', 'tools']

export function apply(ctx) {
  ctx.effect(() => {
    ctx.webServer.register({
      kind: 'prefix',
      path: '/harnessams',
      handler: (req, res) => { void handle(req, res, ctx).catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })) } catch { /* already responded */ } }) },
    }, 'harnessams routes')
    if (ctx.logger?.info) ctx.logger.info('[harnessams] routes mounted at /harnessams')
    else console.log('[harnessams] routes mounted at /harnessams')
  }, 'harnessams webserver routes')
}

async function readBodyJson(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function handle(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.replace(/^\/harnessams/, '') || '/'
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

  const ws = findWorkspaceConfig()

  // ---- static assets (plotly single copy; whitelist lookup) ----
  if (route.startsWith('/assets/')) {
    serveAsset(req, res, route.slice('/assets/'.length))
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Write surface is narrow by design: tasks (project data, local file write) and
    // remote-project creation (workspaceRegistry + same-origin dsh-remote route).
    if (req.method === 'PUT' && route === '/api/tasks') {
      const sessionId = url.searchParams.get('sessionId')
      const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
      if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const w = await writeTasks(project.path, body?.tasks)
      if (w.error) { json(400, { error: w.error }); return }
      await clearTasksIfEmpty(project.path)
      json(200, { ok: true, project, tasks: w.tasks })
      return
    }
    if (req.method === 'POST' && route === '/api/remote-project') {
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const machineId = body?.machineId
      if (!machineId) { json(400, { error: 'missing machineId' }); return }
      const list = await fetchMachines(ctx.tools, req)
      if (!list.ok) { json(503, { error: `dsh-remote machines unavailable: ${list.reason}` }); return }
      const m = list.machines.find((x) => x.id === machineId || x.name === machineId)
      if (!m) { json(404, { error: `no such dsh-remote machine: ${machineId}` }); return }
      const r = await createRemoteProject(ctx, m, req)
      if (r.error) { json(409, { error: r.error }); return }
      json(200, { ok: true, ...r })
      return
    }
    json(405, { error: 'GET only (PUT /api/tasks, POST /api/remote-project)' })
    return
  }

  if (route === '/api/info') {
    json(200, {
      ok: true, plugin: 'dsh-harnessams', workspace: ws ? { root: ws.config.workspace_root, config_path: ws.configPath } : null,
      tiers: {
        console: 'sidebar entry "HarnessAMS" (client half)',
        project: ctx.workspaceRegistry ? 'workspaceRegistry mapped' : 'workspaceRegistry unavailable (tier 2 degraded)',
        tasks: '/api/tasks?sessionId=…',
      },
    })
    return
  }

  // ---- tier 3 Overview: health-check surface (local projects; remote projects get
  // no sidebar, so their answer is a defensive stub for stale clients) ----
  if (route === '/api/checks') {
    const sessionId = url.searchParams.get('sessionId')
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    if (remoteProjectFor(project.path)) {
      json(200, { ok: true, type: 'remote', project, buttons: [], machines: [] })
      return
    }
    const list = await fetchMachines(ctx.tools, req)
    json(200, {
      ok: true, type: 'local', project,
      buttons: [{ id: 'local', item: 'Local environment' }],
      machines: list.ok ? checkMachinesForLocal(ctx, list.machines) : [],
      machinesTotal: list.ok ? (list.machines?.length ?? 0) : 0,
      machinesReason: list.ok ? null : list.reason,
    })
    return
  }
  if (route === '/api/checks/run') {
    const sessionId = url.searchParams.get('sessionId')
    const check = url.searchParams.get('check')
    const machineId = url.searchParams.get('machineId')
    if (!sessionId || !check) { json(400, { error: 'missing sessionId or check parameter' }); return }
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    if (check === 'local') {
      if (!ws) { json(503, { error: 'harnessams-workspace/harnessams.json not found' }); return }
      json(200, { ok: true, type: 'local', results: await runLocalChecks(ws) })
      return
    }
    if (!REMOTE_CHECK_BUTTONS.some((b) => b.id === check)) {
      json(400, { error: `unknown check: ${check} (buttons: ${REMOTE_CHECK_BUTTONS.map((b) => b.id).join(', ')}, local)` })
      return
    }
    if (!machineId) { json(400, { error: 'missing machineId — remote checks target a machine that has a remote project' }); return }
    if (remoteProjectFor(project.path)) {
      json(400, { error: 'remote checks run from a local project — the sidebar is disabled inside remote projects' })
      return
    }
    const list = await fetchMachines(ctx.tools, req)
    if (!list.ok) { json(503, { error: `dsh-remote machines unavailable: ${list.reason}` }); return }
    const machine = list.machines.find((m) => m.id === machineId || m.name === machineId)
    if (!machine) { json(404, { error: `no such dsh-remote machine: ${machineId}` }); return }
    const hit = findRemoteProjectForMachine(ctx, machine)
    if (!hit) {
      json(409, { error: `no remote project for machine ${machine.name ?? machine.host} — create one from the HarnessAMS console page first` })
      return
    }
    // Borrow a live session of that remote project: its cwd sits inside the machine's
    // mirror, which is what binds rw_exec to the machine (dsh-remote bindingFor).
    const agent = sessionInMirror(ctx, hit.rp.mirrorDir)
    if (!agent) {
      json(409, { error: `no live session in the remote project "${hit.ws.title ?? hit.ws.path}" — switch to it once so a session keeps the connection, then retry here` })
      return
    }
    try {
      const r = await runRemoteCheckButton(ctx.tools, check, { ...agent, remotePath: hit.rp.remotePath, ws })
      json(200, { ok: true, type: 'remote', channel: r.channel, results: r.results })
    } catch (e) { json(502, { error: String(e?.message ?? e) }) }
    return
  }

  // ---- tier 1: remote projects / assets / disk ----
  if (route === '/api/machines') {
    json(200, { ok: true, ...(await remoteMachinesStatus(ctx.tools, req, ctx.workspaceRegistry)) })
    return
  }
  if (route === '/api/assets') {
    json(200, { ok: true, ...assetsStatus() })
    return
  }
  if (route === '/api/disk') {
    if (!ws) { json(503, { error: 'workspace config not found' }); return }
    json(200, { ok: true, root: ws.config.workspace_root, entries: await localDiskUsage(ws) })
    return
  }
  if (route === '/api/dirs') {
    if (!ws) { json(503, { error: 'workspace config not found' }); return }
    const root = ws.config.workspace_root
    const demos = await workspaceDirs(ws)
    json(200, { ok: true, workspace_root: root, config_path: ws.configPath, demos })
    return
  }
  // ---- tier 2: project mapping + task store ----
  if (route === '/api/project') {
    const mapped = sessionProject(ctx.workspaceRegistry, url.searchParams.get('sessionId'))
    // The remote flag drives client visibility: remote projects get no task sidebar
    // (they are connection anchors; dsh-remote itself handles their files).
    if (mapped.project) mapped.project.remote = !!remoteProjectFor(mapped.project.path)
    json(200, { ok: true, ...mapped })
    return
  }
  if (route === '/api/tasks') {
    const sessionId = url.searchParams.get('sessionId')
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    json(200, { ok: true, project, ...(await readTasks(project.path)) })
    return
  }
  if (route.startsWith('/reports/')) {
    // Embedded reports (decision #4): static read-only, whitelist root = workspace, no traversal
    const rel = decodeURIComponent(route.slice('/reports/'.length)).replace(/\\/g, '/')
    if (!ws || rel.includes('..')) { json(403, { error: 'forbidden' }); return }
    const abs = path.resolve(ws.config.workspace_root, rel)
    if (!abs.startsWith(path.resolve(ws.config.workspace_root)) || !(await fsp.stat(abs).catch(() => null))) { json(404, { error: 'not found' }); return }
    const st = await fsp.stat(abs)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': st.size })
    res.end(await fsp.readFile(abs))
    return
  }
  json(404, { error: `unknown route: ${route} (the former /harnessams/ui console page moved into the DSH client UI — see the "HarnessAMS" sidebar entry)` })
}
