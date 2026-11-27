// Generic remote batch tools: machine resolution, upload/submit/poll against
// a mocked @linxin666/dsh-ssh tool shell (structured values, no network, no SSH, no
// LSF required). The scheduler=ssh path is the detached launch mode (nohup, no bsub). The
// channel matrix follows the project's cluster_env (D-002): out-of-cluster (the
// default for bare temp dirs) keeps every operation over the mocked ssh shell;
// in-cluster tests plant a .harnessams project root with cluster_env=in-cluster
// and a mocked ctx.shell seam — bsub runs "locally" and transfers are plain
// local copies onto POSIX-shaped paths (drive-resolved on Windows). The
// worker-script upload tree comes from the project's
// workspace_config.json workspace.sim_scripts_dir; tests point
// HARNESSAMS_SIM_SCRIPTS_DIR at a self-built fixture, and the fencing remote root
// is an explicit remote_root argument (the per-project settings.remote_root —
// the family remote_machines map is retired), so nothing depends on the real
// SmartAnaSim checkout or any workspace file.
// The ssh_exec wrapping (timeout -s KILL) and the value shapes live in
// remote.test.mjs / server.test.mjs; submit/ssh idempotency guards are asserted
// here against the generated commands.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolDefinitions } from '../src/index.js'
import { makeTool } from '../src/tool.js'
import { syncAgentsMd } from '../src/core/agentsmd.js'
import { buildSshCommand, buildSubmitCommand, nextSimDir, parsePollOutput, pluginAssets, pluginScripts, resolveRemoteDir, sanitizeRel, simScriptsDir } from '../src/core/batch.js'
import { callTool } from '../src/channel/remote.js'

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

function restoreEnv() {
  if (OLD_SIM_SCRIPTS === undefined) process.env.HARNESSAMS_SIM_SCRIPTS_DIR = SCRIPTS_ROOT
  else process.env.HARNESSAMS_SIM_SCRIPTS_DIR = OLD_SIM_SCRIPTS
}

const HOSTS = [
  // proxyJump mirrors the real ssh_list shape (the field is schema-required
  // there): node1 carries a jump chain (the second hop), lab9 is a direct
  // jump-less entry — the second-hop policy tests lean on exactly that
  { alias: 'node1', host: '192.0.2.11', port: 22, user: 'op', auth: 'key', keyReady: true, proxyJump: ['login4'] },
  // a second registry alias — the registry is pure facts now (roots are
  // per-project settings, not machine columns), it resolves like any other
  { alias: 'lab9', host: '192.0.2.99', port: 22, user: 'op', auth: 'key', keyReady: true, proxyJump: [] },
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
// D-021 anchoring fixture: a registered workspace root the harness injects as
// the explicit `project` argument of every tool call — the tools resolve the
// project through the registry/session seam now, the findProjectRoot walk-up
// is gone. The default mirrors the old walk-up-fail-open behavior (defaults,
// out-of-cluster); tests with a planted root pass it as `project`.
function makeAnchoredProject(clusterEnv = 'out-of-cluster', extra = {}) {
  const root = tmp('hams-anchor-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: clusterEnv, run_mode: 'local', machine_id: null, remote_root: null,
      selfcheck_remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
      ...extra,
    },
  }, null, 2))
  return root
}

function registryFor(project) {
  return { list: () => [{ id: 'ws-fixture', path: project, title: 'fixture' }] }
}

function makeCtx({ poll = {}, pollSeq = null, archive = null, failUpload = false, existing = 0, ls = '', post = '777 RUN\n__STARTED__\n', preCheck = {}, project = null } = {}) {
  const calls = []
  const ok = (value) => ({ isError: false, value })
  let seqIdx = 0 // pollSeq cursor: successive __BJOB__ polls shift through the
  // scripted states (last entry repeats) — the wait_sec loop re-polls
  const proj = project ?? makeAnchoredProject('out-of-cluster')
  return {
    calls,
    __fixtureProject: proj,
    workspaceRegistry: registryFor(proj),
    tools: {
      // spectre_pre_check: registered by default (a passing check); the
      // preCheck option drives the D-020 submit-gate tests
      get: (name) => ((['ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download'].includes(name)
        || (name === 'spectre_pre_check' && !preCheck.missing))
        ? { name } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const view = { name: call.name, arguments: JSON.parse(call.arguments || '{}') }
        calls.push(view)
        const reply = (result) => ({ results: [{ callId: call.id, result }] })
        const a = view.arguments || {}
        if (view.name === 'spectre_pre_check') {
          if (preCheck.fail) {
            return reply(ok({ ok: false, errors: ['format: missing simulator lang=spectre declaration'], warnings: [] }))
          }
          return reply(ok({ ok: true, errors: [], warnings: preCheck.warnings ?? [] }))
        }
        if (view.name === 'ssh_list') return reply(ok({ hosts: HOSTS }))
        if (view.name === 'ssh_upload') {
          if (failUpload) return reply(ok({ ok: false, error: 'upload denied' }))
          return reply(ok({ ok: true, transferredBytes: 12, files: 1 }))
        }
        if (view.name === 'ssh_download') {
          // terminal-poll auto-fetch: the light result files come with content
          if (a.remotePath.endsWith('sweep_progress.json')) {
            fs.writeFileSync(a.localPath, JSON.stringify({ status: 'completed', total_points: 2, completed: 2 }))
          } else if (a.remotePath.endsWith('errlog.txt')) {
            fs.writeFileSync(a.localPath, 'boom\n')
          }
          if (archive) fs.copyFileSync(archive, a.localPath)
          return reply(ok({ ok: true, bytes: 512 }))
        }
        assert.ok(HOSTS.some((h) => h.alias === a.alias), `${view.name}: ssh_* calls target a registry alias (got ${a.alias})`)
        const cmd = String(a.command || '')
        if (cmd.includes('__BJOB__')) {
          if (pollSeq) return reply(ok(pollValue(pollSeq[Math.min(seqIdx++, pollSeq.length - 1)])))
          return reply(ok(pollValue(poll)))
        }
        if (cmd.includes('sleep 1; bjobs')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: post, stderr: '', durationMs: 3 }))
        if (cmd.includes('bsub -q')) {
          return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: 'Job <777> is submitted to queue <normal>.\n', stderr: '', durationMs: 3 }))
        }
        if (cmd.includes('tar czf .batch_fetch.tgz')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: '512\n', stderr: '', durationMs: 3 }))
        if (cmd.includes('ls -1') && cmd.includes('sweep_progress.json')) {
          return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: 'sweep_progress.json\n', stderr: '', durationMs: 3 }))
        }
        if (cmd.includes('wc -l')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: `${existing}\n`, stderr: '', durationMs: 3 }))
        if (cmd.includes('ls -1') && cmd.includes('/home/op/sim')) return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: ls, stderr: '', durationMs: 3 }))
        if (cmd.includes('nohup sh -c') && cmd.includes('.hams_ssh_done')) {
          // scheduler=ssh launch: the detached block + the .worker_started readback
          return reply(ok({
            success: true, exitCode: 0, timedOut: false, durationMs: 5, stderr: '',
            stdout: '[hams] worker detached (stdout/stderr -> ssh_worker.log)\n__STARTED__\n'
              + '{"pid": 4242, "host": "node2", "started_at": "2026-01-01T00:00:00Z", "total_points": 2}\n',
          }))
        }
        return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 3 }))
      },
    },
  }
}

function makeRunDir({ template = 'template.scs', config, under } = {}) {
  const dir = under ? fs.mkdtempSync(path.join(under, 'hams-run-')) : tmp('hams-run-')
  fs.writeFileSync(path.join(dir, template), 'simulator lang=spectre\nparameters SW=@@SW@@\n')
  fs.writeFileSync(path.join(dir, 'sweep_config.json'), JSON.stringify(config || {
    netlist_template: 'template.scs',
    parameters: { SW: [0, 1] },
    sweep_mode: 'cross_product',
  }))
  return dir
}

