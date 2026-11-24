// Project self-check tests (settings + orchestrator + verify assets + client
// contracts). Run: bare `node --test` from the repo root.
//
// The flows call startSelfcheck() DIRECTLY with a temp project (runs live under
// <project>/.harnessams/selfcheck since the 2026-11-19 storage fix) and drive a
// mock ctx.tools shell that:
//   - answers ssh_* (@linxin666/dsh-ssh) with scripted structured values —
//     every ssh_exec command (wrapped in `timeout -s KILL ... sh -c "…"`)
//     is bash -n validated here, same as server.test.mjs;
//   - runs the REAL batch_* tools (makeTool(toolDefinitions(ctx))) so submit/
//     poll logic is exercised for real against the mocked remote; local
//     submissions (scheduler=local) are intercepted to lay down the worker's
//     output + job file, which the REAL batch_poll local branch then reads;
//   - fakes the SmartAnaSim boundary at assemble only (real bundled gen
//     script); parsing is script-face since 2026-11-23 — the parse step runs
//     the fixture parser written into the dummy scripts root, which emits the
//     analytic psf CSVs the real parser would produce;
//   - leaves the verify step REAL (python via runPython / js via import), so
//     the compute channels are tested with actual numbers.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { apply, toolDefinitions } from '../src/index.js'
import { makeTool } from '../src/tool.js'
import { defaultSettings, readSettings, validateSettings, writeSettings, configPath } from '../src/server/settings.js'
import { startSelfcheck, stopSelfcheck, getSelfcheck, buildSelfcheckPrompt, GOLDEN_DIR } from '../src/server/selfcheck.js'
import { runSelfcheckAction } from '../src/tools/selfcheck.js'
import { verifyRun, siValue } from '../src/scripts/selfcheck/selfcheck_verify.mjs'
import { assertValidShell, callRoute, getReq, clientSrc, assertDictKeys } from './helpers.mjs'

