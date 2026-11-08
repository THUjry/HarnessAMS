// Project self-check orchestrator (2026-11-08). One button walks the WHOLE
// pipeline under the project's current settings (project_settings.json, see
// settings.js) — the point is not the simulation itself but verifying machine,
// connection, environment, permissions, tools and compute end to end:
//
//   simulator=spectre  full simulation path: spectre_assemble -> run_sweep ->
//                      spectre_parse -> pointwise verify (local), or
//                      bsub_submit/poll -> remote parse+verify -> fetch +
//                      cross-check (remote; an LSF failure is diagnosed and
//                      retried once with scheduler=none).
//   simulator=none     no simulation: the bundled golden dataset (src/selfcheck/
//                      golden, analytic RC AC responses in psfascii form) replays
//                      parse + compute locally, or upload -> remote compute ->
//                      download + cross-check remotely.
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
// callTool) — SmartAnaSim's spectre_* tools, this plugin's bsub_* tools and
// dsh-remote's rw_* — but verdicts are read from DISK ARTIFACTS
// (sweep_progress.json / psf_index.json / .bsub_job.json) wherever possible:
// the pipeline's serialization of model-tool results is a launch-class TODO and
// artifacts are the ground truth anyway (self-check spirit).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runPython } from '../py.js'
import { callTool, execRemote, uploadFile, downloadFile, shq } from '../remote.js'
import { readJob, readWorkspaceConfig, remoteJoin, resolveRemoteDir, simScriptsDir } from '../bsub.js'
import { readSettings } from './settings.js'
import { sanitizeFailed, createDiagnosisSession } from './diagnose.js'
import { fetchMachines, sessionInMirror } from './machines.js'
import { findRemoteProjectForMachine } from './remote.js'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // src/
export const SELFCHECK_ASSETS = path.join(PKG_ROOT, 'selfcheck')
export const GOLDEN_DIR = path.join(SELFCHECK_ASSETS, 'golden')
export const VERIFY_ASSETS = [
  path.join(PKG_ROOT, 'scripts', 'selfcheck', 'selfcheck_verify.py'),
  path.join(PKG_ROOT, 'scripts', 'selfcheck', 'selfcheck_verify.mjs'),
]

export const TOPOS = ['lpf', 'hpf']
export const TOLERANCE = 0.01
const TOTAL_BUDGET_MS = 30 * 60_000
const POLL_INTERVAL_MS = 5_000
const POLL_BUDGET_MS = 10 * 60_000
const FETCH_INCLUDES = ['point_meta.json', 'sweep_progress.json', 'errlog.txt', 'psf/*_psf.csv']

// In-memory run registry (id -> run). Bounded; the authoritative record is the
// per-run selfcheck_run.json under <workspace>/selfcheck/<id>/, so a restart
// still serves GET /api/selfcheck from disk.
const store = new Map()
const MAX_RUNS = 8
const runningBySession = new Map() // sessionId -> runId while running

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
    scope: run.scope,
    steps: run.steps.map((s) => ({ ...s })),
    summary: run.summary,
    diagnoses: run.diagnoses.map((d) => ({ ...d })),
  }
}

