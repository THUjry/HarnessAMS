// HarnessAMS top-level plugin host half: the /harnessams/* API surface backing the
// three-tier client UI (see client.js for the UI itself):
//   tier 1 (global console page) — machines (the dsh-ssh host registry), digital assets;
//   tier 2 (project = DSH workspace) — session-to-workspace mapping + the per-session
//            config store at <workspace>/.harnessams/sessions.json (D-005);
//   tier 3 (session sidebar) — the Overview project settings / self-check surface:
//            the four buttons and the settings table all land on ONE tool,
//            harnessams_selfcheck (tools/selfcheck.js), through POST /api/tool —
//            the same tool a conversational agent calls in-chat (its `settings`
//            argument is the single config write face, workspace_config.json).
//            The remote working-directory browser (GET /api/remote-browse) and
//            the dashboard report viewer (/dash/<sessionId>/…) are separate
//            read surfaces; the browser's one write — creating a validated
//            ASCII subdirectory (POST /api/remote-browse/mkdir) — rides the
//            same dsh-ssh exec funnel as the self-check's remote probes.
// Routes are not token-gated by the DSH web server (verified): only local
// management reads/writes live here — no credentials, no remote-execution passthrough.
// The Dashboard viewer is display-only: it serves session-registered local HTML
// reports read-only (bounded by each report's own directory) and a one-level
// listing for the add-report picker (/api/browse — the dialog's FALLBACK path;
// its primary local-directory access is the host's native OS folder chooser
// through GET/POST /api/pick-directory, 2026-11-26 ruling: system first) —
// no file writes.
// The system-browser open action (POST /api/open-local, 2026-11-26) stays the
// only route that spawns an OS process from THIS plugin's code: a view action
// fenced to viewable file types (whitelist + existing regular file +
// quoting-safe characters) with same-origin checks — never an executable/
// script path, never arguments. POST /api/pick-directory pops the host's
// native folder dialog through the host 'directoryPicker' service (the host
// spawns the dialog child; the service is read via ctx.get without an inject
// declaration, server/pickdir.js — headless embeds simply get 503).
// Remote connectivity is delegated entirely to @linxin666/dsh-ssh (ssh_* tools
// by alias, zero gating); each project's remote root is its own setting
// (workspace_config.json settings.remote_root — the family harnessams.json and
// its remote_machines map are retired, 2026-11-19 D-004).
// Model tools: harnessams_selfcheck (self-check + config), the batch channel
// (batch_submit with its local/ssh/lsf schedulers, semantics set by the
// project's cluster_env — D-002 — + batch_poll with the
// terminal auto-fetch; worker scripts come from the project's
// workspace.sim_scripts_dir) and the simulator-agnostic report/ops tools
// (gen_sweep_report / safe_trash).
// The session tool cards read two extra read-only endpoints (/api/progress and
// /api/progress-summary, server/progress.js) to draw the simulation progress
// cards inside the conversation — no execution surface, pure file reads.
import fsp from 'node:fs/promises'
import os from 'node:os'
import { sessionProject, readSessionConfigs, writeSessionConfig } from './server/project.js'
import { isForkSession } from './server/forkdetect.js'
import { remoteMachinesStatus, fetchMachines, checkableMachines } from './server/machines.js'
import { initProjectStorage, healFromGlobalMemory, readSettings, declarePlotlyUrl } from './server/settings.js'
import { reconcileSettings } from './server/reconcile.js'
import { parseFacts } from './server/agentsmd.js'
import { getFreshMin, setFreshMin } from './server/globalstore.js'
import { readCheckParams } from './server/checkparams.js'
import { remoteBrowse, remoteMkdir } from './server/remotebrowse.js'
import { serveAsset, assetsStatus } from './server/assets.js'
import { mimeFor, resolveReportFile, browseDir } from './server/dashboard.js'
import { resolveOpenableFile, openWithDefaultApp } from './server/openlocal.js'
import { pickerCapability, pickDirectory } from './server/pickdir.js'
import { seedProjectPlotly } from './report_render.js'
import { progressPayload, progressSummaryPayload, progressFence } from './server/progress.js'
import { progressRemotePayload } from './server/progressRemote.js'
import { registerTools } from './tool.js'
import { batchTools } from './tools/batch.js'
import { genReportTools } from './tools/gen_report.js'
import { selfcheckTools, runSelfcheckAction } from './tools/selfcheck.js'
import { safeTrashTool } from './trash.js'
import { registerSkills } from './skills.js'

