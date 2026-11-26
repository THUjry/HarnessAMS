// Project self-check orchestrator. One button (or one harnessams_selfcheck
// tool call) walks the WHOLE pipeline under the project's current settings
// (workspace_config.json settings section, see settings.js) — the point is not
// the simulation itself but verifying machine,
// connection, environment, permissions, tools and compute end to end:
//
//   simulator=spectre  full simulation path: gen_selfcheck_rc.py (run directly,
//                      2026-11-25) -> batch_submit (which runs the SmartAnaSim
//                      spectre_pre_check netlist gate internally) -> batch_poll ->
//                      the standalone parser run directly -> pointwise verify
//                      (local), or batch_submit/poll (remote LSF/ssh) ->
//                      remote parse+verify -> psf CSV download + cross-check
//                      (an LSF failure is diagnosed and retried once with
//                      scheduler=ssh, when an ssh target is configured).
//   simulator=none     no simulation: the bundled golden dataset (src/selfcheck/
//                      golden, analytic RC AC responses in psfascii form) replays
//                      parse + compute locally, or upload -> remote compute ->
//                      download + cross-check remotely.
//
// The remote chains follow the project's working environment (cluster_env,
// D-002): out-of-cluster everything crosses dsh-ssh through run._priv.alias;
// in-cluster LSF has NO alias — the batch tools submit locally, and this
// module's own parse/verify/upload/download become local copies and
// ctx.shell executions on the shared filesystem (runChannel below).
//
// The verification is POINTWISE (not a -3dB extraction): every frequency sample
// of every sweep point is compared against the analytic RC response with a 1%
// tolerance (selfcheck_verify.py / .mjs — same JSON contract, python and node).
// The compute language is a per-project setting for local AND remote (the remote
// js channel needs node on the remote host; its absence is exactly the kind of
// fault this check exists to surface).
//
// Everything here is plain server code — no LLM anywhere in the flow. The only
// model involvement is FAILURE handling: failed steps are handed to a newly
// created diagnosis session (diagnose.js createDiagnosisSession), immediately
// for the LSF/scheduler cluster (so the fallback attempt can continue in
// parallel) and once more at the end for anything still uncovered.
//
// Tool calls go through the registered tool surface (ctx.tools.execute via
// callTool) — SmartAnaSim's spectre_pre_check (the netlist gate batch_submit
// invokes) and this plugin's batch_* tools and
// @linxin666/dsh-ssh's ssh_*; data processing is script-face (2026-11-23): the
// parse step runs spectre_psf_parse.py from the project's sim_scripts_dir
// directly. Verdicts are read from DISK ARTIFACTS (sweep_progress.json /
// psf_index.json / .batch_job.json) wherever possible: the pipeline's
// serialization of model-tool results is a launch-class TODO and artifacts are
// the ground truth anyway (self-check spirit).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runPython } from '../py.js'
import { callTool, execRemote, uploadFile, downloadFile, shq } from '../remote.js'
import { execLocal, localCopy } from '../localchannel.js'
import { DEFAULT_REMOTE_NODE, DEFAULT_REMOTE_PYTHON, readJob, remoteJoin, resolveRemoteDir, simScriptsDir } from '../batch.js'
import { healFromGlobalMemory, readSettings, resolveScriptsSource, defaultSimScriptsDir, validateSettings, writeSettings, PIN_KEYS, normalizePin, NUMPY_STATES } from './settings.js'
import { reconcileSettings } from './reconcile.js'
import { updateNodePins, updateLocalFacts } from './globalstore.js'
import { localEnvFacts } from './checks.js'
import { ensureProjectScripts, genSelfcheckRcPath, isProjectLocalScriptsRoot } from './scriptStage.js'
import { syncAgentsMd } from './agentsmd.js'
import { sanitizeFailed, createDiagnosisSession } from './diagnose.js'
import { fetchMachines } from './machines.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // src/
const execFileAsync = promisify(execFile)
export const SELFCHECK_ASSETS = path.join(PKG_ROOT, 'selfcheck')
export const GOLDEN_DIR = path.join(SELFCHECK_ASSETS, 'golden')
export const VERIFY_ASSETS = [
  path.join(PKG_ROOT, 'scripts', 'selfcheck', 'selfcheck_verify.py'),
  path.join(PKG_ROOT, 'scripts', 'selfcheck', 'selfcheck_verify.mjs'),
]

// The standalone parser under the project's sim_scripts_dir (the SmartAnaSim
// scripts tree). Data processing is script-face since 2026-11-23 — the parse
// step runs it directly, the same way the smart-spectre skill documents.
export function parserScriptPath(anchor) {
  const p = path.join(simScriptsDir(anchor), 'spectre', 'spectre_psf_parse.py')
  if (!fs.existsSync(p)) {
    throw new Error(`spectre_psf_parse.py not found under the project sim_scripts_dir: ${p} `
      + '(fix the worker scripts root in the project settings table — the Overview settings UI '
      + 'or the harnessams_selfcheck settings argument)')
  }
  return p
}

export const TOPOS = ['lpf', 'hpf']
export const TOLERANCE = 0.01
const TOTAL_BUDGET_MS = 30 * 60_000
const POLL_INTERVAL_MS = 5_000
const POLL_BUDGET_MS = 10 * 60_000
// The 2 s worker-start gate (2026-11-26 ruling): after a detached ssh submit
// (D-028) the worker only writes sweep_progress.json once it is actually
// sweeping, and full batch_poll rounds through that window are heavyweight
// and progress-blind — the gate probes the file's existence directly every
// 2 s instead, then hands over to the poll loop.
const GATE_INTERVAL_MS = 2_000
const GATE_CHANNEL_FAILURES = 3

// In-memory run registry (id -> run). Bounded; the authoritative record is the
// per-run selfcheck_run.json under <project>/.harnessams/selfcheck/<id>/, so a
// restart still serves action=status from disk. Run ARTIFACTS (netlists, psf
// trees, remote staging) are cleaned per the 2026-11-19 ruling: a clean
// successful run's evidence is deleted at finalize; a diagnosed/failed run
// keeps its evidence for the diagnosis sessions, and the NEXT run's start
// cleans historical evidence — selfcheck_run.json always survives.
const store = new Map()
const MAX_RUNS = 8
const runningBySession = new Map() // sessionId -> runId while running
const RUN_RECORD = 'selfcheck_run.json'

// Remove everything inside one run dir except the run record (and its .tmp).
async function cleanRunArtifacts(runDir) {
  let entries = []
  try { entries = await fsp.readdir(runDir) } catch { return }
  await Promise.all(entries
    .filter((n) => n !== RUN_RECORD && n !== RUN_RECORD + '.tmp')
    .map((n) => fsp.rm(path.join(runDir, n), { recursive: true, force: true }).catch(() => {})))
}

// Clean every historical run's artifacts under the project (called at run
// start, before the new run dir exists — so it never touches the live run).
async function cleanHistoricalArtifacts(projectPath) {
  const dir = path.join(projectPath, '.harnessams', 'selfcheck')
  let names = []
  try { names = (await fsp.readdir(dir)).filter((n) => n.startsWith('rc_')) } catch { return }
  await Promise.all(names.map((n) => cleanRunArtifacts(path.join(dir, n))))
}

// ---------------------------------------------------------------------------
// Run state helpers
// ---------------------------------------------------------------------------

function runView(run) {
  if (!run) return null
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    runDir: run.runDir,
    projectPath: run.projectPath,
    scope: run.scope,
    steps: run.steps.map((s) => ({ ...s })),
    summary: run.summary,
    diagnoses: run.diagnoses.map((d) => ({ ...d })),
  }
}

