// Generic remote batch tools: machine resolution, upload/submit/poll/fetch against
// a mocked @linxin666/dsh-ssh tool shell (structured values, no network, no SSH, no
// LSF required). The scheduler=direct path is the node-local foreground mode (no
// bsub). The worker-script upload tree comes from the workspace sim_scripts_dir;
// tests point HARNESSAMS_SIM_SCRIPTS_DIR at a self-built fixture and
// HARNESSAMS_REMOTE_MACHINES at an inline alias->root map so they never depend on
// the real SmartAnaSim checkout or the real harnessams.json.
// The ssh_exec wrapping (timeout -s KILL) and the value shapes live in
// remote.test.mjs / server.test.mjs; submit/direct idempotency guards are asserted
// here against the generated commands.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolDefinitions } from '../src/index.js'
import { makeTool } from '../src/tool.js'
import { resolveMachine } from '../src/remote.js'
import { buildDirectCommand, buildSubmitCommand, parsePollOutput, pluginScripts, resolveRemoteDir, sanitizeRel, simScriptsDir } from '../src/batch.js'
import { setRemoteMachines } from './helpers.mjs'

const execFileAsync = promisify(execFile)
const OLD_SIM_SCRIPTS = process.env.HARNESSAMS_SIM_SCRIPTS_DIR

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeScriptsRoot() {
  const root = tmp('hams-scripts-')
  fs.mkdirSync(path.join(root, 'common'), { recursive: true })
  fs.mkdirSync(path.join(root, 'spectre'), { recursive: true })
  fs.mkdirSync(path.join(root, 'common', '__pycache__'), { recursive: true })
  fs.writeFileSync(path.join(root, 'common', 'common_sweep_engine.py'), '# engine\n')
  fs.writeFileSync(path.join(root, 'common', 'common_workspace.py'), '# workspace\n')
  fs.writeFileSync(path.join(root, 'common', '__pycache__', 'stale.pyc'), 'junk')
  fs.writeFileSync(path.join(root, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  return root
}

// Fixture worker tree for the whole file: deterministic upload manifest, no
// dependency on the sibling SmartAnaSim repo (this repo's tests must pass with
// that checkout absent).
const SCRIPTS_ROOT = makeScriptsRoot()
process.env.HARNESSAMS_SIM_SCRIPTS_DIR = SCRIPTS_ROOT

const REMOTE_ROOT = '/home/op/sim'

// Remote-root map for the whole file (alias node1 -> REMOTE_ROOT). Set for the
// process lifetime — the reject test clears it briefly and restores inline.
setRemoteMachines({ node1: REMOTE_ROOT })

function restoreEnv() {
  setRemoteMachines({ node1: REMOTE_ROOT })
  if (OLD_SIM_SCRIPTS === undefined) process.env.HARNESSAMS_SIM_SCRIPTS_DIR = SCRIPTS_ROOT
  else process.env.HARNESSAMS_SIM_SCRIPTS_DIR = OLD_SIM_SCRIPTS
}

const HOSTS = [
  { alias: 'node1', host: '192.0.2.11', port: 22, user: 'op', auth: 'key', keyReady: true },
  // an alias present in the dsh-ssh registry but absent from remote_machines —
  // the "configured host, no remote root" display state
  { alias: 'lab9', host: '192.0.2.99', port: 22, user: 'op', auth: 'key', keyReady: true },
]

function pollValue({ meta = 2, total = 2, status = 'completed', bjobs = '777 RUN' } = {}) {
  const prog = JSON.stringify({
    status, total_points: total, completed: meta, succeeded: meta, failed: 0,
    simulator: 'spectre', compute_node: 'node3',
  })
  const stdout = `__BJOB__\n${bjobs}\n__META__\n${meta}\n__DIRS__\n${meta}\n`
    + `__PROG__\n${prog}\n__ERR__\n`
  return { success: true, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 3 }
}

// The ssh_* tool shell mock: structured values per the installed dsh-ssh
// src/tools.ts (ssh_exec failures are values, not throws). Commands arrive
// already wrapped by execRemote (timeout -s KILL ... -- sh -c "..."); routing
// matches substrings inside the wrapper, exactly like the assertions below.
function makeCtx({ poll = {}, archive = null, failUpload = false, existing = 0 } = {}) {
  const calls = []
  const ok = (value) => ({ isError: false, value })
  return {
    calls,
    tools: {
      get: (name) => (['ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download'].includes(name)
        ? { name } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const view = { name: call.name, arguments: JSON.parse(call.arguments || '{}') }
        calls.push(view)
        const reply = (result) => ({ results: [{ callId: call.id, result }] })
        const a = view.arguments || {}
        if (view.name === 'ssh_list') return reply(ok({ hosts: HOSTS }))
        if (view.name === 'ssh_upload') {
          if (failUpload) return reply(ok({ ok: false, error: 'upload denied' }))
          return reply(ok({ ok: true, transferredBytes: 12, files: 1 }))
        }
        if (view.name === 'ssh_download') {
          if (archive) fs.copyFileSync(archive, a.localPath)
          return reply(ok({ ok: true, bytes: 512 }))
        }
        assert.equal(a.alias, 'node1', `${view.name}: ssh_* calls target the alias`)
        const cmd = String(a.command || '')
        if (cmd.includes('__BJOB__')) return reply(ok(pollValue(poll)))
        if (cmd.includes('sleep 1; bjobs')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: '777 RUN\n__STARTED__\n', stderr: '', durationMs: 3 }))
        if (cmd.includes('bsub -q')) {
          return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: 'Job <777> is submitted to queue <normal>.\n', stderr: '', durationMs: 3 }))
        }
        if (cmd.includes('tar czf .batch_fetch.tgz')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: '512\n', stderr: '', durationMs: 3 }))
        if (cmd.includes('| sort | head -200')) {
          return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: './00/point_meta.json\n./00/netlist.scs.raw/sp.sp\n', stderr: '', durationMs: 3 }))
        }
        if (cmd.includes('wc -l')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: `${existing}\n`, stderr: '', durationMs: 3 }))
        return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 3 }))
      },
    },
  }
}