export const name = 'dsh-harnessams'
// workspaceRegistry/tools/systemPrompt/skills/shell are required on the web
// composition (all ship with dsh-base); the handlers still guard against
// undefined so degraded embeds fail soft, not loud. systemPrompt is declared
// for the waiting-policy section, skills for the bundled-skill catalog and
// shell for the in-cluster local execution seam (ctx.shell, the official host
// shell — bsub/bjobs on this host when cluster_env=in-cluster). agents backs
// the subagent identity policy (src/subagent.js — the session anchoring walk
// over live agent headers).
// (cordis blocks ctx access to undeclared services — optional chaining
// cannot save that, live-caught 2026-11-21.)
export const inject = ['webServer', 'workspaceRegistry', 'tools', 'systemPrompt', 'skills', 'shell', 'agents']

// Execution safety rules injected into the system prompt while this plugin is
// enabled. 2026-11-24 rework (the "prompts carry SAFETY only" ruling): the
// operational cadence that used to live here (bounded sleeps, backoff steps,
// progress-card refresh rates) moved to the project AGENTS.md workflow table
// and the batch-sweep skill; what stays is the safety core — ask-first on a
// broken chain, no improvised fallbacks, dsh-ssh tools only, never raw shell
// ssh — plus the pointer to the project config block. Static text, registered
// once at plugin load, so the KV prefix stays stable. Prose, not bullets: the
// assembled host prompt is plain paragraphs.
export const REMOTE_WAIT_POLICY = 'HarnessAMS execution safety rules: if the standard chain cannot proceed (repeated tool failures, stuck run, missing capability), stop and ask the user first — never improvise a workaround on your own; any improvised fallback requires explicit user approval and must still go through the dsh-ssh tools (ssh_exec/ssh_upload/ssh_download), never raw ssh commands from the shell; prefer the SAS/HA plugin tools for every simulation step. Projects run in one of two working environments (cluster_env): read the cluster_env row of the project\'s AGENTS.md config block before choosing scheduler="local"/"ssh"/"lsf". Operational cadence (poll intervals, backoff) lives in that block\'s workflow table, not here.'

// Model-source discipline (2026-11-23, the schematic round-trip wave): the agent
// never reads PDK/model-library files; model sections and simulator setup come
// only from include lines already present in user-provided simulation logs. Same
// registration shape as the policy above — static text, one section, KV-stable.
export const MODEL_SOURCE_DISCIPLINE = 'HarnessAMS model-source discipline: never read files under PDK or model-library directories (no browsing, no grepping, no listing to discover model names or sections). The only sanctioned source of model includes, sections and simulator setup is the include lines already present in simulation logs the user provides (the input.scs of a run_dir, or artifacts of past runs) — reuse them verbatim. For a process that has never been run in this workspace, ask the user for the run_dir/log of one minimal no-parameter simulation first and learn the setup from it; afterwards prefer learning from past projects over re-deriving. When unsure which section or include applies, stop and ask the user instead of inspecting PDK trees.'

