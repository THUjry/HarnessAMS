// Progress surface tests (session tool-card backend): server/progress.js
// normalization (progress file → worker_started → sweep_config ladder, BOM
// tolerance) plus the two GET endpoints (/api/progress, /api/progress-summary)
// through the apply()-registered handler, against a synthetic project tree.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerRoutes, callGet } from './helpers.mjs'
import { projectRootOf, readRunProgress, summarizeProject } from '../src/server/progress.js'
import { resetRemoteCacheForTest } from '../src/server/progressRemote.js'

async function makeHandler(registryList = [], ctxExtra = {}) {
  const handler = await registerRoutes({ workspaceRegistry: { list: () => registryList }, ...ctxExtra })
  return (route) => callGet(handler, 'http://127.0.0.1/harnessams' + route)
}

test('progress: projectRootOf derives the root from run-dir shapes', () => {
  assert.equal(projectRootOf('D:\\w\\demo1_ota\\sweep\\Round2\\top'), 'D:/w/demo1_ota')
  assert.equal(projectRootOf('/home/u/proj/sweep/Round10/top/'), '/home/u/proj')
  assert.equal(projectRootOf('/home/u/proj/sweep/RoundX/top'), '/home/u/proj') // Round name is open-ended
  assert.equal(projectRootOf('D:\\w\\proj\\run1'), null)
  assert.equal(projectRootOf('/proj/sweep/top'), null)
  assert.equal(projectRootOf(''), null)
  assert.equal(projectRootOf(null), null)
  // D-012: <root>/RawResults/Sim* strips the RawResults base like sweep/
  assert.equal(projectRootOf('/home/u/proj/RawResults/Sim0_20261121_batch1'), '/home/u/proj')
  assert.equal(projectRootOf('D:\\w\\proj\\RawResults\\Sim3_20261121_batch2'), 'D:/w/proj')
  assert.equal(projectRootOf('/home/u/proj/RawResults/run1'), null) // still needs the Sim shape
})