// A planted project root whose workspace_config.json selects the working
// environment; run dirs created `under` it resolve their settings through the
// walk-up (readSettingsFor), exactly like a real project.
function makeProjectRoot(clusterEnv = 'in-cluster') {
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: clusterEnv, run_mode: 'local', machine_id: null, remote_root: null,
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
    },
  }, null, 2))
  return root
}

// A mocked ctx.shell seam (the in-cluster local executor): records every
// command and answers the same probe shapes the ssh mock does. Any ssh tool
// call throws — in-cluster paths must never touch dsh-ssh.
function makeShellCtx({ existing = 0, poll = null, project = null } = {}) {
  const proj = project ?? makeAnchoredProject('in-cluster')
  const commands = []
  const okExec = (stdout) => ({
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 30_000,
    stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false },
  })
  return {
    commands,
    __fixtureProject: proj,
    workspaceRegistry: registryFor(proj),
    shell: {
      resolve: (req) => ({ onExpiry: 'kill', stdoutMaxBytes: 1 << 20, ...req, workdir: req.workdir || process.cwd() }),
      execute: async (spec) => {
        const cmd = String(spec.command)
        commands.push(cmd)
        let stdout = ''
        if (cmd.includes('__BJOB__')) stdout = poll ? pollValue(poll).stdout : '__BJOB__\n777 RUN\n__META__\n2\n__DIRS__\n2\n__PROG__\n'
        else if (cmd.includes('wc -l')) stdout = `${existing}\n`
        else if (cmd.includes('bsub -q')) stdout = 'Job <777> is submitted to queue <normal>.\n'
        else if (cmd.includes('sleep 1; bjobs')) stdout = '777 RUN\n__STARTED__\n'
        else if (cmd.includes('ls -1') && cmd.includes('sweep_progress.json')) stdout = 'sweep_progress.json\n'
        return {
          status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
          readOutput: () => ({ delta: '', lossy: false }), kill: () => false,
          result: async () => okExec(stdout),
        }
      },
    },
    tools: {
      get: () => undefined,
      execute: async () => { throw new Error('in-cluster paths must not touch the ssh tools') },
    },
  }
}

// A POSIX-shaped "shared filesystem" root unique per call: on Windows Node
// resolves /x against the current drive, so the copies land on a real,
// cleanup-safe path either way.
function makeSharedRoot() {
  return `/hams_ic_${process.pid}_${Date.now()}`
}

function tool(ctx, name) {
  const def = toolDefinitions(ctx).find((d) => d.name === name)
  assert.ok(def, name)
  const t = makeTool(def)
  // D-021: inject the harness's anchored project as the explicit `project`
  // argument of every call (the session seam itself is covered in
  // server.test.mjs / selfcheck.test.mjs)
  const proj = ctx.__fixtureProject
  if (!proj) return t
  const run = t.execute
  t.execute = (args = {}, exec) => run({ project: proj, ...args }, exec)
  return t
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

  // The sibling assets bucket (D-015): snp_common resolves its numfallback
  // import at <scripts root>/../assets, so that is the one probe — absent in
  // the bare fixture, listed when planted next to a scripts root.
  assert.deepEqual(pluginAssets(SCRIPTS_ROOT), [], 'no sibling assets dir in the bare fixture')
  const base = tmp('hams-assets-')
  const aRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(aRoot, 'spectre'), { recursive: true })
  fs.mkdirSync(path.join(base, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(base, 'assets', 'numfallback.py'), '# fallback\n')
  fs.writeFileSync(path.join(base, 'assets', 'notes.txt'), 'ignored\n')
  const assets = pluginAssets(aRoot)
  assert.deepEqual(assets.map((a) => a.rel), ['numfallback.py'])
  assert.equal(assets[0].local, path.join(base, 'assets', 'numfallback.py'))
})