const execFileAsync = promisify(execFile)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const rwExecCommands = []
function guardShell(cmd) {
  // cmd arrives wrapped by execRemote (timeout -s KILL … sh -c "<cmd>") —
  // validate the wrapper as-is, record it flattened for the payload assertions.
  assertValidShell(cmd)
  rwExecCommands.push(String(cmd).replace(/\\"/g, '"'))
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

// A poll output the real batch_poll parser accepts as "completed".
function pollText() {
  return '__BJOB__\n4242 DONE node5\n__META__\n9\n__DIRS__\n9\n__PROG__\n'
    + JSON.stringify({ status: 'completed', total_points: 9, succeeded: 9, failed: 0 })
    + '\n__ERR__\n'
}

// ---------------------------------------------------------------------------
// The mock ctx (tools shell + sessions + sessionController + registry)
// ---------------------------------------------------------------------------

function makeHarness({ scenario = {} }) {
  const execLog = []
  const uploads = []
  const downloads = []
  const localCommands = []
  const scCalls = { create: [], prompt: [], rename: [] }
  let hangResolve = null
  let pollCalls = 0
  let hangUsed = false

  const ctx = {} // filled below (toolDefinitions(ctx) needs ctx first for closures)
  const batchTools = new Map()
  for (const def of toolDefinitions(ctx)) {
    if (def.name.startsWith('batch_')) batchTools.set(def.name, makeTool(def))
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
  }

  // ssh_exec behavior script: commands arrive wrapped by execRemote; routing
  // matches substrings inside the wrapper and answers with structured values.
  // `record`=false serves the ctx.shell mock (same routing, no rw_* recording:
  // a raw local command must not pollute the wrapper-shaped assertion log).
  async function sshExec(command, { record = true } = {}) {
    if (record) guardShell(command)
    if (command.includes('bsub -q')) {
      if (scenario.lsfSubmitFail) return { success: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'bsub: queue not available\n', durationMs: 3 }
      return { success: true, exitCode: 0, timedOut: false, stdout: 'Job <4242> is submitted to queue <normal>\n', stderr: '', durationMs: 3 }
    }
    if (command.includes('spectre_sweep_worker.py')) {
      if (scenario.sshRunFail) return { success: false, exitCode: 2, timedOut: false, stdout: '', stderr: 'worker crashed\n', durationMs: 3 }
      return { success: true, exitCode: 0, timedOut: false, stdout: '[sweep] done: 9 success / 0 partial / 0 failed\n', stderr: '', durationMs: 3 }
    }
    if (command.includes('__BJOB__')) {
      if (scenario.pollFail) return { success: false, exitCode: 255, timedOut: false, stdout: 'bjobs: rejected\n', stderr: '', durationMs: 3 }
      pollCalls += 1
      // scripted incomplete rounds: exercise the pollStep live-progress text
      if (scenario.pollRounds && pollCalls < scenario.pollRounds) {
        return { success: true, exitCode: 0, timedOut: false, stdout: '__BJOB__\n4242 RUN node5\n__META__\n3\n__DIRS__\n3\n__PROG__\n'
          + JSON.stringify({ status: 'running', total_points: 9, succeeded: 3, failed: 0, completed: 3 })
          + '\n__ERR__\n', stderr: '', durationMs: 3 }
      }
      if (scenario.hangPoll && !hangUsed) {
        hangUsed = true
        hangStarted = true
        await new Promise((res) => { hangResolve = res })
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: pollText(), stderr: '', durationMs: 3 }
    }
    if (command.includes('bkill ')) {
      return { success: true, exitCode: 0, timedOut: false, stdout: 'Job <4242> is being terminated\n', stderr: '', durationMs: 3 }
    }
    if (command.includes('test -f errlog.txt')) {
      return { success: true, exitCode: 0, timedOut: false, stdout: '__STARTED__\n', stderr: '', durationMs: 3 }
    }
    if (command.includes('spectre_psf_parse.py')) {
      if (scenario.remoteVerifyFail) return { success: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'remote python exploded\n', durationMs: 3 }
      const topo = /--topo (lpf|hpf)/.exec(command)?.[1] ?? 'lpf'
      return { success: true, exitCode: 0, timedOut: false, stdout: `[selfcheck] ${JSON.stringify(remoteVerifyJson(topo))}\n`, stderr: '', durationMs: 3 }
    }
    if (command.includes('wc -l')) return { success: true, exitCode: 0, timedOut: false, stdout: '0\n', stderr: '', durationMs: 3 }
    return { success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 3 }
  }

  // The official ctx.shell seam (in-cluster local execution, D-002): routes
  // the SAME command script as sshExec — but as the raw command, no
  // `timeout -s KILL` wrapper — and, because the "remote" side is this host's
  // filesystem, physically lays down the artifacts the transfers then copy:
  // the parse branch writes the worker's psf output into the run dir, the poll
  // branch writes sweep_progress.json.
  async function shellExec(command) {
    localCommands.push(String(command))
    assertValidShell(String(command))
    const dirOf = (re) => re.exec(String(command))?.[1]
    if (command.includes('spectre_psf_parse.py')) {
      const dir = dirOf(/cd "([^"]+)" &&/)
      const topo = dirOf(/--topo (lpf|hpf)/) ?? 'lpf'
      if (dir) await writeVerifyFixture(dir, topo)
      const v = await sshExec(command, { record: false })
      return { ...v, stdout: `[selfcheck] ${JSON.stringify(remoteVerifyJson(topo))}\n` }
    }
    if (command.includes('__BJOB__')) {
      const dir = dirOf(/cd "([^"]+)" \|\| exit/)
      if (dir) {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(path.posix.join(dir, 'sweep_progress.json'),
          JSON.stringify({ status: 'completed', total_points: 9, succeeded: 9, failed: 0 }) + '\n', 'utf8')
      }
    }
    return sshExec(command, { record: false })
  }

  async function sshDownload(args) {
    downloads.push(args)
    const remote = String(args.remotePath)
    const local = path.resolve(args.localPath)
    await fsp.mkdir(path.dirname(local), { recursive: true })
    if (remote.endsWith('.tgz')) {
      await fsp.writeFile(local, Buffer.from('not-a-real-tgz')) // forces the per-file fallback
      return { ok: true, bytes: 16 }
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
    return { ok: true, bytes: 128 }
  }

  const HOSTS = [
    { alias: 'node1', host: '192.0.2.10', port: 22, user: 'op', auth: 'key', keyReady: true },
    // mock-only alias: present in the registry, absent from remote_machines
    { alias: 'lab9', host: '192.0.2.90', port: 22, user: 'op', auth: 'key', keyReady: true },
  ]
  const tools = {
    register: () => {},
    get: (name) => {
      if (name.startsWith('ssh_')) return { name }
      if (batchTools.has(name)) return batchTools.get(name)
      if (spectre[name]) return { name }
      return undefined
    },
    execute: async (input) => {
      // ToolBatchInput (dsh-tools 0.2.2-rc.x): record the unwrapped single call so
      // execLog assertions keep reading {name, arguments(object)}; id/signal ride
      // along from the call/batch for the contract pin below.
      const call = input.calls[0]
      const view = { id: call.id, name: call.name,
        arguments: JSON.parse(call.arguments || '{}'), signal: input.signal }
      execLog.push(view)
      const reply = (result) => ({ results: [{ callId: call.id, result }] })
      const name = view.name
      const args = view.arguments ?? {}
      if (name === 'ssh_list') {
        return reply({ isError: false, value: { hosts: HOSTS } })
      }
      if (name === 'ssh_exec') {
        const v = await sshExec(args.command)
        return reply({ isError: false, value: v })
      }
      if (name === 'ssh_upload') {
        uploads.push({ localPath: args.localPath, remotePath: args.remotePath })
        return reply({ isError: false, value: { ok: true, transferredBytes: 128, files: 1 } })
      }
      if (name === 'ssh_download') {
        return reply({ isError: false, value: await sshDownload(args) })
      }
      if (spectre[name]) {
        try {
          const result = await spectre[name](args)
          // content[] is the live dsh-tools result shape; the batch branch below
          // keeps the value:{text} form so resultText's both branches are
          // exercised within this suite
          return reply({ isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] })
        } catch (e) {
          return reply({ isError: true, value: { text: String(e?.message ?? e) } })
        }
      }
      if (name === 'batch_submit' && args.scheduler === 'local') {
        // local submissions never leave this host: lay down the worker's
        // output + job file exactly as the real tool's detached run would, so
        // the REAL batch_poll local branch reads them — the ssh mock stays idle
        const runDir = path.resolve(args.run_dir)
        const topo = path.basename(runDir)
        fs.cpSync(path.join(GOLDEN_DIR, topo), runDir, { recursive: true })
        fs.writeFileSync(path.join(runDir, 'sweep_progress.json'),
          JSON.stringify({ work_dir: runDir, status: 'completed', total_points: 9,
            completed: 9, succeeded: 9, failed: 0, running: 0, points: [] }) + '\n', 'utf8')
        fs.writeFileSync(path.join(runDir, '.batch_job.json'),
          JSON.stringify({ scheduler: 'local', job_id: 'local-test', pid: null,
            worker: 'spectre/spectre_sweep_worker.py',
            submitted_at: new Date().toISOString(), total_points: 9 }) + '\n', 'utf8')
        return reply({ isError: false, value: { text: JSON.stringify({
          ok: true, job_id: 'local-test', state: 'running', scheduler: 'local', run_dir: runDir }) } })
      }
      if (batchTools.has(name)) {
        try {
          const result = await batchTools.get(name).execute(args, {})
          return reply({ isError: false, value: { text: JSON.stringify(result) } })
        } catch (e) {
          return reply({ isError: true, value: { text: String(e?.message ?? e) } })
        }
      }
      return reply({ isError: true, value: { text: `${name} is not registered` } })
    },
  }

  Object.assign(ctx, {
    effect: (fn) => { fn() },
    webServer: { register: () => {} },
    tools,
    shell: {
      resolve: (req) => ({ onExpiry: 'kill', stdoutMaxBytes: 1 << 20, ...req,
        workdir: req.workdir || process.cwd(), timeoutMs: req.timeoutMs ?? 40_000 }),
      execute: async (spec) => {
        const v = await shellExec(String(spec.command))
        return {
          status: 'completed', exitCode: v.exitCode ?? 0, signal: null, done: Promise.resolve(),
          readOutput: () => ({ delta: '', lossy: false }), kill: () => false,
          result: async () => ({ exitCode: v.exitCode ?? 0, signal: null, timedOut: !!v.timedOut, aborted: false,
            timeoutMs: spec.timeoutMs, stdout: { text: String(v.stdout ?? ''), truncated: false },
            stderr: { text: String(v.stderr ?? ''), truncated: false } }),
        }
      },
    },
    workspaceRegistry: { list: () => [] },
    get: (n) => {
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
    __localCommands: localCommands,
    __scCalls: scCalls,
    __waitHang: async () => { while (!hangStarted) await new Promise((r) => setTimeout(r, 10)) },
    __resolveHang: () => { const r = hangResolve; hangResolve = null; r?.() },
  })
  return ctx
}

async function waitDone(runId, projectPath, timeoutMs = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const run = getSelfcheck(runId, projectPath)
    if (run?.status === 'done') return run
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('run did not finish; steps: ' + JSON.stringify(run?.steps?.map((s) => [s.item, s.ok])))
    }
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function waitStatus(runId, projectPath, status, timeoutMs = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const run = getSelfcheck(runId, projectPath)
    if (run?.status === status) return run
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`run did not reach status=${status}; now=${run?.status}; steps: `
        + JSON.stringify(run?.steps?.map((s) => [s.item, s.ok, s.result])))
    }
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function waitDiagnoses(runId, projectPath, count, timeoutMs = 15_000) {
  const t0 = Date.now()
  for (;;) {
    const run = getSelfcheck(runId, projectPath)
    if ((run?.diagnoses ?? []).length >= count) return run
    if (Date.now() - t0 > timeoutMs) throw new Error(`expected ${count} diagnoses, got ${JSON.stringify(run?.diagnoses)}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

// The finalize-side artifact cleanup is fire-and-forget — poll briefly for the
// expected end state instead of asserting synchronously.
async function waitArtifactsGone(runDir, timeoutMs = 5_000) {
  const t0 = Date.now()
  for (;;) {
    const left = fs.readdirSync(runDir).filter((n) => !n.startsWith('selfcheck_run.json'))
    if (!left.length) return left
    if (Date.now() - t0 > timeoutMs) return left
    await new Promise((r) => setTimeout(r, 20))
  }
}

let sessionSeq = 0

// Windows rm races the fire-and-forget persist chain — retry a few beats.
async function rmRetry(target) {
  for (let i = 0; i < 10; i++) {
    try { await fsp.rm(target, { recursive: true, force: true }); return } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
}

async function startFlow({ scenario = {}, settings = {} }) {
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'project')
  await fsp.mkdir(projectPath, { recursive: true })
  // worker scripts root for the batch tools (dummy tree; upload is mocked).
  // The parser entry is FUNCTIONAL: the self-check's parse step runs it
  // directly (script-face since 2026-11-23), and it emits exactly the
  // analytic psf CSVs + psf_index.json the real SmartAnaSim parser would.
  const scriptsRoot = path.join(tmp, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# dummy worker\n')
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_psf_parse.py'), [
    'import json, math, os, sys',
    'wd = sys.argv[sys.argv.index("--work-dir") + 1]',
    'R = ["1k", "2k", "5k"]; C = ["1n", "2n", "5n"]',
    'def si(t):',
    '    t = t.lower()',
    '    for suf, fac in [("k", 1e3), ("m", 1e-3), ("u", 1e-6), ("n", 1e-9), ("p", 1e-12), ("f", 1e-15)]:',
    '        if t.endswith(suf): return float(t[:-len(suf)]) * fac',
    '    return float(t)',
    'n = round(math.log10(1e8 / 1e3) * 50) + 1',
    'freqs = [1e3 * 10 ** (i / 50) for i in range(n)]',
    'topo = os.path.basename(os.path.normpath(wd))',
    'os.makedirs(os.path.join(wd, "psf"), exist_ok=True)',
    'index = {"work_dir": wd, "points": [], "errors": []}',
    'for i in range(9):',
    '    name = "%02d" % i',
    '    r = si(R[i // 3]); c = si(C[i % 3])',
    '    fc = 1 / (2 * math.pi * r * c)',
    '    rows = ["point,signal,index,sweep_value,re,im"]',
    '    for idx, f in enumerate(freqs):',
    '        x = f / fc',
    '        re, im = (1 / (1 + x * x), -x / (1 + x * x)) if topo == "lpf" else (x * x / (1 + x * x), x / (1 + x * x))',
    '        rows.append("%s,ac_freq,%d,,%s," % (name, idx, f))',
    '        rows.append("%s,ac_vout,%d,,%s,%s" % (name, idx, re, im))',
    '    with open(os.path.join(wd, "psf", name + "_psf.csv"), "w") as fh:',
    '        fh.write("\\n".join(rows) + "\\n")',
    '    os.makedirs(os.path.join(wd, name), exist_ok=True)',
    '    with open(os.path.join(wd, name, "point_meta.json"), "w") as fh:',
    '        json.dump({"point_index": i, "point_name": name, "simulator": "spectre",',
    '                   "params": {"r_val": R[i // 3], "c_val": C[i % 3]}, "status": "success"}, fh)',
    '    index["points"].append({"point": name, "signals": ["ac_freq", "ac_vout"]})',
    'with open(os.path.join(wd, "psf", "psf_index.json"), "w") as fh:',
    '    json.dump(index, fh)',
    'print("[psf] 9/9 point(s) parsed")',
  ].join('\n') + '\n')
  const prevScripts = process.env.HARNESSAMS_SIM_SCRIPTS_DIR
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot

  const ctx = makeHarness({ scenario })
  const sessionId = 'sess-' + (++sessionSeq) // unique: a leaked running run must never 409 the next test
  const merged = { ...defaultSettings(), ...settings }
  await writeSettings(projectPath, merged)

  ctx.workspaceRegistry.list = () => [
    { id: 'ws-local', path: projectPath, title: 'Local project', sessionIds: [sessionId] },
  ]
  const start = await startSelfcheck(ctx, {
    sessionId,
    project: { id: 'ws-local', path: projectPath, title: 'Local project' },
    lang: 'en',
  })
  const restoreAll = () => {
    if (prevScripts === undefined) delete process.env.HARNESSAMS_SIM_SCRIPTS_DIR
    else process.env.HARNESSAMS_SIM_SCRIPTS_DIR = prevScripts
  }
  return { ctx, start, tmp, projectPath, restoreAll, sessionId }
}

// ---------------------------------------------------------------------------
// 1) settings
// ---------------------------------------------------------------------------

// D-016 toolchain pins — placeholder paths (the fixture gate: no real cluster paths)
const PIN_PY = '/opt/tools/python3/bin/python3'
const PIN_SPECTRE = '/opt/tools/spectre/bin/spectre'

test('settings: defaults, validation, persistence, workspace section', async () => {
  assert.deepEqual(defaultSettings(), {
    cluster_env: 'out-of-cluster', run_mode: 'local', machine_id: null, remote_root: null, remote_dir: '.harnessams/selfcheck',
    scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    remote_python: null, remote_spectre_cmd: null,
    report_figs: false,
  })
  // valid full object round-trips
  const v = validateSettings({ ...defaultSettings(), run_mode: 'remote', machine_id: 'm1',
    remote_root: '/home/op/sim', remote_dir: '/abs/path', scheduler: 'ssh', compute_script_remote: 'js', report_figs: true })
  assert.ok(!v.error, v.error)
  assert.equal(v.settings.compute_script_remote, 'js')
  assert.equal(v.settings.report_figs, true)
  // D-016 toolchain pins: an absolute path to the executable file, or null.
  // (positive cases need a valid base: out-of-cluster + local + spectre is refused)
  const ok = { ...defaultSettings(), cluster_env: 'in-cluster' }
  const pinned = validateSettings({ ...ok, remote_python: PIN_PY, remote_spectre_cmd: PIN_SPECTRE })
  assert.ok(!pinned.error, pinned.error)
  assert.equal(pinned.settings.remote_python, PIN_PY)
  assert.equal(pinned.settings.remote_spectre_cmd, PIN_SPECTRE)
  assert.equal(validateSettings({ ...ok, remote_python: '' }).settings.remote_python, null, 'empty = unpinned')
  assert.equal(validateSettings({ ...ok }).settings.remote_spectre_cmd, null, 'an omitted key = unpinned')
  assert.equal(validateSettings({ ...ok, remote_python: '/opt/tools/python3\\bin\\python3' }).settings.remote_python,
    '/opt/tools/python3/bin/python3', 'backslashes normalize to the POSIX form')
  // bare names are the incident's failure mode: refused with guidance, both keys
  for (const bare of ['python3', 'python', 'spectre', 'rel/python3']) {
    assert.match(validateSettings({ ...defaultSettings(), remote_python: bare }).error, /remote_python must be an ABSOLUTE path to the executable/)
    assert.match(validateSettings({ ...defaultSettings(), remote_spectre_cmd: bare }).error, /remote_spectre_cmd must be an ABSOLUTE path/)
  }
  // the value is joined into a remote command line: no spaces, no shell characters, a file not a directory
  assert.match(validateSettings({ ...defaultSettings(), remote_python: '/opt/my python/bin/python3' }).error, /remote_python must name the executable file/)
  assert.match(validateSettings({ ...defaultSettings(), remote_spectre_cmd: '/opt/tools/bin/spectre;id' }).error, /must name the executable file/)
  assert.match(validateSettings({ ...defaultSettings(), remote_python: '/opt/$(whoami)/python3' }).error, /must name the executable file/)
  assert.match(validateSettings({ ...defaultSettings(), remote_python: '/opt/tools/bin/' }).error, /must name the executable file/)
  assert.match(validateSettings({ ...defaultSettings(), remote_spectre_cmd: '/a/../b/spectre' }).error, /remote_spectre_cmd must not contain/)
  assert.match(validateSettings({ ...defaultSettings(), remote_python: '/' + 'a'.repeat(400) }).error, /too long/)
  assert.match(validateSettings({ ...defaultSettings(), remote_python: 42 }).error, /absolute path to the executable, or null/)
  // report_figs is strictly boolean (the gen_sweep_report PNG-export gate);
  // an omitted key falls back to the default off (partial payloads are legal)
  assert.match(validateSettings({ ...defaultSettings(), report_figs: 'on' }).error, /report_figs must be a boolean/)
  assert.match(validateSettings({ ...defaultSettings(), report_figs: 1 }).error, /report_figs must be a boolean/)
  const partial = validateSettings({ cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
    remote_dir: '.harnessams/selfcheck', scheduler: 'ssh', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' })
  assert.ok(!partial.error, partial.error)
  assert.equal(partial.settings.report_figs, false)
  // enum + mode coupling guards
  assert.match(validateSettings({ ...defaultSettings(), simulator: 'ngspice' }).error, /simulator must be one of/)
  assert.match(validateSettings({ ...defaultSettings(), scheduler: 'none' }).error, /scheduler must be one of/)
  assert.match(validateSettings({ ...defaultSettings(), cluster_env: 'cluster' }).error, /cluster_env must be one of/)
  assert.match(validateSettings({ ...defaultSettings(), run_mode: 'remote' }).error, /run_mode=remote requires machine_id/)
  assert.match(validateSettings({ ...defaultSettings(), run_mode: 'remote', machine_id: 'm1' }).error,
    /run_mode=remote requires remote_root/)
  // D-002 coupling: out-of-cluster forbids local spectre (the host cannot run it)
  assert.match(validateSettings({ ...defaultSettings(), run_mode: 'local', simulator: 'spectre' }).error,
    /requires cluster_env=in-cluster/)
  assert.ok(!validateSettings({ ...defaultSettings(), cluster_env: 'in-cluster' }).error)
  assert.ok(!validateSettings({ ...defaultSettings(), simulator: 'none' }).error)
  // in-cluster LSF needs no machine; ssh or out-of-cluster does
  assert.ok(!validateSettings({ ...defaultSettings(), cluster_env: 'in-cluster', run_mode: 'remote',
    remote_root: '/home/op/sim' }).error)
  assert.match(validateSettings({ ...defaultSettings(), cluster_env: 'in-cluster', run_mode: 'remote',
    remote_root: '/home/op/sim', scheduler: 'ssh' }).error, /requires machine_id/)
  assert.match(validateSettings({ ...defaultSettings(), remote_dir: 'a/../b' }).error, /must not contain/)
  assert.match(validateSettings({ ...defaultSettings(), remote_root: 'rel/path' }).error, /absolute remote path/)
  assert.match(validateSettings({ ...defaultSettings(), remote_root: '/a/../b' }).error, /must not contain/)

  const tmp = await tmpDir()
  const missing = await readSettings(tmp)
  assert.equal(missing.settings.run_mode, 'local') // missing file = defaults
  await writeSettings(tmp, v.settings)
  const raw = JSON.parse(await fsp.readFile(configPath(tmp), 'utf8'))
  // fresh file: single config carries the workspace section; D-015 — the
  // scripts root is the project's OWN staged copy, laid down at creation
  assert.equal(raw.version, 1)
  assert.equal(raw.workspace.sim_scripts_dir, path.join(tmp, '.harnessams', 'scripts'))
  assert.ok(fs.existsSync(path.join(tmp, '.harnessams', 'scripts')), 'staged scripts dir exists')
  assert.ok(fs.existsSync(path.join(tmp, 'script', 'analysis', 'gen_selfcheck_rc.py')), 'staged gen script (D-015)')
  const sibling = path.resolve(REPO, '..', 'HarnessAMS-SmartAnaSim', 'scripts')
  if (fs.existsSync(path.join(sibling, 'spectre', 'spectre_sweep_worker.py'))) {
    assert.ok(fs.existsSync(path.join(tmp, '.harnessams', 'scripts', 'spectre', 'spectre_sweep_worker.py')),
      'worker tree copied from the source root')
    assert.ok(fs.existsSync(path.join(tmp, '.harnessams', 'assets', 'numfallback.py')), 'assets bucket staged')
  }
  assert.equal(raw.workspace.trash_dir, '.harnessams/trash')
  assert.ok(path.isAbsolute(raw.workspace.plotly_asset))
  const back = await readSettings(tmp)
  assert.equal(back.settings.machine_id, 'm1')
  assert.equal(back.settings.remote_root, '/home/op/sim')
  assert.equal(back.settings.compute_script_remote, 'js')
  assert.equal(back.settings.report_figs, true)
  // read-modify-write keeps a hand-edited workspace section intact
  raw.workspace.plotly_asset = 'C:/custom/plotly.min.js'
  await fsp.writeFile(configPath(tmp), JSON.stringify(raw, null, 2), 'utf8')
  await writeSettings(tmp, { ...v.settings, machine_id: 'm2' })
  const raw2 = JSON.parse(await fsp.readFile(configPath(tmp), 'utf8'))
  assert.equal(raw2.workspace.plotly_asset, 'C:/custom/plotly.min.js')
  assert.equal(raw2.settings.machine_id, 'm2')
  // local mode keeps remote fields stored (in-cluster: local spectre is legal)
  const local = validateSettings({ ...v.settings, run_mode: 'local', cluster_env: 'in-cluster' })
  assert.ok(!local.error, local.error)
  assert.equal(local.settings.machine_id, 'm1')
  // hand-edited junk falls back per-key instead of breaking the Overview
  await fsp.writeFile(configPath(tmp), '{"settings":{"run_mode":"bogus","machine_id":"x","report_figs":"yes"}}', 'utf8')
  const dirty = await readSettings(tmp)
  assert.equal(dirty.settings.run_mode, 'local')
  assert.equal(dirty.settings.machine_id, 'x')
  assert.equal(dirty.settings.report_figs, false) // non-boolean report_figs is dropped, default applies
  // unknown scheduler values (incl. the retired "direct"/"none") fall back to
  // the default — no migration, the pre-release no-compat ruling (D-002 wave)
  await fsp.writeFile(configPath(tmp), '{"settings":{"scheduler":"none"}}', 'utf8')
  assert.equal((await readSettings(tmp)).settings.scheduler, 'lsf')
  await fsp.writeFile(configPath(tmp), '{"settings":{"scheduler":"direct"}}', 'utf8')
  assert.equal((await readSettings(tmp)).settings.scheduler, 'lsf')
  // D-016: a hand-edited invalid pin (a bare name) reads as UNPINNED — the
  // worker then runs under the bare default, never under junk; a valid pin
  // beside it survives
  await fsp.writeFile(configPath(tmp), JSON.stringify({ settings: { remote_python: 'python3', remote_spectre_cmd: PIN_SPECTRE } }), 'utf8')
  const halfPinned = (await readSettings(tmp)).settings
  assert.equal(halfPinned.remote_python, null)
  assert.equal(halfPinned.remote_spectre_cmd, PIN_SPECTRE)
  // and a validated write persists both pins
  await writeSettings(tmp, pinned.settings)
  const storedPins = (await readSettings(tmp)).settings
  assert.equal(storedPins.remote_python, PIN_PY)
  assert.equal(storedPins.remote_spectre_cmd, PIN_SPECTRE)
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

const driveRoute = (routes, req) => callRoute(routes[0].handler, req)

test('routes: GET project-settings defaults + the /api/tool funnel + guards', async () => {
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

  // settings ride the tool funnel (the table's confirm button): written, then
  // AGENTS.md synced in the same action
  const put = await driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        sessionId: 's1', action: 'save_agentsmd',
        settings: { ...defaultSettings(), run_mode: 'remote', machine_id: 'm1', remote_root: '/home/op/sim' },
      }))
    },
  })
  assert.equal(put.code, 200, JSON.stringify(put.body))
  assert.ok(put.body.path.endsWith('AGENTS.md'))
  assert.equal((await readSettings(projectPath)).settings.machine_id, 'm1')
  assert.equal((await readSettings(projectPath)).settings.scheduler, 'lsf')

  // D-016: a PARTIAL settings payload merges over the STORED settings — an
  // agent pins one value without echoing the whole table, and every untouched
  // key keeps its stored value
  const post = (settings) => driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's1', action: 'save_agentsmd', settings })) },
  })
  const partial = await post({ remote_python: PIN_PY, remote_spectre_cmd: PIN_SPECTRE })
  assert.equal(partial.code, 200, JSON.stringify(partial.body))
  const merged = (await readSettings(projectPath)).settings
  assert.equal(merged.remote_python, PIN_PY)
  assert.equal(merged.remote_spectre_cmd, PIN_SPECTRE)
  assert.equal(merged.machine_id, 'm1', 'untouched keys keep their stored values')
  assert.equal(merged.run_mode, 'remote')
  assert.equal(merged.report_figs, false)
  assert.ok((await fsp.readFile(path.join(projectPath, 'AGENTS.md'), 'utf8')).includes(`  remote_python: "${PIN_PY}"`),
    'the merged pin reached the AGENTS.md yaml through the same action')
  // clearing one pin is a partial write too
  const cleared = await post({ remote_spectre_cmd: null })
  assert.equal(cleared.code, 200, JSON.stringify(cleared.body))
  assert.equal((await readSettings(projectPath)).settings.remote_spectre_cmd, null)
  assert.equal((await readSettings(projectPath)).settings.remote_python, PIN_PY)
  // a bad pin is refused whole: nothing is written
  const barePin = await post({ remote_python: 'python3' })
  assert.equal(barePin.code, 400)
  assert.match(String(barePin.body.error), /remote_python must be an ABSOLUTE path/)
  assert.equal((await readSettings(projectPath)).settings.remote_python, PIN_PY, 'the stored pin is untouched')
  // a non-object payload is refused, not silently spread into the merge
  const notObject = await post('python3')
  assert.equal(notObject.code, 400)
  assert.equal((await readSettings(projectPath)).settings.remote_python, PIN_PY)

  const badPut = await driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's1', action: 'save_agentsmd', settings: { run_mode: 'nope' } })) },
  })
  assert.equal(badPut.code, 400)

  const noSession = await driveRoute(routes, getReq('/harnessams/api/project-settings?sessionId=zzz'))
  assert.equal(noSession.code, 404)

  // action=status guards: run_id pins one run (a global "latest" run would
  // bleed verdicts across projects)
  const noId = await driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's1', action: 'status' })) },
  })
  assert.equal(noId.code, 400)

  const noRun = await driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's1', action: 'status', run_id: 'ghost-run' })) },
  })
  assert.equal(noRun.code, 404) // unknown run id: 404 regardless of real runs on disk (hermetic)

  const unknownAction = await driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's1', action: 'nope' })) },
  })
  assert.equal(unknownAction.code, 400)

  const unknownSession = await driveRoute(routes, {
    method: 'POST', url: '/harnessams/api/tool', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'ghost', action: 'run' })) },
  })
  assert.equal(unknownSession.code, 404)
})

test('tool actions: env returns facts+checks; run/status round-trip; project resolution via session', async () => {
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'proj')
  await fsp.mkdir(projectPath, { recursive: true })
  await writeSettings(projectPath, { ...defaultSettings(), simulator: 'none' })
  const ctx = makeHarness({})
  ctx.workspaceRegistry.list = () => [{ id: 'ws1', path: projectPath, title: 'P', sessionIds: ['s1'] }]
  const project = { id: 'ws1', path: projectPath, title: 'P' }

  const env = await runSelfcheckAction(ctx, { sessionId: 's1', project, action: 'env' })
  assert.ok(env.ok)
  assert.ok(env.facts.node.version.startsWith('v'))
  assert.ok(env.checks.some((r) => r.item === 'Node'))
  assert.ok(env.checks.some((r) => /Disk capacity/.test(r.item)))

  const started = await runSelfcheckAction(ctx, { sessionId: 's1', project, action: 'run', lang: 'en' })
  assert.ok(started.ok, started.error)
  const run = await waitDone(started.run_id, projectPath)
  assert.equal(run.summary.ok, true)
  const status = await runSelfcheckAction(ctx, { sessionId: 's1', project, action: 'status', runId: started.run_id })
  assert.ok(status.ok)
  assert.equal(status.run.id, started.run_id)
  // cross-project fence: another project's store never answers
  const other = await tmpDir()
  const miss = await runSelfcheckAction(ctx, { sessionId: 's1', project: { id: 'w2', path: other, title: 'O' }, action: 'status', runId: started.run_id })
  assert.equal(miss.code, 404)
})

// ---------------------------------------------------------------------------
// 7) flows
// ---------------------------------------------------------------------------

test('flow: simulator=none + local (python compute)', async () => {
  const f = await startFlow({ settings: { simulator: 'none' } })
  try {
    assert.ok(f.start.runId, f.start.error)
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true)
    assert.equal(run.summary.remote, 'skipped')
    const items = run.steps.map((s) => [s.item, s.ok])
    assert.deepEqual(items.map((x) => x[0]), [
      'Parser script check', 'Settings validation', 'golden dataset load',
      'spectre_psf_parse.py (golden)', 'pointwise verify (python, LPF+HPF)',
    ])
    assert.ok(items.every(([, ok]) => ok === true), JSON.stringify(items))
    // local-only: not a single rw_* call happened
    assert.equal(f.ctx.__execLog.filter((x) => x.name.startsWith('ssh_')).length, 0)
    // run record survives under the project's .harnessams/selfcheck; a CLEAN
    // run's artifacts are deleted at finalize (2026-11-19 ruling)
    assert.ok(run.runDir.includes(path.join('.harnessams', 'selfcheck')), run.runDir)
    assert.ok(fs.existsSync(path.join(run.runDir, 'selfcheck_run.json')))
    const left = await waitArtifactsGone(run.runDir)
    assert.deepEqual(left, [], 'clean run must leave only selfcheck_run.json: ' + left.join(', '))
  } finally { f.restoreAll() }
})

test('flow: simulator=none + local (js compute)', async () => {
  const f = await startFlow({ settings: { simulator: 'none', compute_script_local: 'js' } })
  try {
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true)
    const verify = run.steps.find((s) => s.settingColumn === 'compute_local')
    assert.equal(verify.ok, true)
    assert.match(verify.item, /\(js, /)
  } finally { f.restoreAll() }
})

test('flow: simulator=spectre + local', async () => {
  const f = await startFlow({})
  try {
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true)
    const byCol = {}
    for (const s of run.steps) byCol[s.item] = s
    assert.equal(byCol['Tool registration check'].ok, true)
    assert.equal(byCol['spectre_assemble (RC tb)'].ok, true)
    assert.equal(byCol['batch_submit local LPF (9 pts)'].ok, true)
    assert.equal(byCol['batch_submit local HPF (9 pts)'].ok, true)
    assert.equal(byCol['spectre_psf_parse.py (LPF+HPF)'].ok, true)
    assert.equal(byCol['pointwise verify (python, LPF+HPF)'].ok, true)
    assert.match(byCol['pointwise verify (python, LPF+HPF)'].result, /9 pts/)
    // the assemble step ran against the REAL project root (D-015: the staged
    // gen script, never a throwaway run-dir copy) through the tool shell
    const asm = f.ctx.__execLog.find((x) => x.name === 'spectre_assemble')
    assert.ok(asm, 'spectre_assemble was not called through ctx.tools')
    assert.equal(path.resolve(asm.arguments.project_dir), path.resolve(f.projectPath))
    assert.ok(fs.existsSync(path.join(f.projectPath, 'script', 'analysis', 'gen_selfcheck_rc.py')), 'project owns its gen script')
    // local chain: submit + poll both went through the tool shell, and not a
    // single ssh_* call happened
    assert.ok(f.ctx.__execLog.some((x) => x.name === 'batch_submit' && x.arguments.scheduler === 'local'))
    assert.ok(f.ctx.__execLog.some((x) => x.name === 'batch_poll'))
    assert.equal(f.ctx.__execLog.filter((x) => x.name.startsWith('ssh_')).length, 0)
  } finally { f.restoreAll() }
})

test('flow: spectre + remote — LSF fails → diagnosis + fallback(ssh) passes; failed-run evidence kept then cleaned by the next run', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', scheduler: 'lsf', compute_script_remote: 'js' },
    scenario: { lsfSubmitFail: true },
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    await waitDone(f.start.runId, f.projectPath)
    const run = await waitDiagnoses(f.start.runId, f.projectPath, 1)
    assert.equal(run.summary.remote, 'ok-via-fallback')
    assert.equal(run.summary.ok, true)

    // scheduler column: primary failed, fallback passed with a warn note
    const schedSteps = run.steps.filter((s) => s.settingColumn === 'scheduler')
    assert.equal(schedSteps.length, 4) // submit+poll × (lsf, direct fallback)
    assert.ok(schedSteps[0].ok === false)
    assert.ok(schedSteps.some((s) => s.warn && /fallback/.test(s.warn)))
    const compRemote = run.steps.filter((s) => s.settingColumn === 'compute_remote')
    assert.ok(compRemote.every((s) => s.ok === true))

    // diagnosis #1 fired for the scheduler cluster before the fallback
    assert.equal(f.ctx.__scCalls.create.length, 1)
    const prompt = f.ctx.__scCalls.prompt[0].content[0].text
    assert.match(prompt, /project self-check/)
    assert.match(prompt, /scheduler=lsf/)
    assert.match(prompt, /batch_submit/)
    assert.match(prompt, /Answer in English\./)
    assert.equal(f.ctx.__scCalls.rename[0].title, 'HarnessAMS diagnosis: selfcheck @ node1')

    // every ssh_exec command went through bash -n and targeted the alias
    const execs = f.ctx.__execLog.filter((x) => x.name === 'ssh_exec')
    assert.ok(execs.length > 0)
    for (const e of execs) {
      assert.equal(e.arguments.alias, 'node1') // zero gating: alias only
      assert.match(e.arguments.command, /^timeout -s KILL \d+s sh -c /) // guaranteed-kill wrapper
      assert.ok(e.id && e.signal instanceof AbortSignal) // batch call id + batch signal
    }
    // remote compute chose node for the js channel
    const verifyCmd = rwExecCommands.find((c) => c.includes('selfcheck_verify.mjs'))
    assert.ok(verifyCmd, 'remote js verify command missing: ' + JSON.stringify(rwExecCommands))
    assert.match(verifyCmd, /selfcheck_verify\.mjs --run-dir \. --topo (lpf|hpf)/)

    // R4 cross-check ran the local python verify on fetched artifacts
    assert.ok(f.ctx.__downloads.some((d) => /_psf\.csv$/.test(d.remotePath)))

    // diagnosed run keeps its evidence (the diagnosis session inspects runDir)
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(fs.existsSync(path.join(run.runDir, 'remote')), 'diagnosed run keeps artifacts')
    // the NEXT run's start cleans historical evidence
    const prevRunDir = run.runDir
    const second = await startSelfcheck(f.ctx, {
      sessionId: f.sessionId,
      project: { id: 'ws-local', path: f.projectPath, title: 'Local project' },
      lang: 'en',
    })
    assert.ok(second.runId, second.error)
    await waitDone(second.runId, f.projectPath)
    assert.ok(!fs.existsSync(path.join(prevRunDir, 'remote')), 'next run cleans historical evidence')
    assert.ok(fs.existsSync(path.join(prevRunDir, 'selfcheck_run.json')), 'run record always survives')
  } finally { f.restoreAll() }
})

test('flow: spectre + remote — scheduler=ssh fails → verdict fails (nothing forgives a primary failure)', async () => {
  // With scheduler=ssh there is no fallback, and finalize must not forgive
  // primary-attempt failures unconditionally — a broken ssh submit would
  // otherwise still report remote:'ok' / summary.ok:true.
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', scheduler: 'ssh' },
    scenario: { sshRunFail: true },
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    await waitDone(f.start.runId, f.projectPath)
    const run = await waitDiagnoses(f.start.runId, f.projectPath, 1)
    assert.equal(run.summary.remote, 'failed')
    assert.equal(run.summary.ok, false)
    assert.equal(run.summary.fallback, undefined)
    const schedSteps = run.steps.filter((s) => s.settingColumn === 'scheduler')
    assert.equal(schedSteps.length, 2) // submit+poll only — no fallback attempt exists
    assert.ok(schedSteps.every((s) => s.ok === false))
  } finally { f.restoreAll() }
})

test('flow: spectre + remote — fallback also fails → final diagnosis covers the rest', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', scheduler: 'lsf' },
    scenario: { lsfSubmitFail: true, sshRunFail: true },
  })
  try {
    await waitDone(f.start.runId, f.projectPath)
    const run = await waitDiagnoses(f.start.runId, f.projectPath, 2)
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

test('flow: spectre + remote in-cluster LSF (D-002) — local bsub via ctx.shell, zero ssh, local-copy transfers', async () => {
  // No machine_id at all: in-cluster LSF is the only channel. The shared root
  // is drive-resolved on Windows, unique per run and cleaned up after.
  const shared = `/hams_sc_ic_${process.pid}_${Date.now()}`
  const localShared = path.resolve(shared)
  const f = await startFlow({
    settings: { cluster_env: 'in-cluster', run_mode: 'remote', machine_id: null, remote_root: shared, scheduler: 'lsf' },
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true, JSON.stringify(run.steps.map((s) => [s.item, s.ok, s.result, s.detail])))
    assert.equal(run.summary.remote, 'ok')
    // zero dsh-ssh usage: bsub/bjobs/parse all went through the ctx.shell seam
    assert.equal(f.ctx.__execLog.filter((x) => x.name.startsWith('ssh_')).length, 0)
    assert.equal(f.ctx.__uploads.length, 0, 'in-cluster transfers are local copies, not sftp uploads')
    assert.ok(f.ctx.__localCommands.some((c) => c.includes('bsub -q')), 'bsub ran locally')
    assert.ok(f.ctx.__localCommands.some((c) => c.includes('bjobs')), 'bjobs polled locally')
    assert.ok(f.ctx.__localCommands.some((c) => c.includes('spectre_psf_parse.py')), 'parse+verify ran locally')
    // staging physically landed on the shared root (plain local copies; a clean
    // run's staging under the project is deleted at finalize, so the shared
    // tree is the durable witness)
    assert.ok(fs.existsSync(path.join(localShared, '.harnessams', 'selfcheck')), 'shared run tree exists')
    // the settings-validation row says so
    const c2 = run.steps.find((s) => s.item === 'Settings validation')
    assert.match(c2.result, /local bsub on this host/, c2.result)
  } finally {
    f.restoreAll()
    await rmRetry(f.tmp)
    fs.rmSync(localShared, { recursive: true, force: true })
  }
})

test('flow: spectre + remote — the toolchain pins drive the submit AND the remote parse (D-016)', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', scheduler: 'lsf',
      remote_python: PIN_PY, remote_spectre_cmd: PIN_SPECTRE },
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true, JSON.stringify(run.steps.map((s) => [s.item, s.ok, s.result, s.detail])))
    // the settings-validation row records the exact pair this run used
    const c2 = run.steps.find((s) => s.item === 'Settings validation')
    assert.ok(c2.detail.includes(`toolchain python=${PIN_PY}, spectre=${PIN_SPECTRE}`), c2.detail)
    assert.ok(!c2.detail.includes('unpinned'), c2.detail)
    // the self-check passed NO interpreter of its own: batch_submit resolved
    // both pins from the project settings
    const submit = f.ctx.__execLog.find((x) => x.name === 'batch_submit')
    assert.equal(submit.arguments.remote_python, undefined)
    assert.equal(submit.arguments.worker_args, undefined)
    const flat = (x) => String(x.arguments.command).replace(/\\"/g, '"')
    const bsubs = f.ctx.__execLog.filter((x) => x.name === 'ssh_exec' && String(x.arguments.command).includes('bsub -q'))
    assert.equal(bsubs.length, 2, 'lpf + hpf')
    for (const b of bsubs) {
      assert.ok(flat(b).includes(`"${PIN_PY}" "/home/op/sim/.harnessams/scripts/spectre/spectre_sweep_worker.py"`), flat(b))
      assert.ok(flat(b).includes('"--spectre-cmd" "' + PIN_SPECTRE + '"'), flat(b))
    }
    // remote parse + verify ran under the pinned interpreter, end to end
    const verifies = f.ctx.__execLog.filter((x) => x.name === 'ssh_exec' && String(x.arguments.command).includes('spectre_psf_parse.py'))
    assert.equal(verifies.length, 2)
    for (const v of verifies) {
      assert.ok(flat(v).includes(`"${PIN_PY}" "/home/op/sim/.harnessams/scripts/spectre/spectre_psf_parse.py"`), flat(v))
      assert.ok(flat(v).includes(`"${PIN_PY}" ./selfcheck_verify.py`), flat(v))
    }
  } finally { f.restoreAll(); await rmRetry(f.tmp) }
})

test('flow: none + remote — the golden chain runs its remote compute under the remote_python pin (D-016)', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', simulator: 'none',
      remote_python: PIN_PY },
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true, JSON.stringify(run.steps.map((s) => [s.item, s.ok, s.result, s.detail])))
    const c2 = run.steps.find((s) => s.item === 'Settings validation')
    assert.ok(c2.detail.includes(`toolchain python=${PIN_PY}`), c2.detail)
    assert.ok(!c2.detail.includes('spectre='), 'no simulator, so no spectre entry in the record')
    const verifies = f.ctx.__execLog.filter((x) => x.name === 'ssh_exec' && String(x.arguments.command).includes('spectre_psf_parse.py'))
    assert.equal(verifies.length, 2)
    for (const v of verifies) {
      const flat = String(v.arguments.command).replace(/\\"/g, '"')
      assert.ok(flat.includes(`"${PIN_PY}" ./spectre_psf_parse.py`), flat)
    }
  } finally { f.restoreAll(); await rmRetry(f.tmp) }
})

test('flow: spectre + remote in-cluster — the pins reach the local bsub and the local parse alike (D-016)', async () => {
  // The shared root is drive-resolved on Windows; the local cross-check runs
  // as in-process js, so the pinned interpreter (a cluster path this test
  // host does not have) is never spawned here.
  const shared = `/hams_sc_pin_${process.pid}_${Date.now()}`
  const localShared = path.resolve(shared)
  const f = await startFlow({
    settings: { cluster_env: 'in-cluster', run_mode: 'remote', machine_id: null, remote_root: shared, scheduler: 'lsf',
      remote_python: PIN_PY, remote_spectre_cmd: PIN_SPECTRE, compute_script_local: 'js' },
  })
  try {
    assert.ok(f.start.runId, f.start.error)
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true, JSON.stringify(run.steps.map((s) => [s.item, s.ok, s.result, s.detail])))
    assert.equal(f.ctx.__execLog.filter((x) => x.name.startsWith('ssh_')).length, 0, 'zero dsh-ssh usage')
    const bsub = f.ctx.__localCommands.find((c) => c.includes('bsub -q'))
    assert.ok(bsub, 'local bsub ran')
    assert.ok(bsub.includes(`"${PIN_PY}" `), bsub)
    assert.ok(bsub.includes('"--spectre-cmd" "' + PIN_SPECTRE + '"'), bsub)
    const parse = f.ctx.__localCommands.find((c) => c.includes('spectre_psf_parse.py'))
    assert.ok(parse.includes(`"${PIN_PY}" "`), parse)
  } finally {
    f.restoreAll()
    await rmRetry(f.tmp)
    fs.rmSync(localShared, { recursive: true, force: true })
  }
})

test('flow: none + remote — upload, remote compute (python), download + js cross-check', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', simulator: 'none', compute_script_local: 'js' },
  })
  try {
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, true, JSON.stringify(run.steps.map((s) => [s.item, s.ok, s.result])))
    const uploads = f.ctx.__uploads
    // per topo: every golden file + 2 verify scripts + 1 parser (counted from the
    // shipped golden tree, so adding a point to the dataset does not desync this)
    const countFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0)
    const expected = ['lpf', 'hpf']
      .reduce((n, topo) => n + countFiles(path.join(GOLDEN_DIR, topo)) + 3, 0)
    assert.equal(uploads.length, expected,
      `expected ${expected} uploads (golden files + verify scripts + parser per topo)`)
    const PREFIX = '/home/op/sim/.harnessams/selfcheck/rc_'
    assert.ok(uploads.every((u) => u.remotePath.startsWith(PREFIX)),
      'unexpected upload paths: ' + JSON.stringify(uploads.filter((u) => !u.remotePath.startsWith(PREFIX)).map((u) => u.remotePath)))
    assert.ok(uploads.some((u) => u.remotePath.endsWith('/spectre_psf_parse.py')))
    // remote verify command used python for compute_script_remote=python (the
    // list is shared across the file's flows: the LAST match is this run's)
    const verifyCmd = rwExecCommands.findLast((c) => c.includes('selfcheck_verify.py'))
    assert.ok(verifyCmd)
    assert.match(verifyCmd, /spectre_psf_parse\.py --work-dir \. --format csv/)
    // downloads: 9 CSVs per topo
    assert.equal(f.ctx.__downloads.filter((d) => /_psf\.csv$/.test(d.remotePath)).length, 18)
    const cross = run.steps.find((s) => /artifact download/.test(s.item))
    assert.equal(cross.ok, true)
    assert.match(cross.result, /local js/)
  } finally { f.restoreAll() }
})

