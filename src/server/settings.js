// Per-project workspace config — the SINGLE config file (2026-11-19 D-004 wave):
// <workspace>/.harnessams/workspace_config.json. It replaces both the retired
// project_settings.json and the retired family harnessams.json, and carries two
// sections:
//   workspace — install/env facts (worker scripts root, plotly seed + url,
//     trash dir). Not a UI surface: laid down once with resolved defaults at
//     file creation and hand-edited only; every key still has a runtime
//     default so a missing or partial section fails open.
//   settings  — the run settings the Overview table stages + confirms through
//     the harnessams_selfcheck tool (working environment / mode / machine /
//     remote_root / selfcheck_remote_dir / scheduler / simulator / compute
//     scripts / the cluster toolchain pins remote_python + remote_spectre_cmd,
//     D-016) plus the MEASURED python facts: local_python_version/_path and
//     the local_python_numpy / remote_python_numpy tri-states (yes / no /
//     fallback — D-021 wave, 2026-11-25). The facts are null until a green
//     self-check measures them; global-store memory prefills fresh projects.
//     The remote root now lives HERE
//     (settings.remote_root), not in a family map — the project is the single
//     authority, so UI / config file / AGENTS.md can never disagree.
// Project anchoring (D-021): there is NO findProjectRoot walk-up anymore —
// every consumer resolves the project from the calling SESSION (or an explicit
// project argument) and reads this file at that root; resolveWorkspacePathsAt
// resolves the workspace section's relative keys against a GIVEN root.
// Per-session check params are NOT here (D-005: sessions.json carries the
// confirmed table; checkparams.js reads the project fallback file).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ensureAgentsMdTemplate } from './agentsmd.js'
import { ensureProjectScripts } from './scriptStage.js'
import { getNodePins, getLocalFacts } from './globalstore.js'

const PKG_ROOT = path.resolve(import.meta.dirname ?? '.', '..') // src/
const STORE_DIR = '.harnessams'
const CONFIG_FILE = 'workspace_config.json'

const ENUMS = {
  cluster_env: ['in-cluster', 'out-of-cluster'],
  run_mode: ['local', 'remote'],
  scheduler: ['lsf', 'ssh'],
  simulator: ['spectre', 'none'],
  compute_script_local: ['python', 'js'],
  compute_script_remote: ['python', 'js'],
  local_python_numpy: ['yes', 'no', 'fallback'],
  remote_python_numpy: ['yes', 'no', 'fallback'],
}

// The numpy tri-state fields and their legal values (D-021): "yes" the
// interpreter imports numpy natively; "fallback" it does not but the staged
// numfallback asset imports (the pure-stdlib shim); "no" neither works (a
// python 2 shell where even the fallback has py3 syntax). null = unmeasured.
export const NUMPY_KEYS = ['local_python_numpy', 'remote_python_numpy']
export const NUMPY_STATES = ENUMS.local_python_numpy

// Every MEASURED python-fact settings key (loose validation — these are facts,
// not configurable knobs; the AGENTS.md reconcile map validates them the same
// way, but with Windows-legal paths rather than the POSIX pin rules).
export const PY_FACT_KEYS = ['local_python_version', 'local_python_path', ...NUMPY_KEYS]

// Stricter shared helper for the loose string facts (also used by the
// AGENTS.md reconcile): non-empty trimmed string, <=400 chars, no control
// characters; null/'' → null.
function normalizeLooseFact(value, key) {
  if (value == null || value === '') return { value: null, error: null }
  if (typeof value !== 'string' || !value.trim()) {
    return { value: null, error: `${key} must be a non-empty string or null` }
  }
  const norm = value.trim()
  if (norm.length > 400) return { value: null, error: `${key} too long (max 400 chars)` }
  if (/[\u0000-\u001F]/.test(norm)) return { value: null, error: `${key} must not contain control characters (it renders into the AGENTS.md yaml)` }
  return { value: norm, error: null }
}

