// harnessams_selfcheck — the ONE self-check/config tool (2026-11-19 D-009 wave).
// The Overview's four buttons are thin parameterizations of this tool (they go
// through POST /api/tool, which calls this def's execute directly with the
// session's project injected), and a conversational agent can call it in-chat:
// passing `settings` writes the project's workspace_config.json settings
// section first, so the agent controls the run configuration with the same
// single write face the UI uses. Session identity follows the D-008 precedent
// (exec.agent.id ≡ sessionId, as in gen-sweep-report) — no project guessing.
import path from 'node:path'
import { sessionProject } from '../server/project.js'
import { readSettings, validateSettings, writeSettings } from '../server/settings.js'
import { localEnvFacts, runLocalChecks } from '../server/checks.js'
import { syncAgentsMd } from '../server/agentsmd.js'
import { startSelfcheck, getSelfcheck, stopSelfcheck } from '../server/selfcheck.js'

// Shared action runner: the tool def (agent-facing, resolves session/project
// itself) and the /api/tool route (button-facing, project already resolved from
// the sessionId) both land here. Returns { ok, ... } or { error, code? }.
export async function runSelfcheckAction(ctx, { sessionId, project, action, settings, runId, lang }) {
  if (settings != null) {
    const v = validateSettings(settings)
    if (v.error) return { error: v.error, code: 400 }
    try {
      await writeSettings(project.path, v.settings)
    } catch (e) {
      return { error: `workspace_config.json write failed: ${String(e?.message ?? e)}`, code: 500 }
    }
  }
  if (action === 'run') {
    const r = await startSelfcheck(ctx, { sessionId, project, lang })
    if (r.error) return { error: r.error, code: r.code ?? 400 }
    return { ok: true, run_id: r.runId, status: 'running' }
  }
  if (action === 'status') {
    if (!runId) return { error: 'run_id is required for action=status', code: 400 }
    const run = getSelfcheck(runId, project.path)
    if (!run) return { error: `no such self-check run in this project: ${runId}`, code: 404 }
    return { ok: true, run }
  }
  if (action === 'stop') {
    // user stop: cancels the gates + in-flight calls, bkills submitted LSF jobs
    // best-effort; the run finalizes as status='cancelled' with evidence kept
    return stopSelfcheck(runId, project.path)
  }
  if (action === 'env') {
    // read-only listing: local node/python facts + workspace probe rows; these
    // values enter AGENTS.md only via save_agentsmd
    const [facts, checks] = await Promise.all([localEnvFacts(), runLocalChecks(project.path)])
    return { ok: true, facts, checks }
  }
  if (action === 'save_agentsmd') {
    let s
    try {
      ({ settings: s } = await readSettings(project.path))
    } catch (e) {
      return { error: `workspace_config.json unreadable: ${String(e?.message ?? e)}`, code: 500 }
    }
    const r = await syncAgentsMd(ctx, { project, settings: s })
    if (r.error) return { error: r.error, code: 500 }
    return { ok: true, path: r.path, created: r.created }
  }
  return { error: `unknown action: ${action} (run | status | stop | env | save_agentsmd)`, code: 400 }
}

// Resolve the project for a direct agent call: an explicit `project` argument
// must be a registered DSH workspace; otherwise the calling session's mapping
// decides. Errors list the candidates so the agent can self-correct.
function resolveProject(ctx, sessionId, projectArg) {
  const registry = ctx?.workspaceRegistry
  const registered = typeof registry?.list === 'function' ? registry.list() : []
  if (projectArg != null) {
    if (typeof projectArg !== 'string' || !projectArg.trim()) return { error: 'project must be a workspace path string' }
    const want = path.resolve(projectArg)
    const hit = registered.find((w) => path.resolve(String(w?.path ?? '')) === want)
    if (!hit) {
      return { error: `project is not a registered workspace: ${projectArg} (registered: `
        + (registered.map((w) => w.path).join(', ') || 'none') + ')' }
    }
    return { project: { id: hit.id, path: hit.path, title: hit.title } }
  }
  const { project, reason } = sessionProject(registry, sessionId)
  if (!project) {
    return { error: (reason ?? 'no project for session') + ' (registered: '
      + (registered.map((w) => w.path).join(', ') || 'none') + ')' }
  }
  return { project }
}

export function selfcheckTools(ctx) {
  return [{
    name: 'harnessams_selfcheck',
    description: 'Project self-check and configuration for the CURRENT DSH workspace. '
      + 'Actions: "run" starts the end-to-end project self-check under the current settings '
      + '(returns run_id; poll with "status"); "status" fetches one run (steps/summary); '
      + '"stop" cancels a running self-check (bkills its LSF jobs best-effort, finalizes as '
      + 'cancelled with evidence kept); "env" lists the local environment facts (read-only); '
      + '"save_agentsmd" rewrites the AGENTS.md project-config block from measured values. '
      + 'Passing "settings" (full object) writes .harnessams/workspace_config.json settings '
      + 'section BEFORE the action runs — that is the single config write face '
      + '(run_mode/machine_id/remote_root/remote_dir/scheduler/simulator/compute_script_local/'
      + 'compute_script_remote; remote mode requires machine_id and an absolute remote_root).',
    parameters: {
      action: { type: 'string', required: true, enum: ['run', 'status', 'stop', 'env', 'save_agentsmd'],
        description: 'run=start a self-check (background, returns run_id) | status=fetch one run | stop=cancel a running self-check | env=local environment listing | save_agentsmd=sync the AGENTS.md config table' },
      settings: { type: 'object',
        description: 'Optional full settings object, validated and written to the project config before the action executes (agent-controlled configuration)' },
      run_id: { type: 'string', description: 'Run id for action=status (the run_id returned by action=run)' },
      lang: { type: 'string', enum: ['zh', 'en'], description: 'Answer language for the diagnosis sessions spawned by a run (default en)' },
      project: { type: 'string', description: 'Optional explicit workspace path (default: the calling session\'s workspace)' },
    },
    async execute(args, exec) {
      const sessionId = args.session_id || exec?.agent?.id || null
      const p = resolveProject(ctx, sessionId, args.project)
      if (p.error) return { ok: false, error: p.error }
      return runSelfcheckAction(ctx, {
        sessionId, project: p.project,
        action: args.action,
        settings: args.settings,
        runId: args.run_id,
        lang: args.lang,
      })
    },
  }]
}