test('progress: readRunProgress walks the progress → worker_started → config ladder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-prog-run-'))
  try {
    const run = path.join(dir, 'top')
    await mkdir(run)

    // nothing in the dir yet: assembled-but-unread (config absent → total unknown)
    const bare = readRunProgress(run)
    assert.equal(bare.local, true)
    assert.equal(bare.source, 'config')
    assert.equal(bare.total, null)
    assert.equal(bare.status, null)

    // sweep_config.json only: planned cross product becomes the pending count
    await writeFile(path.join(run, 'sweep_config.json'),
      JSON.stringify({ parameters: { temperature: [25, 65], SW1: [0, 1, 2] } }))
    const cfg = readRunProgress(run)
    assert.equal(cfg.source, 'config')
    assert.equal(cfg.status, 'pending')
    assert.equal(cfg.total, 6)
    assert.equal(cfg.pending, 6)
    assert.equal(cfg.completed, 0)

    // .batch_job.json (a remote batch was submitted; everything still lives on
    // the remote host) outranks the config — the immediate 0/N submitted frame
    // the batch_poll card shows on its very first fetch (D-016)
    await writeFile(path.join(run, '.batch_job.json'),
      JSON.stringify({ job_id: '777', machine_id: 'node1', remote_root: '/home/op/sim',
        remote_dir: '/home/op/sim/batch1', scheduler: 'lsf', total_points: 6,
        submitted_at: '2026-11-22T00:00:00Z' }))
    const jobFrame = readRunProgress(run)
    assert.equal(jobFrame.source, 'job')
    assert.equal(jobFrame.status, 'submitted')
    assert.equal(jobFrame.total, 6)
    assert.equal(jobFrame.completed, 0)
    assert.equal(jobFrame.pending, 6)
    assert.equal(jobFrame.updated_at, '2026-11-22T00:00:00Z')

    // .worker_started outranks the job file (worker announced; first tick ~30 s out)
    await writeFile(path.join(run, '.worker_started'),
      JSON.stringify({ pid: 42, host: 'node5', started_at: '2026-11-09T00:00:00Z', total_points: 6 }))
    const started = readRunProgress(run)
    assert.equal(started.source, 'worker_started')
    assert.equal(started.status, 'running')
    assert.equal(started.total, 6)
    assert.equal(started.compute_node, 'node5')

    // sweep_progress.json outranks both; missing `simulator` (old files) tolerated
    await writeFile(path.join(run, 'sweep_progress.json'),
      JSON.stringify({ status: 'running', total_points: 6, completed: 2, succeeded: 2, failed: 0,
        running: 4, compute_node: 'node5', updated_at: '2026-11-09T00:01:00Z' }))
    const prog = readRunProgress(run)
    assert.equal(prog.source, 'progress')
    assert.equal(prog.status, 'running')
    assert.equal(prog.total, 6)
    assert.equal(prog.completed, 2)
    assert.equal(prog.pending, 4)
    assert.equal(prog.simulator, null)

    // a BOM must not turn the file into "unreadable"
    await writeFile(path.join(run, 'sweep_progress.json'),
      '\uFEFF' + JSON.stringify({ status: 'completed', total_points: 2, completed: 2, succeeded: 2, failed: 0 }))
    const bom = readRunProgress(run)
    assert.equal(bom.source, 'progress')
    assert.equal(bom.status, 'completed')
    assert.equal(bom.pending, 0)

    // absent directory answers local:false (client omits the block)
    assert.equal(readRunProgress('/no/such/dir').local, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('progress: summarizeProject aggregates sweep/Round*/top with totals', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'hams-proj-'))
  try {
    const mk = async (round, files) => {
      const top = path.join(proj, 'sweep', round, 'top')
      await mkdir(top, { recursive: true })
      for (const [name, body] of Object.entries(files)) await writeFile(path.join(top, name), body)
    }
    await mk('Round1', {
      'sweep_progress.json': JSON.stringify({ status: 'completed', total_points: 4, completed: 4,
        succeeded: 3, failed: 1, running: 0, simulator: 'spectre', compute_node: 'node5' }),
    })
    await mk('Round2', {
      'sweep_config.json': JSON.stringify({ parameters: { a: [1, 2, 3], b: [1, 2] } }),
    })
    await mk('Round3', {}) // bare run dir: unknown total
    await mkdir(path.join(proj, 'sweep', 'Round9'), { recursive: true }) // no top/ → skipped

    const s = summarizeProject(proj)
    assert.equal(s.local, true)
    assert.equal(s.batches.length, 3)
    assert.deepEqual(s.batches.map((b) => b.round), ['Round1', 'Round2', 'Round3'])
    assert.equal(s.batches[0].status, 'completed')
    assert.equal(s.batches[1].total, 6)
    assert.equal(s.batches[2].total, null)
    assert.deepEqual(s.totals, {
      batches: 3, batches_done: 1, batches_unplanned: 1,
      sims_total: 10, sims_completed: 4, sims_failed: 1, sims_pending: 6,
    })

    // round numbers sort numerically (Round2 < Round10)
    await mk('Round10', { 'sweep_config.json': JSON.stringify({ parameters: { a: [1] } }) })
    const s10 = summarizeProject(proj)
    assert.equal(s10.batches[3].round, 'Round10')
    assert.ok(s10.batches.map((b) => b.round).indexOf('Round2') < s10.batches.map((b) => b.round).indexOf('Round10'))

    // a non-project directory answers local:false
    const empty = await mkdtemp(path.join(tmpdir(), 'hams-notproj-'))
    try {
      assert.equal(summarizeProject(empty).local, false)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  } finally {
    await rm(proj, { recursive: true, force: true })
  }
})