test('batch_submit resolves machine/root from the project settings and uploads the sibling assets bucket', async () => {
  const base = tmp('hams-fb-')
  const scriptsRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.mkdirSync(path.join(base, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  fs.writeFileSync(path.join(base, 'assets', 'numfallback.py'), '# fallback\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
    },
  }, null, 2))
  try {
    const run = makeRunDir({ under: root })
    const ctx = makeCtx({ project: root })
    // machine_id and remote_root deliberately omitted: both must resolve from
    // the project settings (D-021: the session-resolved project, injected by
    // the harness registry — no walk-up)
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.remote_dir, '/home/op/sim/batch1')
    const uploads = ctx.calls.filter((c) => c.name === 'ssh_upload')
      .map((c) => c.arguments.remotePath)
    assert.ok(uploads.includes('/home/op/sim/.harnessams/scripts/spectre/spectre_sweep_worker.py'),
      'worker uploaded from the configured scripts root')
    assert.ok(uploads.includes('/home/op/sim/.harnessams/assets/numfallback.py'),
      'the sibling assets bucket uploads beside the scripts root (D-015)')
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// D-021 (read-side reconcile): a hand-edited AGENTS.md yaml row takes effect
// at the very next batch_submit read — no write in between; an illegal row
// keeps the stored value and warns into the submit result.
test('batch_submit overlays a hand-edited AGENTS.md block at READ time (D-021)', async () => {
  const base = tmp('hams-ov-')
  const scriptsRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  const settings = {
    cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
    selfcheck_remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
    compute_script_local: 'python', compute_script_remote: 'python',
  }
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1, settings,
  }, null, 2))
  try {
    // a values sync marks the block (synced_at); the hand-edit then rewrites
    // the remote_root row to a different root
    await syncAgentsMd({}, { project: { path: root, title: 'P' }, settings })
    const file = path.join(root, 'AGENTS.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  remote_root: "/home/op/sim"', '  remote_root: "/home/op/other"'))
    const run = makeRunDir({ under: root })
    const res = await tool(makeCtx({ project: root }), 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.remote_dir, '/home/op/other/batch1', 'the hand-edited remote_root won at read time')

    // an illegal row (a bare-name interpreter pin): the stored value stands and
    // the submit result carries the warning
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace('  remote_root: "/home/op/other"', '  remote_root: "/home/op/sim"')
      .replace('  remote_python: null', '  remote_python: "python3"'))
    const res2 = await tool(makeCtx({ project: root }), 'batch_submit').execute({
      run_dir: makeRunDir({ under: root }), remote_dir: 'batch2', worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res2.ok, true, JSON.stringify(res2))
    assert.match(res2.warnings.join('\n'), /remote_python .*not adopted/)
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 2026-11-25: PEND right after bsub is the expected state (queueing), not a
// failure — the submit result says queued with zero failure-shaped warnings
// (the old wording "post-submit verification failed: <job> PEND" + "no
// .worker_started marker yet" fired on every healthy queued submit).
test('batch_submit classifies a queued (PEND) job as expected — state queued, no warnings', async () => {
  const base = tmp('hams-pend-')
  const scriptsRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
    },
  }, null, 2))
  try {
    const run = makeRunDir({ under: root })
    const ctx = makeCtx({ project: root, post: '777 PEND\n' })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.state, 'queued')
    assert.deepEqual(res.warnings, [])
    assert.equal(res.job_id, '777')
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 2026-11-26: the second-hop (ProxyJump) policy — a dsh-ssh entry without a
// jump chain still runs DIRECT (never blocked), but the submit result warns;
// an entry carrying a jump chain stays silent. An alias entirely absent from
// the registry remains the hard up-front error (resolveMachine, unchanged).
test('batch_submit second-hop policy: no ProxyJump warns and still runs direct; a jump chain stays silent', async () => {
  const base = tmp('hams-jump-')
  const scriptsRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'lab9', remote_root: '/home/op/sim',
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
    },
  }, null, 2))
  try {
    const run = makeRunDir({ under: root })
    const ctx = makeCtx({ project: root, post: '777 PEND\n' })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    // the direct connection runs: the submit succeeds and the warning rides
    // the result (2026-11-26 ruling: warn, never block)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.state, 'queued')
    assert.ok(res.warnings.some((w) => /no ProxyJump \(second hop\)/.test(String(w))), JSON.stringify(res.warnings))

    // a machine with a jump chain carries no second-hop warning
    const run2 = makeRunDir({ under: root })
    const res2 = await tool(ctx, 'batch_submit').execute({
      run_dir: run2, remote_dir: 'batch2', machine_id: 'node1', worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res2.ok, true, JSON.stringify(res2))
    assert.ok(!res2.warnings.some((w) => /ProxyJump/.test(String(w))), JSON.stringify(res2.warnings))
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 2026-11-25 (D-019): the session-level Max-points-per-scan gate. A 222-point
// sweep_config against the calling session's limit of 100 rejects before any
// upload; raising the session field to 250 lets the same scan through.
test('batch_submit enforces the session max-points-per-scan gate (D-019)', async () => {
  const base = tmp('hams-mp-')
  const scriptsRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
    },
  }, null, 2))
  const sessionsFile = path.join(root, '.harnessams', 'sessions.json')
  const writeSessions = (limit) => fs.writeFileSync(sessionsFile, JSON.stringify({
    version: 2,
    sessions: { 'sess-gate': { display: 'session', reports: [], max_points_per_scan: limit } },
  }, null, 2))
  try {
    const cpf = Array.from({ length: 111 }, (_, i) => String(i + 10)) // 111 x 2 = 222 points
    const run = makeRunDir({ under: root, config: {
      netlist_template: 'template.scs',
      parameters: { cpf, SW: [0, 1] },
      sweep_mode: 'cross_product',
    } })
    const exec = { agent: { id: 'sess-gate' } }
    writeSessions(100)
    const gateCtx = makeCtx({ project: root })
    await assert.rejects(tool(gateCtx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, exec), /max points per scan: 222 > 100/)
    // the reject happens before anything is staged: no ssh call left the mock
    assert.equal(gateCtx.calls.length, 0)
    writeSessions(250)
    const res = await tool(makeCtx({ project: root }), 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, exec)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.state, 'running')
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 2026-11-26: the subagent anchoring policy (src/subagent.js). A delegated
// subagent's own id is never workspace-accounted; its effective id is the
// topmost user-visible ancestor, so the D-019 gate reads the USER session's
// limit and the nested pre-check call carries the USER session's id. The
// fixture drops makeCtx's explicit `project` injection and accounts only the
// ancestor session in the registry — the lineage walk is the only way
// through.
test('batch_submit anchors a subagent call on the ancestor session (D-019 gate + nested pre-check id)', async () => {
  const base = tmp('hams-sub-')
  const scriptsRoot = path.join(base, 'scripts')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), '# worker\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const root = tmp('hams-proj-')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
    },
  }, null, 2))
  const sessionsFile = path.join(root, '.harnessams', 'sessions.json')
  const writeSessions = (limit) => fs.writeFileSync(sessionsFile, JSON.stringify({
    version: 2,
    sessions: { 'sess-user': { display: 'session', reports: [], max_points_per_scan: limit } },
  }, null, 2))
  try {
    const cpf = Array.from({ length: 111 }, (_, i) => String(i + 10)) // 111 x 2 = 222 points
    const run = makeRunDir({ under: root, config: {
      netlist_template: 'template.scs',
      parameters: { cpf, SW: [0, 1] },
      sweep_mode: 'cross_product',
    } })
    // only the ANCESTOR is accounted; the child resolves through the walk
    const userAgent = { id: 'sess-user', session: { header: {} } }
    const ctx = makeCtx({ project: root })
    delete ctx.__fixtureProject // no explicit project injection
    ctx.workspaceRegistry = { list: () => [{ id: 'ws-fixture', path: root, title: 'fixture', sessionIds: ['sess-user'] }] }
    const agents = new Map([['sess-user', userAgent]])
    ctx.agents = { get: (id) => agents.get(id) }
    const exec = { agent: {
      id: 'sess-child',
      session: { header: { origin: 'subagent', parentSession: 'sess-user', isSeeded: true } },
    } }
    writeSessions(100)
    await assert.rejects(tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, exec), /max points per scan: 222 > 100/)
    assert.equal(ctx.calls.length, 0, 'the reject happens before anything is staged')
    // raise the user session's limit and submit through: the nested
    // spectre_pre_check call must carry the ANCESTOR session id
    writeSessions(250)
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', worker: 'spectre/spectre_sweep_worker.py',
    }, exec)
    assert.equal(res.ok, true, JSON.stringify(res))
    const preCheck = ctx.calls.find((c) => c.name === 'spectre_pre_check')
    assert.ok(preCheck, 'the built-in gate ran')
    assert.equal(preCheck.arguments.session_id, 'sess-user')
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
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
  // Live-sampled 2026-11-22: a progress file written WITHOUT a trailing newline
  // makes the shell splice `cat sweep_progress.json` straight into `echo __ERR__`
  // (`}__ERR__`). The section split must tolerate the missing boundary newline
  // — before the fix this shape silently parsed progress to null (succeeded 0).
  const noNl = '__BJOB__\n777 RUN\n__META__\n1\n__DIRS__\n1\n__PROG__\n'
    + '{"status": "running", "total_points": 2, "completed": 1, "succeeded": 1, "failed": 0,'
    + ' "simulator": "fake", "compute_node": "node3"}__ERR__\n'
  const spliced = parsePollOutput(noNl, { total: 2 })
  assert.equal(spliced.succeeded, 1)
  assert.equal(spliced.compute_node, 'node3')
  assert.equal(spliced.errlog_tail, null)
})

