// harnessams_selfcheck — the ONE self-check/config tool (2026-11-19 D-002 wave).
// The Overview's four buttons are thin parameterizations of this tool (they go
// through POST /api/tool, which calls this def's execute directly with the
// session's project injected and source='user'), and a conversational agent
// can call it in-chat (source='agent'). Passing `settings` (full or partial —
// a partial payload is merged over the stored settings) writes the project's
// workspace_config.json settings section first, so the agent controls the run
// configuration with the same single write face the UI uses. Session identity
// follows the D-003 precedent (exec.agent.id ≡ sessionId, as in
// gen_sweep_report; a delegated subagent resolves to its topmost user-visible
// ancestor via src/subagent.js) — no project guessing, and since D-008 no
// path walk-up either: resolveProjectTool (server/project.js) is the one
// project anchor.
// 2026-11-25 D-008 write shape: every settings write (1) reconciles json ←
// AGENTS.md first — the block is authoritative because the agent edits the
// outside file first; an invalid row is refused (agent: warning, UI: the save
// is blocked with an error), (2) merges the payload over the reconciled
// baseline, (3) writes, (4) updates the node memory for explicit pin writes,
// (5) supplements still-null fields from the global memory (after the memory
// update, so an explicit null clear sticks), and (6) re-syncs the AGENTS.md
// block so UI = json = AGENTS.md after every write.
import { resolveProjectTool } from '../core/project.js'
import { effectiveSessionId } from '../subagent.js'
import { healFromGlobalMemory, validateSettings, writeSettings, PIN_KEYS } from '../core/settings.js'
import { reconcileSettings } from '../core/reconcile.js'
import { localEnvFacts, runLocalChecks } from '../core/checks.js'
import { syncAgentsMd } from '../core/agentsmd.js'
import { updateNodePins } from '../core/globalstore.js'
import { startSelfcheck, getSelfcheck, stopSelfcheck } from '../core/selfcheck.js'

// Shared action runner: the tool def (agent-facing, resolves session/project
// itself) and the /api/tool route (button-facing, project already resolved from
// the sessionId) both land here. `source` distinguishes the caller: 'agent'
// (tool execute, the default) gets reconcile problems as warnings; 'user'
// (the UI route) gets them as a blocked save. Returns { ok, ... } or
// { error, code? }.
export async function runSelfcheckAction(ctx, { sessionId, project, action, settings, runId, lang, source }) {
  const warnings = []
  const withWarnings = (r) => (warnings.length && r && typeof r === 'object'
    ? { ...r, warnings: [...(r.warnings ?? []), ...warnings] }
    : r)
  if (settings != null) {
    if (typeof settings !== 'object' || Array.isArray(settings)) return { error: 'settings must be an object', code: 400 }
    // D-002 (1): reconcile json ← AGENTS.md — the block is authoritative.
    const rec = await reconcileSettings(project.path, { source })
    if (rec.error) return { error: rec.error, code: rec.code ?? 400 }
    if (rec.warnings?.length) warnings.push(...rec.warnings)
    // (2) partial merge (D-006): the payload overrides the RECONCILED settings
    // key by key — this call's explicit intent beats the hand-edit baseline,
    // so an agent can pin one value without echoing the whole table.
    const v = validateSettings({ ...rec.settings, ...settings })
    if (v.error) return withWarnings({ error: v.error, code: 400 })
    try {
      // (3)
      await writeSettings(project.path, v.settings)
    } catch (e) {
      return { error: `workspace_config.json write failed: ${String(e?.message ?? e)}`, code: 500 }
    }
    // (4) an explicit toolchain pin write doubles as node memory (D-003): the
    // machine's CURRENT pin pair is remembered plugin-globally — values set,
    // clears cleared, so a fresh project on the same node prefills and an
    // explicit null STAYS null (the supplement below runs after this, finds
    // the cleared memory, and does not refill; only a later green run
    // re-measures). Machine-less configs have no node to attribute the pins
    // to.
    const touchedPin = PIN_KEYS.some((k) => Object.prototype.hasOwnProperty.call(settings, k))
    if (v.settings.machine_id && touchedPin) {
      await updateNodePins(v.settings.machine_id, {
        remote_python: v.settings.remote_python ?? null,
        remote_spectre_cmd: v.settings.remote_spectre_cmd ?? null,
      }).catch(() => { /* best-effort memory */ })
    }
    // (5) D-008 null-supplement from the plugin-global memories: only NULL
    // fields fill (an explicit value always wins; a cleared memory key never
    // refills) — a payload that set machine_id prefills that node's remembered
    // pins and python facts here.
    const healed = await healFromGlobalMemory(project.path).catch(() => null)
    const final = healed?.settings ?? v.settings
    // (6) UI = json = AGENTS.md after every settings write: the block
    // re-renders immediately, so an adopted hand-edit survives as a row
    // instead of waiting for the next save/run.
    const sync = await syncAgentsMd(ctx, { project, settings: final }).catch((e) => ({ error: String(e?.message ?? e) }))
    if (sync?.error) warnings.push(`AGENTS.md sync after the settings write failed: ${sync.error}`)
  }
  if (action === 'run') {
    const r = await startSelfcheck(ctx, { sessionId, project, lang })
    if (r.error) return withWarnings({ error: r.error, code: r.code ?? 400 })
    return withWarnings({ ok: true, run_id: r.runId, status: 'running', ...(r.warnings?.length ? { warnings: r.warnings } : {}) })
  }
  if (action === 'status') {
    if (!runId) return { error: 'run_id is required for action=status', code: 400 }
    const run = getSelfcheck(runId, project.path)
    if (!run) return { error: `no such self-check run in this project: ${runId}`, code: 404 }
    return withWarnings({ ok: true, run })
  }
  if (action === 'stop') {
    // user stop: cancels the gates + in-flight calls, bkills submitted LSF jobs
    // best-effort; the run finalizes as status='cancelled' with evidence kept
    return withWarnings(stopSelfcheck(runId, project.path))
  }
  if (action === 'env') {
    // read-only listing: local node/python facts (python probed live, numpy
    // tri-state included — the persisted copies land via a self-check run)
    // plus workspace probe rows; the persisted rows enter AGENTS.md via
    // save_agentsmd / the finalize sync
    const [facts, checks] = await Promise.all([localEnvFacts(project.path), runLocalChecks(project.path)])
    return withWarnings({ ok: true, facts, checks })
  }
  if (action === 'save_agentsmd') {
    // D-002: reconcile json ← AGENTS.md first (the ADOPTION path for a
    // hand-edited block — the agent's natural route for config edits), then
    // the D-003/D-002 prefill of still-null fields from the global memories,
    // then the re-render. A settings payload riding this call already did all
    // three steps above; this second pass is idempotent and only fills what
    // the first pass left.
    const rec = await reconcileSettings(project.path, { source })
    if (rec.error) return { error: rec.error, code: rec.code ?? 500 }
    if (rec.warnings?.length) warnings.push(...rec.warnings)
    if (!rec.settings) return withWarnings({ error: 'no settings to sync', code: 500 })
    const healed = await healFromGlobalMemory(project.path)
    if (healed.error) return { error: healed.error, code: 500 }
    const r = await syncAgentsMd(ctx, { project, settings: healed.settings ?? rec.settings })
    if (r.error) return { error: r.error, code: 500 }
    return withWarnings({ ok: true, path: r.path, created: r.created, adopted: rec.adopted ?? [], healed: healed.healed ?? [] })
  }
  return withWarnings({ error: `unknown action: ${action} (run | status | stop | env | save_agentsmd)`, code: 400 })
}

