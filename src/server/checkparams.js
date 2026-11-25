// Check parameters — PROJECT-LEVEL FALLBACK since 2026-11-19 (decisions.md
// D-005): confirmed params are per-session (sessions.json), and this file at
// <workspace>/.harnessams/check_params.json is the middle of the resolution
// chain the SmartAnaSim pre-check engine applies:
//   built-in defaults  <-  check_params.json  <-  the session's confirmed table
// (src/precheck.js readCheckParamsChain resolves the same chain via the
// session id). The UI edits session entries only; this file remains a
// hand-editable project baseline. Fail-open everywhere: a missing or
// hand-corrupted file falls back per-key to the built-in defaults and must
// never break a pre-check run. Table re-shaped 2026-11-25: bias_check and
// strict_includes are retired with their check families, and the mult table
// (nf/m multiplier ranges) joins rcl and unit_check — legacy keys in existing
// files are ignored on read.
import fsp from 'node:fs/promises'
import path from 'node:path'

const PARAMS_DIR = '.harnessams'
const PARAMS_FILE = 'check_params.json'

// rcl mirrors spectre pre-check IDEAL_RCL_RANGES (kind -> [lo, hi] in the base
// unit: ohm / farad / henry), mult the nf/m multiplier ranges (positive
// integers); unit_check gates the geometry-suffix family.
export function defaultCheckParams() {
  return {
    rcl: { r: [0.1, 1e6], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
    mult: { nf: [1, 128], m: [1, 1000] },
    unit_check: true,
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

// One [lo, hi] multiplier pair: positive integers, ordered.
function validMultPair(v) {
  return Array.isArray(v) && v.length === 2
    && Number.isInteger(v[0]) && Number.isInteger(v[1])
    && v[0] > 0 && v[0] < v[1]
}

function applyLayer(params, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  if (raw.rcl && typeof raw.rcl === 'object' && !Array.isArray(raw.rcl)) {
    for (const k of ['r', 'c', 'l']) {
      if (validPair(raw.rcl[k])) params.rcl[k] = [Number(raw.rcl[k][0]), Number(raw.rcl[k][1])]
    }
  }
  if (raw.mult && typeof raw.mult === 'object' && !Array.isArray(raw.mult)) {
    for (const k of ['nf', 'm']) {
      if (validMultPair(raw.mult[k])) params.mult[k] = [Number(raw.mult[k][0]), Number(raw.mult[k][1])]
    }
  }
  if (typeof raw.unit_check === 'boolean') params.unit_check = raw.unit_check
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
  applyLayer(params, raw)
  return raw ? { params } : { params, defaults: true }
}

// Validate a full object (used for the per-session table in project.js). Returns { params } or { error }.
// Strict: the session table carries the full new shape (rcl + mult +
// unit_check). Entries from the pre-mult shape fail validation and are
// dropped entry-level on read — existing sessions are explicitly NOT kept
// compatible (2026-11-25 user ruling: new sessions are the bar).
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
  if (!input.mult || typeof input.mult !== 'object' || Array.isArray(input.mult)) {
    return { error: 'mult must be an object with nf/m [min, max] pairs' }
  }
  for (const k of ['nf', 'm']) {
    if (!validMultPair(input.mult[k])) {
      return { error: `mult.${k} must be [min, max]: two positive integers, min < max` }
    }
    out.mult[k] = [Number(input.mult[k][0]), Number(input.mult[k][1])]
  }
  if (typeof input.unit_check !== 'boolean') return { error: 'unit_check must be a boolean (on/off switch)' }
  out.unit_check = input.unit_check
  return { params: out }
}
