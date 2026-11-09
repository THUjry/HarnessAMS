// Project self-check tests (settings + orchestrator + verify assets + client
// contracts). Run: bare `node --test` from the repo root.
//
// The flows call startSelfcheck() DIRECTLY with a temp workspace config (the
// route-level ws discovery is global state; guards are covered separately) and
// drive a mock ctx.tools shell that:
//   - answers rw_* (dsh-remote) with scripted text — every rw_exec command is
//     bash -n validated here, same as server.test.mjs;
//   - runs the REAL bsub_* tools (makeTool(toolDefinitions(ctx))) so submit/
//     poll/fetch logic is exercised for real against the mocked remote;
//   - fakes the SmartAnaSim spectre_* boundary: assemble runs the real bundled
//     gen script, run_sweep copies the golden point trees + progress, parse
//     synthesizes the psf CSVs the real parser would emit;
//   - leaves the verify step REAL (python via runPython / js via import), so
//     the compute channels are tested with actual numbers.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { apply, toolDefinitions } from '../src/index.js'
import { makeTool } from '../src/tool.js'
import { defaultSettings, readSettings, validateSettings, writeSettings, settingsPath } from '../src/server/settings.js'
import { startSelfcheck, getSelfcheck, buildSelfcheckPrompt, GOLDEN_DIR } from '../src/server/selfcheck.js'
import { verifyRun, siValue } from '../src/scripts/selfcheck/selfcheck_verify.mjs'

const execFileAsync = promisify(execFile)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let bashAvailable = true
try { execFileSync('bash', ['--version'], { stdio: 'pipe' }) } catch { bashAvailable = false }
const rwExecCommands = []
function assertValidShell(cmd) {
  rwExecCommands.push(cmd)
  if (!bashAvailable) return
  execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'hams-selfcheck-'))
}

const R_VALS = ['1k', '2k', '5k']
const C_VALS = ['1n', '2n', '5n']
const SI = { k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 }
function si(text) {
  const low = String(text).toLowerCase()
  for (const [suf, factor] of Object.entries(SI)) {
    if (low.endsWith(suf)) return Number(low.slice(0, -suf.length)) * factor
  }
  return Number(low)
}
function freqGrid() {
  const n = Math.round(Math.log10(1e8 / 1e3) * 50) + 1
  return Array.from({ length: n }, (_, i) => 1e3 * 10 ** (i / 50))
}
function analytic(topo, freq, r, c) {
  const fc = 1 / (2 * Math.PI * r * c)
  const x = freq / fc
  return topo === 'lpf' ? [1 / (1 + x * x), -x / (1 + x * x)] : [x * x / (1 + x * x), x / (1 + x * x)]
}
function pointRC(index) {
  return [si(R_VALS[Math.floor(index / 3)]), si(C_VALS[index % 3]),
    R_VALS[Math.floor(index / 3)], C_VALS[index % 3]]
}

// Write a run-dir-shaped fixture: 9 point dirs with point_meta.json + psf CSVs
// in exactly the layout spectre_psf_parse.py --format csv produces.
async function writeVerifyFixture(dir, topo, { corrupt = false } = {}) {
  await fsp.mkdir(path.join(dir, 'psf'), { recursive: true })
  for (let i = 0; i < 9; i++) {
    const name = String(i).padStart(2, '0')
    const [r, c, rs, cs] = pointRC(i)
    await fsp.mkdir(path.join(dir, name), { recursive: true })
    await fsp.writeFile(path.join(dir, name, 'point_meta.json'),
      JSON.stringify({ point_index: i, point_name: name, simulator: 'spectre',
        params: { r_val: rs, c_val: cs }, status: 'success' }, null, 2) + '\n', 'utf8')
    const rows = ['point,signal,index,sweep_value,re,im']
    freqGrid().forEach((f, idx) => {
      let [re, im] = analytic(topo, f, r, c)
      if (corrupt && i === 3 && idx === 10) { re *= 1.05; im *= 1.05 }
      rows.push(`${name},ac_freq,${idx},,${f},`)
      rows.push(`${name},ac_vout,${idx},,${re},${im}`)
    })
    await fsp.writeFile(path.join(dir, 'psf', `${name}_psf.csv`), rows.join('\n') + '\n', 'utf8')
  }
}

function remoteVerifyJson(topo) {
  return {
    ok: true, topo, tolerance: 0.01, failed_points: 0, max_rel_err: 6.5e-7,
    points: Array.from({ length: 9 }, (_, i) => ({
      point: String(i).padStart(2, '0'), max_rel_err: 6.5e-7, pass: true,
    })),
  }
}

// A poll output the real bsub_poll parser accepts as "completed".
function pollText() {
  return '__BJOB__\n4242 DONE node5\n__META__\n9\n__DIRS__\n9\n__PROG__\n'
    + JSON.stringify({ status: 'completed', total_points: 9, succeeded: 9, failed: 0 })
    + '\n__ERR__\n\n[exit code: 0]'
}

// ---------------------------------------------------------------------------
// The mock ctx (tools shell + sessions + sessionController + registry)
// ---------------------------------------------------------------------------