test('flow: remote verify failure skips the cross-check step', async () => {
  const f = await startFlow({
    settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', simulator: 'none' },
    scenario: { remoteVerifyFail: true },
  })
  try {
    const run = await waitDone(f.start.runId, f.projectPath)
    assert.equal(run.summary.ok, false)
    const cross = run.steps.find((s) => /artifact download/.test(s.item))
    assert.equal(cross.ok, null) // skipped, not failed
    assert.match(cross.skipReason, /remote verify failed/)
  } finally { f.restoreAll() }
})

// ---------------------------------------------------------------------------
// 8) start guards + re-entry
// ---------------------------------------------------------------------------

test('start guards: unknown machine / missing remote root', async () => {
  const f1 = await startFlow({ settings: { run_mode: 'remote', machine_id: 'nope', remote_root: '/home/op/sim' } })
  try {
    assert.equal(f1.start.code, 404)
    assert.match(f1.start.error, /no such dsh-ssh host: nope/)
  } finally { f1.restoreAll() }

  // remote mode without a remote_root in the project config -> 409
  const tmp = await tmpDir()
  const projectPath = path.join(tmp, 'project')
  await fsp.mkdir(projectPath, { recursive: true })
  const ctx = makeHarness({})
  await writeSettings(projectPath, { ...defaultSettings(), run_mode: 'remote', machine_id: 'lab9' })
  const r = await startSelfcheck(ctx, {
    sessionId: 's1', project: { id: 'ws-local', path: projectPath, title: 'P' }, lang: 'en',
  })
  assert.equal(r.code, 409)
  assert.match(r.error, /requires remote_root/)
})

