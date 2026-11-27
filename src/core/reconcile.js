// AGENTS.md ↔ workspace_config.json reconciliation (D-002, 2026-11-25).
// The agent prefers editing the OUTSIDE file (the AGENTS.md yaml block) over
// calling the tool with a settings payload, so every config WRITE adopts the
// block's values first (AGENTS.md is authoritative) and the batch tools
// OVERLAY them at READ time — a hand-edit takes effect immediately and
// survives the next values sync instead of being clobbered by it.
// Rules (user ruling, 2026-11-25):
//   - A yaml row that is non-null AND differs from the json value is ADOPTED
//     after per-key string-legality validation (validateSettingValue — the
//     same single authority validateSettings uses). An invalid row becomes a
//     problem: NOT adopted, the json value stands.
//   - A null/absent row NEVER clears the json value — omission is how the
//     renderer skips inapplicable rows, not a clearing intent; explicit clears
//     go through the harnessams_selfcheck settings payload.
//   - Rows that only make sense together validate as a SET (validateSettings
//     on the merged object): an inconsistent hand-edit set is refused as one
//     combined problem and nothing is adopted.
//   - Problems: an AGENT caller gets warnings[] in the result (the write of
//     the valid adoptions proceeds); a USER caller (the UI route) is BLOCKED
//     with an error listing the problems.
//   - Never adopted, by construction: synced_* / workspace_root (metadata),
//     remote_scripts_dir (derived), last_selfcheck_* (plugin-written), and
//     local_node_* (process truth — rendered fresh, not configurable).
// This module deliberately sits BETWEEN settings.js and agentsmd.js (both
// imported, neither imports back) to avoid the settings↔agentsmd cycle.
import { readSettings, readSettingsAt, writeSettings, validateSettings, validateSettingValue, PIN_KEYS } from './settings.js'
import { parseFacts, parseFactsSync } from './agentsmd.js'

// yaml row key → settings key (the reconcilable mirror).
const ROW_MAP = [
  ['cluster_env', 'cluster_env'],
  ['run_mode', 'run_mode'],
  ['scheduler', 'scheduler'],
  ['simulator', 'simulator'],
  ['compute_local', 'compute_script_local'],
  ['compute_remote', 'compute_script_remote'],
  ['machine_id', 'machine_id'],
  ['remote_python', 'remote_python'],
  ['remote_spectre_cmd', 'remote_spectre_cmd'],
  ['remote_root', 'remote_root'],
  ['remote_python_numpy', 'remote_python_numpy'],
  ['selfcheck_remote_dir', 'selfcheck_remote_dir'],
  ['local_python_version', 'local_python_version'],
  ['local_python_path', 'local_python_path'],
  ['local_python_numpy', 'local_python_numpy'],
]

// Comparison normalization (the json side is already normalized by
// validateSettings; a hand-edited yaml row may differ only in formatting):
// pins and remote paths fold backslashes; remote_root also strips trailing
// slashes. Approximate equality is safe — a false "equal" just skips an
// adoption the next values sync re-renders anyway.
function compareNorm(settingsKey, v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  if (PIN_KEYS.includes(settingsKey) || settingsKey === 'remote_root' || settingsKey === 'selfcheck_remote_dir') {
    const folded = s.replace(/\\/g, '/')
    if (settingsKey === 'remote_root') return folded.replace(/\/+$/, '') || '/'
    return folded
  }
  return s
}

// Pure diff: which rows would be adopted, which are problems. Shared by the
// async write-side and the sync read-side overlay.
export function diffFacts(settings, facts) {
  const patch = {}
  const problems = []
  if (!settings || !facts) return { patch, problems }
  for (const [rowKey, settingsKey] of ROW_MAP) {
    if (!Object.prototype.hasOwnProperty.call(facts, rowKey)) continue
    const raw = facts[rowKey]
    if (raw == null || raw === '') continue // null/absent rows never clear json
    const cur = compareNorm(settingsKey, settings[settingsKey])
    const want = compareNorm(settingsKey, raw)
    if (want == null || want === cur) continue
    const r = validateSettingValue(settingsKey, raw)
    if (r.error) {
      problems.push({ key: settingsKey, row: rowKey, value: String(raw), reason: r.error })
      continue
    }
    if (r.value != null) patch[settingsKey] = r.value
  }
  return { patch, problems }
}

