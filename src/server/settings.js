// Per-project workspace config — the SINGLE config file (2026-11-19 D-004 wave):
// <workspace>/.harnessams/workspace_config.json. It replaces both the retired
// project_settings.json and the retired family harnessams.json, and carries two
// sections:
//   workspace — install/env facts (worker scripts root, plotly seed, trash dir).
//     Not a UI surface: laid down once with resolved defaults at file creation
//     and hand-edited only; every key still has a runtime default so a missing
//     or partial section fails open.
//   settings  — the run settings the Overview table stages + confirms through
//     the harnessams_selfcheck tool (working environment / mode / machine /
//     remote_root / remote_dir / scheduler / simulator / compute scripts). The
//     remote root now lives HERE
//     (settings.remote_root), not in a family map — the project is the single
//     authority, so UI / config file / AGENTS.md can never disagree.
// Per-session check params are NOT here (D-005: sessions.json carries the
// confirmed table; checkparams.js reads the project fallback file).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ensureAgentsMdTemplate } from './agentsmd.js'

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
}

export function defaultSettings() {
  return {
    cluster_env: 'out-of-cluster',
    run_mode: 'local',
    machine_id: null,
    remote_root: null,
    remote_dir: '.harnessams/selfcheck',
    scheduler: 'lsf',
    simulator: 'spectre',
    compute_script_local: 'python',
    compute_script_remote: 'python',
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

export function defaultWorkspaceSection() {
  return {
    sim_scripts_dir: defaultSimScriptsDir(),
    // the shipped copy inside this package — in an installed layout that IS the
    // ~/.dsh node_modules location
    plotly_asset: path.join(PKG_ROOT, 'assets', 'plotly.min.js'),
    trash_dir: '.harnessams/trash',
  }
}

// ---- file location + project-root discovery ---------------------------------

export function configPath(workspacePath) {
  return path.join(workspacePath, STORE_DIR, CONFIG_FILE)
}

// Nearest ancestor directory that has a .harnessams store — the project root
// anchor for cwd-less consumers (trash, worker scripts). ≤8 levels, like the
// python twin's walkers.
export function findProjectRoot(startDir) {
  let d = path.resolve(String(startDir ?? process.cwd()))
  for (let i = 0; i < 8; i++) {
    try { if (fs.statSync(path.join(d, STORE_DIR)).isDirectory()) return d } catch { /* keep walking */ }
    const parent = path.dirname(d)
    if (parent === d) return null
    d = parent
  }
  return null
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
      } else if (k === 'remote_dir') {
        if (typeof v === 'string' && v.trim()) settings.remote_dir = v.trim().replace(/\\/g, '/')
      } else if (ENUMS[k] && ENUMS[k].includes(v)) {
        settings[k] = v
      }
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

// Settings for an ANCHOR path inside the project (the batch tools' run_dir):
// the project root is the nearest ancestor with a .harnessams store; no store
// or a corrupt file = the defaults (out-of-cluster, the conservative channel).
// Sync — the batch submit/poll call sites are synchronous setup.
export function readSettingsFor(anchor = process.cwd()) {
  const base = findProjectRoot(anchor) ?? path.resolve(String(anchor ?? '.'))
  try {
    return readConfigSync(base).config.settings
  } catch {
    return defaultSettings()
  }
}

// Resolve the workspace section's path keys against the project root (relative
// values like ".harnessams/trash" are project-relative by design). The root is
// the nearest ancestor of `anchor` holding a .harnessams store; with no store
// found the section defaults apply, anchored at `anchor` itself. Sync — the
// consumers (batch/trash) are synchronous call sites.
export function resolveWorkspacePaths(anchor = process.cwd()) {
  const base = findProjectRoot(anchor) ?? path.resolve(String(anchor ?? '.'))
  let ws = defaultWorkspaceSection()
  try {
    const { config } = readConfigSync(base)
    ws = config.workspace
  } catch { /* corrupt or missing — defaults already in place */ }
  return {
    root: base,
    sim_scripts_dir: path.isAbsolute(ws.sim_scripts_dir) ? ws.sim_scripts_dir : path.resolve(base, ws.sim_scripts_dir),
    plotly_asset: path.isAbsolute(ws.plotly_asset) ? ws.plotly_asset : path.resolve(base, ws.plotly_asset),
    trash_dir: path.isAbsolute(ws.trash_dir) ? ws.trash_dir : path.resolve(base, ws.trash_dir),
  }
}

// ---- validate + write --------------------------------------------------------

// Validate a full settings object (tool `settings` param / staged table
// confirm). remote_root: absolute POSIX path fencing remote_dir (resolveRemoteDir
// re-fences at use time); ".." rejected here. remote mode requires remote_root
// always and machine_id unless in-cluster LSF is the only remote channel;
// out-of-cluster forbids local spectre (the host cannot run it).
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'settings must be an object' }
  }
  const out = {}
  for (const k of Object.keys(defaultSettings())) {
    const v = input[k]
    if (k === 'machine_id') {
      if (v == null || v === '') out.machine_id = null
      else if (typeof v === 'string' && v.trim()) out.machine_id = v.trim().slice(0, 120)
      else return { error: 'machine_id must be a non-empty string or null' }
    } else if (k === 'remote_root') {
      if (v == null || v === '') { out.remote_root = null; continue }
      if (typeof v !== 'string' || !v.trim()) return { error: 'remote_root must be a non-empty string or null' }
      const norm = v.trim().replace(/\\/g, '/')
      if (!norm.startsWith('/')) return { error: 'remote_root must be an absolute remote path (starts with "/")' }
      if (norm.length > 400) return { error: 'remote_root too long (max 400 chars)' }
      if (norm.split('/').includes('..')) return { error: 'remote_root must not contain ".."' }
      out.remote_root = norm.replace(/\/+$/, '') || '/'
    } else if (k === 'remote_dir') {
      if (typeof v !== 'string' || !v.trim()) return { error: 'remote_dir is required (a path relative to remote_root, or absolute)' }
      const norm = v.trim().replace(/\\/g, '/')
      if (norm.length > 400) return { error: 'remote_dir too long (max 400 chars)' }
      if (norm.split('/').includes('..')) return { error: 'remote_dir must not contain ".."' }
      out.remote_dir = norm
    } else if (ENUMS[k]) {
      if (!ENUMS[k].includes(v)) return { error: `${k} must be one of: ${ENUMS[k].join(', ')}` }
      out[k] = v
    }
  }
  if (out.run_mode === 'remote') {
    const sshlessLsf = out.cluster_env === 'in-cluster' && out.scheduler !== 'ssh'
    if (!sshlessLsf && !out.machine_id) {
      return { error: 'run_mode=remote requires machine_id unless in-cluster LSF is the only remote channel (pick a dsh-ssh host alias)' }
    }
    if (!out.remote_root) return { error: 'run_mode=remote requires remote_root (the absolute remote path that fences remote_dir)' }
  }
  if (out.cluster_env === 'out-of-cluster' && out.run_mode === 'local' && out.simulator === 'spectre') {
    return { error: 'run_mode=local with simulator=spectre requires cluster_env=in-cluster (the DSH host itself must run spectre)' }
  }
  return { settings: out }
}

// Read-modify-write of the settings section only — the workspace section
// survives untouched. Fresh file: workspace defaults are laid down (the
// "initialize with npm-default plotly / sibling scripts" ruling) and the
// AGENTS.md config-table template rides the .harnessams creation moment.
export async function writeSettings(workspacePath, settings) {
  const dir = path.join(workspacePath, STORE_DIR)
  const finalPath = configPath(workspacePath)
  const fresh = !fs.existsSync(dir)
  const cur = await readConfig(workspacePath)
  await fsp.mkdir(dir, { recursive: true })
  if (fresh) await ensureAgentsMdTemplate(workspacePath)
  const tmp = finalPath + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, workspace: cur.config.workspace, settings }, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, finalPath)
  return settings
}
