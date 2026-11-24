// AGENTS.md project-config block (2026-11-18; flattened 2026-11-19 D-004;
// reshaped 2026-11-24). Per the front-of-house rule (the DSHstudy context-sync
// note: AGENTS.md is the reviewable, diff-able sync vehicle — plugins must not
// assemble injections in the back half), this module only maintains ONE marked
// block at the head of the workspace's own AGENTS.md. The block is tables and
// bullets only, NO prose paragraphs (2026-11-24 ruling):
//   - Core constraints bullets (the ask-first / tools-first / don't-read-
//     .harnessams rules every session must honor);
//   - the yaml table mirroring workspace_config.json plus measured facts and
//     the latest self-check verdict (aliases are NOT rendered — paths only:
//     the tools resolve the machine themselves; the cluster toolchain pins
//     remote_python / remote_spectre_cmd render as the two rows a session
//     reads to run remote parsers without passing an interpreter);
//   - the recommended-workflow .md table (selfcheckWorkflow.js), values builds
//     only — the first-fill template has no settings and renders no table.
// Lifecycle unchanged: .harnessams creation (writeSettings/writeSessionConfig)
// lays the template down; the harnessams_selfcheck tool (action=save_agentsmd
// — the Overview buttons and the self-check finalize both land there) writes
// the same block with plugin-measured values. Plugin writes are external
// writes (no watcher): the block enters context on the next session or after
// the next first-party fs call, as an appended instruction delta — prefix
// cache intact. The yaml is pure English by ruling and single-level; UI
// table = config file = AGENTS.md by construction (the same tool writes
// both).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { localEnvFacts } from './checks.js'
import { workflowTable } from './selfcheckWorkflow.js'

const BEGIN = '<!-- hams-config:begin (HarnessAMS plugin-managed block; the harnessams_selfcheck tool overwrites it — keep edits outside the markers) -->'
const END = '<!-- hams-config:end -->'
const HEADER = '## Project Config (HarnessAMS)'

// The core constraints (2026-11-24 user ruling) — the ONLY bullets in the
// block. Ask-first on unclear design input; tools-first execution with
// consult-on-failure (no improvised bypasses of the plugin chain);
// .harnessams is storage, not a model-facing surface.
const CONSTRAINTS = [
  '- When design constraints are unclear, ask the user before doing anything — never guess or invent them.',
  '- Execute through the SAS/HA plugin tools (spectre_assemble, batch_submit / batch_poll, snp_*, gen_sweep_report); if a tool call fails, stop and consult the user — no hand-rolled workarounds around the tool chain.',
  '- `.harnessams/` is plugin-managed project storage (config, sessions, run records): do not read it during normal work — everything you need is in this block and the Overview settings table.',
]

export function agentsMdPath(workspacePath) {
  return path.join(workspacePath, 'AGENTS.md')
}

// A double-quoted JSON string is a valid YAML double-quoted scalar (escapes
// included), so Windows paths round-trip without hand-rolling a quoter. Nulls
// (no self-check run yet) are the YAML null literal.
const q = (v) => JSON.stringify(String(v))
const scalar = (v) => (v === null || v === undefined ? 'null' : typeof v === 'boolean' ? String(v) : q(v))

// Single-level projection: meta + workspace root + the settings mirror + local
// env facts + the latest finished self-check verdict. Machine ALIASES are
// deliberately absent (2026-11-24): the dsh-ssh alias never appears in the
// block — the batch tools resolve the configured machine themselves, and the
// remote side is stated as paths only (remote_root, remote_dir,
// remote_scripts_dir, and the toolchain pins remote_python /
// remote_spectre_cmd — D-016: null = not pinned yet, the bare defaults).
function yamlLines({ syncedAt, workspaceRoot, settings, env, run }) {
  const s = settings ?? {}
  const lines = ['hams_project_config:']
  const row = (k, v) => lines.push(`  ${k}: ${scalar(v)}`)
  row('synced_at', syncedAt ?? '')
  row('synced_by', 'dsh-harnessams')
  row('workspace_root', workspaceRoot ?? '')
  row('cluster_env', s.cluster_env)
  row('run_mode', s.run_mode)
  row('scheduler', s.scheduler)
  row('simulator', s.simulator)
  row('compute_local', s.compute_script_local)
  row('compute_remote', s.compute_script_remote)
  row('remote_python', s.remote_python ?? null)
  row('remote_spectre_cmd', s.remote_spectre_cmd ?? null)
  row('report_figs', s.report_figs === true)
  row('remote_dir', s.remote_dir)
  row('remote_root', s.remote_root)
  row('remote_scripts_dir', s.remote_root
    ? `${String(s.remote_root).replace(/\/+$/, '')}/.harnessams/scripts` : null)
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

// The whole block between the markers, header included: constraints bullets,
// then the yaml table, then (values builds only — settings present) the
// recommended-workflow table. The first-fill template renders constraints +
// an empty yaml; the values rewrite adds the workflow table.
function buildSection(facts) {
  const parts = [BEGIN, HEADER, '', ...CONSTRAINTS, '', '```yaml', yamlLines(facts).join('\n'), '```']
  if (facts.settings) parts.push('', workflowTable(facts.settings))
  parts.push(END)
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
    await atomicWrite(file, spliceSection(existing ?? '', buildSection({})))
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