export function defaultSettings() {
  return {
    cluster_env: 'out-of-cluster',
    run_mode: 'local',
    machine_id: null,
    remote_root: null,
    // the self-check's remote artifact dir (renamed 2026-11-25 from remote_dir:
    // the name collided with batch_submit's remote_dir ARG — the batch output
    // dir it auto-names under remote_root, a different thing)
    selfcheck_remote_dir: '.harnessams/selfcheck',
    scheduler: 'lsf',
    simulator: 'spectre',
    compute_script_local: 'python',
    compute_script_remote: 'python',
    // cluster toolchain pins (D-016): absolute paths to the executables the
    // batch channel runs on the cluster side; null = unpinned, the bare
    // defaults apply (python3 / spectre on PATH)
    remote_python: null,
    remote_spectre_cmd: null,
    // MEASURED python facts (D-021, 2026-11-25): local_* describe THIS host's
    // bare `python` (probed at self-check finalize, remembered plugin-globally
    // so a fresh project prefills); remote_python_numpy describes the
    // interpreter the worker ran under (worker telemetry on a green run). null
    // = not measured yet; the numpy fields are the yes/no/fallback tri-state.
    local_python_version: null,
    local_python_path: null,
    local_python_numpy: null,
    remote_python_numpy: null,
  }
}

// ---- workspace section: resolved defaults at creation -----------------------
// sim_scripts_dir points at the SmartAnaSim scripts tree (the worker source for
// batch_submit). In a dev checkout that is the sibling HarnessAMS-SmartAnaSim
// package (PKG_ROOT is <plugin>/src, so the sibling sits TWO levels up); in an
// installed layout the sibling dsh-harnessams-smart-ana-sim package (the real
// npm name — an earlier "dsh-harnessams-sim" probe never matched) — probe both,
// keep the dev-shaped default when neither exists (hand-editable). Note
// path.join folds '..' away, hence the explicit double parent.
function defaultSimScriptsDir() {
  const candidates = [
    path.join(PKG_ROOT, '..', '..', 'HarnessAMS-SmartAnaSim', 'scripts'),
    path.join(PKG_ROOT, '..', '..', 'dsh-harnessams-smart-ana-sim', 'scripts'),
  ]
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return path.resolve(c) } catch { /* probe next */ }
  }
  return path.resolve(candidates[0])
}

// Source root for the one-time project script staging (scriptStage.js):
// HARNESSAMS_SIM_SCRIPTS_DIR -> the configured sim_scripts_dir (pre-flip —
// the dev sibling for a fresh project) -> the dev-sibling default. Resolution
// only; existence is the stager's problem (it fails open). `workspacePath` IS
// the project root (no walk-up since D-021).
export function resolveScriptsSource(workspacePath) {
  const env = process.env.HARNESSAMS_SIM_SCRIPTS_DIR
  if (env) return path.resolve(env)
  return resolveWorkspacePathsAt(workspacePath).sim_scripts_dir
}

export function defaultWorkspaceSection() {
  return {
    sim_scripts_dir: defaultSimScriptsDir(),
    // the shipped copy inside this package — in an installed layout that IS the
    // ~/.dsh node_modules location
    plotly_asset: path.join(PKG_ROOT, 'assets', 'plotly.min.js'),
    // the report's plotly <script src> source (D-021): a project-relative or
    // absolute LOCAL path (the default is the bundled plotly.min.js seeded
    // into <project>/.harnessams/assets — offline-capable, root stays clean),
    // or an http(s) URL (used verbatim; then no local file and PNG export
    // skips). An unresolvable value falls back to the CDN at render time.
    plotly_url: '.harnessams/assets/plotly.min.js',
    trash_dir: '.harnessams/trash',
  }
}

// ---- file location -----------------------------------------------------------

export function configPath(workspacePath) {
  return path.join(workspacePath, STORE_DIR, CONFIG_FILE)
}

// ---- read/normalize ----------------------------------------------------------