function makeRunDir({ template = 'template.scs', config } = {}) {
  const dir = tmp('hams-run-')
  fs.writeFileSync(path.join(dir, template), 'simulator lang=spectre\nparameters SW=@@SW@@\n')
  fs.writeFileSync(path.join(dir, 'sweep_config.json'), JSON.stringify(config || {
    netlist_template: 'template.scs',
    parameters: { SW: [0, 1] },
    sweep_mode: 'cross_product',
  }))
  return dir
}

async function makeArchive() {
  const root = tmp('hams-remote-')
  fs.mkdirSync(path.join(root, '00', 'netlist.scs.raw'), { recursive: true })
  fs.writeFileSync(path.join(root, '00', 'point_meta.json'),
    JSON.stringify({ status: 'success', signals: { m: 1 } }))
  fs.writeFileSync(path.join(root, '00', 'netlist.scs.raw', 'sp.sp'),
    '# Hz S RI R 50\n1.0e9 1 0 0 0\n')
  fs.writeFileSync(path.join(root, 'sweep_progress.json'),
    JSON.stringify({ status: 'completed', total_points: 2, completed: 2 }))
  // Archive operand relative via cwd (GNU tar parses absolute "C:\..." operands
  // as host:path; Windows bsdtar accepts both forms). -C absolute values are
  // plain chdir targets and safe on both tars.
  const archDir = tmp('hams-arch-')
  const archive = path.join(archDir, 'fetch.tgz')
  await execFileAsync('tar', ['-czf', 'fetch.tgz', '-C', root, '.'],
    { cwd: archDir, timeout: 60_000 })
  return archive
}

function tool(ctx, name) {
  const def = toolDefinitions(ctx).find((d) => d.name === name)
  assert.ok(def, name)
  return makeTool(def)
}

test('worker scripts root: env override resolves, bad values and pluginScripts layout', () => {
  assert.equal(simScriptsDir(), SCRIPTS_ROOT)

  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = path.join(SCRIPTS_ROOT, 'missing')
  assert.throws(() => simScriptsDir(), /HARNESSAMS_SIM_SCRIPTS_DIR is not a directory/)
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = SCRIPTS_ROOT

  // Upload manifest: relative POSIX layout, __pycache__/.pyc skipped, sorted.
  const rels = pluginScripts(SCRIPTS_ROOT).map((s) => s.rel)
  assert.deepEqual(rels, [
    'common/common_sweep_engine.py',
    'common/common_workspace.py',
    'spectre/spectre_sweep_worker.py',
  ])
  for (const s of pluginScripts(SCRIPTS_ROOT)) {
    assert.equal(s.local, path.join(SCRIPTS_ROOT, ...s.rel.split('/')))
  }
})