test('progress: summarizeProject scans <project>/RawResults/Sim* (D-012 layout), deduped against the root', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'hams-rawres-'))
  try {
    const mkSim = async (base, name, files = {}) => {
      const run = path.join(proj, base, name)
      await mkdir(run, { recursive: true })
      for (const [n, body] of Object.entries(files)) await writeFile(path.join(run, n), body)
      return run
    }
    await mkSim('RawResults', 'Sim0_20261121_batch1', {
      'sweep_progress.json': JSON.stringify({ status: 'completed', total_points: 8, completed: 8,
        succeeded: 8, failed: 0, simulator: 'spectre' }),
    })
    await mkSim('RawResults', 'Sim0_20261121_batch2', {
      'sweep_config.json': JSON.stringify({ parameters: { SW: [0, 1, 2] } }),
    })
    // same-named dir at the project root counts ONCE (seen-set dedup)
    await mkSim('', 'Sim0_20261121_batch1', {
      'sweep_progress.json': JSON.stringify({ status: 'running', total_points: 8, completed: 1,
        succeeded: 1, failed: 0 }),
    })
    // a RawResults sibling that is not a Sim dir is noise
    await mkdir(path.join(proj, 'RawResults', 'notes'), { recursive: true })

    const s = summarizeProject(proj)
    assert.equal(s.local, true)
    assert.deepEqual(s.batches.map((b) => b.round), ['Sim0_20261121_batch1', 'Sim0_20261121_batch2'])
    // dedup kept the FIRST sighting (the RawResults copy, completed)
    assert.equal(s.batches[0].status, 'completed')
    assert.equal(s.batches[1].total, 3)
    assert.deepEqual(s.totals.batches, 2)
  } finally {
    await rm(proj, { recursive: true, force: true })
  }
})

test('progress: GET endpoints fence by cwd→workspace then answer payloads', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'hams-prog-api-'))
  const stray = await mkdtemp(path.join(tmpdir(), 'hams-prog-stray-'))
  try {
    const top1 = path.join(proj, 'sweep', 'Round1', 'top')
    await mkdir(top1, { recursive: true })
    await writeFile(path.join(top1, 'sweep_progress.json'),
      JSON.stringify({ status: 'running', total_points: 8, completed: 3, succeeded: 3, failed: 0,
        running: 5, simulator: 'spectre', compute_node: 'local', updated_at: '2026-11-09T00:00:00Z' }))
    const top2 = path.join(proj, 'sweep', 'Round2', 'top')
    await mkdir(top2, { recursive: true })
    await writeFile(path.join(top2, 'sweep_config.json'),
      JSON.stringify({ parameters: { a: [1, 2, 3, 4] } }))

    const call = await makeHandler([{ id: 'w1', path: proj, sessionIds: ['s1'], title: 'p' }])
    const q = (v) => encodeURIComponent(v)
    const sidq = '&sessionId=s1'

    const one = await call('/api/progress?runDir=' + q(top1) + sidq)
    assert.equal(one.code, 200)
    assert.equal(one.body.ok, true)
    assert.equal(one.body.source, 'progress')
    assert.equal(one.body.completed, 3)
    assert.equal(one.body.pending, 5)
    assert.equal(one.body.simulator, 'spectre')

    // inside the workspace but not present → local:false (client omits the block)
    const missing = await call('/api/progress?runDir=' + q(path.join(proj, 'no', 'such')) + sidq)
    assert.equal(missing.code, 200)
    assert.equal(missing.body.ok, true)
    assert.equal(missing.body.local, false)

    const aggByRun = await call('/api/progress-summary?runDir=' + q(top2) + sidq)
    assert.equal(aggByRun.code, 200)
    assert.equal(aggByRun.body.local, true)
    assert.equal(aggByRun.body.project_dir, path.resolve(proj).replace(/\\/g, '/')) // derived root is slash-normalized
    assert.equal(aggByRun.body.totals.batches, 2)
    assert.equal(aggByRun.body.totals.sims_pending, 9) // Round1 8-3 + Round2 4

    const aggByProject = await call('/api/progress-summary?projectDir=' + q(proj) + sidq)
    assert.equal(aggByProject.code, 200)
    assert.equal(aggByProject.body.totals.batches, 2)

    // fence (review D-3): missing sessionId → 400
    assert.equal((await call('/api/progress?runDir=' + q(top1))).code, 400)
    // fence: session not accounted in any workspace → 400
    assert.equal((await call('/api/progress?runDir=' + q(top1) + '&sessionId=nope')).code, 400)
    // fence: accounted session but the requested path escapes its workspace → 403
    assert.equal((await call('/api/progress?runDir=' + q(stray) + sidq)).code, 403)
    assert.equal((await call('/api/progress-summary?projectDir=' + q(stray) + sidq)).code, 403)

    // POSIX remote-shaped path: outside the workspace root by construction →
    // the fence 403s before the payload ladder (remote batches poll post-fetch
    // local paths, so remote-shaped strings no longer reach local:false)
    const remoteish = await call('/api/progress-summary?runDir=' + q('/home/u/proj/sweep/Round1/top') + sidq)
    assert.equal(remoteish.code, 403)

    assert.equal((await call('/api/progress?sessionId=s1')).code, 400)
    assert.equal((await call('/api/progress-summary?sessionId=s1')).code, 400)
  } finally {
    await rm(proj, { recursive: true, force: true })
    await rm(stray, { recursive: true, force: true })
  }
})