export function toolDefinitions(ctx = {}) {
  return [...selfcheckTools(ctx), ...batchTools(ctx), ...genReportTools(ctx), safeTrashTool(ctx)]
}
// Current tool surface: harnessams_selfcheck (self-check + project config),
// batch_submit (local/ssh/lsf, per cluster_env) / batch_poll (monitor + terminal
// auto-fetch), gen_sweep_report (pure JS report renderer), safe_trash.

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
  ctx.effect(() => {
    // belt-and-braces: inject declares the service, but a hand-rolled embed
    // without it still loads the rest of the plugin
    if (!ctx.systemPrompt?.section) return
    return ctx.systemPrompt.section({
      name: 'harnessams:remote-wait-policy',
      order: 5500, // after TOOLS_SDK (5000), before DELIVERABLE_FILE_REFERENCES (9000)
      text: REMOTE_WAIT_POLICY,
    })
  }, 'harnessams system prompt section')
  ctx.effect(() => {
    // same belt-and-braces guard; ordered BEFORE the wait policy (5500) —
    // smaller order = earlier in the assembled prompt = higher priority
    if (!ctx.systemPrompt?.section) return
    return ctx.systemPrompt.section({
      name: 'harnessams:model-source-discipline',
      order: 5400, // after TOOLS_SDK (5000), before remote-wait-policy (5500)
      text: MODEL_SOURCE_DISCIPLINE,
    })
  }, 'harnessams model-source prompt section')
  ctx.effect(() => {
    // Bundled skills (src/skills/<name>/SKILL.md -> ctx.skills catalog):
    // fail-open — see skills.js. The catalog carries name + description
    // only; bodies load on demand through the `skill` tool.
    const names = registerSkills(ctx)
    if (names.length) {
      if (ctx.logger?.info) ctx.logger.info('[harnessams] registered %d skills: %s', names.length, names.join(', '))
      else console.log('[harnessams] registered', names.length, 'skills:', names.join(', '))
    }
  }, 'harnessams skills')
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

