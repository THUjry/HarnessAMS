// HarnessAMS top-level plugin host half: the /harnessams/* API surface backing the
// three-tier client UI (see client.js for the UI itself):
//   tier 1 (global console page) — machines (the dsh-ssh host registry), digital assets;
//   tier 2 (project = DSH workspace) — session-to-workspace mapping + the per-session
//            config store at <workspace>/.harnessams/sessions.json (D-008);
//   tier 3 (session sidebar) — the Overview project settings / self-check surface:
//            the four buttons and the settings table all land on ONE tool,
//            harnessams_selfcheck (tools/selfcheck.js), through POST /api/tool —
//            the same tool a conversational agent calls in-chat (its `settings`
//            argument is the single config write face, workspace_config.json).
//            The remote working-directory browser (GET /api/remote-browse) and
//            the dashboard report viewer (/dash/<sessionId>/…) are separate
//            read surfaces.
// Routes are not token-gated by the DSH web server (verified): only local
// management reads/writes live here — no credentials, no remote-execution passthrough.
// The Dashboard viewer is display-only: it serves session-registered local HTML
// reports read-only (bounded by each report's own directory) and a one-level
// listing for the add-report picker (/api/browse) — no file writes.
// Remote connectivity is delegated entirely to @linxin666/dsh-ssh (ssh_* tools
// by alias, zero gating); each project's remote root is its own setting
// (workspace_config.json settings.remote_root — the family harnessams.json and
// its remote_machines map are retired, 2026-11-19 D-009).
// Model tools: harnessams_selfcheck (self-check + config), the generic remote
// batch channel (batch_submit/batch_poll/batch_fetch; worker scripts come from
// the project's workspace.sim_scripts_dir) and the simulator-agnostic
// analysis/ops tools (sim_analysis/sim_progress/safe_trash).
// The session tool cards read two extra read-only endpoints (/api/progress and
// /api/progress-summary, server/progress.js) to draw the simulation progress
// cards inside the conversation — no execution surface, pure file reads.
import fsp from 'node:fs/promises'
import os from 'node:os'
import { sessionProject, readSessionConfigs, writeSessionConfig } from './server/project.js'
import { isForkSession } from './server/forkdetect.js'
import { remoteMachinesStatus, fetchMachines, checkableMachines } from './server/machines.js'
import { readSettings } from './server/settings.js'
import { readCheckParams } from './server/checkparams.js'
import { remoteBrowse } from './server/remotebrowse.js'
import { serveAsset, assetsStatus } from './server/assets.js'
import { mimeFor, resolveReportFile, browseDir } from './server/dashboard.js'
import { progressPayload, progressSummaryPayload, progressFence } from './server/progress.js'
import { registerTools } from './tool.js'
import { batchTools } from './tools/batch.js'
import { analysisTools } from './tools/sim_analysis.js'
import { selfcheckTools, runSelfcheckAction } from './tools/selfcheck.js'
import { safeTrashTool } from './trash.js'

export const name = 'dsh-harnessams'
// workspaceRegistry/tools are required on the web composition (both ship with dsh-base);
// the handlers still guard against undefined so degraded embeds fail soft, not loud.
export const inject = ['webServer', 'workspaceRegistry', 'tools']

