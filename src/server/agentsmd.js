// AGENTS.md project-config table (2026-11-18). Per the front-of-house rule
// (DSHstudy Context/项目信息同步方法.md: AGENTS.md is the reviewable,
// diff-able sync vehicle — plugins must not assemble injections in the back
// half), this module only maintains ONE marked block at the head of the
// workspace's own AGENTS.md:
//   - .harnessams creation (writeTasks/writeSettings/writeCheckParams) also
//     lays down the block as an EMPTY table plus a first-fill instruction —
//     any session that starts in the workspace sees the prompt and fills the
//     table from measured checks before working (the user may explicitly
//     waive the self-check; the agent judges that itself);
//   - the Overview buttons ("save to AGENTS.md" / "check all & save") write
//     the same block with plugin-measured values — that rewrite carries no
//     instruction line, so a stale first-fill prompt is removed with it;
//   - plugin writes are external writes (no watcher): the block enters
//     context on the next session or after the next first-party fs call, as
//     an appended instruction delta — prefix cache intact.
// The yaml is pure English by ruling; all values are check-driven facts.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { localEnvFacts } from './checks.js'
import { listMachines } from '../remote.js'

const BEGIN = '<!-- hams-config:begin (HarnessAMS plugin-managed block; the overview buttons overwrite it — keep edits outside the markers) -->'
const END = '<!-- hams-config:end -->'
const HEADER = '## Project Config (HarnessAMS)'
const INSTRUCTION = 'Before starting any task in this workspace: run the project checks (self-check + local environment + machines), fill the table below with MEASURED values, then proceed with the task. Skip only if the user explicitly asks to skip the self-check.'

export function agentsMdPath(workspacePath) {
  return path.join(workspacePath, 'AGENTS.md')
}

// A double-quoted JSON string is a valid YAML double-quoted scalar (escapes
// included), so Windows paths round-trip without hand-rolling a quoter.
const q = (v) => JSON.stringify(v == null ? '' : String(v))

function yamlLines({ syncedAt, workspaceRoot, machines, settings, env, run }) {
  const s = settings ?? {}
  const lines = []
  lines.push('hams_project_config:')
  lines.push(`  meta:      { synced_at: ${q(syncedAt ?? '')}, synced_by: "dsh-harnessams" }`)
  lines.push(`  workspace: { root: ${q(workspaceRoot ?? '')} }`)
  if (machines?.length) {
    lines.push('  machines:')
    for (const m of machines) {
      lines.push(`    - { alias: ${q(m.alias)}, host: ${q(m.host)}, port: ${Number(m.port) || 22},`
        + ` user: ${q(m.username)}, auth: ${q(m.auth)}, remote_root: ${q(m.workspace)} }`)
    }
  } else {
    lines.push('  machines: []')
  }
  lines.push('  settings:')
  lines.push(`    run_mode: ${q(s.run_mode)}`)
  lines.push(`    machine: ${q(s.machine_id)}`)
  lines.push(`    scheduler: ${q(s.scheduler)}`)
  lines.push(`    simulator: ${q(s.simulator)}`)
  lines.push(`    compute_local: ${q(s.compute_script_local)}`)
  lines.push(`    compute_remote: ${q(s.compute_script_remote)}`)
  lines.push(`    remote_dir: ${q(s.remote_dir)}`)
  lines.push('  local_env:')
  lines.push(`    node:    { version: ${q(env?.node?.version)}, path: ${q(env?.node?.path)} }`)
  lines.push(`    python:  { version: ${q(env?.python?.version)}, path: ${q(env?.python?.path)} }`)
  if (run) {
    lines.push('  last_selfcheck:')
    lines.push(`    run_id: ${q(run.run_id)}`)
    lines.push(`    finished_at: ${q(run.finished_at)}`)
    lines.push(`    local: ${q(run.local)}`)
    lines.push(`    remote: ${q(run.remote)}`)
    lines.push(`    overall: ${q(run.overall)}`)
  } else {
    lines.push('  last_selfcheck: null')
  }
  return lines
}

// The whole block between the markers, header included. withInstruction=true is
// the first-fill template (empty table + prompt); the values build omits the
// instruction, so replacing a template block removes a stale prompt with it.
function buildSection(facts, { withInstruction = false } = {}) {
  const parts = [BEGIN, HEADER]
  if (withInstruction) parts.push('', INSTRUCTION)
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
// must not fail the tasks/settings/params write that calls it).
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
// lexicographically = chronologically; the directory is workspace-local, so
// no cross-project bleed). Compact projection for the config table.
export async function latestSelfcheckRun(workspacePath) {
  const dir = path.join(workspacePath, 'selfcheck')
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

// Values sync behind the Overview buttons. settings come from the caller
// (readSettings at the route — keeps this module free of a settings.js import
// cycle, since settings.js hooks ensureAgentsMdTemplate). A missing dsh-ssh
// or python degrades to empty lists/strings instead of failing the write.
export async function syncAgentsMd(ctx, { project, settings }) {
  try {
    if (!project?.path) return { error: 'project.path is required' }
    const env = await localEnvFacts()
    let machines = []
    try {
      const list = await listMachines(ctx)
      if (list.ok) machines = list.machines.filter((m) => m.configured)
    } catch { /* dsh-ssh absent → empty machine list, not a failed sync */ }
    const run = await latestSelfcheckRun(project.path)
    const section = buildSection({
      syncedAt: new Date().toISOString(),
      workspaceRoot: project.path,
      machines,
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