// Shared same-origin fence for the untokened POST routes that touch the host
// desktop (open-local launches a viewer, remote-browse/mkdir writes remotely,
// pick-directory pops a modal OS dialog): these routes carry no host token by
// design, so reject Fetch-Metadata that says the request came from another
// site (a cross-site no-cors text/plain POST can still carry a JSON body;
// sec-fetch-site sees through it). Non-browser clients (curl, tests) send no
// sec-fetch-site and pass. Returns the rejection message or null.
function sameOriginError(req) {
  const sfs = req.headers['sec-fetch-site']
  if (typeof sfs === 'string' && sfs !== 'same-origin' && sfs !== 'none') return 'cross-site requests are not accepted'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    const host = req.headers.host
    let originHost = null
    try { originHost = new URL(origin).host } catch { /* unparseable -> rejected below */ }
    if (host && originHost !== host) return 'cross-origin requests are not accepted'
  }
  return null
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
    // AGENTS.md sync — all project-local file writes; the one remote write is
    // the browser's mkdir, a single validated ASCII directory name through
    // the dsh-ssh exec funnel).
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
        // the UI funnel is USER-initiated (D-021): an AGENTS.md reconcile
        // problem blocks the save with an error here, where the in-chat agent
        // caller only gets warnings
        source: 'user',
      })
      if (r.error) { json(r.code ?? 400, { error: r.error }); return }
      json(200, r)
      return
    }
    if (req.method === 'POST' && route === '/api/project-init') {
      // Project initialization hook (D-015 2026-11-25): the sidebar opening a
      // project is the PRIMARY staging timing — scripts land, the AGENTS.md
      // template appears, sim_scripts_dir flips to the project-local copy, and
      // null toolchain pins heal from the plugin-global node memory. Idempotent
      // (copy-if-missing); the client fires it once per project per page load.
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const sessionId = body?.sessionId
      if (!sessionId || typeof sessionId !== 'string') { json(400, { error: 'missing sessionId' }); return }
      const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
      if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
      try {
        const init = await initProjectStorage(project.path)
        // D-021: reconcile json ← AGENTS.md BEFORE the heal — a hand-edited
        // block (e.g. a .harnessams deletion that kept AGENTS.md) adopts at the
        // sidebar-open moment; invalid rows warn into the response (this is an
        // automatic surface, no user to block). Agent semantics by design.
        const rec = await reconcileSettings(project.path).catch(() => null)
        const healed = await healFromGlobalMemory(project.path)
        json(200, {
          ok: true,
          project,
          ...init,
          adopted: rec?.adopted ?? [],
          warnings: rec?.warnings ?? [],
          healed: healed.healed ?? [],
        })
      } catch (e) {
        json(500, { error: `project init failed: ${String(e?.message ?? e)}` })
      }
      return
    }
    if (req.method === 'POST' && route === '/api/open-local') {
      // Open a local file with the OS default application — the system-browser
      // viewing path for reports (body { sessionId, path }). This is the FIRST
      // route that can trigger an OS process, so it carries its own fence:
      // viewable-extension whitelist + existing regular file + quoting-safe
      // characters (server/openlocal.js), plus the shared same-origin guard
      // (sameOriginError — untokened POST routes only accept same-origin
      // fetches). The window opens on the DSH host's desktop — in-cluster/
      // headless hosts may have no default handler and the spawn error
      // surfaces inline.
      const guard = sameOriginError(req)
      if (guard) { json(403, { error: guard }); return }
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const sessionId = body?.sessionId
      if (!sessionId || typeof sessionId !== 'string') { json(400, { error: 'missing sessionId' }); return }
      const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
      if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
      const target = await resolveOpenableFile(body?.path)
      if (target.error) { json(target.code ?? 400, { error: target.error }); return }
      // Seed the project plotly copy before launching the viewer (user
      // ruling 2026-11-26): a report opened OUTSIDE the sidebar renders as a
      // file:// document whose step-1 relative reference needs the copy, and
      // this click is exactly what creates it (copy-if-missing; the
      // report-resolved route step serves the packaged copy anyway when the
      // page is viewed from the DSH web origin). When the copy exists at the
      // default target afterwards (seedProjectPlotly's present flag), the
      // workspace config gains the plotly_url declaration (declarePlotlyUrl —
      // the config stays plotly-free until this click succeeds). Both steps
      // fail-open — a seed or declare problem never blocks the open. Report
      // documents only; PNGs/logs don't need it.
      let plotlySeed = null
      if (/\.(html?)$/i.test(target.abs)) {
        try { plotlySeed = seedProjectPlotly(project.path) } catch (e) { plotlySeed = { seeded: false, reason: String(e?.message ?? e) } }
        if (plotlySeed?.present === true) {
          try { plotlySeed.declared = (await declarePlotlyUrl(project.path)).added } catch { plotlySeed.declared = false }
        }
      }
      const opened = await openWithDefaultApp(ctx, target.abs)
      if (opened.error) { json(500, { error: opened.error }); return }
      json(200, { ok: true, project, path: target.abs, plotly_seed: plotlySeed })
      return
    }
    if (req.method === 'POST' && route === '/api/remote-browse/mkdir') {
      // Create one directory in the remote browser's current listing (body
      // { sessionId, machineId, dir, name }) — the browser's single remote
      // write: a plain `mkdir` of ONE validated printable-ASCII path segment
      // under the listed directory (server/remotebrowse.js remoteMkdir through
      // the dsh-ssh exec funnel; an existing name errors with "File exists"
      // instead of silently succeeding). Shared same-origin guard as
      // open-local (sameOriginError).
      const guard = sameOriginError(req)
      if (guard) { json(403, { error: guard }); return }
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const sessionId = body?.sessionId
      if (!sessionId || typeof sessionId !== 'string') { json(400, { error: 'missing sessionId' }); return }
      const { project, reason } = sessionProject(ctx.workspaceRegistry, sessionId)
      if (!project) { json(404, { error: reason ?? 'no project for session' }); return }
      const machineId = body?.machineId
      if (!machineId || typeof machineId !== 'string') { json(400, { error: 'missing machineId (a configured dsh-ssh host alias)' }); return }
      try {
        const r = await remoteMkdir(ctx, machineId, body?.dir, body?.name)
        json(200, { ok: true, path: r.path })
      } catch (e) {
        const msg = String(e?.message ?? e)
        const code = /^name |^dir /.test(msg) ? 400
          : /dsh-ssh hosts unavailable/.test(msg) ? 503
          : /no such dsh-ssh host/.test(msg) ? 404
          : 502
        json(code, { error: msg })
      }
      return
    }
    if (req.method === 'POST' && route === '/api/pick-directory') {
      // Pop the host's native OS folder chooser (2026-11-26 ruling: system
      // open first for local directory access; the self-made listing is the
      // fallback). No body, no sessionId — a folder pick has no project
      // dependency. Delegates to the host 'directoryPicker' service through
      // server/pickdir.js (ctx.get, no inject declaration — headless embeds
      // where the service never exists just get 503). Same-origin guard as
      // open-local: an untokened route that disturbs the host desktop with a
      // modal dialog accepts same-origin fetches only.
      const guard = sameOriginError(req)
      if (guard) { json(403, { error: guard }); return }
      const r = await pickDirectory(ctx)
      if (r.error) { json(r.code ?? 500, { error: r.error }); return }
      json(200, { ok: true, ...(r.canceled ? { canceled: true } : { path: r.path }) })
      return
    }
    if (req.method === 'PUT' && route === '/api/global-config') {
      // The plugin-global display config (D-017: ~/.dsh/harnessams.json) —
      // today the self-check freshness window the console's display settings
      // own. Body { selfcheck_fresh_min } (minutes, 1..1440).
      let body
      try { body = await readBodyJson(req) } catch (e) { json(400, { error: `bad JSON body: ${e.message}` }); return }
      const r = await setFreshMin(body?.selfcheck_fresh_min)
      if (r.error) { json(400, { error: r.error }); return }
      json(200, { ok: true, selfcheck_fresh_min: r.value })
      return
    }
    json(405, { error: 'GET only (PUT /api/session-config, PUT /api/global-config, POST /api/tool, POST /api/project-init, POST /api/open-local, POST /api/remote-browse/mkdir, POST /api/pick-directory)' })
    return
  }

  if (route === '/api/info') {
    json(200, {
      ok: true, plugin: 'dsh-harnessams',
      config: 'per-project <workspace>/.harnessams/workspace_config.json (the family harnessams.json is retired)',
      display: { selfcheck_fresh_min: await getFreshMin() },
      tiers: {
        console: 'sidebar entry "HarnessAMS" (client half)',
        project: ctx.workspaceRegistry ? 'workspaceRegistry mapped' : 'workspaceRegistry unavailable (tier 2 degraded)',
        sessions: '/api/session-config?sessionId=…',
        tool: 'POST /api/tool {sessionId, action: run|status|stop|env|save_agentsmd} — the harnessams_selfcheck surface',
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
    // One-level directory listing for the add-report dialog (its fallback
    // path since the 2026-11-26 system-first ruling — the primary folder
    // access is the native chooser at /api/pick-directory); no path param =
    // start at the home dir (report paths are absolute local paths anyway).
    const r = await browseDir(url.searchParams.get('path'), os.homedir())
    if (r.error) { json(400, { error: r.error }); return }
    json(200, { ok: true, ...r })
    return
  }
  if (route === '/api/pick-directory') {
    // Capability probe backing the add-report dialog's system browse button:
    // 'native' renders the button, 'browse'/'none' hide it (the host's
    // documented default for unknown capability kinds) — the self-made
    // listing above stays the fallback either way. Read-only, no side effect.
    json(200, { ok: true, kind: pickerCapability(ctx) })
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
    // the AGENTS.md self-check facts ride along (D-017): the sidebar restores
    // its status display from the yaml block after a page reload — no global
    // "latest run" surface, the block is the per-project record
    if (mapped.project?.path) {
      const facts = await parseFacts(mapped.project.path)
      if (facts) mapped.selfcheck_facts = { ...facts, fresh_min: await getFreshMin() }
    }
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
  if (route === '/api/progress-remote') {
    // Remote live progress for the batch_poll card (D-008): polls the batch's
    // own progress files on the remote host through the dsh-ssh exec funnel.
    // Same workspace fence as the local endpoints; the machine and remote dir
    // are resolved server-side from the run dir's .batch_job.json (written by
    // batch_submit) — the caller supplies nothing beyond the fenced runDir. A
    // short single-flight cache (progressRemote.js) keeps one ssh exec per run
    // dir per ~4 s however many cards poll; failures answer 200 {unreachable}
    // so the card keeps its last frame instead of going blank.
    const fence = progressFence(ctx.workspaceRegistry, url.searchParams)
    if (fence.error) { json(fence.code, { error: fence.error }); return }
    if (!fence.runDir) { json(400, { error: 'runDir is required' }); return }
    const payload = await progressRemotePayload(ctx, fence.runDir)
    json(200, { ok: true, ...payload })
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