export function selfcheckTools(ctx) {
  return [{
    name: 'harnessams_selfcheck',
    description: 'Project self-check and configuration for the CURRENT DSH workspace. '
      + 'Actions: "run" starts the end-to-end project self-check under the current settings '
      + '(returns run_id; poll with "status"); "status" fetches one run (steps/summary); '
      + '"stop" cancels a running self-check (bkills its LSF jobs best-effort, finalizes as '
      + 'cancelled with evidence kept); "env" lists the local environment facts read-only '
      + '(node + python, including the numpy tri-state); "save_agentsmd" rewrites the AGENTS.md '
      + 'config block from the current settings. '
      + 'Passing "settings" (a full object or a partial one — a partial payload is merged over the stored settings) '
      + 'writes the project config settings section BEFORE the action runs — that is the single config write face '
      + '(cluster_env/run_mode/machine_id/remote_root/selfcheck_remote_dir/scheduler/simulator/compute_script_local/'
      + 'compute_script_remote/remote_python/remote_spectre_cmd, plus the MEASURED python facts '
      + 'local_python_version/local_python_path/local_python_numpy/remote_python_numpy — the numpy fields are '
      + 'yes/no/fallback tri-states (fallback = the staged numfallback asset works), null until a green self-check '
      + 'measures them; remote mode requires an absolute remote_root and machine_id unless in-cluster LSF is the only '
      + 'remote channel; scheduler is lsf/ssh; compute_script_* selects the compute LANGUAGE (python/js), never an '
      + 'interpreter path; remote_python and remote_spectre_cmd are the cluster toolchain pins — absolute paths, a '
      + 'bare name is refused, harvest and verify with the cluster-setup skill, never guess a path). '
      + 'A GREEN self-check pins the measured toolchain paths automatically, remembers them per node plugin-globally '
      + '(a fresh project on a known machine prefills), and measures the python facts. '
      + 'Edits made directly in the AGENTS.md yaml block are AUTHORITATIVE: every settings write (and the batch tools '
      + 'at read time) adopts them after string validation — an invalid value is refused with a warning (agent calls) '
      + 'or blocks the save with an error (UI calls); null/absent rows never clear a stored value (explicit clears go '
      + 'through this settings argument).',
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
      // D-002 anchoring with the subagent policy (src/subagent.js): a
      // delegated subagent resolves to its topmost user-visible ancestor, so
      // a delegation-run self-check lands on the user session's project and
      // dedup (runningBySession) spans the whole delegation tree.
      const sessionId = args.session_id || effectiveSessionId(ctx, exec?.agent)
      const p = resolveProjectTool(ctx.workspaceRegistry, sessionId, args.project)
      if (p.error) return { ok: false, error: p.error }
      return runSelfcheckAction(ctx, {
        sessionId, project: p.project,
        action: args.action,
        settings: args.settings,
        runId: args.run_id,
        lang: args.lang,
        source: 'agent',
      })
    },
  }]
}