test('submit/ssh commands carry the replay idempotency guards (and bsub -m)', () => {
  const submit = buildSubmitCommand({
    remoteDir: '/home/op/sim/batch1', python: 'python3',
    workerPath: '/root/.harnessams/scripts/spectre/spectre_sweep_worker.py', workerArgs: [],
  })
  // marker read-back (twice: fast path + inside the flock) + flock + write-on-success
  assert.ok((submit.match(/cat \.hams_submitted/g) ?? []).length >= 2, 'marker must be read back, not skipped')
  assert.ok(submit.includes('flock 9'), 'flock serializes concurrent first attempts')
  assert.ok(submit.includes('| tee .hams_submitted'), 'marker written with the bsub output')
  assert.ok(submit.includes('"$rc" -eq 0'), 'marker only written when bsub exits 0')
  assert.ok(!submit.includes('-m'), 'no host pin without lsf_node')

  // lsf_node pins the job (bsub -m "<node>"): single host or host list
  const pinned = buildSubmitCommand({
    remoteDir: '/home/op/sim/batch1', python: 'python3',
    workerPath: '/w/spectre_sweep_worker.py', workerArgs: [], node: 'node2',
  })
  assert.match(pinned, /-m "node2"/)
  const pinnedList = buildSubmitCommand({
    remoteDir: '/home/op/sim/batch1', python: 'python3',
    workerPath: '/w/spectre_sweep_worker.py', workerArgs: [], node: 'node2 node3',
  })
  assert.match(pinnedList, /-m "node2 node3"/)

  const ssh = buildSshCommand({
    remoteDir: '/home/op/sim/fore', python: 'python3',
    workerPath: '/root/.harnessams/scripts/spectre/spectre_sweep_worker.py', workerArgs: [],
  })
  assert.ok((ssh.match(/\.hams_ssh_done/g) ?? []).length >= 3, 'done marker checked twice + touched')
  assert.ok(ssh.includes('flock 9'), 'ssh also serializes replays behind a live run')
  assert.ok(ssh.includes('&& touch .hams_ssh_done'), 'marker written only on worker success')
  assert.ok(!submit.includes('rm -f .hams_submitted'), 'plain submit never clears markers')

  // overwrite=true (2026-11-23): a finished batch re-runs — stale markers are
  // cleared under the lock, and the fresh markers carry a tag so a replay of
  // the SAME overwrite call still short-circuits instead of double-running
  const ow = buildSubmitCommand({
    remoteDir: '/home/op/sim/batch1', python: 'python3',
    workerPath: '/w/spectre_sweep_worker.py', workerArgs: [], overwrite: true,
  })
  assert.match(ow, /rm -f \.hams_submitted \.hams_ssh_done/, 'stale markers cleared')
  assert.match(ow, /grep -q "\^#hams-overwrite" \.hams_submitted/, 'a tagged fresh marker still short-circuits')
  assert.match(ow, /#hams-overwrite\\n' "\$out"/, 'the marker this run writes is tagged')

  const owSsh = buildSshCommand({
    remoteDir: '/home/op/sim/fore', python: 'python3',
    workerPath: '/w/spectre_sweep_worker.py', workerArgs: [], overwrite: true,
  })
  assert.match(owSsh, /rm -f \.hams_submitted \.hams_ssh_done/, 'ssh clears both markers too')
  assert.match(owSsh, /#hams-overwrite\\+n' > \.hams_ssh_done/, 'the done marker is tagged')
})

test('batch_submit uploads the worker scripts tree and run files, then records the job', async () => {
  const run = makeRunDir()
  try {
    const ctx = makeCtx()
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'batch1',
      machine_id: 'node1',
      remote_root: '/home/op/sim',
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

test('batch_submit runs the SmartAnaSim netlist pre-check before staging (D-020)', async () => {
  try {
    const run = makeRunDir()
    const ctx = makeCtx()
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, { agent: { id: 'session-aaaa1111-2222-3332-4444-555555555555' } })
    assert.equal(res.ok, true, JSON.stringify(res))
    // the check ran BEFORE any staging, and the session id rode along so the
    // check-param chain resolves the calling session's confirmed table
    const pre = ctx.calls.find((c) => c.name === 'spectre_pre_check')
    assert.ok(pre, 'the pre-check ran')
    assert.equal(pre.arguments.run_dir, run)
    assert.equal(pre.arguments.session_id, 'session-aaaa1111-2222-3332-4444-555555555555')
    assert.ok(ctx.calls.findIndex((c) => c.name === 'spectre_pre_check')
      < ctx.calls.findIndex((c) => c.name === 'ssh_upload'), 'check precedes uploads')
    // pre-check warnings ride into the submit result
    const ctx2 = makeCtx({ preCheck: { warnings: ['params: swept parameter SW is never referenced by the circuit'] } })
    const res2 = await tool(ctx2, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch2', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.ok(res2.warnings.some((w) => String(w).includes('never referenced')),
      JSON.stringify(res2.warnings))
  } finally {
    restoreEnv()
  }
})

test('batch_submit fails closed on pre-check errors; no_pre_check waives, a missing tool warns', async () => {
  try {
    const run = makeRunDir()
    const base = {
      run_dir: run, machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }
    // errors -> the submit throws with the findings and the waiver hint,
    // before anything is staged
    const ctx = makeCtx({ preCheck: { fail: true } })
    await assert.rejects(() => tool(ctx, 'batch_submit').execute(
      { ...base, remote_dir: 'batch1' }, {}), (e) => {
      assert.match(String(e.message), /spectre pre-check failed/)
      assert.match(String(e.message), /no_pre_check: true/)
      assert.match(String(e.message), /simulator lang=spectre/)
      return true
    })
    assert.ok(!ctx.calls.some((c) => c.name === 'ssh_upload'), 'nothing staged after a failed pre-check')
    // no_pre_check: true skips the check entirely
    const ctx2 = makeCtx({ preCheck: { fail: true } })
    const res = await tool(ctx2, 'batch_submit').execute(
      { ...base, remote_dir: 'batch3', no_pre_check: true }, {})
    assert.equal(res.ok, true)
    assert.ok(!ctx2.calls.some((c) => c.name === 'spectre_pre_check'), 'the check is skipped')
    // a missing tool is fail-open: the submit proceeds with a warning
    const ctx3 = makeCtx({ preCheck: { missing: true } })
    const res3 = await tool(ctx3, 'batch_submit').execute(
      { ...base, remote_dir: 'batch4' }, {})
    assert.equal(res3.ok, true)
    assert.ok(res3.warnings.some((w) => String(w).includes('spectre_pre_check is not registered')),
      JSON.stringify(res3.warnings))
  } finally {
    restoreEnv()
  }
})

test('batch_submit rejects a worker outside the scripts root with guidance', async () => {
  try {
    const ctx = makeCtx()
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/no_such_worker.py',
    }, {}), /worker script not found under the project sim_scripts_dir/)
  } finally {
    restoreEnv()
  }
})

test('batch_submit scheduler=ssh launches the worker detached on the target host (no bsub)', async () => {
  const run = makeRunDir()
  try {
    const ctx = makeCtx()
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'fore',
      machine_id: 'node1',
      remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
      scheduler: 'ssh',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.scheduler, 'ssh')
    // D-028: a quick launch returns the non-terminal state — the mocked worker
    // reports its .worker_started marker, so the startup verification maps to running
    assert.equal(res.state, 'running')
    assert.match(res.output, /worker detached/)

    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.scheduler, 'ssh')
    assert.equal(job.queue, null)
    assert.equal(job.cluster_env, 'out-of-cluster')
    assert.match(job.job_id, /^ssh-/)
    assert.equal(job.remote_dir, '/home/op/sim/fore')

    const launch = ctx.calls.find((c) => c.name === 'ssh_exec'
      && String(c.arguments.command).includes('spectre_sweep_worker.py'))
    assert.ok(launch, 'ssh worker command sent')
    const ssh = String(launch.arguments.command).replace(/\\+"/g, '"')
    assert.match(ssh, /"--work-dir" "\/home\/op\/sim\/fore"/)
    assert.ok(ssh.includes('.hams_ssh_done'), 'ssh run carries the done-marker guard')
    // D-028 shape: the guarded block is backgrounded with every fd redirected
    // (survives the channel closing) and the foreground waits for the marker
    assert.ok(ssh.includes('nohup sh -c'), 'guarded block runs under nohup')
    assert.ok(ssh.includes('> ssh_worker.log 2>&1 < /dev/null &'), 'worker fds redirected away from the channel')
    assert.match(ssh, /while \[ \\?\$i -lt 20 \]/, 'bounded startup wait')
    assert.ok(ssh.includes('.worker_started'), 'startup wait watches the worker marker')
    assert.ok(ssh.includes('__STARTED__'), 'startup verification marker in the launch output')
    // the exec budget is launch-scale (60 s + execRemote's 90 s headroom), NOT the retired 600 s per-run deadline
    assert.equal(launch.arguments.timeoutMs, 150_000)
  } finally {
    restoreEnv()
  }
})