export function toolDefinitions(ctx = {}) {
  return [...selfcheckTools(ctx), ...batchTools(ctx), ...analysisTools(ctx), safeTrashTool()]
}
// Current tool surface: harnessams_selfcheck (self-check + project config),
// batch_submit/batch_poll/batch_fetch (remote channel), sim_analysis /
// sim_progress (pure JS analysis), safe_trash.

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
  ctx.effect(() => {
    const names = registerTools(ctx, toolDefinitions(ctx))
    if (ctx.logger?.info) ctx.logger.info('[harnessams] registered %d tools', names.size)
    else console.log('[harnessams] registered', names.size, 'tools')
  }, 'harnessams tools')
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

  // ---- static assets (plotly single copy; whitelist lookup) ----
  if (route.startsWith('/assets/')) {
    serveAsset(req, res, route.slice('/assets/'.length))
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Write surface is narrow by design: per-session configs (sessions.json)
    // and the single tool funnel (self-check + workspace_config.json settings +
    // AGENTS.md sync — all project-local file writes; no remote execution
    // surface lives here).
    if (req.method === 'PUT' && route === '/api/session-config') {
      // merge-write ONE session's entry ({ sessionId, state }) — never a stale
      // full-file clobber of sibling sessions
      const sessionId = url.searchParams.get('sessionId')
      const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
      if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const w = await writeSessionConfig(project.path, body?.sessionId, body?.state)
      if (w.error) { json(400, { error: w.error }); return }
      json(200, { ok: true, project, sessions: w.sessions })
      return
    }
    if (req.method === 'POST' && route === '/api/tool') {
      // The one funnel behind the Overview's four buttons (and anything else
      // that wants the same behavior in-chat): body { sessionId, action,
      // settings?, run_id?, lang? } — the project resolves from the session,
      // then the harnessams_selfcheck action runner executes. Passing settings
      // stages a config write before the action (the table's confirm button).
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const sessionId = body?.sessionId
      if (!sessionId || typeof sessionId !== 'string') { json(400, { error: 'missing sessionId' }); return }
      const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
      if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
      const r = await runSelfcheckAction(ctx, {
        sessionId,
        project,
        action: typeof body?.action === 'string' ? body.action : '',
        settings: body?.settings,
        runId: body?.run_id,
        lang: body?.lang === 'zh' ? 'zh' : 'en',
      })
      if (r.error) { json(r.code ?? 400, { error: r.error }); return }
      json(200, r)
      return
    }
    json(405, { error: 'GET only (PUT /api/session-config, POST /api/tool)' })
    return
  }

  if (route === '/api/info') {
    json(200, {
      ok: true, plugin: 'dsh-harnessams',
      config: 'per-project <workspace>/.harnessams/workspace_config.json (the family harnessams.json is retired)',
      tiers: {
        console: 'sidebar entry "HarnessAMS" (client half)',
        project: ctx.workspaceRegistry ? 'workspaceRegistry mapped' : 'workspaceRegistry unavailable (tier 2 degraded)',
        sessions: '/api/session-config?sessionId=…',
        tool: 'POST /api/tool {sessionId, action: run|status|env|save_agentsmd} — the harnessams_selfcheck surface',
      },
    })
    return
  }

  // ---- tier 3 Overview: the machine list (the settings table's machine
  // dropdown consumes the same projection; the remote root is a separate
  // per-project setting, not a machine fact) ----
  if (route === '/api/checks') {
    const sessionId = url.searchParams.get('sessionId')
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    const list = await fetchMachines(ctx.tools)
    json(200, {
      ok: true, type: 'local', project,
      buttons: [{ id: 'local', item: 'Local environment' }],
      machines: list.ok ? checkableMachines(list.machines) : [],
      machinesTotal: list.ok ? (list.machines?.length ?? 0) : 0,
      machinesReason: list.ok ? null : list.reason,
    })
    return
  }

  // ---- tier 3 Overview: project settings (workspace_config.json settings
  // section; the write path is POST /api/tool with a settings object) ----
  if (route === '/api/project-settings') {
    const sessionId = url.searchParams.get('sessionId')
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    let settings
    try { ({ settings } = await readSettings(project.path)) } catch (e) { json(500, { error: `workspace_config.json unreadable: ${e.message}` }); return }
    json(200, { ok: true, settings })
    return
  }
  if (route === '/api/check-params') {
    // Retired with the task concept (2026-11-19): per-session check params live
    // in sessions.json; this route only ever read the project-level file.
    json(404, { error: 'check-params route retired — check params are per-session now (GET /api/session-config carries fallback_params)' })
    return
  }

  // ---- tier 1: machines / assets ----
  if (route === '/api/machines') {
    json(200, { ok: true, ...(await remoteMachinesStatus(ctx.tools, req, ctx.workspaceRegistry)) })
    return
  }
  if (route === '/api/assets') {
    // package copies + served routes; no workspace scan (the family workspace
    // root is retired — per-project copies live under each project's assets/)
    json(200, { ok: true, ...assetsStatus() })
    return
  }
  if (route === '/api/browse') {
    // One-level directory listing for the add-report dialog; no path param =
    // start at the home dir (report paths are absolute local paths anyway).
    const r = await browseDir(url.searchParams.get('path'), os.homedir())
    if (r.error) { json(400, { error: r.error }); return }
    json(200, { ok: true, ...r })
    return
  }
  if (route === '/api/remote-browse') {
    // One remote directory level for the working-directory picker (settings
    // table, remote mode): directories only, through the dsh-ssh exec funnel;
    // the default listing root is the project's settings.remote_root.
    const sessionId = url.searchParams.get('sessionId')
    const machineId = url.searchParams.get('machineId')
    const dir = url.searchParams.get('dir')
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    if (!machineId) { json(400, { error: 'missing machineId (a configured dsh-ssh host alias)' }); return }
    let remoteRoot
    try {
      const { settings } = await readSettings(project.path)
      remoteRoot = settings.remote_root
    } catch { remoteRoot = null }
    try {
      const r = await remoteBrowse(ctx, machineId, dir, remoteRoot)
      json(200, { ok: true, ...r })
    } catch (e) {
      const msg = String(e?.message ?? e)
      const code = /dsh-ssh hosts unavailable/.test(msg) ? 503
        : /no such dsh-ssh host/.test(msg) ? 404
        : /remote_root is required/.test(msg) ? 409
        : /^dir /.test(msg) ? 400
        : 502
      json(code, { error: msg })
    }
    return
  }
  // ---- tier 2: project mapping + per-session config store ----
  if (route === '/api/project') {
    const mapped = sessionProject(ctx.workspaceRegistry, url.searchParams.get('sessionId'))
    json(200, { ok: true, ...mapped })
    return
  }
  if (route === '/api/session-config') {
    // Per-session config (sessions.json): GET returns the whole map (the
    // sidebar hydrates its per-session entries from it), plus
    // - fallback_params: project-file∪built-in defaults — the greyed ghost
    //   values behind the check sub-view and the effective params for any
    //   session that has not confirmed its own table;
    // - fork: computed ONLY while the asking session has no entry yet (the
    //   client's first-seen flow splits copy-vs-empty on it; an existing entry
    //   is the tombstone that stops re-detection).
    const sessionId = url.searchParams.get('sessionId')
    const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
    if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
    const store = await readSessionConfigs(project.path)
    let fallback_params
    try { ({ params: fallback_params } = await readCheckParams(project.path)) } catch { /* corrupt file -> defaults */ }
    let fork
    if (sessionId && !store.sessions[sessionId]) fork = isForkSession(sessionId)
    json(200, { ok: true, project, ...store, fallback_params, ...(fork !== undefined ? { fork } : {}) })
    return
  }
  if (route === '/api/report-stat') {
    // Change signal for the Dashboard auto-refresh poll: mtime + size of the
    // report document. The generator rewrites the HTML on
    // every run, so the document stat alone is a sufficient freshness token —
    // no body fetch. Resolution mirrors /dash (opaque ids, no secrets).
    const sessionId = url.searchParams.get('sessionId')
    const reportId = url.searchParams.get('reportId')
    if (!sessionId || !reportId) { json(400, { error: 'sessionId and reportId are required' }); return }
    const hit = await resolveReportFile(ctx.workspaceRegistry, sessionId, reportId, '')
    if (hit.error) { json(hit.code ?? 404, { error: hit.error }); return }
    const st = await fsp.stat(hit.abs).catch(() => null)
    if (!st || !st.isFile()) { json(404, { error: 'not found' }); return }
    json(200, { ok: true, mtime_ms: Math.round(st.mtimeMs), size: st.size })
    return
  }
  if (route === '/api/progress') {
    // Session tool cards (tool.call.toolview): live single-run progress while a
    // local sweep blocks its tool call. Read-only and workspace-fenced (D-3):
    // the card passes its sessionId (added to the toolview owner via the slot
    // register-inject hook) plus the run dir from the tool arguments it already
    // shows; progressFence resolves the session to its registered workspace and
    // keeps the run dir inside it.
    const fence = progressFence(ctx.workspaceRegistry, url.searchParams)
    if (fence.error) { json(fence.code, { error: fence.error }); return }
    if (!fence.runDir) { json(400, { error: 'runDir is required' }); return }
    json(200, { ok: true, ...progressPayload(fence.runDir) })
    return
  }
  if (route === '/api/progress-summary') {
    // Cross-batch aggregate over <project>/sweep/Round*/top ("3/5 batches done,
    // 120/360 sims, 240 pending"). Same workspace fence; the project root is
    // derived from a run dir or passed explicitly; local:false lets the client
    // omit the block quietly.
    const fence = progressFence(ctx.workspaceRegistry, url.searchParams)
    if (fence.error) { json(fence.code, { error: fence.error }); return }
    json(200, { ok: true, ...progressSummaryPayload({ runDir: fence.runDir, projectDir: fence.projectDir }) })
    return
  }
  if (route.startsWith('/dash/')) {
    // Session-attached dashboard reports: /dash/<sessionId>/<reportId>/<rel…> (empty
    // rel = the report document itself). rel resolves against the report's own
    // directory so the document's relative references (data/*.js, images) keep
    // working; the ids are opaque lookups into the session stores, not paths.
    const segs = route.slice('/dash/'.length).split('/').map((s) => {
      try { return decodeURIComponent(s) } catch { return null }
    })
    if (segs.length < 2 || segs.slice(0, 2).some((s) => !s)) { json(400, { error: 'bad dashboard route (expected /dash/<sessionId>/<reportId>/<rel…>)' }); return }
    const [sessionId, reportId] = segs
    const rel = segs.slice(2).join('/')
    const hit = await resolveReportFile(ctx.workspaceRegistry, sessionId, reportId, rel)
    if (hit.error) { json(hit.code ?? 404, { error: hit.error }); return }
    // read first, then size the response from the buffer: a stat-then-read race
    // against an in-place rewrite would send a wrong Content-Length
    const buf = await fsp.readFile(hit.abs).catch(() => null)
    if (!buf) { json(404, { error: 'not found' }); return }
    res.writeHead(200, { 'Content-Type': mimeFor(hit.abs), 'Content-Length': buf.length })
    res.end(buf)
    return
  }
  json(404, { error: `unknown route: ${route} (the console lives in the DSH client UI — see the "HarnessAMS" sidebar entry; the self-check/config funnel is POST /api/tool)` })
}
