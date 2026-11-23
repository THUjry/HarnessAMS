// AGENTS.md project-config block (2026-11-18; flattened 2026-11-19 D-004).
// Per the front-of-house rule (the DSHstudy context-sync note: AGENTS.md
// is the reviewable, diff-able sync vehicle — plugins must not assemble
// injections in the back half), this module only maintains ONE marked block at
// the head of the workspace's own AGENTS.md:
//   - .harnessams creation (writeSettings/writeSessionConfig) also lays down
//     the block as an EMPTY table plus a first-fill instruction — any session
//     that starts in the workspace sees the prompt and fills the table from
//     measured checks before working (the user may explicitly waive the
//     self-check; the agent judges that itself);
//   - the harnessams_selfcheck tool (action=save_agentsmd — the Overview
//     buttons and the self-check finalize both land there) writes the same
//     block with plugin-measured values; that rewrite carries no instruction
//     line, so a stale first-fill prompt is removed with it;
//   - values builds also render the self-check WORKFLOW branch for the saved
//     settings (selfcheckWorkflow.js), so the block documents how this
//     workspace runs; the first-fill template has no settings and renders none;
//   - plugin writes are external writes (no watcher): the block enters context
//     on the next session or after the next first-party fs call, as an
//     appended instruction delta — prefix cache intact.
// The yaml is pure English by ruling, single-level (no nested sections, no
// machines registry facts — 2026-11-19), and mirrors workspace_config.json:
// UI table = config file = AGENTS.md by construction (the same tool writes
// both). The .harnessams pointer paragraph rides BOTH the template and the
// values build, so it always tells the agent where the real state lives.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { localEnvFacts } from './checks.js'
import { workflowSection } from './selfcheckWorkflow.js'

const BEGIN = '<!-- hams-config:begin (HarnessAMS plugin-managed block; the harnessams_selfcheck tool overwrites it — keep edits outside the markers) -->'
const END = '<!-- hams-config:end -->'
const HEADER = '## Project Config (HarnessAMS)'
const POINTER = 'Project state lives in `.harnessams/`: workspace_config.json (workspace env + run settings incl. remote_root), '
  + 'sessions.json (per-session display/reports/confirmed check params), check_params.json (project check-param fallback), '
  + 'selfcheck/ (run records; artifacts are cleaned after runs — only selfcheck_run.json persists). '
  + 'The yaml below is the plugin-maintained mirror of workspace_config.json plus measured facts; '
  + 'the self-check workflow section in between is rendered from the same settings.'
const INSTRUCTION = 'Before starting any task in this workspace: run the project checks (self-check + local environment), fill the table below with MEASURED values, then proceed with the task. Skip only if the user explicitly asks to skip the self-check.'

export function agentsMdPath(workspacePath) {
  return path.join(workspacePath, 'AGENTS.md')
}

// A double-quoted JSON string is a valid YAML double-quoted scalar (escapes
// included), so Windows paths round-trip without hand-rolling a quoter. Nulls
// (no self-check run yet) are the YAML null literal.
const q = (v) => JSON.stringify(String(v))
const scalar = (v) => (v === null || v === undefined ? 'null' : q(v))

// Single-level projection: meta + workspace root + the settings mirror + local
// env facts + the latest finished self-check verdict.
function yamlLines({ syncedAt, workspaceRoot, settings, env, run }) {
  const s = settings ?? {}
  const lines = ['hams_project_config:']
  const row = (k, v) => lines.push(`  ${k}: ${scalar(v)}`)
  row('synced_at', syncedAt ?? '')
  row('synced_by', 'dsh-harnessams')
  row('workspace_root', workspaceRoot ?? '')
  row('run_mode', s.run_mode)
  row('machine', s.machine_id)
  row('scheduler', s.scheduler)
  row('simulator', s.simulator)
  row('compute_local', s.compute_script_local)
  row('compute_remote', s.compute_script_remote)
  row('remote_dir', s.remote_dir)
  row('remote_root', s.remote_root)
  row('node_version', env?.node?.version)
  row('node_path', env?.node?.path)
  row('python_version', env?.python?.version)
  row('python_path', env?.python?.path)
  row('last_selfcheck_run_id', run?.run_id ?? null)
  row('last_selfcheck_finished_at', run?.finished_at ?? null)
  row('last_selfcheck_local', run?.local ?? null)
  row('last_selfcheck_remote', run?.remote ?? null)
  row('last_selfcheck_overall', run?.overall ?? null)
  return lines
}