test('scheduler=local: detached worker + local poll, zero ssh (in-cluster project)', async () => {
  // out-of-cluster (a bare temp run dir, no .harnessams walk-up hit) rejects
  // scheduler=local up front — the host cannot run the worker
  await assert.rejects(() => tool(makeCtx(), 'batch_submit').execute({
    run_dir: makeRunDir(), worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local',
  }, {}), /requires cluster_env=in-cluster/)

  // a runnable fake worker under a private scripts root (the shared fixture
  // tree is a stub whose upload manifest is pinned by another test)
  const scriptsRoot = tmp('hams-local-')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), [
    'import json, os, sys',
    'wd = sys.argv[sys.argv.index("--work-dir") + 1]',
    'prog = {"status": "completed", "total_points": 2, "completed": 2, "succeeded": 2, "failed": 0,',
    '        "simulator": "spectre", "compute_node": "local", "points": [], "updated_at": "2026-11-23T00:00:00Z"}',
    'tmp = os.path.join(wd, "sweep_progress.json.tmp")',
    'with open(tmp, "w") as f: json.dump(prog, f)',
    'os.replace(tmp, os.path.join(wd, "sweep_progress.json"))',
  ].join('\n'))
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const proj = makeProjectRoot('in-cluster')
  const run = makeRunDir({ under: proj })
  try {
    const ctx = makeCtx({ project: proj })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      worker: 'spectre/spectre_sweep_worker.py',
      scheduler: 'local',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.scheduler, 'local')
    assert.equal(res.state, 'running')
    assert.equal(typeof res.pid, 'number')
    // zero SSH hops — but the netlist pre-check (D-020) did run as a tool call
    assert.equal(ctx.calls.filter((c) => c.name.startsWith('ssh_')).length, 0, 'local submit touches no ssh tool')
    assert.ok(ctx.calls.some((c) => c.name === 'spectre_pre_check'), 'the pre-check ran before the local spawn')

    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.scheduler, 'local')
    assert.equal(job.total_points, 2)
    assert.ok(fs.existsSync(path.join(run, '.batch_local.out')))
    assert.ok(fs.existsSync(path.join(run, '.batch_local.err')))

    // wait_sec re-polls the local ladder until the worker's progress lands
    const poll = await tool(ctx, 'batch_poll').execute({ run_dir: run, wait_sec: 1 }, {})
    assert.equal(poll.ok, true)
    assert.equal(poll.scheduler, 'local')
    assert.equal(poll.state, 'completed')
    assert.equal(poll.completed, 2)
    assert.deepEqual(poll.fetched, []) // nothing to pull for a local run — and the payload says so
    assert.match(poll.fetched_note, /already live in run_dir/)
    // the only recorded tool call is the submit-time pre-check; the poll
    // itself reads the run directory's own files — never an ssh hop
    assert.equal(ctx.calls.filter((c) => c.name.startsWith('ssh_')).length, 0, 'local poll reads files only')

    // a worker that dies at startup is a FAILED frame carrying its stderr — not
    // "running" until wait_sec runs out (the blocking poll used to burn its
    // whole window on a corpse)
    const workerFile = path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py')
    fs.writeFileSync(workerFile, [
      'import sys',
      'print("fake worker: unrecognized arguments --nope", file=sys.stderr)',
      'sys.exit(3)',
    ].join('\n'))
    const crashRun = makeRunDir({ under: proj })
    await tool(ctx, 'batch_submit').execute({ run_dir: crashRun, worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local' }, {})
    const crashed = await tool(ctx, 'batch_poll').execute({ run_dir: crashRun, wait_sec: 1 }, {})
    assert.equal(crashed.state, 'failed')
    assert.equal(crashed.completed, 0)
    assert.match(crashed.errlog_tail, /unrecognized arguments --nope/)

    // a worker that dies mid-run (its last tick still says running) is failed too
    fs.writeFileSync(workerFile, [
      'import json, os, sys',
      'wd = sys.argv[sys.argv.index("--work-dir") + 1]',
      'prog = {"status": "running", "total_points": 2, "completed": 1, "succeeded": 1, "failed": 0, "points": []}',
      'tmp = os.path.join(wd, "sweep_progress.json.tmp")',
      'with open(tmp, "w") as f: json.dump(prog, f)',
      'os.replace(tmp, os.path.join(wd, "sweep_progress.json"))',
    ].join('\n'))
    const midRun = makeRunDir({ under: proj })
    await tool(ctx, 'batch_submit').execute({ run_dir: midRun, worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local' }, {})
    const died = await tool(ctx, 'batch_poll').execute({ run_dir: midRun, wait_sec: 1 }, {})
    assert.equal(died.state, 'failed')
    assert.equal(died.completed, 1)

    // sim_scripts_dir naming an existing directory IS the scripts root (the
    // documented override) and wins over the env/project default — a custom
    // worker tree runs as handed, not the stock worker (2026-11-23 instance check)
    const otherRoot = tmp('hams-local-root-')
    fs.mkdirSync(path.join(otherRoot, 'spectre'), { recursive: true })
    fs.writeFileSync(path.join(otherRoot, 'spectre', 'spectre_sweep_worker.py'), 'import sys; sys.exit(0)\n')
    const override = await tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir({ under: proj }), worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local', sim_scripts_dir: otherRoot,
    }, {})
    assert.equal(override.ok, true, JSON.stringify(override))
    const overrideJob = JSON.parse(fs.readFileSync(override.job_file, 'utf8'))
    assert.equal(overrideJob.worker, path.join(otherRoot, 'spectre', 'spectre_sweep_worker.py'))

    // no python on PATH: the submit rejects cleanly (an unlistened spawn 'error'
    // is an uncaught exception in the host) and leaves no job file to poll
    const savedPath = process.env.PATH
    process.env.PATH = tmp('hams-local-nopath-')
    try {
      const noPythonRun = makeRunDir({ under: proj })
      await assert.rejects(
        () => tool(ctx, 'batch_submit').execute({ run_dir: noPythonRun, worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local' }, {}),
        /cannot start the local worker/)
      assert.ok(!fs.existsSync(path.join(noPythonRun, '.batch_job.json')))
    } finally {
      process.env.PATH = savedPath
    }
    assert.equal(ctx.calls.filter((c) => c.name.startsWith('ssh_')).length, 0, 'none of the local paths touches an ssh tool')
  } finally {
    restoreEnv()
  }
})

test('batch_poll reads the job file, reports completed and auto-fetches the result files', async () => {
  const run = makeRunDir()
  try {
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '/home/op/sim/batch1', job_id: '777', total_points: 2,
    }))
    const ctx = makeCtx({ poll: { meta: 2, total: 2 } })
    const res = await tool(ctx, 'batch_poll').execute({ run_dir: run }, {})
    assert.equal(res.ok, true)
    assert.equal(res.state, 'completed')
    assert.equal(res.completed, 2)
    assert.equal(res.job_id, '777')
    // terminal poll absorbed fetch: the light result files landed in run_dir
    assert.deepEqual(res.fetched, ['sweep_progress.json'])
    const prog = JSON.parse(fs.readFileSync(path.join(run, 'sweep_progress.json'), 'utf8'))
    assert.equal(prog.status, 'completed')
  } finally {
    restoreEnv()
  }
})

test('batch_poll wait_sec (D-008): a terminal first poll breaks immediately, no re-poll', async () => {
  const run = makeRunDir()
  try {
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '/home/op/sim/batch1', job_id: '777', total_points: 2,
    }))
    const ctx = makeCtx({ poll: { meta: 2, total: 2 } })
    const res = await tool(ctx, 'batch_poll').execute({ run_dir: run, wait_sec: 30 }, {})
    assert.equal(res.ok, true)
    assert.equal(res.state, 'completed')
    assert.equal(res.completed, 2)
    assert.equal(res.scheduler, 'lsf') // payload shape unchanged by wait_sec
    const polls = ctx.calls.filter((c) => c.name === 'ssh_exec' && String(c.arguments.command).includes('__BJOB__'))
    assert.equal(polls.length, 1)
  } finally {
    restoreEnv()
  }
})

test('batch_poll wait_sec (D-008): re-polls through a running batch until it settles', async () => {
  const run = makeRunDir()
  try {
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '/home/op/sim/batch1', job_id: '777', total_points: 2,
    }))
    // first poll: 1/2 running; the ~10 s gap is clamped to the 1 s deadline,
    // so the second poll (scripted completed) runs ~1 s in and breaks the loop
    const ctx = makeCtx({ pollSeq: [
      { meta: 1, total: 2, status: 'running', bjobs: '777 RUN' },
      { meta: 2, total: 2 },
    ] })
    const res = await tool(ctx, 'batch_poll').execute({ run_dir: run, wait_sec: 1 }, {})
    assert.equal(res.ok, true)
    assert.equal(res.state, 'completed') // the LAST payload wins
    assert.equal(res.completed, 2)
    const polls = ctx.calls.filter((c) => c.name === 'ssh_exec' && String(c.arguments.command).includes('__BJOB__'))
    assert.equal(polls.length, 2)
  } finally {
    restoreEnv()
  }
})