test('path guards and poll parsing', () => {
  assert.throws(() => sanitizeRel('../x.py'), /unsafe relative path/)
  assert.throws(() => resolveRemoteDir('/home/op/sim', '../evil'), /escapes the remote workspace/)
  assert.equal(resolveRemoteDir('/home/op/sim', 'batch1'), '/home/op/sim/batch1')
  const parsed = parsePollOutput(pollValue({ meta: 2, total: 2 }).stdout, { total: 2 })
  assert.equal(parsed.state, 'completed')
  assert.equal(parsed.completed, 2)
  const empty = parsePollOutput(pollValue({ meta: 2, bjobs: 'No job found' }).stdout, { total: 2 })
  assert.equal(empty.state, 'completed')
  const running = parsePollOutput(pollValue({ meta: 1, total: 2, status: 'running' }).stdout, { total: 2 })
  assert.equal(running.state, 'running')
})

test('submit/direct commands carry the replay idempotency guards', () => {
  const submit = buildSubmitCommand({
    remoteDir: '/home/op/sim/batch1', python: 'python3',
    workerPath: '/root/.harnessams/scripts/spectre/spectre_sweep_worker.py', workerArgs: [],
  })
  // marker read-back (twice: fast path + inside the flock) + flock + write-on-success
  assert.ok((submit.match(/cat \.hams_submitted/g) ?? []).length >= 2, 'marker must be read back, not skipped')
  assert.ok(submit.includes('flock 9'), 'flock serializes concurrent first attempts')
  assert.ok(submit.includes('| tee .hams_submitted'), 'marker written with the bsub output')
  assert.ok(submit.includes('"$rc" -eq 0'), 'marker only written when bsub exits 0')

  const direct = buildDirectCommand({
    remoteDir: '/home/op/sim/fore', python: 'python3',
    workerPath: '/root/.harnessams/scripts/spectre/spectre_sweep_worker.py', workerArgs: [],
  })
  assert.ok(!direct.includes('bsub'))
  assert.ok((direct.match(/\.hams_direct_done/g) ?? []).length >= 3, 'done marker checked twice + touched')
  assert.ok(direct.includes('flock 9'), 'direct also serializes replays behind a live run')
  assert.ok(direct.includes('&& touch .hams_direct_done'), 'marker written only on worker success')
})

test('batch_submit uploads the worker scripts tree and run files, then records the job', async () => {
  const run = makeRunDir()
  try {
    const ctx = makeCtx()
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'batch1',
      machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
      worker_args: ['--config', 'sweep_config.json', '--max-parallel', '2'],
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.job_id, '777')
    assert.equal(res.remote_dir, '/home/op/sim/batch1')
    assert.equal(res.state, 'running')

    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.job_id, '777')
    assert.equal(job.total_points, 2)
    assert.equal(job.remote_dir, '/home/op/sim/batch1')

    // fixture tree = 3 scripts (common x2 + spectre worker) + 2 run files
    const uploads = ctx.calls.filter((c) => c.name === 'ssh_upload')
      .map((c) => c.arguments.remotePath)
    assert.ok(uploads.includes('/home/op/sim/.harnessams/scripts/spectre/spectre_sweep_worker.py'))
    assert.ok(uploads.includes('/home/op/sim/.harnessams/scripts/common/common_sweep_engine.py'))
    assert.ok(uploads.includes('/home/op/sim/batch1/template.scs'))
    assert.ok(uploads.includes('/home/op/sim/batch1/sweep_config.json'))
    assert.equal(uploads.length, 5, uploads.join('\n'))

    const bsub = ctx.calls.find((c) => c.name === 'ssh_exec'
      && String(c.arguments.command).includes('bsub -q'))
    assert.ok(bsub, 'bsub command sent')
    // execRemote wraps commands as `timeout … -- sh -c "<cmd>"` with the inner
    // double quotes escaped; flatten the escapes before asserting on the payload
    const flat = String(bsub.arguments.command).replace(/\\"/g, '"')
    assert.match(flat, /"--work-dir" "\/home\/op\/sim\/batch1"/)
    assert.match(flat, /spectre_sweep_worker\.py/)
    assert.match(flat, /\.hams_submitted/, 'LSF submit carries the marker guard')
  } finally {
    restoreEnv()
  }
})

test('batch_submit rejects a worker outside the scripts root with guidance', async () => {
  try {
    const ctx = makeCtx()
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1',
      worker: 'spectre/no_such_worker.py',
    }, {}), /worker script not found under the workspace sim_scripts_dir/)
  } finally {
    restoreEnv()
  }
})