function parseConfig(raw) {
  const workspace = defaultWorkspaceSection()
  const settings = defaultSettings()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { version: 1, workspace, settings }, defaults: true }
  }
  const wsIn = raw.workspace
  if (wsIn && typeof wsIn === 'object' && !Array.isArray(wsIn)) {
    for (const k of Object.keys(workspace)) {
      const v = wsIn[k]
      if (typeof v === 'string' && v.trim()) workspace[k] = v.trim()
    }
  }
  const sIn = raw.settings
  if (sIn && typeof sIn === 'object' && !Array.isArray(sIn)) {
    for (const k of Object.keys(settings)) {
      const v = sIn[k]
      if (k === 'machine_id') {
        if (typeof v === 'string' && v.trim()) settings.machine_id = v.trim().slice(0, 120)
      } else if (k === 'remote_root') {
        if (typeof v === 'string' && v.trim()) settings.remote_root = v.trim().replace(/\\/g, '/')
      } else if (k === 'selfcheck_remote_dir') {
        if (typeof v === 'string' && v.trim()) settings.selfcheck_remote_dir = v.trim().replace(/\\/g, '/')
      } else if (PIN_KEYS.includes(k)) {
        // an invalid stored pin (hand-edited) reads as unpinned — the same
        // fail-open every other key gets
        settings[k] = normalizePin(v, k).value
      } else if (k === 'local_python_version' || k === 'local_python_path') {
        // measured facts: same fail-open (invalid reads as unmeasured)
        settings[k] = normalizeLooseFact(v, k).value
      } else if (ENUMS[k] && ENUMS[k].includes(v)) {
        settings[k] = v
      }
    }
    // legacy configs wrote the self-check dir as remote_dir (renamed 2026-11-25
    // to end the collision with the batch_submit remote_dir ARG): migrate on
    // read, fail-open like every other key — the next write persists the new key
    if (sIn.selfcheck_remote_dir === undefined
      && typeof sIn.remote_dir === 'string' && sIn.remote_dir.trim()) {
      settings.selfcheck_remote_dir = sIn.remote_dir.trim().replace(/\\/g, '/')
    }
  }
  return { config: { version: 1, workspace, settings } }
}