test('batch_poll wait_sec (D-008): deadline returns the last (non-terminal) payload', async () => {
  const run = makeRunDir()
  try {
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '/home/op/sim/batch1', job_id: '777', total_points: 2,
    }))
    const ctx = makeCtx({ pollSeq: [{ meta: 1, total: 2, status: 'running', bjobs: '777 RUN' }] })
    const res = await tool(ctx, 'batch_poll').execute({ run_dir: run, wait_sec: 1 }, {})
    assert.equal(res.ok, true)
    assert.equal(res.state, 'running') // never settled within the deadline
    assert.equal(res.completed, 1)
  } finally {
    restoreEnv()
  }
})

test('batch tools reject escaped paths and unresolvable machines', async () => {
  try {
    const ctx = makeCtx()
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim', worker: '../evil.py',
    }, {}), /unsafe relative path/)

    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: '../evil', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /escapes the remote workspace/)

    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
      remote_scripts_dir: '/tmp/elsewhere', sync_scripts: true,
    }, {}), /remote_scripts_dir must be under the remote workspace/)

    // machine_id falls back to the project settings first (2026-11-24); with
    // no configured machine either, the rejection comes from machine resolution
    // (the resolveMachine unit surface — ghost host, root-required, alias
    // resolution — lives in server.test.mjs)
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /no machine configured for this project/)
  } finally {
    restoreEnv()
  }
})