// D-016: the remote live-progress endpoint. The ssh_* tool shell is mocked per
// the installed dsh-ssh contract (structured values; same routing-by-substring
// style as batch.test.mjs's makeCtx) — machine/dir/job come from the run dir's
// .batch_job.json, never from client params.
function sshTools({ hosts } = {}) {
  const registry = hosts || [{ alias: 'node1', host: '192.0.2.11', port: 22, user: 'op', auth: 'key', keyReady: true }]
  const calls = []
  const ok = (value) => ({ isError: false, value })
  const pollStdout = '__BJOB__\n777 RUN\n__META__\n1\n__DIRS__\n1\n__PROG__\n'
    + JSON.stringify({ status: 'running', total_points: 2, completed: 1, succeeded: 1, failed: 0, compute_node: 'node3' })
    + '\n__ERR__\n'
  return {
    calls,
    tools: {
      register: () => {},
      get: (name) => (['ssh_list', 'ssh_exec'].includes(name) ? { name } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        calls.push({ name: call.name, arguments: JSON.parse(call.arguments || '{}') })
        const reply = (result) => ({ results: [{ callId: call.id, result }] })
        if (call.name === 'ssh_list') return reply(ok({ hosts: registry }))
        return reply(ok({ success: true, exitCode: 0, timedOut: false, stdout: pollStdout, stderr: '', durationMs: 3 }))
      },
    },
  }
}