test('re-entry: a second start while running gets 409', async () => {
  const f = await startFlow({ scenario: { hangTool: 'spectre_assemble' } })
  try {
    assert.ok(f.start.runId)
    const second = await startSelfcheck(f.ctx, {
      sessionId: f.sessionId,
      project: { id: 'ws-local', path: f.projectPath, title: 'P' },
      lang: 'en',
    })
    assert.equal(second.code, 409)
    assert.match(second.error, /already running/)
    await f.ctx.__waitHang()
    f.ctx.__resolveHang()
    const run = await waitDone(f.start.runId, f.projectPath)
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
    machine: { id: 'node1', name: 'node1', host: '192.0.2.10', port: 22, username: 'op' },
    remotePath: '/home/op/sim', projectTitle: 'P',
    failed: [{ section: 'remote', item: 'golden upload', ok: false, ms: 5, result: 'upload failed', detail: 'x'.repeat(3000) }],
    lang: 'zh',
  })
  assert.match(p, /diagnostic agent of the HarnessAMS workbench/)
  assert.match(p, /mode=remote env=n\/a simulator=none/)
  assert.match(p, /Run artifacts: C:\/ws\/selfcheck\/rc_x/)
  assert.match(p, /Remote root: \/home\/op\/sim/)
  assert.match(p, /dsh-ssh alias "node1"/)
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
    const file = path.join(f.projectPath, '.harnessams', 'selfcheck', f.start.runId, 'selfcheck_run.json')
    let corrupt = null
    // hammer the status file while the orchestrator writes it: every published
    // snapshot must parse as a complete JSON document (tmp+rename is the only
    // publish path, and the per-run chain keeps two writes from interleaving)
    const t0 = Date.now()
    while (Date.now() - t0 < 30_000) {
      const live = getSelfcheck(f.start.runId, f.projectPath)
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

test('client static contract: keys bilingual, tool funnel wired, staged table, poll', async () => {
  const src = await clientSrc()
  assertDictKeys(src, [
    'pset.title', 'pset.rootLabel', 'pset.dirLocalHint', 'pset.dirRemoteRel',
    'pset.colMode', 'pset.colMachine', 'pset.colSched',
    'pset.colSim', 'pset.colCompLocal', 'pset.colCompRemote', 'pset.mode.local', 'pset.mode.remote',
    'pset.sched.lsf', 'pset.sched.ssh', 'pset.sim.spectre', 'pset.sim.none', 'pset.comp.python',
    'pset.comp.js', 'pset.noMachine', 'pset.saveFailed', 'pset.unsaved', 'pset.confirmBtn',
    'pset.stagedHint',
    'selfchk.desc', 'selfchk.run', 'selfchk.running', 'selfchk.startFailed',
    'selfchk.stop', 'selfchk.stopping', 'selfchk.stopped', 'selfchk.stopFailed',
    'selfchk.scopeLocal', 'selfchk.scopeRemote', 'selfchk.noneYet', 'selfchk.skipped',
    'selfchk.summaryOk', 'selfchk.summaryFallback', 'selfchk.summaryFail', 'selfchk.diagDone', 'selfchk.diagFail',
  ])
  assert.ok(src.includes("API + '/tool'"), 'all buttons ride the single /api/tool funnel')
  assert.ok(src.includes('const callToolRoute ='), 'tool funnel helper')
  assert.ok(src.includes("action: 'status', run_id: runId"), 'poll via action=status')
  assert.ok(src.includes("action: 'run'"), 'self-check start via action=run')
  assert.ok(src.includes("action: 'stop'"), 'stop button via action=stop')
  assert.ok(src.includes("action: 'env'"), 'local env listing via action=env')
  assert.ok(src.includes("action: 'save_agentsmd'"), 'save/confirm via action=save_agentsmd')
  assert.ok(src.includes('function ProjectSelfcheck('))
  assert.ok(src.includes('function SettingsTable('))
  assert.ok(src.includes('function SelfcheckSteps('))
  assert.ok(src.includes('SETTING_COLS'), 'row config drives the transposed three-column table (name / value / verdict)')
  assert.ok(src.includes('h(ProjectSelfcheck, { sessionId, info: checksInfo, projectPath })'), 'mounted in the Overview tab')
  assert.match(src, /,\s*3_000\s*\)/, '3s poll while running')
  assert.match(src, /,\s*1_000\s*\)/, '1s settings poll follows tool-side config writes')
  assert.ok(src.includes("'local'"), 'local dir display branch')
  // staged table: PER-ROW out-of-sync marker (only the edited row goes red)
  assert.ok(src.includes('const rowDirty = !!settings'), 'per-row dirty computation')
  assert.ok(src.includes("JSON.stringify(draft[c.id] ?? null) !== JSON.stringify(settings[c.id] ?? null)"),
    'row dirty = that row\'s draft vs saved value')
  assert.ok(src.includes("JSON.stringify(draft) !== JSON.stringify(settings)"), 'global dirty still gates pendingSettings')
  // 1:1:2 columns + dropdowns fill their cell
  assert.ok(src.includes("width: '25%'"), 'colgroup narrow columns')
  assert.ok(src.includes("width: '50%'"), 'colgroup double-width verdict column')
  assert.ok(src.includes('.hams-settable .hams-select { width: 100%; }'), 'selects fill the cell')
  // merged remote-root row: browse-only
  assert.ok(src.includes("updateSetting('remote_root', dir)"), 'browse pick writes remote_root')
  // stop button + cancelled summary line
  assert.ok(src.includes("tr('selfchk.stop')"), 'stop button label')
  assert.ok(src.includes("run.status === 'cancelled'"), 'cancelled summary line')
  // in-flight step rows render a distinct marker
  assert.ok(src.includes('const inFlight = s.ms == null && s.ok === undefined && !s.skipReason'), 'in-flight step marker')
  // remote-switch auto-pick: the machine column only renders in remote mode
  assert.ok(src.includes("value === 'remote' && !next.machine_id && machines.length"),
    'remote switch must auto-pick a machine when none is set')
  assert.ok(src.includes('next.machine_id = machines[0].id'), 'auto-pick assigns machines[0].id')
  // working-environment switch (D-002): confirm dialog gates the write
  assert.ok(src.includes('const [envDialog, setEnvDialog]'), 'pending-switch state exists')
  assert.ok(src.includes('const commitEnv = async (next)'), 'confirm handler commits the switch')
  assert.ok(src.includes("action: 'save_agentsmd', lang: effectiveLang(), settings: base"),
    'the switch rides the single write funnel (save_agentsmd + settings)')
  assert.ok(src.includes("tr('envc.ok')") && src.includes("tr('common.cancel')"), 'confirm/cancel labels')
})