test('batch_submit enforces the template*.scs family convention (own name + declared match)', async () => {
  try {
    // declared-vs-uploaded mismatch is caught before anything is submitted
    const run = makeRunDir({
      template: 'template_thorough.scs',
      config: { netlist_template: 'template.scs', parameters: { SW: [0, 1] } },
    })
    const ctx = makeCtx()
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: run, remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /netlist_template is "template\.scs" but the run directory holds "template_thorough\.scs"/)

    // declared + matching: the file uploads under its OWN name (no rename)
    const run2 = makeRunDir({
      template: 'template_thorough.scs',
      config: { netlist_template: 'template_thorough.scs', parameters: { SW: [0, 1] } },
    })
    await tool(ctx, 'batch_submit').execute({
      run_dir: run2, remote_dir: 'batch2', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    const uploads = ctx.calls.filter((c) => c.name === 'ssh_upload')
      .map((c) => c.arguments.remotePath)
    assert.ok(uploads.includes('/home/op/sim/batch2/template_thorough.scs'), uploads.join('\n'))
    assert.ok(!uploads.some((p) => p.endsWith('/batch2/template.scs')), uploads.join('\n'))
  } finally {
    restoreEnv()
  }
})

test('batch_submit auto-names the remote dir Sim<N>_<date>_batch<M> when remote_dir is omitted', async () => {
  try {
    const ctx = makeCtx({ ls: 'Sim0_20260805_batch1\nSim0_20260805_batch2\nSim1_20260806_batch1\nmisc\n' })
    const out = await tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    // Sim1 is the highest index but dated yesterday -> new index, batch1; the
    // auto-name lands under <remote_root>/RawResults (D-006 layout)
    const today = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`
    assert.equal(out.remote_dir, `/home/op/sim/RawResults/Sim2_${stamp}_batch1`, out.remote_dir)

    const ctx2 = makeCtx({ ls: `Sim2_${stamp}_batch1\n` }) // same index, today -> batch+1
    const out2 = await tool(ctx2, 'batch_submit').execute({
      run_dir: makeRunDir(), machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(out2.remote_dir, `/home/op/sim/RawResults/Sim2_${stamp}_batch2`, out2.remote_dir)

    // the auto-name path probes the remote root strictly, then lists the
    // RawResults base tolerantly (shq single-quotes paths; match parts)
    const lsCall = ctx2.calls.find((c) => {
      const cmd = String(c.arguments?.command || '')
      return cmd.includes('ls -1') && cmd.includes('/home/op/sim/RawResults')
    })
    assert.ok(lsCall, 'RawResults listing issued')
    assert.ok(String(lsCall.arguments?.command || '').includes('__NOROOT__'), 'root probe marker present')
  } finally {
    restoreEnv()
  }
})

test('batch_submit surfaces upload failures and refuses to clobber a batch', async () => {
  try {
    const ctx = makeCtx({ failUpload: true })
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /upload failed/)

    const clobberCtx = makeCtx({ existing: 3 })
    await assert.rejects(() => tool(clobberCtx, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch1', machine_id: 'node1', remote_root: '/home/op/sim',
      worker: 'spectre/spectre_sweep_worker.py',
    }, {}), /already holds 3 point_meta\.json/)
  } finally {
    restoreEnv()
  }
})

test('nextSimDir: Sim<N>_<date>_batch<M> naming rules (2026-11-21 convention)', () => {
  // empty root -> Sim0 batch1
  assert.equal(nextSimDir([], '20261121'), 'Sim0_20261121_batch1')
  assert.equal(nextSimDir(['misc', 'Round1', 'sim0_x'], '20261121'), 'Sim0_20261121_batch1')
  // highest index dated today -> same index, batch+1 (not lexicographic: batch9 -> batch10)
  assert.equal(nextSimDir(['Sim2_20261121_batch9'], '20261121'), 'Sim2_20261121_batch10')
  // numeric index ordering beats lexicographic (Sim10 > Sim9, not the reverse)
  assert.equal(nextSimDir(['Sim9_20261120_batch1', 'Sim10_20261120_batch3'], '20261121'),
    'Sim11_20261121_batch1')
  // highest index dated another day -> new index, batch1
  assert.equal(nextSimDir(['Sim0_20260805_batch1', 'Sim0_20260805_batch2', 'Sim1_20260806_batch1'], '20261121'),
    'Sim2_20261121_batch1')
  // same highest index across days: its latest batch still governs
  assert.equal(nextSimDir(['Sim1_20260805_batch4', 'Sim1_20261120_batch2'], '20261121'),
    'Sim2_20261121_batch1')
})

test('in-cluster LSF (D-002): bsub through ctx.shell, transfers are local copies, no ssh', async () => {
  const proj = makeProjectRoot('in-cluster')
  const shared = makeSharedRoot()
  const localShared = path.resolve(shared)
  try {
    const ctx = makeShellCtx()
    const run = makeRunDir({ under: proj })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'batch1',
      remote_root: shared,
      worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.job_id, '777')
    assert.equal(res.state, 'running')

    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.scheduler, 'lsf')
    assert.equal(job.cluster_env, 'in-cluster')
    assert.equal(job.machine_id, null, 'in-cluster LSF needs no machine')

    // bsub ran through the local shell seam, without a host pin
    const bsub = ctx.commands.find((c) => c.includes('bsub -q'))
    assert.ok(bsub, 'local bsub command issued')
    assert.ok(!bsub.includes('-m '), 'no bsub -m without lsf_node')
    assert.ok(bsub.includes(`"--work-dir" "${shared}/batch1"`), bsub)

    // "transfers" landed as plain local copies on the shared root: run files
    // and the synced scripts tree (drive-resolved on Windows)
    assert.ok(fs.existsSync(path.join(localShared, 'batch1', 'template.scs')))
    assert.ok(fs.existsSync(path.join(localShared, 'batch1', 'sweep_config.json')))
    assert.ok(fs.existsSync(path.join(localShared, '.harnessams', 'scripts', 'spectre', 'spectre_sweep_worker.py')))
  } finally {
    fs.rmSync(localShared, { recursive: true, force: true })
    restoreEnv()
  }
})

test('lsf_node pins bsub -m and validates its token shape', async () => {
  const proj = makeProjectRoot('in-cluster')
  const shared = makeSharedRoot()
  const localShared = path.resolve(shared)
  try {
    const ctx = makeShellCtx()
    const run = makeRunDir({ under: proj })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'batch1',
      remote_root: shared,
      worker: 'spectre/spectre_sweep_worker.py',
      lsf_node: 'node2',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    const bsub = ctx.commands.find((c) => c.includes('bsub -q'))
    assert.match(bsub, /-m "node2"/)
    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.lsf_node, 'node2')

    // shell metacharacters are refused; the pin applies to lsf only
    await assert.rejects(() => tool(makeShellCtx(), 'batch_submit').execute({
      run_dir: makeRunDir({ under: proj }), remote_dir: 'b2', remote_root: shared,
      worker: 'spectre/spectre_sweep_worker.py', lsf_node: 'a;b',
    }, {}), /invalid lsf_node/)
    await assert.rejects(() => tool(makeCtx(), 'batch_submit').execute({
      run_dir: makeRunDir({ under: proj }), remote_dir: 'b3', remote_root: '/home/op/sim',
      machine_id: 'node1', worker: 'spectre/spectre_sweep_worker.py',
      scheduler: 'ssh', lsf_node: 'node2',
    }, {}), /lsf_node applies to scheduler="lsf" only/)
  } finally {
    fs.rmSync(localShared, { recursive: true, force: true })
    restoreEnv()
  }
})

test('in-cluster LSF poll (D-002): reads bjobs and fetches results locally', async () => {
  const proj = makeProjectRoot('in-cluster')
  const shared = makeSharedRoot()
  const localShared = path.resolve(shared)
  try {
    const run = makeRunDir({ under: proj })
    fs.mkdirSync(path.join(localShared, 'batch1'), { recursive: true })
    fs.writeFileSync(path.join(localShared, 'batch1', 'sweep_progress.json'),
      JSON.stringify({ status: 'completed', total_points: 2, completed: 2, succeeded: 2, failed: 0 }))
    fs.writeFileSync(path.join(run, '.batch_job.json'), JSON.stringify({
      machine_id: null, remote_root: shared, remote_dir: shared + '/batch1', job_id: '777',
      scheduler: 'lsf', cluster_env: 'in-cluster', total_points: 2,
    }))
    const ctx = makeShellCtx({ poll: { meta: 2, total: 2 } })
    const res = await tool(ctx, 'batch_poll').execute({ run_dir: run }, {})
    assert.equal(res.ok, true)
    assert.equal(res.state, 'completed')
    assert.equal(res.completed, 2)
    assert.equal(res.scheduler, 'lsf')
    assert.ok(ctx.commands.some((c) => c.includes('bjobs')), 'bjobs ran through the local seam')
    // terminal auto-fetch = a plain local copy into the run dir
    assert.deepEqual(res.fetched, ['sweep_progress.json'])
    assert.ok(fs.existsSync(path.join(run, 'sweep_progress.json')))
  } finally {
    fs.rmSync(localShared, { recursive: true, force: true })
    restoreEnv()
  }
})

test('in-cluster scheduler=ssh (D-002): exec over ssh, staging stays a local copy', async () => {
  const proj = makeProjectRoot('in-cluster')
  const shared = makeSharedRoot()
  const localShared = path.resolve(shared)
  try {
    const ctx = makeCtx({ project: proj })
    const run = makeRunDir({ under: proj })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: run,
      remote_dir: 'fore',
      machine_id: 'node1',
      remote_root: shared,
      worker: 'spectre/spectre_sweep_worker.py',
      scheduler: 'ssh',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.scheduler, 'ssh')
    assert.equal(res.state, 'running')

    const job = JSON.parse(fs.readFileSync(path.join(run, '.batch_job.json'), 'utf8'))
    assert.equal(job.cluster_env, 'in-cluster')
    assert.equal(job.machine_id, 'node1')

    // the run crossed ssh (worker command), but NO sftp: staging was a local copy
    const sshCalls = ctx.calls.filter((c) => c.name === 'ssh_exec')
      .map((c) => String(c.arguments.command).replace(/\\"/g, '"'))
    assert.ok(sshCalls.some((c) => c.includes('spectre_sweep_worker.py') && c.includes('.hams_ssh_done')),
      'ssh worker command sent with the done-marker guard')
    assert.equal(ctx.calls.filter((c) => c.name === 'ssh_upload').length, 0, 'in-cluster ssh stages no sftp upload')
    assert.ok(fs.existsSync(path.join(localShared, 'fore', 'template.scs')), 'staging landed on the shared root')
  } finally {
    fs.rmSync(localShared, { recursive: true, force: true })
    restoreEnv()
  }
})

// ---- toolchain pins (D-016) ---------------------------------------------------
//
// The project settings carry absolute paths for the worker interpreter
// (remote_python) and the spectre executable (remote_spectre_cmd). Every
// scheduler resolves the interpreter the same way — a per-call remote_python
// (absolute only) > the pin > the bare default — and the spectre pin reaches
// the BUNDLED worker as --spectre-cmd, nothing else. Placeholder paths only.

const PIN_PY = '/opt/tools/python3/bin/python3'
const PIN_SPECTRE = '/opt/tools/spectre/bin/spectre'

function plantPins(root, pins) {
  const file = path.join(root, '.harnessams', 'workspace_config.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(cfg.settings, pins)
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}

// The command of the one ssh_exec call that carries `needle`, with execRemote's
// escaped double quotes flattened.
const flatCommand = (ctx, needle) => {
  const call = ctx.calls.find((c) => c.name === 'ssh_exec' && String(c.arguments.command).includes(needle))
  assert.ok(call, `no ssh_exec command carrying ${needle}`)
  return String(call.arguments.command).replace(/\\+"/g, '"')
}

test('toolchain pins (D-016): remote_python / remote_spectre_cmd resolve from the project settings on every remote scheduler', async () => {
  const base = tmp('hams-pins-')
  const root = path.join(base, 'proj')
  fs.mkdirSync(path.join(root, '.harnessams'), { recursive: true })
  fs.writeFileSync(path.join(root, '.harnessams', 'workspace_config.json'), JSON.stringify({
    version: 1,
    settings: {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
      remote_python: PIN_PY, remote_spectre_cmd: PIN_SPECTRE,
    },
  }, null, 2))
  const WORKER = 'spectre/spectre_sweep_worker.py'
  const submit = (ctx, extra) => tool(ctx, 'batch_submit').execute({ run_dir: makeRunDir({ under: root }), worker: WORKER, ...extra }, {})
  try {
    // LSF: machine_id / remote_root / remote_python / --spectre-cmd all omitted
    const ctx = makeCtx({ project: root })
    const res = await submit(ctx, { remote_dir: 'batch1', worker_args: ['--config', 'sweep_config.json'] })
    assert.equal(res.ok, true, JSON.stringify(res))
    const bsub = flatCommand(ctx, 'bsub -q')
    assert.ok(bsub.includes(`"${PIN_PY}" "/home/op/sim/.harnessams/scripts/spectre/spectre_sweep_worker.py" "--config" "sweep_config.json" `
      + `"--spectre-cmd" "${PIN_SPECTRE}" "--work-dir" "/home/op/sim/batch1"`), bsub)
    const job = JSON.parse(fs.readFileSync(res.job_file, 'utf8'))
    assert.equal(job.remote_python, PIN_PY, 'the job file records the interpreter that ran')
    assert.deepEqual(job.worker_args, ['--config', 'sweep_config.json', '--spectre-cmd', PIN_SPECTRE])

    // ssh scheduler: the same pair, detached launch (D-028)
    const sshCtx = makeCtx({ project: root })
    const res2 = await submit(sshCtx, { remote_dir: 'fore', scheduler: 'ssh' })
    assert.equal(res2.ok, true, JSON.stringify(res2))
    const ssh = flatCommand(sshCtx, '.hams_ssh_done')
    assert.ok(ssh.includes(`"${PIN_PY}" "/home/op/sim/.harnessams/scripts/spectre/spectre_sweep_worker.py" "--spectre-cmd" "${PIN_SPECTRE}" `), ssh)

    // a per-call remote_python (an absolute path) wins over the pin
    const ctx3 = makeCtx({ project: root })
    await submit(ctx3, { remote_dir: 'batch3', remote_python: '/opt/tools/other/bin/python3' })
    const bsub3 = flatCommand(ctx3, 'bsub -q')
    assert.ok(bsub3.includes('"/opt/tools/other/bin/python3" '), bsub3)
    assert.ok(!bsub3.includes(PIN_PY), 'the pin is overridden')
    assert.ok(bsub3.includes(`"--spectre-cmd" "${PIN_SPECTRE}"`), 'the spectre pin still rides along')

    // a bare remote_python is refused BEFORE anything is staged — it resolves
    // to whatever tool python comes first on PATH (the 2026-11-24 incident;
    // the full bare-name validation surface lives in selfcheck's settings test)
    const ctx4 = makeCtx({ project: root })
    await assert.rejects(() => submit(ctx4, { remote_dir: 'batch4', remote_python: 'python3' }),
      /remote_python must be an ABSOLUTE path to the executable/)
    assert.equal(ctx4.calls.filter((c) => c.name === 'ssh_upload').length, 0, 'rejected before the uploads')

    // the spectre pin is the BUNDLED worker's contract only
    const ctx5 = makeCtx({ project: root })
    await submit(ctx5, { remote_dir: 'batch5', worker: 'common/common_sweep_engine.py' })
    assert.ok(!flatCommand(ctx5, 'bsub -q').includes('--spectre-cmd'), 'a custom worker keeps its own argument contract')
    // ... and a worker_args entry the caller wrote always wins
    const ctx6 = makeCtx({ project: root })
    await submit(ctx6, { remote_dir: 'batch6', worker_args: ['--spectre-cmd', '/opt/tools/legacy/bin/spectre'] })
    const own = flatCommand(ctx6, 'bsub -q')
    assert.equal(own.split('--spectre-cmd').length - 1, 1, 'exactly one --spectre-cmd')
    assert.ok(own.includes('"/opt/tools/legacy/bin/spectre"'))

    // an unpinned project: the bare defaults, the behavior of every earlier test
    const ctx7 = makeCtx()
    await tool(ctx7, 'batch_submit').execute({
      run_dir: makeRunDir(), remote_dir: 'batch7', machine_id: 'node1', remote_root: '/home/op/sim', worker: WORKER,
    }, {})
    const plain = flatCommand(ctx7, 'bsub -q')
    assert.ok(plain.includes('"python3" "/home/op/sim/.harnessams/scripts/spectre/spectre_sweep_worker.py" "--work-dir" "/home/op/sim/batch7"'), plain)
    assert.ok(!plain.includes('--spectre-cmd'))
  } finally {
    restoreEnv()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('toolchain pins (D-016): in-cluster — the local bsub carries the pins, the local scheduler spawns the pinned interpreter', async () => {
  // a runnable fake worker under a private scripts root (the shared fixture
  // tree is a stub whose upload manifest is pinned by another test)
  const scriptsRoot = tmp('hams-pin-local-')
  fs.mkdirSync(path.join(scriptsRoot, 'spectre'), { recursive: true })
  fs.writeFileSync(path.join(scriptsRoot, 'spectre', 'spectre_sweep_worker.py'), 'import sys; sys.exit(0)\n')
  process.env.HARNESSAMS_SIM_SCRIPTS_DIR = scriptsRoot
  const proj = makeProjectRoot('in-cluster')
  plantPins(proj, { remote_spectre_cmd: PIN_SPECTRE })
  const shared = makeSharedRoot()
  const localShared = path.resolve(shared)
  try {
    // local bsub through ctx.shell: the same resolution as the ssh schedulers
    const ctx = makeShellCtx({ project: proj })
    const res = await tool(ctx, 'batch_submit').execute({
      run_dir: makeRunDir({ under: proj }), remote_dir: 'batch1', remote_root: shared, worker: 'spectre/spectre_sweep_worker.py',
    }, {})
    assert.equal(res.ok, true, JSON.stringify(res))
    const bsub = ctx.commands.find((c) => c.includes('bsub -q'))
    assert.ok(bsub.includes('"python3" '), 'no interpreter pin → the bare default')
    assert.ok(bsub.includes(`"--spectre-cmd" "${PIN_SPECTRE}"`), bsub)

    // scheduler=local: the pinned spectre reaches the spawned worker, and the
    // interpreter is the host's bare python while remote_python is unpinned
    const run = makeRunDir({ under: proj })
    const local = await tool(ctx, 'batch_submit').execute({
      run_dir: run, worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local',
    }, {})
    assert.equal(local.ok, true, JSON.stringify(local))
    const job = JSON.parse(fs.readFileSync(local.job_file, 'utf8'))
    assert.equal(job.remote_python, 'python')
    assert.deepEqual(job.worker_args, ['--spectre-cmd', PIN_SPECTRE, '--work-dir', run])

    // a remote_python pin is what gets spawned: a path this host cannot run
    // fails the submit before any job file exists
    plantPins(proj, { remote_python: PIN_PY })
    const noRun = makeRunDir({ under: proj })
    await assert.rejects(() => tool(ctx, 'batch_submit').execute({
      run_dir: noRun, worker: 'spectre/spectre_sweep_worker.py', scheduler: 'local',
    }, {}), /cannot start the local worker \(interpreter \/opt\/tools\/python3\/bin\/python3\)/)
    assert.ok(!fs.existsSync(path.join(noRun, '.batch_job.json')))
  } finally {
    fs.rmSync(localShared, { recursive: true, force: true })
    restoreEnv()
  }
})

// ---- abort contract (D-029) --------------------------------------------------
//
// The session stop reaches the channels as the tool's exec.signal. callTool
// must settle AT ONCE even when the nested tool body never settles (dsh-ssh
// sftp has no abort path; the host pipeline likewise drains an aborted batch
// until its bodies settle), and the batch input must carry the signal down so
// exec-shaped calls get dsh-ssh's KILL + channel close.

test('abort contract (D-029): callTool races a never-settling nested call and reports the uncertainty', async () => {
  const ac = new AbortController()
  let nestedSignal = null
  const ctx = {
    tools: {
      get: () => ({ name: 'ssh_exec' }),
      execute: (input) => {
        nestedSignal = input.signal
        return new Promise(() => {}) // sftp-style body: ignores cancellation forever
      },
    },
  }
  const t0 = Date.now()
  const pending = callTool(ctx, 'ssh_exec', { alias: 'node1', command: 'x' }, { timeoutMs: 60_000, signal: ac.signal })
  setTimeout(() => ac.abort(), 50)
  const r = await pending
  const elapsed = Date.now() - t0
  assert.equal(r.isError, true)
  assert.match(r.text, /uncertain/i)
  assert.ok(elapsed < 2000, `settled in ${elapsed} ms — the race, not the budget`)
  assert.ok(nestedSignal && nestedSignal.aborted, 'the nested batch input carried and aborted the signal')
})

test('abort contract (D-029): an already-aborted signal returns without dispatching', async () => {
  let dispatched = false
  const ctx = {
    tools: {
      get: () => ({ name: 'ssh_exec' }),
      execute: () => { dispatched = true; return new Promise(() => {}) },
    },
  }
  const ac = new AbortController()
  ac.abort()
  const r = await callTool(ctx, 'ssh_exec', { alias: 'node1', command: 'x' }, { signal: ac.signal })
  assert.equal(r.isError, true)
  assert.match(r.text, /uncertain/i)
  assert.equal(dispatched, false)
})

test('batch_poll without a job record states the batch uncertainty (D-029)', async () => {
  const run = makeRunDir()
  try {
    const ctx = makeCtx()
    await assert.rejects(
      () => tool(ctx, 'batch_poll').execute({ run_dir: run }, {}),
      (e) => /UNCERTAIN/.test(e.message)
        && /sweep_progress\.json/.test(e.message)
        && /job_id/.test(e.message),
    )
  } finally {
    restoreEnv()
  }
})
