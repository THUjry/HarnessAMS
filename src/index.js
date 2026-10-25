// HarnessAMS top-level plugin host half: the /harnessams/* API surface backing the
// three-tier client UI (see client.js for the UI itself):
//   tier 1 (global console page) — server checks, nodes.yaml management, dsh-remote
//            alignment, digital assets, disk usage;
//   tier 2 (project = DSH workspace) — session-to-workspace mapping + per-project task
//            store at <workspace>/.harnessams/tasks.json;
//   tier 3 (task sidebar)          — the task store API consumed per active session.
// Routes are not token-gated by the DSH web server (verified 2026-10-25): only local
// management reads/writes live here — no credentials, no remote-execution passthrough.
// Remote node checks go through system OpenSSH wrapped in `bash -c` with BatchMode=yes.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findWorkspaceConfig, readNodes, validateNodes, writeNodes } from './server/workspace.js'
import { runLocalChecks, runNodeChecks } from './server/checks.js'
import { localDiskUsage, workspaceDirs } from './server/disk.js'
import { sessionProject, readTasks, writeTasks, clearTasksIfEmpty } from './server/project.js'
import { remoteMachinesStatus } from './server/machines.js'
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
    // Write surface is narrow by design: nodes (config management) and tasks (project
    // data), both local file writes only.
    if (req.method === 'PUT' && route === '/api/nodes') {
      if (!ws) { json(503, { error: 'workspace config not found (harnessams.json)' }); return }
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const v = validateNodes(body?.nodes)
      if (v.error) { json(400, { error: v.error }); return }
      const nodesPath = path.join(path.dirname(ws.configPath), 'nodes.yaml')
      try { writeNodes(nodesPath, v.nodes) } catch (e) { json(500, { error: `write failed: ${e.message}` }); return }
      json(200, { ok: true, path: nodesPath, nodes: readNodes(path.dirname(ws.configPath)).nodes })
      return
    }
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
    json(405, { error: 'GET only (PUT for /api/nodes and /api/tasks)' })
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
  if (route === '/api/check-local') {
    if (!ws) { json(503, { error: 'harnessams-workspace/harnessams.json not found' }); return }
    json(200, { ok: true, node: 'local', results: await runLocalChecks(ws) })
    return
  }
  if (route === '/api/check') {
    const host = url.searchParams.get('node')
    if (!host) { json(400, { error: 'missing node parameter' }); return }
    if (host === 'local') { json(200, { ok: true, node: 'local', results: await runLocalChecks(ws) }); return }
    const nodes = ws ? readNodes(path.dirname(ws.configPath)).nodes : []
    const node = nodes.find((n) => String(n.HOST) === host)
    if (!node) { json(404, { error: `no such node in nodes.yaml: ${host} (or nodes.yaml has no real nodes configured)` }); return }
    json(200, { ok: true, node: host, results: await runNodeChecks(node, ws) })
    return
  }
  if (route === '/api/nodes') {
    const data = ws ? readNodes(path.dirname(ws.configPath)) : { path: null, nodes: [] }
    json(200, { ok: true, path: data.path, nodes: data.nodes,
                hint: 'HOST is also the ~/.ssh/config alias; credentials stay with the system OpenSSH; the programmatic path is BatchMode; PUT /api/nodes writes this file (comments are lost)' })
    return
  }
  if (route === '/api/machines') {
    if (!ws) { json(503, { error: 'workspace config not found' }); return }
    const nodes = readNodes(path.dirname(ws.configPath)).nodes
    json(200, { ok: true, ...(await remoteMachinesStatus(ctx.tools, req, nodes)) })
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
    const nodes = readNodes(path.dirname(ws.configPath))
    json(200, { ok: true, workspace_root: root, config_path: ws.configPath, demos, nodes_path: nodes.path,
                nodes: nodes.nodes.map((n) => ({ host: n.HOST, workspace: n.WORKSPACE ?? null, reserved: n.reserved === 'true' })),
                remote_workspace: ws.config.remote_workspace ?? null })
    return
  }
  // ---- tier 2: project mapping + task store ----
  if (route === '/api/project') {
    json(200, { ok: true, ...sessionProject(ctx.workspaceRegistry, url.searchParams.get('sessionId')) })
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