// The whole block between the markers, header included. withInstruction=true is
// the first-fill template (empty table + prompt); the values build omits the
// instruction, so replacing a template block removes a stale prompt with it.
// The POINTER rides both builds — a values rewrite must not orphan the agent
// from the .harnessams state it describes.
function buildSection(facts, { withInstruction = false } = {}) {
  const parts = [BEGIN, HEADER, '', POINTER]
  if (withInstruction) parts.push('', INSTRUCTION)
  // values builds carry settings, so they also carry the workflow branch that
  // matches them; the first-fill template (no settings) renders no workflow
  if (facts.settings) parts.push('', workflowSection(facts.settings))
  parts.push('', '```yaml', yamlLines(facts).join('\n'), '```', END)
  return parts.join('\n')
}

// Replace the marked block in place, or prepend the block at the head of a
// file that never carried it (a fresh workspace gets a file of its own).
function spliceSection(existing, section) {
  const begin = existing.indexOf(BEGIN)
  if (begin >= 0) {
    const end = existing.indexOf(END, begin)
    if (end >= 0) return existing.slice(0, begin) + section + existing.slice(end + END.length)
  }
  const body = String(existing ?? '')
  return body.trim() ? section + '\n\n' + body : section + '\n'
}

async function atomicWrite(file, text) {
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, file)
}

// Idempotent first-fill template: only writes when the file or the marked
// block is missing, never overwrites values, never throws (a broken template
// must not fail the settings/session write that calls it).
export async function ensureAgentsMdTemplate(workspacePath) {
  try {
    if (!workspacePath || typeof workspacePath !== 'string') return { ok: false, error: 'workspacePath is required' }
    const file = agentsMdPath(workspacePath)
    const existing = await fsp.readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
    if (existing != null && existing.includes(BEGIN)) return { ok: true, created: false }
    await atomicWrite(file, spliceSection(existing ?? '', buildSection({}, { withInstruction: true })))
    return { ok: true, created: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// Latest finished self-check run of THIS workspace (ids sort
// lexicographically = chronologically; runs live under the project's own
// .harnessams/selfcheck since the 2026-11-19 storage fix, so no cross-project
// bleed). Compact projection for the config table.
export async function latestSelfcheckRun(workspacePath) {
  const dir = path.join(workspacePath, '.harnessams', 'selfcheck')
  let names = []
  try { names = (await fsp.readdir(dir)).filter((n) => n.startsWith('rc_')) } catch { return null }
  names.sort()
  for (let i = names.length - 1; i >= 0; i--) {
    try {
      const run = JSON.parse(await fsp.readFile(path.join(dir, names[i], 'selfcheck_run.json'), 'utf8'))
      if (run?.status !== 'done') continue
      const s = run.summary ?? {}
      return {
        run_id: run.id ?? names[i],
        finished_at: run.finishedAt ?? run.startedAt ?? null,
        local: s.local ? 'ok' : 'failed',
        remote: s.remote ?? 'skipped',
        overall: s.ok ? 'ok' : 'failed',
      }
    } catch { /* unreadable run dir — fall through to the older one */ }
  }
  return null
}

// Values sync behind the harnessams_selfcheck tool (action=save_agentsmd) and
// the self-check finalize. settings come from the caller (readSettings at the
// action — keeps this module free of a settings.js import cycle, since
// settings.js hooks ensureAgentsMdTemplate). Degrades to empty strings instead
// of failing the write when a fact is unprobeable.
export async function syncAgentsMd(ctx, { project, settings }) {
  try {
    if (!project?.path) return { error: 'project.path is required' }
    const env = await localEnvFacts()
    const run = await latestSelfcheckRun(project.path)
    const section = buildSection({
      syncedAt: new Date().toISOString(),
      workspaceRoot: project.path,
      settings,
      env,
      run,
    })
    const file = agentsMdPath(project.path)
    const existing = await fsp.readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
    const created = !(existing != null && existing.includes(BEGIN))
    await atomicWrite(file, spliceSection(existing ?? '', section))
    return { ok: true, path: file, created }
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}