function makeHarness({ scenario = {} }) {
  const execLog = []
  const uploads = []
  const downloads = []
  const scCalls = { create: [], prompt: [], rename: [] }
  let hangResolve = null

  const ctx = {} // filled below (toolDefinitions(ctx) needs ctx first for closures)
  const bsubTools = new Map()
  for (const def of toolDefinitions(ctx)) {
    if (def.name.startsWith('bsub_')) bsubTools.set(def.name, makeTool(def))
  }

  let hangStarted = false
  const spectre = {
    spectre_assemble: async (args) => {
      if (scenario.hangTool === 'spectre_assemble') {
        hangStarted = true
        await new Promise((res) => { hangResolve = res })
      }
      const gen = path.join(REPO, 'src', 'selfcheck', 'script', 'analysis', 'gen_selfcheck_rc.py')
      const { stdout } = await execFileAsync('python', [gen, '--out', path.resolve(args.out_dir)], { timeout: 60_000 })
      return { ok: true, output: stdout.trim(), project_dir: args.project_dir, simulator: 'spectre' }
    },
    spectre_run_sweep: async (args) => {
      if (scenario.hangTool === 'spectre_run_sweep') await new Promise((res) => { hangResolve = res })
      const topo = path.basename(path.resolve(args.run_dir))
      fs.cpSync(path.join(GOLDEN_DIR, topo), args.run_dir, { recursive: true })
      fs.writeFileSync(path.join(args.run_dir, 'sweep_progress.json'),
        JSON.stringify({ work_dir: args.run_dir, status: 'completed', total_points: 9,
          completed: 9, succeeded: 9, failed: 0, running: 0 }) + '\n', 'utf8')
      return { ok: true, output: '[sweep] done: 9 success / 0 partial / 0 failed in 1.0s', run_dir: args.run_dir, simulator: 'spectre' }
    },
    spectre_parse: async (args) => {
      if (scenario.parseFail) throw new Error('parse failed (mock)')
      const workDir = path.resolve(args.work_dir)
      const topo = path.basename(workDir)
      await writeVerifyFixture(workDir, topo, { corrupt: scenario.parseCorrupt === true })
      const points = Array.from({ length: 9 }, (_, i) => ({
        point: String(i).padStart(2, '0'), signals: ['ac_freq', 'ac_vout'],
      }))
      fs.writeFileSync(path.join(workDir, 'psf', 'psf_index.json'),
        JSON.stringify({ work_dir: workDir, points, errors: [] }) + '\n', 'utf8')
      return { ok: true, out_dir: path.join(workDir, 'psf'),
        summary: { work_dir: workDir, points }, output: '[psf] 9/9 point(s) parsed' }
    },
  }

  async function rwExec(command) {
    assertValidShell(command)
    if (command.includes('bsub -q')) {
      if (scenario.lsfSubmitFail) return { text: 'bsub: queue not available\n[exit code: 1]' }
      return { text: 'Job <4242> is submitted to queue <normal>\n[exit code: 0]' }
    }
    if (command.includes('spectre_sweep_worker.py')) {
      if (scenario.directRunFail) return { text: 'worker crashed\n[exit code: 2]' }
      return { text: '[sweep] done: 9 success / 0 partial / 0 failed\n[exit code: 0]' }
    }
    if (command.includes('__BJOB__')) {
      if (scenario.pollFail) return { text: 'bjobs: rejected\n[exit code: 255]' }
      return { text: pollText() }
    }
    if (command.includes('test -f errlog.txt')) {
      return { text: '__STARTED__\n[exit code: 0]' }
    }
    if (command.includes('spectre_psf_parse.py')) {
      if (scenario.remoteVerifyFail) return { text: 'remote python exploded\n[exit code: 1]' }
      const topo = /--topo (lpf|hpf)/.exec(command)?.[1] ?? 'lpf'
      return { text: `[selfcheck] ${JSON.stringify(remoteVerifyJson(topo))}\n[exit code: 0]` }
    }
    if (command.includes('wc -l')) return { text: '0\n[exit code: 0]' }
    if (command.includes('tar czf')) return { text: '1024\n[exit code: 0]' } // fetch pack (archive itself is garbage → extraction falls back)
    if (command.includes('head -200')) {
      // per-file fallback listing: point metas + psf CSVs
      const lines = []
      for (let i = 0; i < 9; i++) {
        const n = String(i).padStart(2, '0')
        lines.push(`./${n}/point_meta.json`, `./psf/${n}_psf.csv`)
      }
      return { text: lines.join('\n') + '\n[exit code: 0]' }
    }
    return { text: '[exit code: 0]' }
  }

  async function rwDownload(args) {
    downloads.push(args)
    const remote = String(args.path)
    const local = path.resolve(args.localPath)
    await fsp.mkdir(path.dirname(local), { recursive: true })
    if (remote.endsWith('.tgz')) {
      await fsp.writeFile(local, Buffer.from('not-a-real-tgz')) // forces the per-file fallback
      return { text: `downloaded ${remote}\n[exit code: 0]` }
    }
    const topo = /\/(lpf|hpf)(_|\b)/.exec(remote)?.[1] ?? 'lpf'
    if (remote.endsWith('point_meta.json')) {
      const index = Number(path.basename(path.dirname(remote)))
      const [, , rs, cs] = pointRC(index)
      await fsp.writeFile(local, JSON.stringify({ point_index: index,
        point_name: String(index).padStart(2, '0'), simulator: 'spectre',
        params: { r_val: rs, c_val: cs }, status: 'success' }) + '\n', 'utf8')
    } else if (remote.endsWith('_psf.csv')) {
      const index = Number(path.basename(remote).slice(0, 2))
      const [r, c] = pointRC(index)
      const rows = ['point,signal,index,sweep_value,re,im']
      freqGrid().forEach((f, idx) => {
        const [re, im] = analytic(topo, f, r, c)
        rows.push(`${String(index).padStart(2, '0')},ac_freq,${idx},,${f},`)
        rows.push(`${String(index).padStart(2, '0')},ac_vout,${idx},,${re},${im}`)
      })
      await fsp.writeFile(local, rows.join('\n') + '\n', 'utf8')
    } else if (remote.endsWith('sweep_progress.json')) {
      await fsp.writeFile(local, JSON.stringify({ status: 'completed', total_points: 9, succeeded: 9 }) + '\n', 'utf8')
    } else {
      await fsp.writeFile(local, '', 'utf8')
    }
    return { text: `downloaded ${remote}\n[exit code: 0]` }
  }

  const tools = {
    register: () => {},
    get: (name) => {
      if (name.startsWith('rw_')) return { name }
      if (bsubTools.has(name)) return bsubTools.get(name)
      if (spectre[name]) return { name }
      return undefined
    },
    execute: async (input) => {
      execLog.push(input)
      const name = input.name
      const args = input.arguments ?? {}
      if (name === 'rw_machines') {
        return { isError: false, value: { text: '- m1 "node1" [native] op@192.0.2.10:22\n  auth: key workspace=/home/op/sim' } }
      }
      if (name === 'rw_exec') {
        if (input.agent?.session?.header?.cwd == null) {
          return { isError: true, value: { text: 'session "undefined" is not live in this store' } }
        }
        const r = await rwExec(args.command)
        return { isError: false, value: { text: r.text } }
      }
      if (name === 'rw_upload') {
        uploads.push({ localPath: args.localPath, path: args.path })
        return { isError: false, value: { text: `uploaded 128 bytes to ${args.path}\n[exit code: 0]` } }
      }
      if (name === 'rw_download') {
        return { isError: false, value: { text: (await rwDownload(args)).text } }
      }
      if (spectre[name]) {
        try {
          const result = await spectre[name](args)
          return { isError: false, value: { text: JSON.stringify(result) } }
        } catch (e) {
          return { isError: true, value: { text: String(e?.message ?? e) } }
        }
      }
      if (bsubTools.has(name)) {
        try {
          const result = await bsubTools.get(name).execute(args, {})
          return { isError: false, value: { text: JSON.stringify(result) } }
        } catch (e) {
          return { isError: true, value: { text: String(e?.message ?? e) } }
        }
      }
      return { isError: true, value: { text: `${name} is not registered` } }
    },
  }

  Object.assign(ctx, {
    effect: (fn) => { fn() },
    webServer: { register: () => {} },
    tools,
    workspaceRegistry: { list: () => [] },
    get: (n) => {
      if (n === 'sessions') return { list: () => scenario.sessions ?? [] }
      if (n === 'sessionController') {
        return {
          create: async ({ workspaceId }) => { scCalls.create.push(workspaceId); return { sessionId: 'diag-' + (scCalls.create.length) } },
          prompt: async (req, signal) => { scCalls.prompt.push(req); signal?.throwIfAborted?.() },
          rename: async ({ sessionId, title }) => { scCalls.rename.push({ sessionId, title }) },
        }
      }
      return undefined
    },
    __execLog: execLog,
    __uploads: uploads,
    __downloads: downloads,
    __scCalls: scCalls,
    __waitHang: async () => { while (!hangStarted) await new Promise((r) => setTimeout(r, 10)) },
    __resolveHang: () => { const r = hangResolve; hangResolve = null; r?.() },
  })
  return ctx
}