async function persistRun(run) {
  try {
    const tmp = path.join(run.runDir, 'selfcheck_run.json.tmp')
    await fsp.writeFile(tmp, JSON.stringify(runView(run), null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, path.join(run.runDir, 'selfcheck_run.json'))
  } catch { /* the in-memory copy keeps the API alive; disk is durability only */ }
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
    const out = (await fn()) ?? {}
    step.ok = out.ok
    step.result = out.result ?? ''
    step.detail = out.detail ?? ''
    if (out.warn != null) step.warn = out.warn // otherwise a warn preset on the spec survives
  } catch (e) {
    step.ok = false
    step.result = 'error'
    step.detail = String(e?.message ?? e).slice(0, 2000)
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

function checkBudget(run) {
  if (Date.now() > run._priv.deadline) throw new Error('self-check global budget exhausted (30 min)')
}

// ---------------------------------------------------------------------------
// Prompt for the auto diagnosis sessions (English body, answer-language line)
// ---------------------------------------------------------------------------

export function buildSelfcheckPrompt({ scope, runDir, machine, remotePath, mirrorDir, projectTitle, failed, lang }) {
  const lines = []
  lines.push('You are the diagnostic agent of the HarnessAMS workbench.')
  lines.push('')
  lines.push('A project self-check reported problems. Diagnose the root cause. Context:')
  lines.push(`- Self-check settings: mode=${scope?.mode} simulator=${scope?.simulator} `
    + `scheduler=${scope?.scheduler ?? 'n/a'} compute=local:${scope?.compute_local}/remote:${scope?.compute_remote}`)
  if (machine) {
    lines.push(`- Machine: ${machine.name || machine.host} (${machine.username ? machine.username + '@' : ''}${machine.host}:${machine.port ?? 22})`)
    if (remotePath) lines.push(`- Remote workspace path: ${remotePath}`)
    if (mirrorDir) lines.push(`- Local mirror of that workspace: ${mirrorDir}`)
  } else {
    lines.push('- Machine: local (this host)')
  }
  lines.push(`- Run artifacts: ${runDir} (point_meta.json / sweep_progress.json / errlog.txt / `
    + 'spectre.out / .bsub_job.json / selfcheck_run.json live under it — inspect them read-only)')
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
    lines.push('- This session was created inside the machine\'s remote-project workspace, so dsh-remote binds its remote tools to that machine: you may run read-only commands on it (e.g. via the rw_* tools) to verify. If a remote tool errors out, say so and analyze from the evidence above instead.')
  } else {
    lines.push('- You may run read-only local commands to verify (the workspace is this machine\'s HarnessAMS workspace).')
  }
  lines.push('- The likely fault families: missing simulator/python/node executable, dsh-remote connectivity or permissions (upload/write), LSF submission/queue, netlist/parse errors, compute-script numeric drift. Identify which one this is.')
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
  const { ctx, settings, machine, hit, localWorkspaceId, lang, project } = run._priv
  const allRemote = machine && failed.every((s) => s.section === 'remote')
  const workspaceId = allRemote ? hit.ws.id : localWorkspaceId
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
    machine: allRemote ? machine : null,
    remotePath: allRemote ? hit.rp.remotePath : null,
    mirrorDir: allRemote ? hit.rp.mirrorDir : null,
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

export async function startSelfcheck(ctx, { sessionId, project, lang, ws, req }) {
  let settings
  try {
    ({ settings } = await readSettings(project.path))
  } catch (e) {
    return { error: `project_settings.json unreadable: ${e?.message ?? e}`, code: 400 }
  }

  let machine = null
  let hit = null
  let agent = null
  let remoteBase = null
  if (settings.run_mode === 'remote') {
    const list = await fetchMachines(ctx.tools, req)
    if (!list.ok) return { error: `dsh-remote machines unavailable: ${list.reason}`, code: 503 }
    machine = list.machines.find((m) => m.id === settings.machine_id || m.name === settings.machine_id) || null
    if (!machine) return { error: `no such dsh-remote machine: ${settings.machine_id}`, code: 404 }
    hit = findRemoteProjectForMachine(ctx, machine)
    if (!hit) {
      return {
        error: `no remote project for machine ${machine.name ?? machine.host} — create one from the HarnessAMS console page first`,
        code: 409,
      }
    }
    const wrapped = sessionInMirror(ctx, hit.rp.mirrorDir)
    if (!wrapped) {
      return {
        error: `no live session in the remote project "${hit.ws.title ?? hit.ws.path}" — switch to it once so a session keeps the connection, then retry`,
        code: 409,
      }
    }
    agent = wrapped.agent
    try {
      remoteBase = resolveRemoteDir(hit.rp.remotePath, settings.remote_dir)
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
  const runDir = path.join(ws.config.workspace_root, 'selfcheck', runId)
  await fsp.mkdir(runDir, { recursive: true })

  const run = {
    id: runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    runDir,
    scope: {
      mode: settings.run_mode,
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
      ctx, sessionId, settings, project, lang, ws, machine, hit, agent, remoteBase,
      localWorkspaceId, deadline: Date.now() + TOTAL_BUDGET_MS, current: null,
      diagnosed: new Set(),
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
  void orchestrate(run)
  return { runId }
}

export function getSelfcheck(id, ws) {
  if (id) {
    const mem = store.get(id)
    if (mem) return runView(mem)
    return runView(readRunFromDisk(id, ws))
  }
  let best = null
  for (const run of store.values()) {
    if (!best || run.startedAt > best.startedAt) best = run
  }
  if (best) return runView(best)
  return runView(latestRunFromDisk(ws))
}

function readRunFromDisk(id, ws) {
  if (!ws || !/^[\w-]+$/.test(id)) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(ws.config.workspace_root, 'selfcheck', id, 'selfcheck_run.json'), 'utf8'))
  } catch { return null }
}

function latestRunFromDisk(ws) {
  if (!ws) return null
  const root = path.join(ws.config.workspace_root, 'selfcheck')
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  let best = null
  for (const ent of entries.slice(0, 30)) {
    if (!ent.isDirectory()) continue
    try {
      const p = path.join(root, ent.name, 'selfcheck_run.json')
      const run = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (!best || (run.startedAt ?? '') > (best.startedAt ?? '')) best = run
    } catch { /* skip unreadable */ }
  }
  return best
}

// ---------------------------------------------------------------------------
// Compute helpers (both channels share the JSON contract)
// ---------------------------------------------------------------------------

function parseMarkerJson(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('[selfcheck] ')).pop()
  if (!line) return null
  try { return JSON.parse(line.slice('[selfcheck] '.length)) } catch { return null }
}

async function runVerifyLocal(lang, topo, dir) {
  if (lang === 'js') {
    const mod = await import('../scripts/selfcheck/selfcheck_verify.mjs')
    return mod.verifyRun(dir, topo, TOLERANCE)
  }
  const { stdout } = await runPython('selfcheck/selfcheck_verify.py',
    ['--run-dir', dir, '--topo', topo, '--tolerance', String(TOLERANCE)], 120_000)
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
    // C1 — SmartAnaSim tool registration
    const required = sim === 'spectre'
      ? ['spectre_assemble', 'spectre_run_sweep', 'spectre_parse']
      : ['spectre_parse']
    const registered = required.filter((n) => ctx.tools?.get?.(n))
    const missing = required.filter((n) => !ctx.tools?.get?.(n))
    const c1 = addStep(run, { item: 'SmartAnaSim tool registration', settingColumn: 'simulator' })
    c1.ms = 1
    if (missing.length) {
      c1.ok = false
      c1.result = `missing: ${missing.join(', ')}`
      c1.detail = 'The SmartAnaSim plugin registers the spectre_* tools — install/enable it '
        + '(and check its Config family switches), then retry.'
    } else {
      c1.ok = true
      c1.result = `${required.join(', ')} registered`
      if (sim === 'none') {
        const optional = ['spectre_assemble', 'spectre_run_sweep'].filter((n) => !ctx.tools?.get?.(n))
        if (optional.length) c1.warn = `not registered (unused in simulator=none): ${optional.join(', ')}`
      }
    }
    void persistRun(run)
    const toolsOk = !missing.length

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
      ? `machine ${run._priv.machine?.name ?? run._priv.machine?.host}, remote dir ${run._priv.remoteBase}`
      : 'local mode'
    c2.detail = `simulator=${sim}, compute local=${settings.compute_script_local}, remote=${settings.compute_script_remote}`
      + (run.scope.scheduler ? `, scheduler=${run.scope.scheduler}` : '')
    void persistRun(run)

    if (!toolsOk) {
      if (sim === 'spectre') {
        skipStep(run, { item: 'spectre_assemble (RC tb)', settingColumn: 'simulator' }, 'tools missing')
      } else {
        skipStep(run, { item: 'golden dataset load', settingColumn: 'simulator' }, 'tools missing')
      }
      skipRestForUnprepared(run, mode, sim, 'tools missing')
      return // finalize handles the rest
    }
    checkBudget(run)

    // Common preparation: assemble (spectre) or golden load (none)
    let prepared = false
    if (sim === 'spectre') {
      const step = await timedStep(run, { item: 'spectre_assemble (RC tb)', settingColumn: 'simulator' }, async () => {
        await fsp.cp(path.join(SELFCHECK_ASSETS, 'script'), path.join(run.runDir, 'project', 'script'), { recursive: true })
        const r = await callTool(ctx, 'spectre_assemble', {
          project_dir: path.join(run.runDir, 'project'),
          gen_script: 'gen_selfcheck_rc.py',
          out_dir: run.runDir,
        }, { timeoutMs: 150_000 })
        const have = TOPOS.every((topo) => fs.existsSync(path.join(run.runDir, topo, 'template.scs'))
          && fs.existsSync(path.join(run.runDir, topo, 'sweep_config.json')))
        return {
          ok: !r.isError && have,
          result: have ? 'RC LPF+HPF tb generated (3x3)' : 'assembly output incomplete',
          detail: (r.text || '').split(/\r?\n/).slice(-4).join('\n').slice(0, 800),
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
    const cur = run._priv.current
    if (cur && cur.ok === null) {
      cur.ok = false
      cur.result = 'error'
      cur.detail = String(e?.message ?? e).slice(0, 2000)
      if (!cur.ms) cur.ms = 1
      void persistRun(run)
    }
  } finally {
    finalize(run)
  }
}

function skipRestForUnprepared(run, mode, sim, reason) {
  const section = mode === 'remote' ? 'remote' : 'local'
  if (mode === 'local') {
    if (sim === 'spectre') {
      skipStep(run, { item: 'spectre_run_sweep LPF (9 pts)', settingColumn: 'simulator' }, reason)
      skipStep(run, { item: 'spectre_run_sweep HPF (9 pts)', settingColumn: 'simulator' }, reason)
    }
    skipStep(run, { item: sim === 'spectre' ? 'spectre_parse (LPF+HPF)' : 'spectre_parse (golden)', settingColumn: 'simulator' }, reason)
    skipStep(run, { item: `pointwise verify (${run._priv.settings.compute_script_local}, LPF+HPF)`, settingColumn: 'compute_local' }, reason)
  } else if (sim === 'spectre') {
    skipStep(run, { section, item: 'bsub_submit (LPF+HPF)', settingColumn: 'scheduler' }, reason)
    skipStep(run, { section, item: 'bsub_poll → completed', settingColumn: 'scheduler' }, reason)
    skipStep(run, { section, item: `remote parse + verify (${run._priv.settings.compute_script_remote})`, settingColumn: 'compute_remote' }, reason)
    skipStep(run, { section, item: 'bsub_fetch + local cross-check', settingColumn: 'compute_remote' }, reason)
  } else {
    skipStep(run, { section, item: 'golden upload (rw_upload)', settingColumn: 'machine' }, reason)
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
      const step = await timedStep(run, { item: `spectre_run_sweep ${topo.toUpperCase()} (9 pts)`, settingColumn: 'simulator' }, async () => {
        const r = await callTool(ctx, 'spectre_run_sweep',
          { run_dir: path.join(run.runDir, topo), timeout_sec: 600 }, { timeoutMs: 660_000 })
        const prog = await fsp.readFile(path.join(run.runDir, topo, 'sweep_progress.json'), 'utf8')
          .then((t) => JSON.parse(t)).catch(() => null)
        const total = Number(prog?.total_points) || 0
        const succ = Number(prog?.succeeded) || 0
        const ok = !r.isError && prog?.status === 'completed' && total === 9 && succ === total
        const cmd = await fsp.readFile(path.join(run.runDir, topo, '00', 'point_meta.json'), 'utf8')
          .then((t) => JSON.parse(t)?.command).catch(() => null)
        return {
          ok,
          result: prog ? `${succ}/${total} success (${prog.status})` : 'no sweep_progress.json',
          detail: [cmd ? `spectre: ${String(cmd).split(/\s+/).slice(0, 3).join(' ')}` : '',
            (r.text || '').split(/\r?\n/).filter((l) => l.startsWith('[sweep]')).slice(-3).join('\n')]
            .filter(Boolean).join('\n').slice(0, 800),
        }
      })
      sweepSteps.push(step)
    }
    const swept = sweepSteps.every((s) => s.ok === true)
    const parseStep = await runParseStep(run, swept, 'spectre_parse (LPF+HPF)')
    await runVerifyStep(run, parseStep.ok === true)
  } else {
    const parseStep = await runParseStep(run, true, 'spectre_parse (golden)')
    await runVerifyStep(run, parseStep.ok === true)
  }
}

async function runParseStep(run, prerequisiteOk, label) {
  const { ctx } = run._priv
  if (!prerequisiteOk) {
    const s = addStep(run, { item: label, settingColumn: 'simulator' })
    s.ok = null; s.skipReason = 'sweep failed'; s.ms = 1
    void persistRun(run)
    return s
  }
  return timedStep(run, { item: label, settingColumn: 'simulator' }, async () => {
    const details = []
    let ok = true
    for (const topo of TOPOS) {
      const dir = path.join(run.runDir, topo)
      const r = await callTool(ctx, 'spectre_parse', { work_dir: dir, format: 'csv' }, { timeoutMs: 620_000 })
      const index = await fsp.readFile(path.join(dir, 'psf', 'psf_index.json'), 'utf8')
        .then((t) => JSON.parse(t)).catch(() => null)
      const points = Array.isArray(index?.points) ? index.points.length : 0
      const signals = index?.points?.[0]?.signals ?? []
      const haveSignals = signals.includes('ac_freq') && signals.includes('ac_vout')
      if (r.isError || points !== 9 || !haveSignals) ok = false
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
      const json = await runVerifyLocal(lang, topo, path.join(run.runDir, topo))
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

// ---------------------------------------------------------------------------
// Remote chains
// ---------------------------------------------------------------------------

function remoteDirFor(run, topo, scheduler) {
  // Per-attempt subdirectories keep the LSF retry from colliding with the
  // failed batch (bsub_submit refuses clobbering existing point_meta files).
  return remoteJoin(run._priv.remoteBase, run.id, `${topo}_${scheduler}`)
}

async function remoteSpectreChain(run) {
  const { ctx, settings } = run._priv
  const primary = settings.scheduler === 'none' ? 'none' : 'lsf'

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
    section: 'remote', item: `bsub_submit (LPF+HPF, ${label})`, settingColumn: 'scheduler',
    attempt: fallback ? 'fallback' : 'primary',
    ...(fallback ? { warn: 'fallback attempt after scheduler failure' } : {}),
  }, async () => {
    checkBudget(run)
    const details = []
    let ok = true
    for (const topo of TOPOS) {
      const staging = path.join(run.runDir, 'remote', topo)
      const r = await callTool(ctx, 'bsub_submit', {
        run_dir: staging,
        remote_dir: remoteDirFor(run, topo, scheduler),
        worker: 'spectre/spectre_sweep_worker.py',
        machine_id: settings.machine_id,
        scheduler,
      }, { timeoutMs: scheduler === 'none' ? 660_000 : 900_000 })
      const job = readJob(staging)
      if (r.isError || !job) ok = false
      details.push(`${topo}: ${job ? `${job.scheduler}/${job.job_id} -> ${job.remote_dir}` : (r.text || 'no job file').slice(0, 300)}`)
    }
    return { ok, result: ok ? `submitted (${details.length} batches)` : 'submit failed', detail: details.join('\n').slice(0, 1500) }
  })

  const pollStep = (scheduler, submitOk) => timedStep(run, {
    section: 'remote', item: 'bsub_poll → completed', settingColumn: 'scheduler',
    attempt: scheduler === primary ? 'primary' : 'fallback',
  }, async () => {
    if (!submitOk) return { ok: false, result: 'skipped (submit failed)', detail: '' }
    checkBudget(run)
    const details = []
    let ok = true
    for (const topo of TOPOS) {
      const staging = path.join(run.runDir, 'remote', topo)
      const budget = Date.now() + POLL_BUDGET_MS
      let state = null
      let last = null
      while (Date.now() < budget) {
        const r = await callTool(ctx, 'bsub_poll', { run_dir: staging, machine_id: settings.machine_id },
          { timeoutMs: 60_000 })
        last = r
        const parsed = extractStateJson(r.text)
        state = parsed?.state ?? null
        if (state === 'completed' || state === 'failed' || r.isError) break
        if (scheduler === 'none') break // direct runs finish inside submit
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
      }
      const prog = await fsp.readFile(path.join(staging, 'sweep_progress.json'), 'utf8')
        .then((t) => JSON.parse(t)).catch(() => null)
      const fetchedOk = state === 'completed' || (prog?.status === 'completed' && Number(prog.succeeded) === 9)
      if (!fetchedOk) ok = false
      details.push(`${topo}: state=${state ?? 'unknown'}${prog ? ` (${prog.succeeded}/${prog.total_points})` : ''}`
        + (last?.isError ? ` — ${String(last.text).slice(0, 200)}` : ''))
    }
    return { ok, result: ok ? 'completed 9/9 (both topos)' : 'batch not completed', detail: details.join('\n').slice(0, 1200) }
  })

  const s1 = await submitStep(primary, primary === 'lsf' ? 'LSF' : 'direct', false)
  const p1 = await pollStep(primary, s1.ok === true)
  let good = { scheduler: primary, ok: s1.ok === true && p1.ok === true }

  if (!good.ok && primary !== 'none') {
    // Immediate diagnosis of the scheduler cluster, then retry direct.
    await diagnoseSteps(run, [s1, p1], 'remote-scheduler')
    const s2 = await submitStep('none', 'direct', true)
    const p2 = await pollStep('none', s2.ok === true)
    if (s2.ok === true && p2.ok === true) {
      good = { scheduler: 'none', ok: true, viaFallback: true }
      p2.warn = (p2.warn ? p2.warn + ' · ' : '') + 'completed via fallback (direct run)'
      void persistRun(run)
    }
  }

  if (!good.ok) {
    skipStep(run, { section: 'remote', item: `remote parse + verify (${settings.compute_script_remote})`, settingColumn: 'compute_remote' }, 'batch failed')
    skipStep(run, { section: 'remote', item: 'bsub_fetch + local cross-check', settingColumn: 'compute_remote' }, 'batch failed')
    return
  }
  run._priv.usedScheduler = good.scheduler
  run._priv.viaFallback = !!good.viaFallback
  await remoteVerifyAndFetch(run, { parserFromScriptsDir: true })
}

async function remoteVerifyAndFetch(run, { parserFromScriptsDir }) {
  const { ctx, settings, agent } = run._priv
  const lang = settings.compute_script_remote
  const wsConfig = readWorkspaceConfig().config
  const remotePython = wsConfig.remote_python || 'python3'
  const remoteNode = wsConfig.remote_node || 'node'

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
      const r = await execRemote(ctx, agent, cmd, { timeoutMs: 180_000 })
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
    skipStep(run, { section: 'remote', item: parserFromScriptsDir ? 'bsub_fetch + local cross-check' : 'artifact download + local cross-check', settingColumn: 'compute_remote' }, 'remote verify failed')
    return
  }

  // R4 / RN3 — fetch artifacts + local cross-check in the selected LOCAL language
  await timedStep(run, {
    section: 'remote', item: parserFromScriptsDir ? 'bsub_fetch + local cross-check' : 'artifact download + local cross-check',
    settingColumn: 'compute_remote',
  }, async () => {
    checkBudget(run)
    const localLang = settings.compute_script_local
    const parts = []
    let ok = true
    for (const topo of TOPOS) {
      const staging = path.join(run.runDir, 'remote', topo)
      if (parserFromScriptsDir) {
        const r = await callTool(ctx, 'bsub_fetch',
          { run_dir: staging, machine_id: settings.machine_id, includes: FETCH_INCLUDES },
          { timeoutMs: 300_000 })
        if (r.isError) {
          ok = false
          parts.push(`${topo}: fetch failed — ${String(r.text).slice(0, 200)}`)
          continue
        }
      } else {
        // none-mode: plain rw_download of the psf CSVs the remote parse produced
        const dir = remoteJoin(run._priv.remoteBase, run.id, topo)
        await fsp.mkdir(path.join(staging, 'psf'), { recursive: true })
        let got = 0
        for (let i = 0; i < 9; i++) {
          const name = `${String(i).padStart(2, '0')}_psf.csv`
          const dl = await downloadFile(ctx, agent, remoteJoin(dir, 'psf', name), path.join(staging, 'psf', name))
          if (dl.ok) got += 1
        }
        if (got !== 9) {
          ok = false
          parts.push(`${topo}: downloaded ${got}/9 psf CSVs`)
          continue
        }
      }
      const localJson = await runVerifyLocal(localLang, topo, staging)
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
  const { ctx, agent, settings } = run._priv

  // RN1 — upload the golden run trees + the verify flavors + the standalone
  // psf parser (spectre_psf_parse.py is stdlib-only, so it runs from the batch
  // dir without the whole scripts tree)
  const uploadStep = await timedStep(run, {
    section: 'remote', item: 'golden upload (rw_upload)', settingColumn: 'machine',
  }, async () => {
    checkBudget(run)
    let parserSrc
    try {
      parserSrc = path.join(simScriptsDir(), 'spectre', 'spectre_psf_parse.py')
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
        const up = await uploadFile(ctx, agent, local, remoteJoin(dir, rel))
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

function finalize(run) {
  run.status = 'done'
  run.finishedAt = new Date().toISOString()
  const localSteps = run.steps.filter((s) => s.section === 'local' && s.ms != null && s.ok !== null)
  const localOk = localSteps.every((s) => s.ok === true)
  let remote = 'skipped'
  if (run.scope.mode === 'remote') {
    const remoteSteps = run.steps.filter((s) => s.section === 'remote' && s.ms != null && s.ok !== null)
    // The PRIMARY submit/poll pair fails on purpose when the scheduler breaks and
    // the fallback attempt takes over — those failures must not sink the verdict
    // once the fallback completed the chain.
    const hardFailed = remoteSteps.some((s) => s.ok === false && s.attempt !== 'primary')
    if (hardFailed) remote = 'failed'
    else if (run._priv.viaFallback) remote = 'ok-via-fallback'
    else remote = remoteSteps.length ? 'ok' : 'failed'
  }
  run.summary = {
    local: localOk,
    remote,
    ok: localOk && remote !== 'failed',
    ...(run._priv.viaFallback ? { fallback: true } : {}),
  }
  const remaining = run.steps.filter((s) => s.ok === false && !run._priv.diagnosed.has(s))
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
}