// ---------------------------------------------------------------------------
// stop action (2026-11-21): mid-run cancel, bkill, cancelled finalize
// ---------------------------------------------------------------------------

const REMOTE_LSF = { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
  remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
  compute_script_local: 'python', compute_script_remote: 'python' }

test('selfcheck stop: cancelled finalize, bkill both LSF jobs, evidence kept, no AGENTS.md sync', async () => {
  const flow = await startFlow({ scenario: { hangPoll: true }, settings: REMOTE_LSF })
  try {
    assert.ok(flow.start.runId, 'run started')
    await flow.ctx.__waitHang() // parked inside batch_poll's ssh_exec (topo 1)
    const agentsBefore = fs.readFileSync(path.join(flow.projectPath, 'AGENTS.md'), 'utf8')
    assert.deepEqual(await stopSelfcheck(flow.start.runId, flow.projectPath), { ok: true, status: 'stopping' })
    // both submitted LSF jobs get a best-effort bkill through the exec funnel
    await new Promise((r) => setTimeout(r, 60))
    const bkills = flow.ctx.__execLog.filter((c) => c.name === 'ssh_exec' && c.arguments.command.includes('bkill '))
    assert.equal(bkills.length, 2, 'one bkill per topology')
    assert.match(bkills[0].arguments.command, /bkill \\"4242\\"/)
    flow.ctx.__resolveHang() // release the parked poll; the next gate cancels
    const run = await waitStatus(flow.start.runId, flow.projectPath, 'cancelled')
    assert.equal(run.summary.cancelled, true)
    assert.equal(run.summary.ok, false)
    assert.deepEqual(run.diagnoses, [], 'no diagnosis sessions on a user stop')
    for (const topo of ['lpf', 'hpf']) {
      assert.ok(fs.existsSync(path.join(run.runDir, 'remote', topo, '.batch_job.json')),
        `${topo} staging evidence kept (cancelled runs are not cleaned)`)
    }
    assert.equal(fs.readFileSync(path.join(flow.projectPath, 'AGENTS.md'), 'utf8'), agentsBefore,
      'a cancelled run must not re-sync AGENTS.md from half-finished measurements')
    // idempotent + error shapes
    assert.deepEqual(await stopSelfcheck(flow.start.runId, flow.projectPath), { ok: true, status: 'cancelled' })
    assert.equal((await stopSelfcheck('rc_nope', flow.projectPath)).code, 404)
    assert.equal((await stopSelfcheck(null, flow.projectPath)).code, 400)
  } finally {
    flow.ctx.__resolveHang() // never leave a parked poll: it would leak runningBySession
    flow.restoreAll()
    await rmRetry(flow.tmp)
  }
})