test('progress: GET /api/progress-remote answers remote truth, local fallback, fence and single-flight (D-016)', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'hams-prog-rem-'))
  const stray = await mkdtemp(path.join(tmpdir(), 'hams-prog-rem-stray-'))
  try {
    const run = path.join(proj, 'RawResults', 'Sim0_20261122_batch1')
    await mkdir(run, { recursive: true })
    await writeFile(path.join(run, 'sweep_config.json'), JSON.stringify({ parameters: { SW: [0, 1] } }))
    await writeFile(path.join(run, '.batch_job.json'), JSON.stringify({
      job_id: '777', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '/home/op/sim/Sim0_20261122_batch1', scheduler: 'lsf',
      total_points: 2, submitted_at: '2026-11-22T00:00:00Z' }))
    const local = path.join(proj, 'sweep', 'Round1', 'top') // no job file
    await mkdir(local, { recursive: true })
    await writeFile(path.join(local, 'sweep_config.json'),
      JSON.stringify({ parameters: { a: [1, 2, 3] } }))

    const ssh = sshTools()
    const call = await makeHandler([{ id: 'w1', path: proj, sessionIds: ['s1'], title: 'p' }], { tools: ssh.tools })
    const q = (v) => encodeURIComponent(v)
    resetRemoteCacheForTest()

    // remote truth: state from bjobs + point_meta count, total falls back to the job file
    const live = await call('/api/progress-remote?runDir=' + q(run) + '&sessionId=s1')
    assert.equal(live.code, 200)
    assert.equal(live.body.ok, true)
    assert.equal(live.body.remote, true)
    assert.equal(live.body.state, 'running')
    assert.equal(live.body.job_state, 'running')
    assert.equal(live.body.completed, 1)
    assert.equal(live.body.total, 2)
    assert.equal(live.body.compute_node, 'node3')
    // machine/dir were resolved from the job file, not from client params
    const exec = ssh.calls.filter((c) => c.name === 'ssh_exec')[0]
    assert.equal(exec.arguments.alias, 'node1')
    assert.ok(exec.arguments.command.includes('/home/op/sim/Sim0_20261122_batch1'))

    // TTL window: an immediate repeat call serves the cached payload, no new exec
    const execCount = ssh.calls.filter((c) => c.name === 'ssh_exec').length
    const again = await call('/api/progress-remote?runDir=' + q(run) + '&sessionId=s1')
    assert.equal(again.code, 200)
    assert.equal(again.body.state, 'running')
    assert.equal(ssh.calls.filter((c) => c.name === 'ssh_exec').length, execCount)

    // single-flight: two concurrent calls after a cache reset share ONE exec
    resetRemoteCacheForTest()
    ssh.calls.length = 0
    const pair = await Promise.all([
      call('/api/progress-remote?runDir=' + q(run) + '&sessionId=s1'),
      call('/api/progress-remote?runDir=' + q(run) + '&sessionId=s1'),
    ])
    assert.equal(pair[0].code, 200)
    assert.equal(pair[1].code, 200)
    assert.equal(ssh.calls.filter((c) => c.name === 'ssh_exec').length, 1)

    // no job file → local semantics (identical to /api/progress)
    const asLocal = await call('/api/progress-remote?runDir=' + q(local) + '&sessionId=s1')
    assert.equal(asLocal.code, 200)
    assert.equal(asLocal.body.remote, false)
    assert.equal(asLocal.body.source, 'config')
    assert.equal(asLocal.body.total, 3)

    // fence: same rules as the local endpoints
    assert.equal((await call('/api/progress-remote?runDir=' + q(run))).code, 400)
    assert.equal((await call('/api/progress-remote?runDir=' + q(run) + '&sessionId=nope')).code, 400)
    assert.equal((await call('/api/progress-remote?runDir=' + q(stray) + '&sessionId=s1')).code, 403)
    assert.equal((await call('/api/progress-remote?sessionId=s1')).code, 400)
  } finally {
    await rm(proj, { recursive: true, force: true })
    await rm(stray, { recursive: true, force: true })
  }
})

test('progress: GET /api/progress-remote answers unreachable (keep-last-frame shape) when the host registry is empty', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'hams-prog-unreach-'))
  try {
    const run = path.join(proj, 'RawResults', 'Sim0_20261122_batch2')
    await mkdir(run, { recursive: true })
    await writeFile(path.join(run, '.batch_job.json'), JSON.stringify({
      job_id: '778', machine_id: 'node1', remote_root: '/home/op/sim',
      remote_dir: '/home/op/sim/Sim0_20261122_batch2', scheduler: 'lsf', total_points: 2 }))
    const ssh = sshTools({ hosts: [] }) // ssh_list answers no hosts → resolveMachine throws
    const call = await makeHandler([{ id: 'w1', path: proj, sessionIds: ['s1'], title: 'p' }], { tools: ssh.tools })
    resetRemoteCacheForTest()

    const r = await call('/api/progress-remote?runDir=' + encodeURIComponent(run) + '&sessionId=s1')
    assert.equal(r.code, 200) // 200 + unreachable: the card keeps its last frame, never blanks
    assert.equal(r.body.ok, true)
    assert.equal(r.body.remote, true)
    assert.equal(r.body.unreachable, true)
    assert.ok(String(r.body.error).length > 0)
  } finally {
    await rm(proj, { recursive: true, force: true })
  }
})