// Mirror + registry setup for remote flows (DSH_HOME layout, like diagnose.test.mjs).
function setupRemoteEnv(tmp, ctx, sessionId, projectPath) {
  const prevHome = process.env.DSH_HOME
  const home = path.join(tmp, 'dshhome')
  const mirrorDir = path.join(home, 'remote-workspaces', 'h1', 'ws1')
  fs.mkdirSync(mirrorDir, { recursive: true })
  fs.writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'),
    JSON.stringify({ host: '192.0.2.10', port: 22, username: 'op', remotePath: '/home/op/sim' }))
  process.env.DSH_HOME = home
  ctx.workspaceRegistry.list = () => [
    { id: 'ws-local', path: projectPath, title: 'Local project', sessionIds: [sessionId] },
    { id: 'ws-remote', path: mirrorDir, title: 'node1 (remote)', sessionIds: ['sess-remote-1'] },
  ]
  return {
    mirrorDir,
    remotePath: '/home/op/sim',
    restore: () => { if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome },
  }
}

async function waitDone(runId, ws, timeoutMs = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const run = getSelfcheck(runId, ws)
    if (run?.status === 'done') return run
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('run did not finish; steps: ' + JSON.stringify(run?.steps?.map((s) => [s.item, s.ok])))
    }
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function waitDiagnoses(runId, ws, count, timeoutMs = 15_000) {
  const t0 = Date.now()
  for (;;) {
    const run = getSelfcheck(runId, ws)
    if ((run?.diagnoses ?? []).length >= count) return run
    if (Date.now() - t0 > timeoutMs) throw new Error(`expected ${count} diagnoses, got ${JSON.stringify(run?.diagnoses)}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function startFlow({ scenario = {}, settings = {}, sessions, remote = false }) {
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'project')
  const wsRoot = path.join(tmp, 'wsroot')
  await fsp.mkdir(projectPath, { recursive: true })
  await fsp.mkdir(wsRoot, { recursive: true })
  // worker scripts root for bsub (dummy tree; upload is mocked)
  const scriptsRoot = path.join(tmp, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# dummy worker\n')
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_psf_parse.py'), '# dummy parser\n')
  const prevScripts = process.env.HARNESSAMS_SIM_SCRIPTS_DIR
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot

  const ctx = makeHarness({ scenario })
  const sessionId = 'sess-1'
  const merged = { ...defaultSettings(), ...settings }
  await writeSettings(projectPath, merged)

  let env = null
  if (remote) {
    env = setupRemoteEnv(tmp, ctx, sessionId, projectPath)
    // one live session inside the machine's mirror unless the scenario overrides
    scenario.sessions = scenario.sessions ?? [{ id: 'sess-remote-1', header: { cwd: env.mirrorDir } }]
  } else {
    ctx.workspaceRegistry.list = () => [
      { id: 'ws-local', path: projectPath, title: 'Local project', sessionIds: [sessionId] },
    ]
  }
  const ws = { config: { workspace_root: wsRoot }, configPath: path.join(wsRoot, 'harnessams.json') }
  const start = await startSelfcheck(ctx, {
    sessionId,
    project: { id: 'ws-local', path: projectPath, title: 'Local project' },
    lang: 'en',
    ws,
    req: {},
  })
  const restoreAll = () => {
    env?.restore()
    if (prevScripts === undefined) delete process.env.HARNESSAMS_SIM_SCRIPTS_DIR
    else process.env.HARNESSAMS_SIM_SCRIPTS_DIR = prevScripts
  }
  return { ctx, start, ws, tmp, projectPath, restoreAll, sessionId }
}

// ---------------------------------------------------------------------------
// 1) settings
// ---------------------------------------------------------------------------

test('settings: defaults, validation, persistence', async () => {
  assert.deepEqual(defaultSettings(), {
    run_mode: 'local', machine_id: null, remote_dir: '.harnessams/selfcheck',
    scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
  })
  // valid full object round-trips
  const v = validateSettings({ ...defaultSettings(), run_mode: 'remote', machine_id: 'm1',
    remote_dir: '/abs/path', scheduler: 'none', compute_script_remote: 'js' })
  assert.ok(!v.error, v.error)
  assert.equal(v.settings.compute_script_remote, 'js')
  // enum + mode coupling guards
  assert.match(validateSettings({ ...defaultSettings(), simulator: 'ngspice' }).error, /simulator must be one of/)
  assert.match(validateSettings({ ...defaultSettings(), run_mode: 'remote' }).error, /run_mode=remote requires machine_id/)
  assert.match(validateSettings({ ...defaultSettings(), remote_dir: 'a/../b' }).error, /must not contain/)

  const tmp = await tmpDir()
  const missing = await readSettings(tmp)
  assert.equal(missing.settings.run_mode, 'local') // missing file = defaults
  await writeSettings(tmp, v.settings)
  const back = await readSettings(tmp)
  assert.equal(back.settings.machine_id, 'm1')
  assert.equal(back.settings.compute_script_remote, 'js')
  // local mode keeps remote fields stored
  const local = validateSettings({ ...v.settings, run_mode: 'local' })
  assert.ok(!local.error)
  assert.equal(local.settings.machine_id, 'm1')
  // hand-edited junk falls back per-key instead of breaking the Overview
  await fsp.writeFile(settingsPath(tmp), '{"run_mode":"bogus","machine_id":"x"}', 'utf8')
  const dirty = await readSettings(tmp)
  assert.equal(dirty.settings.run_mode, 'local')
  assert.equal(dirty.settings.machine_id, 'x')
})

// ---------------------------------------------------------------------------
// 2) gen script + golden grid consistency
// ---------------------------------------------------------------------------

test('gen script emits the 3x3 tb for both topos (grid matches golden)', async () => {
  const tmp = await tmpDir()
  const out = path.join(tmp, 'out')
  const gen = path.join(REPO, 'src', 'selfcheck', 'script', 'analysis', 'gen_selfcheck_rc.py')
  const { stdout } = await execFileAsync('python', [gen, '--out', out], { timeout: 60_000 })
  assert.match(stdout, /9 points per topology/)
  for (const topo of ['lpf', 'hpf']) {
    const tpl = await fsp.readFile(path.join(out, topo, 'template.scs'), 'utf8')
    assert.match(tpl, /^simulator lang=spectre$/m)
    assert.doesNotMatch(tpl, /^\./m) // no SPICE dot directives (.ac/.tran/…)
    assert.match(tpl, /vsource dc=0 mag=1/)
    assert.match(tpl, /save vout/)
    assert.match(tpl, /ac ac start=1e\+?0?3 stop=1e\+?0?8 dec=50/)
    assert.match(tpl, /@@r_val@@/)
    assert.match(tpl, /@@c_val@@/)
    if (topo === 'lpf') assert.match(tpl, /R1 \(vin vout\) resistor/) // series R first = LPF
    else assert.match(tpl, /C1 \(vin vout\) capacitor/) // series C first = HPF
    const cfg = JSON.parse(await fsp.readFile(path.join(out, topo, 'sweep_config.json'), 'utf8'))
    assert.deepEqual(cfg.parameters, { r_val: ['1k', '2k', '5k'], c_val: ['1n', '2n', '5n'] })
    assert.equal(cfg.netlist_template, 'template.scs')
    // golden point metas cover the exact same 3x3 grid
    for (let i = 0; i < 9; i++) {
      const meta = JSON.parse(await fsp.readFile(
        path.join(GOLDEN_DIR, topo, String(i).padStart(2, '0'), 'point_meta.json'), 'utf8'))
      const rIdx = Math.floor(i / 3)
      assert.deepEqual(meta.params, { r_val: cfg.parameters.r_val[rIdx], c_val: cfg.parameters.c_val[i % 3] })
    }
  }
})

// ---------------------------------------------------------------------------
// 3) golden byte-stability
// ---------------------------------------------------------------------------

test('golden dataset regenerates byte-identically', async () => {
  const tmp = await tmpDir()
  await execFileAsync('python', [path.join(REPO, 'tests', 'golden_gen.py'), '--out', tmp], { timeout: 60_000 })
  async function compare(a, b) {
    const sa = await fsp.stat(a)
    const sb = await fsp.stat(b)
    if (sa.isDirectory()) {
      const ea = (await fsp.readdir(a)).sort()
      const eb = (await fsp.readdir(b)).sort()
      assert.deepEqual(ea, eb, `dir listing differs: ${a}`)
      for (const n of ea) await compare(path.join(a, n), path.join(b, n))
    } else {
      assert.deepEqual(await fsp.readFile(a), await fsp.readFile(b), `file differs: ${a}`)
    }
  }
  await compare(tmp, GOLDEN_DIR)
})

// ---------------------------------------------------------------------------
// 4) golden through the REAL SmartAnaSim parser (when the sibling repo exists)
// ---------------------------------------------------------------------------

test('golden parses with the real spectre_psf_parse.py and verifies clean', async (t) => {
  const parser = path.resolve(REPO, '..', 'HarnessAMS-SmartAnaSim', 'scripts', 'spectre', 'spectre_psf_parse.py')
  if (!fs.existsSync(parser)) return t.skip('sibling SmartAnaSim repo not present')
  const tmp = await tmpDir()
  for (const topo of ['lpf', 'hpf']) {
    const run = path.join(tmp, topo)
    fs.cpSync(path.join(GOLDEN_DIR, topo), run, { recursive: true })
    const { stdout } = await execFileAsync('python', [parser, '--work-dir', run, '--format', 'csv'], { timeout: 60_000 })
    assert.match(stdout, new RegExp(`9/9 point\\(s\\) parsed`))
    const index = JSON.parse(await fsp.readFile(path.join(run, 'psf', 'psf_index.json'), 'utf8'))
    assert.deepEqual(index.points[0].signals.sort(), ['ac_freq', 'ac_vout'])
    const py = await execFileAsync('python',
      [path.join(REPO, 'src', 'scripts', 'selfcheck', 'selfcheck_verify.py'), '--run-dir', run, '--topo', topo])
    const pyJson = JSON.parse(py.stdout.split(/\r?\n/).filter((l) => l.startsWith('[selfcheck] ')).pop().slice(12))
    assert.equal(pyJson.ok, true)
    assert.equal(pyJson.points.length, 9)
    const js = verifyRun(run, topo)
    assert.equal(js.ok, true)
    assert.ok(Math.abs(js.max_rel_err - pyJson.max_rel_err) < 1e-9)
  }
})

// ---------------------------------------------------------------------------
// 5) verify channels: python CLI / node CLI / in-process agree; drift fails
// ---------------------------------------------------------------------------

test('verify: three channels agree; a >1% drift fails', async () => {
  const good = await tmpDir()
  await writeVerifyFixture(good, 'lpf')
  const js = verifyRun(good, 'lpf')
  assert.equal(js.ok, true)
  assert.equal(js.points.length, 9)
  assert.ok(js.max_rel_err < 1e-9)

  const py = await execFileAsync('python',
    [path.join(REPO, 'src', 'scripts', 'selfcheck', 'selfcheck_verify.py'), '--run-dir', good, '--topo', 'lpf'])
  const pyJson = JSON.parse(py.stdout.split(/\r?\n/).filter((l) => l.startsWith('[selfcheck] ')).pop().slice(12))
  const node = await execFileAsync(process.execPath,
    [path.join(REPO, 'src', 'scripts', 'selfcheck', 'selfcheck_verify.mjs'), '--run-dir', good, '--topo', 'lpf'])
  const nodeJson = JSON.parse(node.stdout.split(/\r?\n/).filter((l) => l.startsWith('[selfcheck] ')).pop().slice(12))
  // worst_freq_hz is noise-driven when every error sits at 1e-16 (the analytic
  // fixture) — normalize it away below the noise floor before comparing.
  const round = (j) => ({ ...j, points: j.points.map((p) => ({ ...p,
    max_rel_err: Math.round(p.max_rel_err * 1e12), fc_hz: Math.round(p.fc_hz * 1e6),
    worst_freq_hz: p.max_rel_err < 1e-12 ? null : Math.round(p.worst_freq_hz * 1e6) })),
    max_rel_err: Math.round(j.max_rel_err * 1e12) })
  assert.deepEqual(round(pyJson), round(js))
  assert.deepEqual(round(nodeJson), round(js))

  const bad = await tmpDir()
  await writeVerifyFixture(bad, 'hpf', { corrupt: true })
  const badJs = verifyRun(bad, 'hpf')
  assert.equal(badJs.ok, false)
  assert.equal(badJs.failed_points, 1)
  assert.equal(badJs.points[3].pass, false)
  // usage error → exit 2
  const rc = await execFileAsync('python',
    [path.join(REPO, 'src', 'scripts', 'selfcheck', 'selfcheck_verify.py'), '--run-dir', path.join(bad, 'nope'), '--topo', 'lpf'])
    .then(() => 0, (e) => e.code)
  assert.equal(rc, 2)
})

// ---------------------------------------------------------------------------
// 6) routes: project-settings + selfcheck guards
// ---------------------------------------------------------------------------

function fakeRes() {
  return { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b ?? '') } }
}
async function driveRoute(routes, req) {
  const res = fakeRes()
  await routes[0].handler(req, res)
  for (let i = 0; i < 200 && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(res.code, 'route never responded')
  return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
}
const getReq = (url) => ({ method: 'GET', url, headers: {} })

test('routes: project-settings GET/PUT happy path + guards', async () => {
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'proj')
  await fsp.mkdir(projectPath, { recursive: true })
  const ctx = makeHarness({})
  ctx.workspaceRegistry.list = () => [{ id: 'ws1', path: projectPath, title: 'P', sessionIds: ['s1'] }]
  const routes = []
  ctx.webServer.register = (r) => routes.push(r)
  await apply(ctx)

  const ok = await driveRoute(routes, getReq('/harnessams/api/project-settings?sessionId=s1'))
  assert.equal(ok.code, 200)
  assert.equal(ok.body.settings.run_mode, 'local') // defaults

  const put = await driveRoute(routes, {
    method: 'PUT', url: '/harnessams/api/project-settings?sessionId=s1', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...defaultSettings(), run_mode: 'remote', machine_id: 'm1' })) },
  })
  assert.equal(put.code, 200)
  assert.equal(put.body.settings.machine_id, 'm1')
  assert.equal((await readSettings(projectPath)).settings.scheduler, 'lsf')

  const badPut = await driveRoute(routes, {
    method: 'PUT', url: '/harnessams/api/project-settings?sessionId=s1', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"run_mode":"nope"}') },
  })
  assert.equal(badPut.code, 400)

  const noSession = await driveRoute(routes, getReq('/harnessams/api/project-settings?sessionId=zzz'))
  assert.equal(noSession.code, 404)

  const noRun = await driveRoute(routes, getReq('/harnessams/api/selfcheck?id=ghost-run'))
  assert.equal(noRun.code, 404) // unknown run id: 404 regardless of real runs on disk (hermetic)
})

test('route: selfcheck POST rejects unknown session / remote project', async () => {
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'proj')
  await fsp.mkdir(projectPath, { recursive: true })
  const ctx = makeHarness({})
  const routes = []
  ctx.webServer.register = (r) => routes.push(r)
  await apply(ctx)

  const body = (obj) => ({
    method: 'POST', url: '/harnessams/api/selfcheck', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)) },
  })

  const unknown = await driveRoute(routes, body({ sessionId: 'ghost' }))
  assert.equal(unknown.code, 404)

  // remote project: the session belongs to the workspace inside a dsh-remote mirror
  const env = setupRemoteEnv(tmp, ctx, 's1', projectPath)
  try {
    const remote = await driveRoute(routes, body({ sessionId: 'sess-remote-1' }))
    assert.equal(remote.code, 400)
    assert.match(remote.body.error, /local project/)
  } finally {
    env.restore()
  }
})

// ---------------------------------------------------------------------------
// 7) flows
// ---------------------------------------------------------------------------

test('flow: simulator=none + local (python compute)', async () => {
  const f = await startFlow({ settings: { simulator: 'none' } })
  try {
    assert.ok(f.start.runId, f.start.error)
    const run = await waitDone(f.start.runId, f.ws)
    assert.equal(run.summary.ok, true)
    assert.equal(run.summary.remote, 'skipped')
    const items = run.steps.map((s) => [s.item, s.ok])
    assert.deepEqual(items.map((x) => x[0]), [
      'SmartAnaSim tool registration', 'Settings validation', 'golden dataset load',
      'spectre_parse (golden)', 'pointwise verify (python, LPF+HPF)',
    ])
    assert.ok(items.every(([, ok]) => ok === true), JSON.stringify(items))
    // local-only: not a single rw_* call happened
    assert.equal(f.ctx.__execLog.filter((x) => x.name.startsWith('rw_')).length, 0)
    // artifacts landed under the workspace selfcheck root
    assert.ok(fs.existsSync(path.join(run.runDir, 'lpf', 'psf', '00_psf.csv')))
    assert.ok(fs.existsSync(path.join(run.runDir, 'selfcheck_run.json')))
  } finally { f.restoreAll() }
})

test('flow: simulator=none + local (js compute)', async () => {
  const f = await startFlow({ settings: { simulator: 'none', compute_script_local: 'js' } })
  try {
    const run = await waitDone(f.start.runId, f.ws)
    assert.equal(run.summary.ok, true)
    const verify = run.steps.find((s) => s.settingColumn === 'compute_local')
    assert.equal(verify.ok, true)
    assert.match(verify.item, /\(js, /)
  } finally { f.restoreAll() }
})

test('flow: simulator=spectre + local', async () => {
  const f = await startFlow({})
  try {
    const run = await waitDone(f.start.runId, f.ws)
    assert.equal(run.summary.ok, true)
    const byCol = {}
    for (const s of run.steps) byCol[s.item] = s
    assert.equal(byCol['spectre_assemble (RC tb)'].ok, true)
    assert.equal(byCol['spectre_run_sweep LPF (9 pts)'].ok, true)
    assert.equal(byCol['spectre_run_sweep HPF (9 pts)'].ok, true)
    assert.equal(byCol['spectre_parse (LPF+HPF)'].ok, true)
    assert.equal(byCol['pointwise verify (python, LPF+HPF)'].ok, true)
    assert.match(byCol['pointwise verify (python, LPF+HPF)'].result, /9 pts/)
    // the assemble step really ran the bundled gen script through the tool shell
    const asm = f.ctx.__execLog.find((x) => x.name === 'spectre_assemble')
    assert.ok(asm, 'spectre_assemble was not called through ctx.tools')
    assert.ok(asm.arguments.project_dir.endsWith(path.join('project')))
  } finally { f.restoreAll() }
})

test('flow: spectre + remote — LSF fails → diagnosis + fallback(none) passes', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'm1', scheduler: 'lsf', compute_script_remote: 'js' },
    scenario: { lsfSubmitFail: true },
    remote: true,
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    await waitDone(f.start.runId, f.ws)
    const run = await waitDiagnoses(f.start.runId, f.ws, 1)
    assert.equal(run.summary.remote, 'ok-via-fallback')
    assert.equal(run.summary.ok, true)

    // scheduler column: primary failed, fallback passed with a warn note
    const schedSteps = run.steps.filter((s) => s.settingColumn === 'scheduler')
    assert.equal(schedSteps.length, 4) // submit+poll × (lsf, none fallback)
    assert.ok(schedSteps[0].ok === false)
    assert.ok(schedSteps.some((s) => s.warn && /fallback/.test(s.warn)))
    const compRemote = run.steps.filter((s) => s.settingColumn === 'compute_remote')
    assert.ok(compRemote.every((s) => s.ok === true))

    // diagnosis #1 fired for the scheduler cluster before the fallback
    assert.equal(f.ctx.__scCalls.create.length, 1)
    const prompt = f.ctx.__scCalls.prompt[0].content[0].text
    assert.match(prompt, /project self-check/)
    assert.match(prompt, /scheduler=lsf/)
    assert.match(prompt, /bsub_submit/)
    assert.match(prompt, /Answer in English\./)
    assert.equal(f.ctx.__scCalls.rename[0].title, 'HarnessAMS diagnosis: selfcheck @ node1')

    // every rw_exec command went through bash -n and the borrow discipline
    const execs = f.ctx.__execLog.filter((x) => x.name === 'rw_exec')
    assert.ok(execs.length > 0)
    for (const e of execs) {
      assert.equal(e.arguments.promoteOnTimeout, false)
      assert.equal(typeof e.agent?.session?.header?.cwd, 'string')
      assert.ok(e.callId && e.signal instanceof AbortSignal)
    }
    // remote compute chose node for the js channel
    const verifyCmd = rwExecCommands.find((c) => c.includes('selfcheck_verify.mjs'))
    assert.ok(verifyCmd, 'remote js verify command missing: ' + JSON.stringify(rwExecCommands))
    assert.match(verifyCmd, /"?node"?\s+\.\/selfcheck_verify\.mjs --run-dir \. --topo (lpf|hpf)/)

    // R4 cross-check ran the local python verify on fetched artifacts
    assert.ok(f.ctx.__downloads.some((d) => /_psf\.csv$/.test(d.path)))
  } finally { f.restoreAll() }
})

test('flow: spectre + remote — fallback also fails → final diagnosis covers the rest', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'm1', scheduler: 'lsf' },
    scenario: { lsfSubmitFail: true, directRunFail: true },
    remote: true,
  })
  try {
    await waitDone(f.start.runId, f.ws)
    const run = await waitDiagnoses(f.start.runId, f.ws, 2)
    assert.equal(run.summary.remote, 'failed')
    assert.equal(run.summary.ok, false)
    const triggers = run.diagnoses.map((d) => d.trigger).sort()
    assert.deepEqual(triggers, ['final', 'remote-scheduler'])
    // R3/R4 recorded as skipped (batch failed), not silent
    const skipped = run.steps.filter((s) => s.ok === null)
    assert.ok(skipped.length >= 2)
    assert.ok(skipped.some((s) => /remote parse \+ verify/.test(s.item)))
    assert.equal(run.diagnoses.every((d) => d.status === 'done'), true)
  } finally { f.restoreAll() }
})

test('flow: none + remote — upload, remote compute (python), download + js cross-check', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'm1', simulator: 'none', compute_script_local: 'js' },
    remote: true,
  })
  try {
    const run = await waitDone(f.start.runId, f.ws)
    assert.equal(run.summary.ok, true, JSON.stringify(run.steps.map((s) => [s.item, s.ok, s.result])))
    const uploads = f.ctx.__uploads
    // per topo: 18 golden files + 2 verify scripts + 1 parser = 21
    assert.equal(uploads.length, 42)
    const PREFIX = '/home/op/sim/.harnessams/selfcheck/rc_'
    assert.ok(uploads.every((u) => u.path.startsWith(PREFIX)),
      'unexpected upload paths: ' + JSON.stringify(uploads.filter((u) => !u.path.startsWith(PREFIX)).map((u) => u.path)))
    assert.ok(uploads.some((u) => u.path.endsWith('/spectre_psf_parse.py')))
    // remote verify command used python for compute_script_remote=python
    const verifyCmd = rwExecCommands.find((c) => c.includes('selfcheck_verify.py'))
    assert.ok(verifyCmd)
    assert.match(verifyCmd, /\.\/spectre_psf_parse\.py --work-dir \. --format csv/)
    // downloads: 9 CSVs per topo
    assert.equal(f.ctx.__downloads.filter((d) => /_psf\.csv$/.test(d.path)).length, 18)
    const cross = run.steps.find((s) => /artifact download/.test(s.item))
    assert.equal(cross.ok, true)
    assert.match(cross.result, /local js/)
  } finally { f.restoreAll() }
})

test('flow: remote verify failure skips the cross-check step', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'm1', simulator: 'none' },
    scenario: { remoteVerifyFail: true },
    remote: true,
  })
  try {
    const run = await waitDone(f.start.runId, f.ws)
    assert.equal(run.summary.ok, false)
    const cross = run.steps.find((s) => /artifact download/.test(s.item))
    assert.equal(cross.ok, null) // skipped, not failed
    assert.match(cross.skipReason, /remote verify failed/)
  } finally { f.restoreAll() }
})

// ---------------------------------------------------------------------------
// 8) start guards + re-entry
// ---------------------------------------------------------------------------

test('start guards: unknown machine / no remote project / no live session', async () => {
  const f1 = await startFlow({ settings: { run_mode: 'remote', machine_id: 'nope' }, remote: true })
  try {
    assert.equal(f1.start.code, 404)
  } finally { f1.restoreAll() }

  // machine exists but no workspace registered inside its mirror → 409
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'project')
  await fsp.mkdir(projectPath, { recursive: true })
  const ctx = makeHarness({})
  const env = setupRemoteEnv(tmp, ctx, 's1', projectPath)
  try {
    ctx.workspaceRegistry.list = () => [{ id: 'ws-local', path: projectPath, title: 'P', sessionIds: ['s1'] }]
    await writeSettings(projectPath, { ...defaultSettings(), run_mode: 'remote', machine_id: 'm1' })
    const r = await startSelfcheck(ctx, {
      sessionId: 's1', project: { id: 'ws-local', path: projectPath, title: 'P' }, lang: 'en',
      ws: { config: { workspace_root: path.join(tmp, 'wsroot') } }, req: {},
    })
    assert.equal(r.code, 409)
    assert.match(r.error, /no remote project/)

    // remote project registered but no live session in it → 409
    ctx.workspaceRegistry.list = () => [
      { id: 'ws-local', path: projectPath, title: 'P', sessionIds: ['s1'] },
      { id: 'ws-remote', path: env.mirrorDir, title: 'R', sessionIds: [] },
    ]
    const r2 = await startSelfcheck(ctx, {
      sessionId: 's1', project: { id: 'ws-local', path: projectPath, title: 'P' }, lang: 'en',
      ws: { config: { workspace_root: path.join(tmp, 'wsroot') } }, req: {},
    })
    assert.equal(r2.code, 409)
    assert.match(r2.error, /no live session/)
  } finally { env.restore() }
})

test('re-entry: a second start while running gets 409', async () => {
  const f = await startFlow({ scenario: { hangTool: 'spectre_assemble' } })
  try {
    assert.ok(f.start.runId)
    const second = await startSelfcheck(f.ctx, {
      sessionId: f.sessionId,
      project: { id: 'ws-local', path: f.projectPath, title: 'P' },
      lang: 'en', ws: f.ws, req: {},
    })
    assert.equal(second.code, 409)
    assert.match(second.error, /already running/)
    await f.ctx.__waitHang()
    f.ctx.__resolveHang()
    const run = await waitDone(f.start.runId, f.ws)
    assert.equal(run.status, 'done')
  } finally { f.restoreAll() }
})

// ---------------------------------------------------------------------------
// 9) prompt builder + client static contract
// ---------------------------------------------------------------------------

test('buildSelfcheckPrompt: english body, artifacts pointer, answer-language line', () => {
  const p = buildSelfcheckPrompt({
    scope: { mode: 'remote', simulator: 'none', scheduler: null, compute_local: 'js', compute_remote: 'python' },
    runDir: 'C:/ws/selfcheck/rc_x',
    machine: { name: 'node1', host: '192.0.2.10', port: 22, username: 'op' },
    remotePath: '/home/op/sim', mirrorDir: 'C:/mirror', projectTitle: 'P',
    failed: [{ section: 'remote', item: 'golden upload', ok: false, ms: 5, result: 'upload failed', detail: 'x'.repeat(3000) }],
    lang: 'zh',
  })
  assert.match(p, /diagnostic agent of the HarnessAMS workbench/)
  assert.match(p, /mode=remote simulator=none/)
  assert.match(p, /Run artifacts: C:\/ws\/selfcheck\/rc_x/)
  assert.match(p, /Remote workspace path: \/home\/op\/sim/)
  assert.ok(p.length < 6000) // sanitize caps held
  assert.match(p, /Answer in Chinese\./)
})

// ---------------------------------------------------------------------------
// 10) persist serialization (regression: fire-and-forget persistRun calls used
// to share selfcheck_run.json.tmp and could publish a corrupted concatenated
// document — live-verified 2/7 runs before the per-run persist chain)
// ---------------------------------------------------------------------------

test('persist serialization: status file stays valid JSON through a run and matches the final verdict', async () => {
  const serverSrc = await fsp.readFile(path.join(REPO, 'src', 'server', 'selfcheck.js'), 'utf8')
  assert.ok(serverSrc.includes('run._persistChain'), 'persists must serialize through a per-run chain')
  const f = await startFlow({ settings: { simulator: 'none' } })
  try {
    assert.ok(f.start.runId, f.start.error)
    const file = path.join(f.ws.config.workspace_root, 'selfcheck', f.start.runId, 'selfcheck_run.json')
    let corrupt = null
    // hammer the status file while the orchestrator writes it: every published
    // snapshot must parse as a complete JSON document (tmp+rename is the only
    // publish path, and the per-run chain keeps two writes from interleaving)
    const t0 = Date.now()
    while (Date.now() - t0 < 30_000) {
      const live = getSelfcheck(f.start.runId, f.ws)
      if (live?.status === 'done') break
      let raw
      try { raw = fs.readFileSync(file) } catch { /* not published yet */ }
      if (raw) {
        try { JSON.parse(raw.toString('utf8')) } catch (e) { corrupt = corrupt ?? e }
      }
      await new Promise((r) => setTimeout(r, 2))
    }
    // let the final queued write drain, then the file must equal the verdict
    await new Promise((r) => setTimeout(r, 300))
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(disk.status, 'done')
    assert.equal(disk.summary.ok, true)
    assert.ifError(corrupt)
  } finally { f.restoreAll() }
})

test('client static contract: keys bilingual, endpoints wired, two-row table, poll', async () => {
  const src = await fsp.readFile(path.join(REPO, 'src', 'client.js'), 'utf8')
  const keys = [
    'pset.title', 'pset.dirLabel', 'pset.dirLocalHint', 'pset.dirRemoteRel', 'pset.browse',
    'pset.browseTitle', 'pset.browseNoMirror', 'pset.browseUp', 'pset.browseHere',
    'pset.currentMirrorDir', 'pset.pickSubdir', 'pset.colMode', 'pset.colMachine', 'pset.colSched',
    'pset.colSim', 'pset.colCompLocal', 'pset.colCompRemote', 'pset.mode.local', 'pset.mode.remote',
    'pset.sched.lsf', 'pset.sched.none', 'pset.sim.spectre', 'pset.sim.none', 'pset.comp.python',
    'pset.comp.js', 'pset.noMachine', 'pset.saveFailed',
    'selfchk.title', 'selfchk.desc', 'selfchk.run', 'selfchk.running', 'selfchk.startFailed',
    'selfchk.scopeLocal', 'selfchk.scopeRemote', 'selfchk.noneYet', 'selfchk.skipped',
    'selfchk.summaryOk', 'selfchk.summaryFallback', 'selfchk.summaryFail', 'selfchk.diagDone', 'selfchk.diagFail',
  ]
  for (const k of keys) {
    assert.equal(src.split(`'${k}':`).length - 1, 2, `key '${k}' must appear exactly twice (zh+en)`)
  }
  assert.ok(src.includes("API + '/project-settings?"), 'client must call /api/project-settings')
  assert.ok(src.includes("API + '/selfcheck'"), 'client must call /api/selfcheck')
  assert.ok(src.includes('function ProjectSelfcheck('))
  assert.ok(src.includes('function SettingsTable('))
  assert.ok(src.includes('function RemoteDirBrowse('))
  assert.ok(src.includes('function SelfcheckSteps('))
  assert.ok(src.includes('SETTING_COLS'), 'column config drives the two-row table')
  assert.ok(src.includes('h(ProjectSelfcheck, { sessionId, info: checksInfo })'), 'mounted in the Overview')
  assert.ok(src.includes('}, 3_000)'), '3s poll while running')
  assert.ok(src.includes("'local'"), 'local dir display branch')
  // remote-switch auto-pick: the machine column only renders in remote mode, so
  // without this the mode switch PUT-400s and rolls back — remote unreachable
  assert.ok(src.includes("value === 'remote' && !next.machine_id && machines.length"),
    'remote switch must auto-pick a machine when none is set')
  assert.ok(src.includes('next.machine_id = machines[0].id'), 'auto-pick assigns machines[0].id')
})
