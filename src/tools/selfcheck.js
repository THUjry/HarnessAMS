// harnessams_selfcheck — the ONE self-check/config tool (2026-11-19 D-004 wave).
// The Overview's four buttons are thin parameterizations of this tool (they go
// through POST /api/tool, which calls this def's execute directly with the
// session's project injected), and a conversational agent can call it in-chat:
// passing `settings` (full or partial — a partial payload is merged over the
// stored settings) writes the project's workspace_config.json settings section
// first, so the agent controls the run configuration with the same single
// write face the UI uses. Session identity follows the D-005 precedent
// (exec.agent.id ≡ sessionId, as in gen_sweep_report) — no project guessing.
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
    if (typeof settings !== 'object' || Array.isArray(settings)) return { error: 'settings must be an object', code: 400 }
    // Partial merge (D-016): the payload overrides the STORED settings key by
    // key, so an agent can pin one value (e.g. a toolchain path) without
    // echoing the whole table; the UI keeps sending full drafts — same result.
    let stored
    try {
      ({ settings: stored } = await readSettings(project.path))
    } catch (e) {
      return { error: `workspace_config.json unreadable: ${String(e?.message ?? e)}`, code: 500 }
    }
    const v = validateSettings({ ...stored, ...settings })
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
      + '"save_agentsmd" rewrites the AGENTS.md project-config block (core constraints + yaml '
      + 'config and self-check results + the recommended-workflow table for the current settings). '
      + 'Passing "settings" (a full object or a partial one — a partial payload is merged over the stored settings) '
      + 'writes the project config settings section BEFORE the action runs — that is the single config write face '
      + '(cluster_env/run_mode/machine_id/remote_root/remote_dir/scheduler/simulator/compute_script_local/'
      + 'compute_script_remote/remote_python/remote_spectre_cmd; remote mode requires an absolute remote_root and machine_id '
      + 'unless in-cluster LSF is the only remote channel; scheduler is lsf/ssh; compute_script_* selects the compute '
      + 'LANGUAGE (python/js), never an interpreter path; remote_python and remote_spectre_cmd are the cluster toolchain '
      + 'pins — absolute paths to the worker interpreter and to the spectre executable, null = the bare defaults: harvest '
      + 'and verify them with the cluster-setup skill, never guess a path. The pins are not a settings-table row: this '
      + 'argument is their write face and the AGENTS.md yaml is where they are kept.',
    parameters: {
      action: { type: 'string', required: true, enum: ['run', 'status', 'stop', 'env', 'save_agentsmd'],
        description: 'run=start a self-check (background, returns run_id) | status=fetch one run | stop=cancel a running self-check | env=local environment listing | save_agentsmd=sync the AGENTS.md config table' },
      settings: { type: 'object',
        description: 'Optional settings object (full, or partial — a partial one is merged over the stored settings), validated and written to the project config before the action executes (agent-controlled configuration)' },
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