async function doPersist(run) {
  try {
    const tmp = path.join(run.runDir, 'selfcheck_run.json.tmp')
    await fsp.writeFile(tmp, JSON.stringify(runView(run), null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, path.join(run.runDir, 'selfcheck_run.json'))
  } catch { /* the in-memory copy keeps the API alive; disk is durability only */ }
}

// All persist callers are fire-and-forget, so two writes can run
// concurrently and share selfcheck_run.json.tmp — interleaved writeFile/rename
// ordering produces a corrupted concatenated document (live-verified head of
// one snapshot + tail of the next). Serialize through a per-run promise chain;
// the rejection branch keeps the queue draining when a single write fails.
function persistRun(run) {
  const chain = (run._persistChain ?? Promise.resolve()).then(() => doPersist(run), () => doPersist(run))
  run._persistChain = chain
  return chain
}

function addStep(run, spec) {
  const step = {
    section: 'local', item: '', settingColumn: null,
    ok: null, result: '', detail: '', warn: null, ms: null, skipReason: null,
    ...spec,
  }
  run.steps.push(step)
  void persistRun(run)
  return step
}

async function timedStep(run, spec, fn) {
  const step = addStep(run, spec)
  const t0 = Date.now()
  run._priv.current = step
  try {
    // fn receives its own step so long-running bodies can stream live progress
    // into the record (the UI polls it every 3 s)
    const out = (await fn(step)) ?? {}
    step.ok = out.ok
    step.result = out.result ?? ''
    step.detail = out.detail ?? ''
    if (out.warn != null) step.warn = out.warn // otherwise a warn preset on the spec survives
  } catch (e) {
    step.ok = false
    step.result = e instanceof SelfcheckCancelled ? 'cancelled' : 'error'
    step.detail = String(e?.message ?? e).slice(0, 2000)
    if (e instanceof SelfcheckCancelled) throw e // run-level cancellation propagates
  } finally {
    run._priv.current = null
    step.ms = Date.now() - t0
    void persistRun(run)
  }
  return step
}

function skipStep(run, spec, reason) {
  addStep(run, { ...spec, ok: null, skipReason: reason })
}

// User stop (action=stop): thrown at every gate; timedStep marks the in-flight
// step cancelled and rethrows so orchestrate can finalize the whole run as
// cancelled (evidence kept, no diagnosis sessions, no AGENTS.md re-sync).
class SelfcheckCancelled extends Error {
  constructor() { super('self-check stopped by user') }
}

function checkCancelled(run) {
  if (run._priv.cancel?.requested) throw new SelfcheckCancelled()
}

function checkBudget(run) {
  checkCancelled(run)
  if (Date.now() > run._priv.deadline) throw new Error('self-check global budget exhausted (30 min)')
}

// ---------------------------------------------------------------------------
// Prompt for the auto diagnosis sessions (English body, answer-language line)
// ---------------------------------------------------------------------------

export function buildSelfcheckPrompt({ scope, runDir, machine, remotePath, projectTitle, failed, lang }) {
  const lines = []
  lines.push('You are the diagnostic agent of the HarnessAMS workbench.')
  lines.push('')
  lines.push('A project self-check reported problems. Diagnose the root cause. Context:')
  lines.push(`- Self-check settings: mode=${scope?.mode} env=${scope?.cluster_env ?? 'n/a'} simulator=${scope?.simulator} `
    + `scheduler=${scope?.scheduler ?? 'n/a'} compute=local:${scope?.compute_local}/remote:${scope?.compute_remote}`)
  if (machine) {
    lines.push(`- Machine: ${machine.name || machine.host} (${machine.username ? machine.username + '@' : ''}${machine.host}:${machine.port ?? 22}, dsh-ssh alias "${machine.alias ?? machine.id}")`)
    if (remotePath) lines.push(`- Remote root: ${remotePath}`)
  } else {
    lines.push('- Machine: local (this host)')
  }
  lines.push(`- Run artifacts: ${runDir} (point_meta.json / sweep_progress.json / errlog.txt / `
    + 'spectre.out / .batch_job.json / selfcheck_run.json live under it — inspect them read-only)')
  if (projectTitle) lines.push(`- Project: ${projectTitle}`)
  lines.push(`- Time: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('Failed steps (ok = false), verbatim from the self-check run:')
  const entries = sanitizeFailed(failed.map((s) => ({
    item: `${s.section}/${s.item}`, ok: false, ms: s.ms,
    result: s.result, detail: s.detail, warn: s.warn,
  })))
  entries.forEach((x, i) => {
    lines.push(`${i + 1}. ${x.item}`)
    if (x.result) lines.push(`   summary: ${x.result}`)
    if (x.detail) lines.push(`   detail: ${x.detail}`)
    if (x.warn) lines.push(`   warning: ${x.warn}`)
  })
  lines.push('')
  lines.push('Instructions:')
  lines.push('- READ-ONLY diagnosis: do not create, modify, move, or delete anything.')
  if (machine) {
    lines.push(`- The dsh-ssh plugin is installed, so you may run read-only commands on that machine via ssh_exec (alias "${machine.name || machine.host}") to verify. If a remote tool errors out, say so and analyze from the evidence above instead.`)
  } else {
    lines.push('- You may run read-only local commands to verify (the workspace is this machine\'s HarnessAMS workspace).')
  }
  lines.push('- The likely fault families: missing simulator/python/node executable, dsh-ssh connectivity or permissions (upload/write), LSF submission/queue, netlist/parse errors, compute-script numeric drift. Identify which one this is.')
  lines.push('- Give: (1) the most likely root cause, (2) the evidence for it, (3) the next concrete read-only command(s) to confirm, and, when obvious, (4) what a fix would look like — without applying it.')
  lines.push('- Keep the answer compact and structured.')
  lines.push('')
  lines.push(lang === 'zh' ? 'Answer in Chinese.' : 'Answer in English.')
  return lines.join('\n')
}

async function diagnoseSteps(run, steps, trigger) {
  const failed = steps.filter((s) => s && s.ok === false)
  if (!failed.length) return
  for (const s of failed) run._priv.diagnosed.add(s)
  const { ctx, settings, machine, localWorkspaceId, lang, project } = run._priv
  const workspaceId = localWorkspaceId
  const record = { trigger, status: 'failed', sessionId: null, error: null,
    title: 'HarnessAMS diagnosis: selfcheck @ ' + (machine ? (machine.name || machine.host) : 'local') }
  if (!workspaceId) {
    record.error = 'no workspace to anchor the diagnosis session (project workspace not registered)'
    run.diagnoses.push(record)
    void persistRun(run)
    return
  }
  const prompt = buildSelfcheckPrompt({
    scope: run.scope,
    runDir: run.runDir,
    machine: machine ?? null,
    remotePath: run._priv.settings.remote_root ?? null,
    projectTitle: project?.title,
    failed,
    lang,
  })
  const r = await createDiagnosisSession(ctx, { workspaceId, title: record.title, prompt })
  if (r.error) record.error = r.error
  else record.status = 'done'
  record.sessionId = r.sessionId ?? null
  run.diagnoses.push(record)
  void persistRun(run)
}

// ---------------------------------------------------------------------------
// Entry: validate + register the run, then orchestrate in the background
// ---------------------------------------------------------------------------

export async function startSelfcheck(ctx, { sessionId, project, lang }) {
  let settings
  try {
    ({ settings } = await readSettings(project.path))
  } catch (e) {
    return { error: `workspace_config.json unreadable: ${e?.message ?? e}`, code: 400 }
  }
  // D-021: reconcile json ← AGENTS.md BEFORE the prefill — a hand-edited block
  // (the agent's natural config-edit route) adopts here so the run submits
  // under the edited values; invalid rows warn into the run record and keep
  // the json values (agent semantics: a run is not a save, nothing blocks).
  const reconcileWarnings = []
  try {
    const rec = await reconcileSettings(project.path)
    if (rec.settings) settings = rec.settings
    if (rec.warnings?.length) reconcileWarnings.push(...rec.warnings)
  } catch { /* keep the settings as read */ }
  // D-017/D-021 prefill: null pins and python facts heal from the
  // plugin-global memories before anything runs, so the run submits under the
  // paths the AGENTS.md yaml will claim (best-effort — an unreadable memory
  // keeps what was just read)
  try {
    const healed = await healFromGlobalMemory(project.path)
    if (healed.settings) settings = healed.settings
  } catch { /* keep the settings as read */ }

  let machine = null
  let alias = null
  let remoteBase = null
  const inCluster = settings.cluster_env === 'in-cluster'
  if (settings.run_mode === 'remote') {
    if (!settings.remote_root) {
      return { error: 'run_mode=remote requires remote_root — set it in the Overview settings table '
        + '(or pass settings to the harnessams_selfcheck tool) and confirm', code: 409 }
    }
    // D-002: in-cluster LSF needs no ssh hop — no machine. Everything else
    // (ssh scheduler, out-of-cluster) targets the configured dsh-ssh alias.
    const needMachine = !inCluster || settings.scheduler === 'ssh'
    if (needMachine) {
      const list = await fetchMachines(ctx.tools)
      if (!list.ok) return { error: `dsh-ssh hosts unavailable: ${list.reason}`, code: 503 }
      machine = list.machines.find((m) => m.id === settings.machine_id || m.name === settings.machine_id) || null
      if (!machine) return { error: `no such dsh-ssh host: ${settings.machine_id}`, code: 404 }
      alias = machine.id
    }
    try {
      remoteBase = resolveRemoteDir(settings.remote_root, settings.selfcheck_remote_dir)
    } catch (e) {
      return { error: String(e?.message ?? e), code: 400 }
    }
  }

  if (runningBySession.has(sessionId)) {
    return { error: 'a self-check is already running for this session (wait for it to finish)', code: 409 }
  }

  const localWorkspaceId = (typeof ctx.workspaceRegistry?.list === 'function' ? ctx.workspaceRegistry.list() : [])
    .find((x) => x?.path === project.path)?.id ?? null

  const runId = 'rc_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '_' + randomUUID().slice(0, 6)
  const runDir = path.join(project.path, '.harnessams', 'selfcheck', runId)
  // claim the session slot before the first await: two concurrent submissions
  // must not both pass the 409 check while mkdir is still in flight
  runningBySession.set(sessionId, runId)
  try {
    await fsp.mkdir(runDir, { recursive: true })
    // historical evidence (a failed/diagnosed run kept its artifacts) is cleaned
    // now, ahead of the new run — bounded disk: at most the live run's artifacts
    await cleanHistoricalArtifacts(project.path).catch(() => {})
    // Conditional script staging (see healProjectScriptsAt): the default
    // root now IS the package install location and needs no project copy —
    // only a root inside the project's own .harnessams gets the heal, so
    // everything the self-check exercises stays usable afterwards (the
    // 2026-11-24 rationale, kept for the roots that still point local)
    await healProjectScriptsAt(project.path)
  } catch (e) {
    runningBySession.delete(sessionId)
    return { error: `cannot prepare the self-check run dir: ${e?.message ?? e}`, code: 500 }
  }

  const run = {
    id: runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    runDir,
    projectPath: project.path,
    scope: {
      mode: settings.run_mode,
      cluster_env: settings.cluster_env,
      simulator: settings.simulator,
      scheduler: settings.run_mode === 'remote' && settings.simulator === 'spectre' ? settings.scheduler : null,
      compute_local: settings.compute_script_local,
      compute_remote: settings.compute_script_remote,
      machine: machine ? { id: machine.id, name: machine.name, host: machine.host } : null,
    },
    steps: [],
    summary: null,
    diagnoses: [],
    _priv: {
      ctx, sessionId, settings, project, lang, machine, alias, remoteBase, inCluster,
      localWorkspaceId, deadline: Date.now() + TOTAL_BUDGET_MS, current: null,
      diagnosed: new Set(),
      // stop face (action=stop): the flag trips every gate; aborting the
      // controller cancels in-flight tool calls threaded with its signal
      cancel: { requested: false, controller: new AbortController() },
      cancelled: false,
    },
  }
  store.set(runId, run)
  runningBySession.set(sessionId, runId)
  // Bound the registry (running runs are never evicted).
  for (const id of store.keys()) {
    if (store.size <= MAX_RUNS) break
    if (store.get(id).status === 'running') continue
    store.delete(id)
  }
  if (reconcileWarnings.length) run.reconcileWarnings = reconcileWarnings
  void orchestrate(run)
  return { runId, ...(reconcileWarnings.length ? { warnings: reconcileWarnings } : {}) }
}

// A run is only reachable by its id (action=run returns the run_id; the client
// polls action=status) AND its owning project — the in-memory hit is fenced on
// projectPath exactly like the disk fallback, so a live run of project A never
// answers project B's poll. There is deliberately no global "latest" surface.
export function getSelfcheck(id, projectPath) {
  if (!id) return null
  const mem = store.get(id)
  if (mem && path.resolve(mem.projectPath) === path.resolve(String(projectPath ?? ''))) return runView(mem)
  return runView(readRunFromDisk(id, projectPath))
}

function readRunFromDisk(id, projectPath) {
  if (!projectPath || !/^[\w-]+$/.test(id)) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.harnessams', 'selfcheck', id, RUN_RECORD), 'utf8'))
  } catch { return null }
}

// User stop (action=stop / the sidebar's stop button): project-fenced like
// getSelfcheck; flips the cancel flag, aborts in-flight tool calls, and kills
// any submitted LSF jobs best-effort (direct runs die on their own remote
// timeout-KILL wrapper). Idempotent — a finished run answers its status.
export async function stopSelfcheck(id, projectPath) {
  if (!id) return { error: 'run_id is required for action=stop', code: 400 }
  const mem = store.get(id)
  const run = (mem && path.resolve(mem.projectPath) === path.resolve(String(projectPath ?? ''))) ? mem : null
  if (!run && !readRunFromDisk(id, projectPath)) return { error: `no such self-check run in this project: ${id}`, code: 404 }
  if (!run || run.status !== 'running') return { ok: true, status: run?.status ?? 'done' }
  run._priv.cancel.requested = true
  run._priv.cancel.controller.abort()
  void killSubmittedLsfJobs(run).catch(() => { /* best-effort; the gates end the run regardless */ })
  return { ok: true, status: 'stopping' }
}

async function killSubmittedLsfJobs(run) {
  const ch = runChannel(run, { withSignal: false })
  for (const topo of TOPOS) {
    const job = readJob(path.join(run.runDir, 'remote', topo))
    if (job?.scheduler === 'lsf' && job.job_id) {
      await ch.exec('bkill ' + shq(String(job.job_id)), { timeoutMs: 15_000 })
    }
  }
}

// ---------------------------------------------------------------------------
// Compute helpers (both channels share the JSON contract)
// ---------------------------------------------------------------------------

function parseMarkerJson(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('[selfcheck] ')).pop()
  if (!line) return null
  try { return JSON.parse(line.slice('[selfcheck] '.length)) } catch { return null }
}

// The interpreter for the local chain's direct script calls (parser, verify).
// In-cluster the remote_python pin is a path on THIS host and applies — on a
// cluster whose bare python is 2.x the parsers must agree with the worker
// the pin just ran; out-of-cluster the pin names a cluster path this host
// does not have, so the host's own python runs.
function localChainPython(settings) {
  return settings.cluster_env === 'in-cluster' && settings.remote_python ? settings.remote_python : 'python'
}

async function runVerifyLocal(lang, topo, dir, python = 'python') {
  if (lang === 'js') {
    const mod = await import('../scripts/selfcheck/selfcheck_verify.mjs')
    return mod.verifyRun(dir, topo, TOLERANCE)
  }
  const { stdout } = await runPython('selfcheck/selfcheck_verify.py',
    ['--run-dir', dir, '--topo', topo, '--tolerance', String(TOLERANCE)], 120_000, { python })
  const json = parseMarkerJson(stdout)
  if (!json) throw new Error('verify script produced no [selfcheck] marker line')
  return json
}

function verifySummary(topo, json, { prefix = true } = {}) {
  if (!json) return { ok: false, text: 'no result' }
  const pts = Array.isArray(json.points) ? json.points.length : 0
  const failed = Number(json.failed_points) || 0
  const pct = (Number(json.max_rel_err) * 100)
  const body = `${pts} pts, max rel err ${pct.toPrecision(3)}%${failed ? `, ${failed} failed` : ''}`
  return { ok: !!json.ok, text: prefix ? `${topo}: ${body}` : body }
}

function consistency(localJson, remoteJson) {
  if (!localJson || !remoteJson) return { ok: false, maxDiff: null }
  if (!!localJson.ok !== !!remoteJson.ok) return { ok: false, maxDiff: null }
  let maxDiff = 0
  const byName = new Map((remoteJson.points ?? []).map((p) => [p.point, p]))
  for (const p of localJson.points ?? []) {
    const q = byName.get(p.point)
    if (!q) return { ok: false, maxDiff: null }
    maxDiff = Math.max(maxDiff, Math.abs((Number(p.max_rel_err) || 0) - (Number(q.max_rel_err) || 0)))
  }
  return { ok: maxDiff <= TOLERANCE, maxDiff }
}

function remoteComputeCommand({ remoteDir, parserPath, python, node, lang, topo }) {
  const parser = parserPath ? shq(parserPath) : './spectre_psf_parse.py'
  const verify = lang === 'js'
    ? `${shq(node)} ./selfcheck_verify.mjs --run-dir . --topo ${topo}`
    : `${shq(python)} ./selfcheck_verify.py --run-dir . --topo ${topo}`
  return `cd ${shq(remoteDir)} && ${shq(python)} ${parser} --work-dir . --format csv && ${verify}`
}

function extractStateJson(text) {
  try {
    const j = JSON.parse(String(text))
    if (j && typeof j.state === 'string') return j
  } catch { /* not JSON — fall through to the regex probe */ }
  const m = String(text ?? '').match(/"state"\s*:\s*"([a-z-]+)"/)
  return m ? { state: m[1] } : null
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function orchestrate(run) {
  const { ctx, settings } = run._priv
  const mode = settings.run_mode
  const sim = settings.simulator
  try {
    // C1 — tool face readiness: spectre needs the SmartAnaSim pre-check tool
    // (the netlist gate batch_submit invokes) plus this plugin's batch channel;
    // simulator=none runs no tools at all, so its gate is the standalone parser
    // under the scripts root
    let toolsOk = true
    if (sim === 'spectre') {
      const required = ['spectre_pre_check', 'batch_submit', 'batch_poll']
      const missing = required.filter((n) => !ctx.tools?.get?.(n))
      const c1 = addStep(run, { item: 'Tool registration check', settingColumn: 'simulator' })
      c1.ms = 1
      if (missing.length) {
        toolsOk = false
        c1.ok = false
        c1.result = `missing: ${missing.join(', ')}`
        c1.detail = 'spectre_pre_check registers with the SmartAnaSim plugin; batch_submit/batch_poll '
          + 'live in this one — install/enable the plugins (and check the SmartAnaSim Config family '
          + 'switches), then retry.'
      } else {
        c1.ok = true
        c1.result = `${required.join(', ')} registered`
      }
    } else {
      const c1 = addStep(run, { item: 'Parser script check', settingColumn: 'simulator' })
      c1.ms = 1
      try {
        const p = parserScriptPath(run._priv.project.path)
        c1.ok = true
        c1.result = `spectre_psf_parse.py under sim_scripts_dir (${path.basename(path.dirname(p))}/)`
      } catch (e) {
        toolsOk = false
        c1.ok = false
        c1.result = 'parser not found'
        c1.detail = String(e?.message ?? e)
      }
    }
    void persistRun(run)

    // C2 — settings validation snapshot (the route already enforced the remote
    // prerequisites; record what this run resolved to)
    const c2 = addStep(run, {
      section: mode === 'remote' ? 'remote' : 'local',
      item: 'Settings validation',
      settingColumn: mode === 'remote' ? 'machine' : 'run_mode',
    })
    c2.ok = true
    c2.ms = 1
    c2.result = mode === 'remote'
      ? (run._priv.machine
        ? `remote node ${run._priv.machine.name ?? run._priv.machine.host} (this run), remote dir ${run._priv.remoteBase}`
        : `local bsub on this host (in-cluster), remote dir ${run._priv.remoteBase}`)
      : 'local mode'
    c2.detail = `env=${settings.cluster_env}, simulator=${sim}, compute local=${settings.compute_script_local}, remote=${settings.compute_script_remote}`
      + (run.scope.scheduler ? `, scheduler=${run.scope.scheduler}` : '')
      // the toolchain this run really submits with (D-016): the pins, or the
      // bare default the batch tools fall back to
      + `, toolchain python=${settings.remote_python ?? (mode === 'remote' ? DEFAULT_REMOTE_PYTHON : 'python')}`
      + `${settings.remote_python ? '' : ' (unpinned)'}`
      + (sim === 'spectre' ? `, spectre=${settings.remote_spectre_cmd ?? 'on PATH'}${settings.remote_spectre_cmd ? '' : ' (unpinned)'}` : '')
    void persistRun(run)

    if (!toolsOk) {
      if (sim === 'spectre') {
        skipStep(run, { item: 'gen_selfcheck_rc.py (RC tb)', settingColumn: 'simulator' }, 'tools missing')
      } else {
        skipStep(run, { item: 'golden dataset load', settingColumn: 'simulator' }, 'tools missing')
      }
      skipRestForUnprepared(run, mode, sim, 'tools missing')
      return // finalize handles the rest
    }
    checkBudget(run)

    // Common preparation: generate (spectre) or golden load (none)
    let prepared = false
    if (sim === 'spectre') {
      const step = await timedStep(run, { item: 'gen_selfcheck_rc.py (RC tb)', settingColumn: 'simulator' }, async () => {
        // The gen script runs straight from THIS package's install location
        // (2026-11-25 ruling): the project script/ folder is retired —
        // nothing stages a copy into the project anymore (the earlier
        // 2026-11-24 staging is gone). cwd stays the REAL project root and
        // --out / HARNESSAMS_SIMULATOR are unchanged, so the emitted run dir
        // is exactly what a project-local gen would have written; the netlist
        // the batch_submit step stages still passes through the real
        // spectre_pre_check gate. Host python (not the toolchain pin — the
        // pins name the CLUSTER-side interpreter that runs the worker; this
        // fixture generator is host-side stdlib).
        const gen = genSelfcheckRcPath()
        const signal = run._priv.cancel.controller.signal
        const child = execFileAsync('python', [gen, '--out', run.runDir], {
          timeout: 150_000,
          windowsHide: true,
          encoding: 'utf8',
          cwd: run._priv.project.path,
          env: { ...process.env, HARNESSAMS_SIMULATOR: 'spectre', PYTHONUTF8: '1' },
          signal,
        })
        let out = ''
        try { out = (await child).stdout } catch (e) {
          const detail = [e?.stdout, e?.stderr].filter(Boolean).join('\n').slice(-2000) || String(e?.message ?? e)
          throw new Error(`gen failed: ${detail}`)
        }
        const have = TOPOS.every((topo) => fs.existsSync(path.join(run.runDir, topo, 'template.scs'))
          && fs.existsSync(path.join(run.runDir, topo, 'sweep_config.json')))
        return {
          ok: have,
          result: have ? 'RC LPF+HPF tb generated (3x3)' : 'assembly output incomplete',
          detail: String(out || '').split(/\r?\n/).slice(-4).join('\n').slice(0, 800),
        }
      })
      prepared = step.ok === true
      if (!prepared) {
        skipRestForUnprepared(run, mode, sim, 'preparation failed')
        return
      }
    } else {
      const step = await timedStep(run, { item: 'golden dataset load', settingColumn: 'simulator' }, async () => {
        let files = 0
        for (const topo of TOPOS) {
          await fsp.cp(path.join(GOLDEN_DIR, topo), path.join(run.runDir, topo), { recursive: true })
          for (let i = 0; i < 9; i++) {
            const name = String(i).padStart(2, '0')
            if (!fs.existsSync(path.join(run.runDir, topo, name, 'point_meta.json'))) throw new Error(`golden incomplete: ${topo}/${name}/point_meta.json`)
            if (!fs.existsSync(path.join(run.runDir, topo, name, 'netlist.scs.raw', 'ac.ac'))) throw new Error(`golden incomplete: ${topo}/${name}/netlist.scs.raw/ac.ac`)
            files += 2
          }
        }
        return { ok: true, result: `golden loaded: ${files} files (lpf+hpf, 9 pts each)` }
      })
      prepared = step.ok === true
      if (!prepared) {
        skipRestForUnprepared(run, mode, sim, 'preparation failed')
        return
      }
    }
    checkBudget(run)

    if (mode === 'local') await localChain(run, sim)
    else if (sim === 'spectre') await remoteSpectreChain(run)
    else await remoteGoldenChain(run)
  } catch (e) {
    if (e instanceof SelfcheckCancelled) {
      // user stop: no synthetic error step — the in-flight step (if any) was
      // already marked "cancelled" by timedStep; finalize stamps the run
      run._priv.cancelled = true
    } else {
      const cur = run._priv.current
      if (cur && cur.ok === null) {
        cur.ok = false
        cur.result = 'error'
        cur.detail = String(e?.message ?? e).slice(0, 2000)
        if (!cur.ms) cur.ms = 1
        void persistRun(run)
      } else if (!cur) {
        // thrown between steps (e.g. checkBudget after a step finished): record
        // it instead of losing it, so a budget-exhausted truncation can never
        // finalize with summary.ok=true
        const step = addStep(run, {
          section: mode === 'remote' ? 'remote' : 'local',
          item: 'orchestration', ok: false, result: 'error',
          detail: String(e?.message ?? e).slice(0, 2000),
        })
        step.ms = 1
        void persistRun(run)
      }
    }
  } finally {
    finalize(run)
  }
}

function skipRestForUnprepared(run, mode, sim, reason) {
  const section = mode === 'remote' ? 'remote' : 'local'
  if (mode === 'local') {
    if (sim === 'spectre') {
      skipStep(run, { item: 'batch_submit local LPF (9 pts)', settingColumn: 'run_mode' }, reason)
      skipStep(run, { item: 'batch_submit local HPF (9 pts)', settingColumn: 'run_mode' }, reason)
    }
    skipStep(run, { item: sim === 'spectre' ? 'spectre_psf_parse.py (LPF+HPF)' : 'spectre_psf_parse.py (golden)', settingColumn: 'simulator' }, reason)
    skipStep(run, { item: `pointwise verify (${run._priv.settings.compute_script_local}, LPF+HPF)`, settingColumn: 'compute_local' }, reason)
  } else if (sim === 'spectre') {
    skipStep(run, { section, item: 'batch_submit (LPF+HPF)', settingColumn: 'scheduler' }, reason)
    skipStep(run, { section, item: 'batch_poll → completed', settingColumn: 'scheduler' }, reason)
    skipStep(run, { section, item: `remote parse + verify (${run._priv.settings.compute_script_remote})`, settingColumn: 'compute_remote' }, reason)
    skipStep(run, { section, item: 'result download + local cross-check', settingColumn: 'compute_remote' }, reason)
  } else {
    skipStep(run, { section, item: `golden upload (${run._priv.alias ? 'ssh_upload' : 'local copy'})`, settingColumn: 'machine' }, reason)
    skipStep(run, { section, item: `remote parse + verify (${run._priv.settings.compute_script_remote})`, settingColumn: 'compute_remote' }, reason)
    skipStep(run, { section, item: 'artifact download + local cross-check', settingColumn: 'compute_remote' }, reason)
  }
}

// ---------------------------------------------------------------------------
// Local chains
// ---------------------------------------------------------------------------

async function localChain(run, sim) {
  const { ctx } = run._priv
  if (sim === 'spectre') {
    const sweepSteps = []
    for (const topo of TOPOS) {
      checkBudget(run)
      const runDir = path.join(run.runDir, topo)
      const step = await timedStep(run, { item: `batch_submit local ${topo.toUpperCase()} (9 pts)`, settingColumn: 'run_mode' }, async (stepRef) => {
        const sub = await callTool(ctx, 'batch_submit',
          { run_dir: runDir, worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local', project: run._priv.project.path },
          { timeoutMs: 60_000, signal: run._priv.cancel.controller.signal })
        if (sub.isError) {
          return { ok: false, result: 'submit failed', detail: String(sub.text || '').slice(0, 400) }
        }
        // poll the local ladder until the worker settles (cancellation lands
        // within one poll interval; live progress updates the step row)
        let state = null
        let last = null
        const budget = Date.now() + POLL_BUDGET_MS
        while (Date.now() < budget) {
          checkCancelled(run)
          last = await callTool(ctx, 'batch_poll', { run_dir: runDir, project: run._priv.project.path },
            { timeoutMs: 60_000, signal: run._priv.cancel.controller.signal })
          const parsed = extractStateJson(last.text)
          state = parsed?.state ?? null
          if (stepRef) {
            stepRef.result = `local ${topo}: ${state ?? 'unknown'}`
              + (parsed?.completed != null ? ` (${parsed.completed}/${parsed?.total ?? '?'})` : '')
            void persistRun(run)
          }
          if (state === 'completed' || state === 'failed' || last.isError) break
          await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
        }
        const prog = await fsp.readFile(path.join(runDir, 'sweep_progress.json'), 'utf8')
          .then((t) => JSON.parse(t)).catch(() => null)
        // toolchain telemetry (D-016/D-017): the local worker records its own
        // interpreter + resolved spectre too — the in-cluster pin this run used
        if (prog?.toolchain && !run._priv.toolchainTelemetry) run._priv.toolchainTelemetry = prog.toolchain
        const total = Number(prog?.total_points) || 0
        const succ = Number(prog?.succeeded) || 0
        const ok = !last?.isError && prog?.status === 'completed' && total === 9 && succ === total
        const cmd = await fsp.readFile(path.join(runDir, '00', 'point_meta.json'), 'utf8')
          .then((t) => JSON.parse(t)?.command).catch(() => null)
        return {
          ok,
          result: prog ? `${succ}/${total} success (${prog.status})` : 'no sweep_progress.json',
          detail: [cmd ? `spectre: ${String(cmd).split(/\s+/).slice(0, 3).join(' ')}` : '',
            (last?.text || '').split(/\r?\n/).filter((l) => l.startsWith('"[sweep]') || l.includes('[sweep]')).slice(-3).join('\n')]
            .filter(Boolean).join('\n').slice(0, 800),
        }
      })
      sweepSteps.push(step)
    }
    const swept = sweepSteps.every((s) => s.ok === true)
    const parseStep = await runParseStep(run, swept, 'spectre_psf_parse.py (LPF+HPF)')
    await runVerifyStep(run, parseStep.ok === true)
  } else {
    const parseStep = await runParseStep(run, true, 'spectre_psf_parse.py (golden)')
    await runVerifyStep(run, parseStep.ok === true)
  }
}

async function runParseStep(run, prerequisiteOk, label) {
  if (!prerequisiteOk) {
    const s = addStep(run, { item: label, settingColumn: 'simulator' })
    s.ok = null; s.skipReason = 'sweep failed'; s.ms = 1
    void persistRun(run)
    return s
  }
  return timedStep(run, { item: label, settingColumn: 'simulator' }, async () => {
    const details = []
    let ok = true
    let parser
    try {
      parser = parserScriptPath(run._priv.project.path)
    } catch (e) {
      return { ok: false, result: 'parser not found', detail: String(e?.message ?? e) }
    }
    for (const topo of TOPOS) {
      const dir = path.join(run.runDir, topo)
      // script-face parsing (2026-11-23): run the standalone parser directly —
      // data processing is not tool-shaped anymore
      try {
        await execFileAsync(localChainPython(run._priv.settings), [parser, '--work-dir', dir, '--format', 'csv'], {
          timeout: 600_000, windowsHide: true, encoding: 'utf8',
          env: { ...process.env, PYTHONUTF8: '1' },
          signal: run._priv.cancel.controller.signal,
        })
      } catch (e) {
        ok = false
        const out = [e?.stdout, e?.stderr].filter(Boolean).join('\n').slice(-300)
        details.push(`${topo}: parser failed — ${out || String(e?.message ?? e)}`)
        continue
      }
      const index = await fsp.readFile(path.join(dir, 'psf', 'psf_index.json'), 'utf8')
        .then((t) => JSON.parse(t)).catch(() => null)
      const points = Array.isArray(index?.points) ? index.points.length : 0
      const signals = index?.points?.[0]?.signals ?? []
      const haveSignals = signals.includes('ac_freq') && signals.includes('ac_vout')
      if (points !== 9 || !haveSignals) ok = false
      details.push(`${topo}: ${points} pts parsed${haveSignals ? '' : ' (missing ac_freq/ac_vout)'}`)
    }
    return { ok, result: details.join(' · '), detail: details.join('\n') }
  })
}

async function runVerifyStep(run, prerequisiteOk) {
  const lang = run._priv.settings.compute_script_local
  const spec = { item: `pointwise verify (${lang}, LPF+HPF)`, settingColumn: 'compute_local' }
  if (!prerequisiteOk) {
    skipStep(run, spec, 'parse failed')
    return
  }
  await timedStep(run, spec, async () => {
    checkBudget(run)
    const parts = []
    let ok = true
    for (const topo of TOPOS) {
      const json = await runVerifyLocal(lang, topo, path.join(run.runDir, topo), localChainPython(run._priv.settings))
      const sum = verifySummary(topo, json)
      if (!sum.ok) ok = false
      parts.push(sum.text)
    }
    return {
      ok,
      result: `${parts.join(' · ')} (tol ${(TOLERANCE * 100).toFixed(0)}%)`,
      detail: parts.join('\n'),
    }
  })
}

// Conditional script heal at run start (the lazy copy-if-missing half of the
// 2026-11-26 package-path-first policy, exported for the test face): only a
// scripts root INSIDE the project's .harnessams — the legacy flipped layout
// or an explicit config — gets a local copy at all, completed from the
// PACKAGE tree (the configured root IS the destination, so it cannot also be
// the source: ensureProjectScripts' self-copy guard would no-op). The
// packaged default root needs no copy; a custom external root is the user's
// own. Returns what it did for observability.
export async function healProjectScriptsAt(projectPath) {
  const scriptsRoot = resolveScriptsSource(projectPath)
  if (!isProjectLocalScriptsRoot(projectPath, scriptsRoot)) {
    return { healed: false, scriptsRoot }
  }
  const staged = await ensureProjectScripts(projectPath, defaultSimScriptsDir())
  return { healed: true, scriptsRoot, staged }
}

// ---------------------------------------------------------------------------
// Remote chains
// ---------------------------------------------------------------------------

function remoteDirFor(run, topo, scheduler) {
  // Per-attempt subdirectories keep the LSF retry from colliding with the
  // failed batch (batch_submit refuses clobbering existing point_meta files).
  return remoteJoin(run._priv.remoteBase, run.id, `${topo}_${scheduler}`)
}

// Wait for the worker's first progress artifact (sweep_progress.json, or the
// .hams_ssh_done replay marker) with a cheap direct probe every 2 s — the
// ssh-exec bypass is user-approved for exactly this gate (2026-11-26); the
// monitoring channel itself stays batch_poll. Out-of-cluster the probe
// crosses dsh-ssh (execRemote through runChannel — the cancel signal rides
// it, D-029); in-cluster scheduler=ssh shares the cluster filesystem, so a
// local stat is the same fact with zero traffic. Fails the topology after
// GATE_CHANNEL_FAILURES consecutive channel-level errors (no exit code /
// timed out / tool error — exit 1 is "not present yet", not a failure), or
// when the gate budget expires with no marker (the worker never started —
// the detail points at the run dir's own logs for the diagnosis).
async function waitForWorkerProgress(run, step, topo, staging) {
  const { alias, inCluster } = run._priv
  const job = readJob(staging)
  const remoteDir = job?.remote_dir
  if (!remoteDir) {
    return { ok: false, detail: `${topo}: no job record under ${staging} — the submit never landed a remote dir to gate on` }
  }
  const dir = String(remoteDir).replace(/\/+$/, '')
  const progressFile = `${dir}/sweep_progress.json`
  const doneFile = `${dir}/.hams_ssh_done`
  const ch = alias && !inCluster ? runChannel(run) : null
  const deadline = Date.now() + POLL_BUDGET_MS
  let channelFailures = 0
  for (;;) {
    checkCancelled(run) // user stop lands within one gate interval (2 s)
    checkBudget(run)
    if (Date.now() >= deadline) break
    if (ch) {
      const r = await ch.exec(`test -f ${shq(progressFile)} -o -f ${shq(doneFile)}`, { timeoutMs: 10_000 })
      if (r.isError || r.timedOut || r.exitCode == null) {
        channelFailures += 1
        if (channelFailures >= GATE_CHANNEL_FAILURES) {
          return { ok: false, detail: `${topo}: ssh channel unusable while waiting for the worker start: ${String(r.text || r.stderr || 'no detail').slice(0, 200)}` }
        }
      } else {
        channelFailures = 0
        if (Number(r.exitCode) === 0) return { ok: true }
      }
    } else if (fs.existsSync(progressFile) || fs.existsSync(doneFile)) {
      return { ok: true }
    }
    if (step) {
      step.result = `waiting for worker start: ${topo} (${Math.ceil((deadline - Date.now()) / 1000)}s budget left)`
      void persistRun(run)
    }
    await new Promise((res) => setTimeout(res, GATE_INTERVAL_MS))
  }
  return { ok: false, detail: `${topo}: the worker never wrote a progress marker under ${dir} within ${Math.round(POLL_BUDGET_MS / 60_000)} min — inspect the run dir directly (tail ssh_worker.log / errlog.txt; the gate watches sweep_progress.json and .hams_ssh_done)` }
}

// The remote chains' exec/transfer channel. Exec follows the alias: over
// dsh-ssh when one is configured (out-of-cluster, or in-cluster scheduler=ssh
// — the run itself crosses ssh), else the official local ctx.shell seam
// (in-cluster LSF). Transfers cross ssh ONLY out-of-cluster (D-002): an
// in-cluster run stages and fetches with plain local copies on the shared
// filesystem, whatever the scheduler. Same value shapes either way, so the
// chains below stay channel-agnostic. The run's cancel controller signal
// rides every call (D-029 discipline): the self-check stop then settles
// in-flight remote execs at once (dsh-ssh KILL + close / ctx.shell kill)
// instead of waiting out their budgets — previously the signal only reached
// the callTool-invoked batch tools, not these direct channel calls.
function runChannel(run, { withSignal = true } = {}) {
  const { ctx, alias, inCluster } = run._priv
  // Cancel cleanup (killSubmittedLsfJobs) runs AFTER the controller aborted —
  // carrying the dead signal there would abort the bkill before dispatch, so
  // that path opts out (withSignal: false): cleanup must outlive the cancel.
  const signal = withSignal ? (run._priv.cancel?.controller?.signal ?? null) : null
  return {
    exec: alias
      ? (cmd, opts) => execRemote(ctx, alias, cmd, { ...opts, signal })
      : (cmd, opts) => execLocal(ctx, cmd, { ...opts, signal }),
    upload: !inCluster && alias
      ? (localPath, remotePath) => uploadFile(ctx, alias, localPath, remotePath, { signal })
      : localCopy,
    download: !inCluster && alias
      ? (remotePath, localPath) => downloadFile(ctx, alias, remotePath, localPath, { signal })
      : localCopy,
  }
}

async function remoteSpectreChain(run) {
  const { ctx, settings } = run._priv
  const primary = settings.scheduler === 'ssh' ? 'ssh' : 'lsf'

  // staging: template + sweep_config + both verify flavors ride along (the
  // compute language can be switched without re-staging)
  for (const topo of TOPOS) {
    const staging = path.join(run.runDir, 'remote', topo)
    await fsp.mkdir(staging, { recursive: true })
    await fsp.copyFile(path.join(run.runDir, topo, 'template.scs'), path.join(staging, 'template.scs'))
    await fsp.copyFile(path.join(run.runDir, topo, 'sweep_config.json'), path.join(staging, 'sweep_config.json'))
    for (const asset of VERIFY_ASSETS) await fsp.copyFile(asset, path.join(staging, path.basename(asset)))
  }

  const submitStep = (scheduler, label, fallback) => timedStep(run, {
    section: 'remote', item: `batch_submit (LPF+HPF, ${label})`, settingColumn: 'scheduler',
    attempt: fallback ? 'fallback' : 'primary',
    ...(fallback ? { warn: 'fallback attempt after scheduler failure' } : {}),
  }, async () => {
    checkBudget(run)
    const details = []
    let ok = true
    for (const topo of TOPOS) {
      const staging = path.join(run.runDir, 'remote', topo)
      const r = await callTool(ctx, 'batch_submit', {
        run_dir: staging,
        remote_dir: remoteDirFor(run, topo, scheduler),
        worker: 'spectre/spectre_sweep_worker.py',
        machine_id: settings.machine_id,
        remote_root: settings.remote_root,
        scheduler,
        project: run._priv.project.path,
      }, { timeoutMs: scheduler === 'ssh' ? 660_000 : 900_000, signal: run._priv.cancel.controller.signal })
      const job = readJob(staging)
      if (r.isError || !job) ok = false
      // failure-first: the error text leads; a leftover job record from the
      // OTHER attempt (primary/fallback share the staging dir) is an annotation,
      // never the headline (2026-11-21 observability fix)
      const jobNote = job ? `${job.scheduler}/${job.job_id} -> ${job.remote_dir}` : ''
      if (r.isError) {
        details.push(`${topo}: FAILED — ${String(r.text || 'submit error').slice(0, 300)}`
          + (jobNote ? `\n  (stale job record from a previous attempt: ${jobNote})` : ''))
      } else if (jobNote) {
        details.push(`${topo}: ${jobNote}`)
      } else {
        details.push(`${topo}: no job file — ${String(r.text || 'no output').slice(0, 300)}`)
      }
    }
    return { ok, result: ok ? `submitted (${details.length} batches)` : 'submit failed', detail: details.join('\n').slice(0, 1500) }
  })

  const pollStep = (scheduler, submitOk) => timedStep(run, {
    section: 'remote', item: 'batch_poll → completed', settingColumn: 'scheduler',
    attempt: scheduler === primary ? 'primary' : 'fallback',
  }, async (step) => {
    if (!submitOk) return { ok: false, result: 'skipped (submit failed)', detail: '' }
    checkBudget(run)
    const details = []
    let ok = true
    for (const topo of TOPOS) {
      const staging = path.join(run.runDir, 'remote', topo)
      if (scheduler === 'ssh') {
        // the worker-start gate: a detached ssh submit (D-028) returns before
        // the worker sweeps, so wait for the first progress marker with 2 s
        // direct probes, THEN poll — and the poll loop below runs ssh chains
        // to a terminal state exactly like lsf (the old one-round ssh break
        // was the pre-detach contract and left the green run undecided).
        // LSF chains skip the gate: bjobs' PEND state is exactly the
        // information a file gate would hide.
        const gated = await waitForWorkerProgress(run, step, topo, staging)
        if (!gated.ok) {
          ok = false
          details.push(gated.detail)
          continue
        }
      }
      const budget = Date.now() + POLL_BUDGET_MS
      let state = null
      let last = null
      while (Date.now() < budget) {
        checkCancelled(run) // user stop lands within one poll interval (5 s)
        const r = await callTool(ctx, 'batch_poll', { run_dir: staging, machine_id: settings.machine_id, project: run._priv.project.path },
          { timeoutMs: 60_000, signal: run._priv.cancel.controller.signal })
        last = r
        const parsed = extractStateJson(r.text)
        state = parsed?.state ?? null
        // live progress: the step row the sidebar polls every 3 s shows the
        // latest counts instead of sitting silent through the whole wait
        if (step) {
          step.result = `polling ${topo}: ${state ?? 'unknown'}`
            + (parsed?.completed != null ? ` (${parsed.completed}/${parsed?.total ?? '?'})` : '')
          void persistRun(run)
        }
        if (state === 'completed' || state === 'failed' || r.isError) break
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
      }
      const prog = await fsp.readFile(path.join(staging, 'sweep_progress.json'), 'utf8')
        .then((t) => JSON.parse(t)).catch(() => null)
      // toolchain telemetry (D-016/D-017): the worker records the interpreter
      // and spectre the JOB really got — harvest it for the finalize auto-pin
      if (prog?.toolchain && !run._priv.toolchainTelemetry) run._priv.toolchainTelemetry = prog.toolchain
      const fetchedOk = state === 'completed' || (prog?.status === 'completed' && Number(prog.succeeded) === 9)
      if (!fetchedOk) ok = false
      details.push(`${topo}: state=${state ?? 'unknown'}${prog ? ` (${prog.succeeded}/${prog.total_points})` : ''}`
        + (last?.isError ? ` — ${String(last.text).slice(0, 200)}` : ''))
    }
    return { ok, result: ok ? 'completed 9/9 (both topos)' : 'batch not completed', detail: details.join('\n').slice(0, 1200) }
  })

  const s1 = await submitStep(primary, primary === 'lsf' ? 'LSF' : 'ssh', false)
  const p1 = await pollStep(primary, s1.ok === true)
  let good = { scheduler: primary, ok: s1.ok === true && p1.ok === true }

  if (!good.ok && primary !== 'ssh') {
    if (run._priv.cancel.requested) throw new SelfcheckCancelled()
    // A scheduler=ssh retry needs an ssh target: without machine_id (in-cluster
    // LSF-only project) there is no fallback at all — say so instead of trying.
    if (!settings.machine_id) {
      p1.warn = (p1.warn ? p1.warn + ' · ' : '') + 'no scheduler=ssh fallback possible without machine_id'
      void persistRun(run)
    } else {
      // Immediate diagnosis of the scheduler cluster, then retry ssh.
      await diagnoseSteps(run, [s1, p1], 'remote-scheduler')
      const s2 = await submitStep('ssh', 'ssh', true)
      const p2 = await pollStep('ssh', s2.ok === true)
      if (s2.ok === true && p2.ok === true) {
        good = { scheduler: 'ssh', ok: true, viaFallback: true }
        p2.warn = (p2.warn ? p2.warn + ' · ' : '') + 'completed via fallback (ssh run)'
        void persistRun(run)
      }
    }
  }

  if (!good.ok) {
    skipStep(run, { section: 'remote', item: `remote parse + verify (${settings.compute_script_remote})`, settingColumn: 'compute_remote' }, 'batch failed')
    skipStep(run, { section: 'remote', item: 'result download + local cross-check', settingColumn: 'compute_remote' }, 'batch failed')
    return
  }
  run._priv.usedScheduler = good.scheduler
  run._priv.viaFallback = !!good.viaFallback
  await remoteVerifyAndFetch(run, { parserFromScriptsDir: true })
}

async function remoteVerifyAndFetch(run, { parserFromScriptsDir }) {
  const { settings } = run._priv
  const ch = runChannel(run)
  const lang = settings.compute_script_remote
  // the pinned interpreter, else the bare default (the spectre chain takes it
  // from the job file below, which already resolved the same pin)
  const remotePython = settings.remote_python || DEFAULT_REMOTE_PYTHON
  const remoteNode = DEFAULT_REMOTE_NODE

  // R3 / RN2 — remote parse + verify (one command chain per topology)
  const verifyStep = await timedStep(run, {
    section: 'remote', item: `remote parse + verify (${lang})`, settingColumn: 'compute_remote',
  }, async () => {
    checkBudget(run)
    const results = {}
    const details = []
    let ok = true
    for (const topo of TOPOS) {
      const dir = parserFromScriptsDir
        ? remoteDirFor(run, topo, run._priv.usedScheduler ?? settings.scheduler)
        : remoteJoin(run._priv.remoteBase, run.id, topo)
      const job = parserFromScriptsDir ? readJob(path.join(run.runDir, 'remote', topo)) : null
      const parserPath = job ? remoteJoin(job.scripts_dir, 'spectre', 'spectre_psf_parse.py') : null
      const cmd = remoteComputeCommand({
        remoteDir: dir, parserPath, python: job?.remote_python ?? remotePython,
        node: remoteNode, lang, topo,
      })
      const r = await ch.exec(cmd, { timeoutMs: 180_000 })
      const json = parseMarkerJson(r.stdout)
      results[topo] = json
      const sum = verifySummary(topo, json, { prefix: false })
      if (!r.ok || !json || !sum.ok) ok = false
      details.push(`${topo}: ${r.ok ? (json ? sum.text : 'no [selfcheck] marker') : `exit ${r.exitCode}`}`)
    }
    run._priv.remoteVerify = results
    return { ok, result: details.join(' · '), detail: details.join('\n').slice(0, 1200) }
  })

  if (verifyStep.ok !== true) {
    skipStep(run, { section: 'remote', item: parserFromScriptsDir ? 'psf CSV download + local cross-check' : 'artifact download + local cross-check', settingColumn: 'compute_remote' }, 'remote verify failed')
    return
  }

  // R4 / RN3 — download the compact results the remote parse produced (point
  // metas for the params + the psf CSVs the verifier compares), then local
  // cross-check in the selected LOCAL language (plain per-file ssh_download:
  // the light result files never need an archive)
  await timedStep(run, {
    section: 'remote', item: parserFromScriptsDir ? 'result download + local cross-check' : 'artifact download + local cross-check',
    settingColumn: 'compute_remote',
  }, async () => {
    checkBudget(run)
    const localLang = settings.compute_script_local
    const parts = []
    let ok = true
    for (const topo of TOPOS) {
      const staging = path.join(run.runDir, 'remote', topo)
      const dir = parserFromScriptsDir
        ? remoteDirFor(run, topo, run._priv.usedScheduler ?? settings.scheduler)
        : remoteJoin(run._priv.remoteBase, run.id, topo)
      let got = 0
      for (let i = 0; i < 9; i++) {
        const name = String(i).padStart(2, '0')
        for (const rel of [`${name}/point_meta.json`, `psf/${name}_psf.csv`]) {
          const local = path.join(staging, ...rel.split('/'))
          await fsp.mkdir(path.dirname(local), { recursive: true })
          const dl = await ch.download(remoteJoin(dir, rel), local)
          if (dl.ok) got += 1
        }
      }
      if (got !== 18) {
        ok = false
        parts.push(`${topo}: downloaded ${got}/18 result files (metas + psf CSVs)`)
        continue
      }
      const localJson = await runVerifyLocal(localLang, topo, staging, localChainPython(settings))
      const remoteJson = run._priv.remoteVerify?.[topo] ?? null
      const cons = consistency(localJson, remoteJson)
      if (!localJson.ok || !cons.ok) ok = false
      parts.push(`${topo}: local ${verifySummary(topo, localJson).text}`
        + (cons.maxDiff != null ? `; remote-vs-local diff ${(cons.maxDiff * 100).toPrecision(3)}%` : ''))
    }
    return { ok, result: `${parts.join(' · ')} (local ${localLang})`, detail: parts.join('\n').slice(0, 1200) }
  })
}

async function remoteGoldenChain(run) {
  const { settings } = run._priv
  const ch = runChannel(run)
  const via = run._priv.alias ? 'ssh_upload' : 'local copy'

  // RN1 — upload the golden run trees + the verify flavors + the standalone
  // psf parser (spectre_psf_parse.py is stdlib-only, so it runs from the batch
  // dir without the whole scripts tree); in-cluster this "upload" is a local
  // copy on the shared filesystem (D-002)
  const uploadStep = await timedStep(run, {
    section: 'remote', item: `golden upload (${via})`, settingColumn: 'machine',
  }, async () => {
    checkBudget(run)
    let parserSrc
    try {
      parserSrc = path.join(simScriptsDir(run._priv.project.path), 'spectre', 'spectre_psf_parse.py')
    } catch (e) {
      return { ok: false, result: 'no scripts root', detail: String(e?.message ?? e) }
    }
    if (!fs.existsSync(parserSrc)) {
      return { ok: false, result: 'spectre_psf_parse.py not found under sim_scripts_dir' }
    }
    let uploaded = 0
    let failed = []
    for (const topo of TOPOS) {
      const dir = remoteJoin(run._priv.remoteBase, run.id, topo)
      const staging = path.join(run.runDir, 'remote', topo)
      await fsp.mkdir(staging, { recursive: true })
      const wants = []
      for (let i = 0; i < 9; i++) {
        const name = String(i).padStart(2, '0')
        wants.push([path.join(run.runDir, topo, name, 'point_meta.json'), `${name}/point_meta.json`])
        wants.push([path.join(run.runDir, topo, name, 'netlist.scs.raw', 'ac.ac'), `${name}/netlist.scs.raw/ac.ac`])
      }
      for (const asset of VERIFY_ASSETS) wants.push([asset, path.basename(asset)])
      wants.push([parserSrc, 'spectre_psf_parse.py'])
      for (const [local, rel] of wants) {
        const target = path.join(staging, ...rel.split('/'))
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.copyFile(local, target)
        const up = await ch.upload(local, remoteJoin(dir, rel))
        if (up.ok) uploaded += 1
        else failed.push(`${topo}/${rel}: ${up.text.slice(0, 120)}`)
      }
    }
    return {
      ok: failed.length === 0,
      result: failed.length ? `upload failed (${failed.length})` : `${uploaded} files uploaded`,
      detail: failed.slice(0, 6).join('\n').slice(0, 1000),
    }
  })

  if (uploadStep.ok !== true) {
    skipStep(run, { section: 'remote', item: `remote parse + verify (${settings.compute_script_remote})`, settingColumn: 'compute_remote' }, 'upload failed')
    skipStep(run, { section: 'remote', item: 'artifact download + local cross-check', settingColumn: 'compute_remote' }, 'upload failed')
    return
  }
  await remoteVerifyAndFetch(run, { parserFromScriptsDir: false })
}

// ---------------------------------------------------------------------------
// Finalize: summary + the end-of-run diagnosis for uncovered failures
// ---------------------------------------------------------------------------

// A green run pins the toolchain it MEASURED and remembers it per node
// (2026-11-25, D-016/D-017): the worker's sweep_progress.json telemetry is
// what the job really ran under — sys.executable and the resolved spectre —
// never a guess, and it equals an explicit pin anyway (the worker runs under
// it). Writing it refreshes the settings + the plugin-global node memory, so
// the yaml the finalize sync renders carries no null pins and the next
// project on the same node starts pinned. Without telemetry (an older worker,
// simulator=none) nothing is written — the honest nulls stay.
export async function autoPinToolchain(run) {
  const tel = run._priv.toolchainTelemetry
  run.summary.toolchain_pinned = false
  if (!run.summary.ok || !tel) return
  const patch = {}
  if (tel.python && normalizePin(tel.python, 'remote_python').value) patch.remote_python = tel.python
  if (tel.spectre && normalizePin(tel.spectre, 'remote_spectre_cmd').value) patch.remote_spectre_cmd = tel.spectre
  // D-021: the numpy tri-state of the interpreter that ran the worker (the
  // worker probes it at startup — yes / fallback / no); it lands alongside
  // the pins it describes
  if (NUMPY_STATES.includes(tel.numpy)) patch.remote_python_numpy = tel.numpy
  if (!PIN_KEYS.some((k) => patch[k] != null) && patch.remote_python_numpy == null) return
  const stored = run._priv.settings
  const v = validateSettings({ ...stored, ...patch })
  if (v.error) return
  await writeSettings(run._priv.project.path, v.settings)
  run._priv.settings = v.settings
  run.summary.toolchain_pinned = true
  // node memory: keyed by the dsh-ssh machine alias; in-cluster LSF (no
  // machine) falls back to the hostname the telemetry itself reports
  const nodeKey = stored.machine_id || (tel.node ? String(tel.node) : null)
  if (nodeKey) {
    await updateNodePins(nodeKey, {
      host: run._priv.machine?.host ?? (tel.node ? String(tel.node) : null),
      remote_python: patch.remote_python ?? v.settings.remote_python ?? null,
      remote_spectre_cmd: patch.remote_spectre_cmd ?? v.settings.remote_spectre_cmd ?? null,
      remote_python_numpy: v.settings.remote_python_numpy ?? null,
    }).catch(() => { /* best-effort memory; the settings pin already landed */ })
  }
}

// D-021: measure THIS host's python facts once (version + executable + the
// numpy tri-state, one probe with the project's staged numfallback asset in
// scope) and persist them into the settings AND the plugin-global local
// memory — the finalize sync right after renders the fresh rows, and fresh
// projects on this machine prefill from the memory. Best-effort: a degraded
// probe (no executable path) keeps the existing facts untouched.
async function persistLocalFacts(run) {
  const project = run._priv.project
  const facts = await localEnvFacts(project.path).catch(() => null)
  const p = facts?.python
  if (!p?.version || !p?.path) return
  const patch = {
    local_python_version: p.version,
    local_python_path: p.path,
    ...(p.numpy ? { local_python_numpy: p.numpy } : {}),
  }
  let cur
  try {
    ({ settings: cur } = await readSettings(project.path))
  } catch {
    return
  }
  const v = validateSettings({ ...cur, ...patch })
  if (v.error) return
  await writeSettings(project.path, v.settings).catch(() => {})
  run._priv.settings = v.settings
  await updateLocalFacts(patch).catch(() => { /* best-effort memory */ })
}

function finalize(run) {
  // A user-stopped run finalizes as status='cancelled' (not 'done'): partial
  // evidence is KEPT for inspection, no diagnosis sessions spawn, and the
  // AGENTS.md block does not re-sync from half-finished measurements. The
  // status filter in agentsmd.latestSelfcheckRun only reads 'done' runs, so a
  // cancelled run can never become last_selfcheck_*.
  const cancelled = !!run._priv.cancelled
  run.status = cancelled ? 'cancelled' : 'done'
  run.finishedAt = new Date().toISOString()
  const localSteps = run.steps.filter((s) => s.section === 'local' && s.ms != null && s.ok !== null)
  const localOk = localSteps.every((s) => s.ok === true)
  let remote = 'skipped'
  if (run.scope.mode === 'remote') {
    const remoteSteps = run.steps.filter((s) => s.section === 'remote' && s.ms != null && s.ok !== null)
    // The PRIMARY submit/poll pair fails on purpose when the scheduler breaks and
    // the fallback attempt takes over — those failures must not sink the verdict
    // once the fallback completed the chain. Without a SUCCESSFUL fallback there
    // is nothing to forgive: with scheduler=ssh (or an in-cluster LSF-only
    // project with no machine_id) there is no fallback at all,
    // so a primary failure must fail the verdict.
    const hardFailed = remoteSteps.some((s) => s.ok === false
      && (s.attempt !== 'primary' || !run._priv.viaFallback))
    if (hardFailed) remote = 'failed'
    else if (run._priv.viaFallback) remote = 'ok-via-fallback'
    else remote = remoteSteps.length ? 'ok' : 'failed'
  }
  run.summary = {
    local: localOk,
    remote,
    ok: !cancelled && localOk && remote !== 'failed',
    ...(run._priv.viaFallback ? { fallback: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  }
  const remaining = cancelled ? [] : run.steps.filter((s) => s.ok === false && !run._priv.diagnosed.has(s))
  if (remaining.length) {
    // fire-and-forget: finalize must never throw on diagnosis trouble (the
    // record carries the error either way)
    diagnoseSteps(run, remaining, 'final')
      .catch((e) => {
        run.diagnoses.push({ trigger: 'final', status: 'failed', sessionId: null, error: String(e?.message ?? e), title: 'HarnessAMS diagnosis: selfcheck' })
        void persistRun(run)
      })
      .finally(() => {
        runningBySession.delete(run._priv.sessionId)
        void persistRun(run)
      })
  } else {
    runningBySession.delete(run._priv.sessionId)
  }
  void persistRun(run)
  if (cancelled) return
  // 2026-11-19 rulings: a CLEAN run's artifacts are deleted at finalize (a
  // diagnosed/failed run keeps its evidence; the next run's start cleans it),
  // and the AGENTS.md config block re-syncs on every finalize so
  // last_selfcheck_* never goes stale (UI = workspace_config.json = AGENTS.md).
  if (run.summary.ok && run.diagnoses.length === 0) {
    void cleanRunArtifacts(run.runDir).catch(() => {})
  }
  // the auto-pin must land BEFORE the AGENTS.md sync — the yaml then renders
  // with the just-measured pins, not the nulls the run started with.
  // D-021 order: (1) reconcile json ← AGENTS.md — a hand-edit made DURING the
  // run would otherwise be clobbered by this re-render (non-pin keys keep the
  // edit; pin keys keep the measurement below, D-016); (2) auto-pin the
  // measured toolchain + the remote numpy tri-state; (3) measure and persist
  // the local python facts; (4) re-render.
  void (async () => {
    try {
      const rec = await reconcileSettings(run._priv.project.path).catch(() => null)
      if (rec?.settings) run._priv.settings = rec.settings
      await autoPinToolchain(run)
      void persistRun(run)
    } catch { /* best-effort: the honest nulls simply stay */ }
    await persistLocalFacts(run).catch(() => { /* best-effort: existing facts stand */ })
    await syncAgentsMd(run._priv.ctx, { project: run._priv.project, settings: run._priv.settings })
      .catch(() => { /* best-effort at finalize; the save button can always re-sync */ })
  })()
}