// A missing file is the defaults, not an error (fresh project, first write
// pending); a corrupt file throws — silently resetting settings would be worse.
// Returns { config, defaults? }.
export async function readConfig(workspacePath) {
  let raw = null
  try {
    raw = JSON.parse(await fsp.readFile(configPath(workspacePath), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  return parseConfig(raw)
}

export function readConfigSync(workspacePath) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(configPath(workspacePath), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  return parseConfig(raw)
}

export async function readSettings(workspacePath) {
  const { config } = await readConfig(workspacePath)
  return { settings: config.settings }
}

// Settings at a KNOWN project root, synchronously (the batch tools' setup is
// synchronous). No walk-up (D-021): the caller resolved the project from the
// calling session (or an explicit project argument). A missing or corrupt file
// = the defaults (out-of-cluster, the conservative channel).
export function readSettingsAt(projectRoot) {
  const base = path.resolve(String(projectRoot ?? '.'))
  try {
    return readConfigSync(base).config.settings
  } catch {
    return defaultSettings()
  }
}

// Resolve the workspace section's path keys against a GIVEN project root
// (relative values like ".harnessams/trash" are project-relative by design —
// the caller passes the session-resolved project root; no ancestor walk).
// plotly_url is passed through unresolved — its classification (URL vs local
// path) is the report renderer's business. Sync — the consumers (batch/trash)
// are synchronous call sites.
export function resolveWorkspacePathsAt(projectRoot) {
  const base = path.resolve(String(projectRoot ?? '.'))
  let ws = defaultWorkspaceSection()
  try {
    const { config } = readConfigSync(base)
    ws = config.workspace
  } catch { /* corrupt or missing — defaults already in place */ }
  return {
    root: base,
    sim_scripts_dir: path.isAbsolute(ws.sim_scripts_dir) ? ws.sim_scripts_dir : path.resolve(base, ws.sim_scripts_dir),
    plotly_asset: path.isAbsolute(ws.plotly_asset) ? ws.plotly_asset : path.resolve(base, ws.plotly_asset),
    plotly_url: typeof ws.plotly_url === 'string' ? ws.plotly_url : '',
    trash_dir: path.isAbsolute(ws.trash_dir) ? ws.trash_dir : path.resolve(base, ws.trash_dir),
  }
}

// ---- cluster toolchain pins (D-016) -------------------------------------------
//
// remote_python / remote_spectre_cmd name the executables the batch channel
// runs on the cluster side by ABSOLUTE path (the cluster-setup skill harvests
// and verifies them); null = unpinned, the bare defaults apply (python3 /
// spectre on PATH). ONE normalizer guards every face — settings file, tool
// argument, UI row — because the value is joined into a remote command line:
// absolute POSIX path to the executable FILE, ASCII, no whitespace or shell
// characters, no "..". A bare name is refused with guidance: it resolves
// through whatever PATH the startup chain left behind. Returns
// { value, error } — value is null whenever error is set.

export const PIN_KEYS = ['remote_python', 'remote_spectre_cmd']

export function normalizePin(value, key) {
  if (value == null || value === '') return { value: null, error: null }
  if (typeof value !== 'string' || !value.trim()) {
    return { value: null, error: `${key} must be an absolute path to the executable, or null` }
  }
  const norm = value.trim().replace(/\\/g, '/')
  if (!norm.startsWith('/')) {
    return { value: null, error: `${key} must be an ABSOLUTE path to the executable (starts with "/"), not the bare name `
      + `${JSON.stringify(norm)}: a bare name resolves through whatever PATH the shell startup chain left behind — `
      + 'omit it (null keeps the default) or run the cluster-setup skill to harvest and verify the real path' }
  }
  if (norm.length > 400) return { value: null, error: `${key} too long (max 400 chars)` }
  if (norm.split('/').includes('..')) return { value: null, error: `${key} must not contain ".."` }
  if (norm.endsWith('/') || !/^\/[A-Za-z0-9._+@/-]+$/.test(norm)) {
    return { value: null, error: `${key} must name the executable file — absolute, ASCII, no spaces or shell characters `
      + `(it is joined into a remote command line): ${JSON.stringify(norm)}` }
  }
  return { value: norm, error: null }
}

// ---- validate + write --------------------------------------------------------

// Context-free per-key validation for ONE value (D-021, 2026-11-25): the
// single authority validateSettings loops over, and the AGENTS.md reconcile
// (reconcile.js) reuses to validate one hand-edited yaml row before adopting
// it. Nullable keys accept null/'' → { value: null }; NO cross-key coupling —
// the whole-object validateSettings call owns the coupling rules, so the
// reconcile can adopt a pair of rows that only make sense together.
export function validateSettingValue(key, value) {
  if (key === 'machine_id') {
    if (value == null || value === '') return { value: null, error: null }
    if (typeof value !== 'string' || !value.trim()) {
      return { value: null, error: 'machine_id must be a non-empty string or null' }
    }
    return { value: value.trim().slice(0, 120), error: null }
  }
  if (key === 'remote_root') {
    if (value == null || value === '') return { value: null, error: null }
    if (typeof value !== 'string' || !value.trim()) {
      return { value: null, error: 'remote_root must be a non-empty string or null' }
    }
    const norm = value.trim().replace(/\\/g, '/')
    if (!norm.startsWith('/')) return { value: null, error: 'remote_root must be an absolute remote path (starts with "/")' }
    if (norm.length > 400) return { value: null, error: 'remote_root too long (max 400 chars)' }
    if (norm.split('/').includes('..')) return { value: null, error: 'remote_root must not contain ".."' }
    return { value: norm.replace(/\/+$/, '') || '/', error: null }
  }
  if (key === 'selfcheck_remote_dir') {
    if (typeof value !== 'string' || !value.trim()) {
      return { value: null, error: 'selfcheck_remote_dir is required (a path relative to remote_root, or absolute)' }
    }
    const norm = value.trim().replace(/\\/g, '/')
    if (norm.length > 400) return { value: null, error: 'selfcheck_remote_dir too long (max 400 chars)' }
    if (norm.split('/').includes('..')) return { value: null, error: 'selfcheck_remote_dir must not contain ".."' }
    return { value: norm, error: null }
  }
  if (PIN_KEYS.includes(key)) return normalizePin(value, key)
  if (key === 'local_python_version' || key === 'local_python_path') return normalizeLooseFact(value, key)
  if (ENUMS[key]) {
    if (NUMPY_KEYS.includes(key) && (value == null || value === '')) return { value: null, error: null }
    if (!ENUMS[key].includes(value)) {
      const orNull = NUMPY_KEYS.includes(key) ? ' (or null — not measured yet)' : ''
      return { value: null, error: `${key} must be one of: ${ENUMS[key].join(', ')}${orNull}` }
    }
    return { value, error: null }
  }
  return { value: null, error: `unknown settings key: ${key}` }
}

// Validate a full settings object (the tool `settings` param after the partial
// merge, or a staged table confirm). remote_root: absolute POSIX path fencing
// selfcheck_remote_dir (resolveRemoteDir re-fences at use time); ".." rejected here.
// remote mode requires remote_root always and machine_id unless in-cluster LSF
// is the only remote channel; out-of-cluster forbids local spectre (the host
// cannot run it). Per-key rules come from validateSettingValue (single
// authority); the coupling checks below are this function's own.
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'settings must be an object' }
  }
  const out = {}
  for (const k of Object.keys(defaultSettings())) {
    const r = validateSettingValue(k, input[k])
    if (r.error) return { error: r.error }
    out[k] = r.value
  }
  if (out.run_mode === 'remote') {
    const sshlessLsf = out.cluster_env === 'in-cluster' && out.scheduler !== 'ssh'
    if (!sshlessLsf && !out.machine_id) {
      return { error: 'run_mode=remote requires machine_id unless in-cluster LSF is the only remote channel (pick a dsh-ssh host alias)' }
    }
    if (!out.remote_root) return { error: 'run_mode=remote requires remote_root (the absolute remote path that fences selfcheck_remote_dir)' }
  }
  if (out.cluster_env === 'out-of-cluster' && out.run_mode === 'local' && out.simulator === 'spectre') {
    return { error: 'run_mode=local with simulator=spectre requires cluster_env=in-cluster (the DSH host itself must run spectre)' }
  }
  return { settings: out }
}

