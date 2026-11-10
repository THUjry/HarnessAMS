// Check parameters (2026-11-10, check-params tab era): per-project assembly-check
// config at <workspace>/.harnessams/check_params.json, next to project_settings.json.
// The task tab's check sub-view edits the whole object through one confirmed PUT;
// the SmartAnaSim assembly-check library (scripts/common/common_workspace.py
// read_check_params) reads the same file as its default source, so a UI change
// takes effect on the next assembly run. Fail-open everywhere: a missing or
// hand-corrupted file falls back per-key to the built-in defaults and must never
// break an assembly run.
import fsp from 'node:fs/promises'
import path from 'node:path'

const PARAMS_DIR = '.harnessams'
const PARAMS_FILE = 'check_params.json'

// rcl mirrors spectre_checks.py IDEAL_RCL_RANGES (kind -> [lo, hi] in the base
// unit: ohm / farad / henry); the switches gate whole check families.
export function defaultCheckParams() {
  return {
    rcl: { r: [0.1, 1e6], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
    unit_check: true,
    bias_check: true,
    strict_includes: false,
  }
}

export function checkParamsPath(workspacePath) {
  return path.join(workspacePath, PARAMS_DIR, PARAMS_FILE)
}

// One [lo, hi] pair from an untrusted source: finite, positive, ordered.
function validPair(v) {
  return Array.isArray(v) && v.length === 2
    && Number.isFinite(v[0]) && Number.isFinite(v[1])
    && v[0] > 0 && v[0] < v[1]
}

// Read + normalize. A missing file is the defaults, not an error (same contract
// as readSettings); an off-spec file falls back per-key.
export async function readCheckParams(workspacePath) {
  let raw = null
  try {
    raw = JSON.parse(await fsp.readFile(checkParamsPath(workspacePath), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const params = defaultCheckParams()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { params, defaults: true }
  if (raw.rcl && typeof raw.rcl === 'object' && !Array.isArray(raw.rcl)) {
    for (const k of ['r', 'c', 'l']) {
      if (validPair(raw.rcl[k])) params.rcl[k] = [Number(raw.rcl[k][0]), Number(raw.rcl[k][1])]
    }
  }
  for (const k of ['unit_check', 'bias_check', 'strict_includes']) {
    if (typeof raw[k] === 'boolean') params[k] = raw[k]
  }
  return { params }
}

// Validate a full object from the client PUT. Returns { params } or { error }.
export function validateCheckParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'check params must be an object' }
  }
  const out = defaultCheckParams()
  if (!input.rcl || typeof input.rcl !== 'object' || Array.isArray(input.rcl)) {
    return { error: 'rcl must be an object with r/c/l [min, max] pairs' }
  }
  for (const k of ['r', 'c', 'l']) {
    if (!validPair(input.rcl[k])) {
      return { error: `rcl.${k} must be [min, max]: two finite numbers, min > 0, min < max` }
    }
    out.rcl[k] = [Number(input.rcl[k][0]), Number(input.rcl[k][1])]
  }
  for (const k of ['unit_check', 'bias_check', 'strict_includes']) {
    if (typeof input[k] !== 'boolean') return { error: `${k} must be a boolean (on/off switch)` }
    out[k] = input[k]
  }
  return { params: out }
}

export async function writeCheckParams(workspacePath, params) {
  const dir = path.join(workspacePath, PARAMS_DIR)
  const finalPath = checkParamsPath(workspacePath)
  await fsp.mkdir(dir, { recursive: true })
  // Atomic replace — same discipline as project_settings.json / tasks.json.
  const tmp = finalPath + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, ...params }, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, finalPath)
  return params
}