function problemWarnings(problems) {
  return problems.map((p) => `AGENTS.md row ${p.row}${p.key ? ` (settings.${p.key})` : ''} was not adopted: ${p.reason}`
    + (p.value ? ` — value: ${JSON.stringify(p.value.slice(0, 200))}` : ''))
}

// Write-side reconcile (every config write calls this FIRST). Returns
// { settings, adopted?, problems?, warnings? } — or { error, code: 400 } when
// source === 'user' and any problem exists (the save is blocked). Adoptions
// are validated as a set and written; problems never block an agent caller,
// only annotate the result.
export async function reconcileSettings(projectPath, { source } = {}) {
  let settings
  try {
    ({ settings } = await readSettings(projectPath))
  } catch (e) {
    return { error: `workspace_config.json unreadable: ${e?.message ?? e}`, code: 500 }
  }
  const facts = await parseFacts(projectPath)
  if (!facts) return { settings }
  // A NEVER-SYNCED block (synced_at still empty — the first-fill template) is
  // a plugin placeholder, not a hand-edit: its rows carry the pre-write
  // defaults, and adopting them would fight the very settings that follow.
  // Reconciliation only reads SYNCED blocks; the post-write sync marks one.
  if (!facts.synced_at) return { settings }
  const { patch, problems } = diffFacts(settings, facts)
  if (!Object.keys(patch).length && !problems.length) return { settings }
  let merged = settings
  if (Object.keys(patch).length) {
    const v = validateSettings({ ...settings, ...patch })
    if (v.error) {
      problems.push({
        key: null, row: '(combined)', value: '',
        reason: `the adopted AGENTS.md values break a settings rule as a set: ${v.error}`,
      })
    } else {
      merged = v.settings
    }
  }
  const warnings = problemWarnings(problems)
  if (problems.length && source === 'user') {
    return {
      error: 'the AGENTS.md config block has values the project config refuses to adopt — fix them before saving:\n- '
        + warnings.join('\n- '),
      problems, warnings, code: 400,
    }
  }
  if (merged !== settings) {
    try {
      await writeSettings(projectPath, merged)
      return { settings: merged, adopted: Object.keys(patch), problems, warnings }
    } catch (e) {
      warnings.push(`workspace_config.json write failed while adopting AGENTS.md values: ${e?.message ?? e}`)
    }
  }
  return { settings, problems, warnings }
}

// Read-side overlay (the batch tools' settings resolution, D-002 "reconcile
// at read AND write"): the session-project settings with the AGENTS.md rows
// overlaid — legal rows win, illegal rows keep the json value and surface as
// warnings the tool result carries. Synchronous (the batch call sites are
// synchronous setup); writes nothing.
export function overlaySettingsAt(projectPath, settings) {
  const base = settings ?? readSettingsAt(projectPath)
  const facts = parseFactsSync(projectPath)
  if (!facts) return { settings: base, warnings: [] }
  // unsynced first-fill template: a placeholder, nothing to overlay (see
  // reconcileSettings for the reasoning; the template renders synced_at as an
  // empty string, a synced block as an ISO timestamp)
  if (!facts.synced_at) return { settings: base, warnings: [] }
  const { patch, problems } = diffFacts(base, facts)
  let out = base
  if (Object.keys(patch).length) {
    const v = validateSettings({ ...base, ...patch })
    if (!v.error) out = v.settings
  }
  return { settings: out, warnings: problemWarnings(problems) }
}