// Project storage initialization (2026-11-25: the sidebar-open moment is now
// the PRIMARY staging timing — POST /api/project-init — with the fresh config
// write and the self-check start as backstops). Idempotent: AGENTS.md template
// only while missing, scripts copy-if-missing (a user-edited copy is never
// clobbered), and sim_scripts_dir flips to the project-local copy ONLY while
// the configured value is still the packaged default — a hand-edited explicit
// value stays (legacy projects, README "worker scripts" contract). Fixes the
// asymmetry where a session-config write creating .harnessams first used to
// suppress the fresh-init staging forever.
export async function initProjectStorage(workspacePath, { settings } = {}) {
  const dir = path.join(workspacePath, STORE_DIR)
  const finalPath = configPath(workspacePath)
  const fresh = !fs.existsSync(dir)
  const cur = await readConfig(workspacePath)
  await fsp.mkdir(dir, { recursive: true })
  if (fresh) {
    // Measured local python facts prefill from the plugin-global memory
    // (D-021): the local_node_* rows render from process either way (dsh runs
    // on node — always available, filled at establishment), the python rows
    // PERSIST here, honestly null when this machine was never measured. Pins
    // stay null on a fresh config (no machine to attribute them to yet; the
    // project-init heal fills them from node memory when machine_id is set).
    try {
      const facts = await getLocalFacts()
      if (facts) {
        for (const k of ['local_python_version', 'local_python_path', 'local_python_numpy']) {
          if (cur.config.settings[k] == null && facts[k] != null) cur.config.settings[k] = facts[k]
        }
      }
    } catch { /* memory unreadable — the honest nulls stand */ }
    // The template renders the settings about to be WRITTEN when the caller
    // states them (writeSettings' fresh path) — a template carrying the
    // pre-write defaults would read as a divergent hand-edit at the next
    // reconcile (D-021).
    await ensureAgentsMdTemplate(workspacePath, { settings: settings ?? cur.config.settings })
  }
  await ensureProjectScripts(workspacePath, resolveScriptsSource(workspacePath))
  const ws = cur.config.workspace
  const configured = path.isAbsolute(ws.sim_scripts_dir) ? ws.sim_scripts_dir : path.resolve(workspacePath, ws.sim_scripts_dir)
  let flipped = false
  if (path.resolve(configured) === defaultSimScriptsDir()) {
    ws.sim_scripts_dir = path.join(dir, 'scripts')
    flipped = true
  }
  if (fresh || flipped) {
    const tmp = finalPath + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, workspace: ws, settings: cur.config.settings }, null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, finalPath)
  }
  return { fresh, flipped }
}

