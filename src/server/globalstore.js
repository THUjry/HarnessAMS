// Plugin-global store (D-003, 2026-11-25): machine-scope facts that outlive any
// one project. Three tenants:
//   nodes   — the cluster toolchain pins a node MEASURED for any project (a
//             green self-check pins them, see selfcheck.js finalize); the next
//             fresh project on the same node prefills from here, so its
//             AGENTS.md yaml never starts with null pins. Entries also carry
//             the measured remote_python_numpy tri-state (yes / no / fallback
//             — the numpy mode of the interpreter the worker ran under).
//   local   — THIS host's own python facts (local_python_version / _path, and
//             the local_python_numpy tri-state): measured by a self-check's
//             finalize-side probe, remembered here, prefilling fresh projects
//             on the same machine. Null until the first measurement.
//   display — the UI globals; today one: selfcheck_fresh_min, the freshness
//             window the settings-table status cells restore by (a verdict
//             within the window shows its check mark, past it the table says
//             "not self-checked for > N min"; the console's display settings
//             own the write face).
// Location: HARNESSAMS_GLOBAL_STORE (tests point it at a tmp file) ->
// (DSH_HOME || ~/.dsh)/harnessams.json — the dsh-ssh.json neighborhood, NOT the
// family workspace (that one is cleanable at any time). Every read is
// fail-open (missing/corrupt = defaults); writes are read-modify-write,
// atomic, idempotent, and small.
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_FRESH_MIN = 30

// The numpy tri-state both python-fact fields use (2026-11-25 ruling): "yes"
// the interpreter imports numpy natively, "fallback" it does not but the staged
// numfallback asset imports, "no" neither works (e.g. a python 2 shell where
// even the pure-stdlib fallback has py3 syntax). null = not measured yet.
const NUMPY_STATES = ['yes', 'no', 'fallback']
const numpyState = (v) => (typeof v === 'string' && NUMPY_STATES.includes(v) ? v : null)

function storePath() {
  const env = process.env.HARNESSAMS_GLOBAL_STORE
  if (env) return path.resolve(env)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'harnessams.json')
}

function emptyStore() {
  return { version: 1, nodes: {}, local: null, display: { selfcheck_fresh_min: DEFAULT_FRESH_MIN } }
}

async function writeStore(store) {
  const p = storePath()
  await fsp.mkdir(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, p)
}

export async function readGlobalStore() {
  let raw = null
  try {
    raw = JSON.parse(await fsp.readFile(storePath(), 'utf8'))
  } catch {
    return emptyStore() // missing or corrupt — defaults, the next write heals
  }
  const store = emptyStore()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store
  if (raw.display && typeof raw.display === 'object' && !Array.isArray(raw.display)) {
    const m = Number(raw.display.selfcheck_fresh_min)
    if (Number.isFinite(m) && m >= 1 && m <= 1440) store.display.selfcheck_fresh_min = Math.round(m)
  }
  if (raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes)) {
    for (const [k, v] of Object.entries(raw.nodes)) {
      if (!k || typeof k !== 'string' || !v || typeof v !== 'object') continue
      const str = (x) => (typeof x === 'string' && x.trim() ? x.slice(0, 400) : null)
      store.nodes[k] = {
        host: str(v.host),
        remote_python: str(v.remote_python),
        remote_spectre_cmd: str(v.remote_spectre_cmd),
        remote_python_numpy: numpyState(v.remote_python_numpy),
        updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
      }
    }
  }
  if (raw.local && typeof raw.local === 'object' && !Array.isArray(raw.local)) {
    const str = (x) => (typeof x === 'string' && x.trim() ? x.slice(0, 400) : null)
    const v = raw.local
    const facts = {
      local_python_version: str(v.local_python_version),
      local_python_path: str(v.local_python_path),
      local_python_numpy: numpyState(v.local_python_numpy),
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    }
    if (facts.local_python_version || facts.local_python_path || facts.local_python_numpy) store.local = facts
  }
  return store
}

// The remembered pins for one node key (the dsh-ssh machine_id, or an
// in-cluster hostname). Null when nothing is remembered yet.
export async function getNodePins(nodeKey) {
  if (!nodeKey || typeof nodeKey !== 'string') return null
  const { nodes } = await readGlobalStore()
  const v = nodes[nodeKey]
  if (!v) return null
  return {
    host: v.host,
    remote_python: v.remote_python,
    remote_spectre_cmd: v.remote_spectre_cmd,
    remote_python_numpy: v.remote_python_numpy,
    updatedAt: v.updatedAt,
  }
}

// Remember what a node runs. The caller states the FULL current pin pair (a
// green run's measurement, or an explicit pin write): null means unpinned for
// that key, and both-null removes the entry — so an explicit clear keeps
// sticking (heal reads this store and never re-fills a cleared key; only a
// later green run re-measures). An omitted host keeps the remembered one; the
// measured remote_python_numpy tri-state is preserved the same way (only a
// valid yes/no/fallback value overwrites, so an explicit pin write cannot
// erase the last measurement).
export async function updateNodePins(nodeKey, { host, remote_python, remote_spectre_cmd, remote_python_numpy } = {}) {
  if (!nodeKey || typeof nodeKey !== 'string') return { error: 'node key required' }
  const python = remote_python ?? null
  const spectre = remote_spectre_cmd ?? null
  const store = await readGlobalStore()
  if (!python && !spectre) {
    if (store.nodes[nodeKey]) {
      delete store.nodes[nodeKey]
      await writeStore(store)
    }
    return { ok: true, removed: true }
  }
  const prev = store.nodes[nodeKey]
  store.nodes[nodeKey] = {
    host: typeof host === 'string' && host.trim() ? host.slice(0, 200) : prev?.host ?? null,
    remote_python: python,
    remote_spectre_cmd: spectre,
    remote_python_numpy: numpyState(remote_python_numpy) ?? prev?.remote_python_numpy ?? null,
    updatedAt: new Date().toISOString(),
  }
  await writeStore(store)
  return { ok: true }
}

// This host's remembered python facts (the local_python_* prefill source —
// the field names match the settings keys one-to-one). Null when nothing has
// been measured yet. updateLocalFacts states the full current triple — a null
// field clears that fact (only a fresh measurement refills).
export async function getLocalFacts() {
  const { local } = await readGlobalStore()
  return local
}

export async function updateLocalFacts({ local_python_version, local_python_path, local_python_numpy } = {}) {
  const str = (x) => (typeof x === 'string' && x.trim() ? x.slice(0, 400) : null)
  const facts = {
    local_python_version: str(local_python_version),
    local_python_path: str(local_python_path),
    local_python_numpy: numpyState(local_python_numpy),
    updatedAt: new Date().toISOString(),
  }
  const store = await readGlobalStore()
  store.local = facts.local_python_version || facts.local_python_path || facts.local_python_numpy ? facts : null
  await writeStore(store)
  return { ok: true }
}

export async function getFreshMin() {
  return (await readGlobalStore()).display.selfcheck_fresh_min
}

export async function setFreshMin(minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m < 1 || m > 1440) {
    return { error: 'selfcheck_fresh_min must be a number of minutes within 1..1440' }
  }
  const store = await readGlobalStore()
  store.display.selfcheck_fresh_min = Math.round(m)
  await writeStore(store)
  return { ok: true, value: store.display.selfcheck_fresh_min }
}
