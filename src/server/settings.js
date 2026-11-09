// Project settings (2026-11-08, project self-check era): per-project config at
// <workspace>/.harnessams/project_settings.json, next to tasks.json. The Overview
// settings table edits it; the self-check orchestrator reads it as the single
// source of truth for HOW a run executes (mode / machine / scheduler / simulator
// / compute scripts). Local mode keeps the remote fields stored but unused, so
// toggling the mode back and forth never loses the binding.
import fsp from 'node:fs/promises'
import path from 'node:path'

const SETTINGS_DIR = '.harnessams'
const SETTINGS_FILE = 'project_settings.json'

const ENUMS = {
  run_mode: ['local', 'remote'],
  scheduler: ['lsf', 'direct'],
  simulator: ['spectre', 'none'],
  compute_script_local: ['python', 'js'],
  compute_script_remote: ['python', 'js'],
}

export function defaultSettings() {
  return {
    run_mode: 'local',
    machine_id: null,
    remote_dir: '.harnessams/selfcheck',
    scheduler: 'lsf',
    simulator: 'spectre',
    compute_script_local: 'python',
    compute_script_remote: 'python',
  }
}

export function settingsPath(workspacePath) {
  return path.join(workspacePath, SETTINGS_DIR, SETTINGS_FILE)
}

// Read + normalize. A missing file is the defaults, not an error; a hand-edited
// file with invalid values falls back per-key (the file is normally server-written,
// so anything off-spec was edited externally and must not break the Overview).
export async function readSettings(workspacePath) {
  let raw = null
  try {
    raw = JSON.parse(await fsp.readFile(settingsPath(workspacePath), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const settings = defaultSettings()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { settings, defaults: true }
  for (const k of Object.keys(settings)) {
    const v = raw[k]
    if (k === 'machine_id') {
      if (typeof v === 'string' && v.trim()) settings.machine_id = v.trim().slice(0, 120)
    } else if (k === 'remote_dir') {
      if (typeof v === 'string' && v.trim()) settings.remote_dir = v.trim().replace(/\\/g, '/')
    } else if (k === 'scheduler' && v === 'none') {
      settings.scheduler = 'direct' // legacy value from before the scheduler=direct rename
    } else if (ENUMS[k] && ENUMS[k].includes(v)) {
      settings[k] = v
    }
  }
  return { settings }
}

// Validate a full settings object from the client PUT. Returns { settings } or
// { error }. remote_dir accepts a path relative to the machine's remotePath or an
// absolute remote path; ".." is rejected here and resolveRemoteDir() re-fences it
// against the remote workspace root at use time.
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
    } else if (k === 'remote_dir') {
      if (typeof v !== 'string' || !v.trim()) return { error: 'remote_dir is required (a path relative to the machine workspace, or absolute)' }
      const norm = v.trim().replace(/\\/g, '/')
      if (norm.length > 400) return { error: 'remote_dir too long (max 400 chars)' }
      if (norm.split('/').includes('..')) return { error: 'remote_dir must not contain ".."' }
      out.remote_dir = norm
    } else if (ENUMS[k]) {
      if (!ENUMS[k].includes(v)) return { error: `${k} must be one of: ${ENUMS[k].join(', ')}` }
      out[k] = v
    }
  }
  if (out.run_mode === 'remote' && !out.machine_id) {
    return { error: 'run_mode=remote requires machine_id (pick a dsh-remote machine)' }
  }
  return { settings: out }
}

export async function writeSettings(workspacePath, settings) {
  const dir = path.join(workspacePath, SETTINGS_DIR)
  const finalPath = settingsPath(workspacePath)
  await fsp.mkdir(dir, { recursive: true })
  // Atomic replace — same discipline as tasks.json.
  const tmp = finalPath + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, ...settings }, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, finalPath)
  return settings
}