test('batch_submit scheduler=direct runs the worker directly on the host (no bsub)', async () => {
  const run = makeRunDir()
  try {
    const ctx = makeCtx()
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'fore',
      machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
      scheduler: 'direct',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.scheduler, 'direct')
    assert.equal(res.state, 'completed')

    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.scheduler, 'direct')
    assert.equal(job.queue, null)
    assert.match(job.job_id, /^direct-/)
    assert.equal(job.remote_dir, '/home/op/sim/fore')

    const commands = ctx.calls.filter((c) => c.name === 'ssh_exec')
      .map((c) => String(c.arguments.command).replace(/\\"/g, '"'))
    const direct = commands.find((c) => c.includes('spectre_sweep_worker.py'))
    assert.ok(direct, 'direct worker command sent')
    assert.ok(!direct.includes('bsub'))
    assert.match(direct, /"--work-dir" "\/home\/op\/sim\/fore"/)
    assert.ok(direct.includes('.hams_direct_done'), 'direct carries the done-marker guard')
    assert.ok(!commands.some((c) => c.includes('bsub -q')), 'no bsub invocation')
  } finally {
    restoreEnv()
  }
})

test('batch_poll reads the job file and reports completed', async () => {
  const run = makeRunDir()
  try {
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: 'node1', remote_dir: '/home/op/sim/batch1', job_id: '777', total_points: 2,
    }))
    const ctx = makeCtx({ poll: { meta: 2, total: 2 } })
    const res = await tool(ctx, 'batch_poll').execute({ run_dir: run }, {})
    assert.equal(res.ok, true)
    assert.equal(res.state, 'completed')
    assert.equal(res.completed, 2)
    assert.equal(res.job_id, '777')
  } finally {
    restoreEnv()
  }
})

test('batch_fetch downloads the archive and extracts it into the run directory', async () => {
  const run = makeRunDir()
  const archive = await makeArchive()
  try {
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: 'node1', remote_dir: '/home/op/sim/batch1', job_id: '777', total_points: 2,
    }))
    const ctx = makeCtx({ archive })
    const res = await tool(ctx, 'batch_fetch').execute({
      run_dir: run,
      includes: ['*/point_meta.json', '*/netlist.scs.raw/sp.sp', 'sweep_progress.json'],
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.mode, 'archive')
    assert.equal(res.fetched.points, 1)
    assert.equal(res.fetched.sp_files, 1)
    assert.ok(fs.existsSync(path.join(run, '00', 'point_meta.json')))
    assert.ok(fs.existsSync(path.join(run, '00', 'netlist.scs.raw', 'sp.sp')))
    assert.ok(fs.existsSync(path.join(run, 'sweep_progress.json')))
    assert.ok(fs.existsSync(path.join(run, 'fetch_777.tgz')))
  } finally {
    restoreEnv()
  }
})

test('batch tools reject escaped paths and unresolvable machines', async () => {
  try {
    const ctx = makeCtx()
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1', worker: '../evil.py',
    }, {}), /unsafe relative path/)

    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: '../evil', machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /escapes the remote workspace/)

    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
      remote_scripts_dir: '/tmp/elsewhere', sync_scripts: true,
    }, {}), /remote_scripts_dir must be under the remote workspace/)

    // machine_id is now a required dsh-ssh alias (no mirror-session fallback);
    // the schema layer rejects the call before execute() ever runs
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /missing required property "machine_id"/)

    await assert.rejects(() => resolveMachine(makeCtx(), 'ghost'), /no such dsh-ssh host: ghost/)

    // alias exists in the dsh-ssh registry but has no remote root configured
    // (lab9 is mock-only, so the real harnessams.json cannot mask this branch)
    await assert.rejects(() => resolveMachine(makeCtx(), 'lab9'), /no remote root configured for host lab9/)
  } finally {
    restoreEnv()
  }
})

test('batch_submit enforces the template.scs upload convention', async () => {
  try {
    const run = makeRunDir({
      template: 'template_thorough.scs',
      config: { netlist_template: 'template_thorough.scs', parameters: { SW: [0, 1] } },
    })
    const ctx = makeCtx()
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /netlist_template is "template_thorough.scs"/)

    const run2 = makeRunDir({ template: 'template_thorough.scs' })
    await tool(ctx, 'batch_submit').execute({
      run_dir: run2, remote_dir: 'batch2', machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    const uploads = ctx.calls.filter((c) => c.name === 'ssh_upload')
      .map((c) => c.arguments.remotePath)
    assert.ok(uploads.includes('/home/op/sim/batch2/template.scs'), uploads.join('\n'))
  } finally {
    restoreEnv()
  }
})

test('batch_submit surfaces upload failures and refuses to clobber a batch', async () => {
  try {
    const ctx = makeCtx({ failUpload: true })
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /upload failed/)

    const clobberCtx = makeCtx({ existing: 3 })
    await assert.rejects(() => tool(clobberCtx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /already holds 3 point_meta\.json/)
  } finally {
    restoreEnv()
  }
})