// Read-modify-write of the settings section only — the workspace section
// survives untouched. Fresh file: workspace defaults are laid down (the
// "initialize with npm-default plotly / sibling scripts" ruling) and the
// AGENTS.md config-table template rides the .harnessams creation moment —
// which also stages the project's reusable simulation scripts and points
// sim_scripts_dir at the project-local copy (2026-11-24: what the self-check
// exercises must stay usable afterwards; existing projects keep their
// explicit value, no migration).
export async function writeSettings(workspacePath, settings) {
  const dir = path.join(workspacePath, STORE_DIR)
  const finalPath = configPath(workspacePath)
  const fresh = !fs.existsSync(dir)
  if (fresh) await initProjectStorage(workspacePath, { settings })
  const cur = await readConfig(workspacePath)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = finalPath + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, workspace: cur.config.workspace, settings }, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, finalPath)
  return settings
}

// Prefill NULL settings fields from the plugin-global memories (D-017, widened
// D-021): a node measured for any earlier project heals a project on the same
// machine (the toolchain pins plus the measured remote_python_numpy tri-state
// — machine-scoped, machine_id required); THIS host's remembered python facts
// heal the local_python_* fields (host-scoped, no machine needed). Only NULL
// fields are healed — an explicit value always wins, and a remembered
// null/cleared key never refills (only a later green run re-measures). The
// AGENTS.md reconcile (reconcile.js) runs BEFORE this at each write entry so a
// hand-edited yaml value beats the memory. Returns the (possibly healed)
// settings.
export async function healFromGlobalMemory(workspacePath) {
  let settings
  try {
    ({ settings } = await readSettings(workspacePath))
  } catch (e) {
    return { error: `workspace_config.json unreadable: ${e?.message ?? e}` }
  }
  const patch = {}
  const needNode = [...PIN_KEYS, 'remote_python_numpy'].filter((k) => settings[k] == null)
  if (needNode.length && settings.machine_id) {
    const pins = await getNodePins(settings.machine_id)
    if (pins) for (const k of needNode) if (pins[k]) patch[k] = pins[k]
  }
  const needLocal = ['local_python_version', 'local_python_path', 'local_python_numpy']
    .filter((k) => settings[k] == null)
  if (needLocal.length) {
    const facts = await getLocalFacts()
    if (facts) for (const k of needLocal) if (facts[k]) patch[k] = facts[k]
  }
  if (!Object.keys(patch).length) return { settings }
  const v = validateSettings({ ...settings, ...patch })
  if (v.error) return { settings } // a remembered fact that stopped validating: keep nulls, no error
  await writeSettings(workspacePath, v.settings)
  return { settings: v.settings, healed: Object.keys(patch) }
}