test('selfcheck fallback observability: a failed submit leads with its error text, stale job record annotated', async () => {
  const flow = await startFlow({ scenario: { pollFail: true, sshRunFail: true }, settings: REMOTE_LSF })
  try {
    const run = await waitDone(flow.start.runId, flow.projectPath)
    assert.equal(run.summary.remote, 'failed')
    const fb = run.steps.find((s) => s.attempt === 'fallback' && s.item.includes('batch_submit'))
    assert.ok(fb, 'fallback submit step exists')
    assert.equal(fb.ok, false)
    assert.match(fb.detail, /FAILED — ssh run failed/, 'the failure text is the headline')
    assert.match(fb.detail, /stale job record from a previous attempt/,
      'a leftover job record demotes to an annotation (2026-11-21 observability fix)')
  } finally {
    flow.restoreAll()
    await rmRetry(flow.tmp)
  }
})

test('selfcheck poll live progress: the polling step row carries the latest counts mid-wait', async () => {
  const flow = await startFlow({ scenario: { pollRounds: 3, hangPoll: true }, settings: REMOTE_LSF })
  try {
    assert.ok(flow.start.runId, 'run started')
    await flow.ctx.__waitHang() // two incomplete rounds done, third poll parked
    const mid = getSelfcheck(flow.start.runId, flow.projectPath)
    const polling = mid.steps.filter((s) => s.item.includes('batch_poll'))
    assert.ok(polling.length, 'a polling step exists mid-run')
    const row = polling[polling.length - 1]
    assert.equal(row.ms, null, 'still in flight (no elapsed stamp)')
    assert.match(row.result, /polling lpf: running \(3\/9\)/, 'live counts on the step row')
    flow.ctx.__resolveHang()
    const run = await waitDone(flow.start.runId, flow.projectPath)
    assert.equal(run.summary.ok, true)
    const done = run.steps.find((s) => s.item.includes('batch_poll') && s.attempt !== 'fallback')
    assert.equal(done.ok, true)
    assert.match(done.result, /completed 9\/9/)
  } finally {
    flow.ctx.__resolveHang()
    flow.restoreAll()
    await rmRetry(flow.tmp)
  }
})

test('selfcheck tool surface: action enum carries stop and the runner dispatches it', async () => {
  const ctx = makeHarness({ scenario: {} })
  const def = toolDefinitions(ctx).find((d) => d.name === 'harnessams_selfcheck')
  assert.ok(def, 'selfcheck tool registered')
  assert.deepEqual(def.parameters.action.enum, ['run', 'status', 'stop', 'env', 'save_agentsmd'])
  assert.match(def.description, /"stop" cancels a running self-check/)
  // action=stop without a run_id → 400; unknown action lists the stop branch
  const noId = await runSelfcheckAction(ctx, { sessionId: 's', project: { id: 'w', path: 'D:/proj/x', title: 'X' }, action: 'stop' })
  assert.equal(noId.code, 400)
  const bogus = await runSelfcheckAction(ctx, { sessionId: 's', project: { id: 'w', path: 'D:/proj/x', title: 'X' }, action: 'bogus' })
  assert.match(bogus.error, /run \| status \| stop \| env \| save_agentsmd/)
})
