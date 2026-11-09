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
import { apply } from '../src/index.js'
import { projectRootOf, readRunProgress, summarizeProject } from '../src/server/progress.js'

async function makeHandler() {
  const routes = []
  await apply({
    effect: (fn) => { fn() },
    webServer: { register: (r) => routes.push(r) },
    workspaceRegistry: { list: () => [] },
    tools: { register: () => {} },
  })
  const handler = routes[0].handler
  return async (route) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
    handler({ method: 'GET', url: 'http://127.0.0.1/harnessams' + route }, res)
    // the route handler fire-and-forgets its async work — give it a macrotask
    for (let i = 0; i < 50 && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
    return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
  }
}

test('progress: projectRootOf derives the root from run-dir shapes', () => {
  assert.equal(projectRootOf('D:\\w\\demo1_ota\\sweep\\Round2\\top'), 'D:/w/demo1_ota')
  assert.equal(projectRootOf('/home/u/proj/sweep/Round10/top/'), '/home/u/proj')
  assert.equal(projectRootOf('/home/u/proj/sweep/RoundX/top'), '/home/u/proj') // Round name is open-ended
  assert.equal(projectRootOf('D:\\w\\proj\\run1'), null)
  assert.equal(projectRootOf('/proj/sweep/top'), null)
  assert.equal(projectRootOf(''), null)
  assert.equal(projectRootOf(null), null)
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

    // .worker_started outranks the config (worker announced; first tick ~30 s out)
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

test('progress: GET endpoints answer single-run and cross-batch payloads', async () => {
  const proj = await mkdtemp(path.join(tmpdir(), 'hams-prog-api-'))
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

    const call = await makeHandler()
    const q = (v) => encodeURIComponent(v)

    const one = await call('/api/progress?runDir=' + q(top1))
    assert.equal(one.code, 200)
    assert.equal(one.body.ok, true)
    assert.equal(one.body.source, 'progress')
    assert.equal(one.body.completed, 3)
    assert.equal(one.body.pending, 5)
    assert.equal(one.body.simulator, 'spectre')

    const missing = await call('/api/progress?runDir=' + q('/no/such/dir'))
    assert.equal(missing.code, 200)
    assert.equal(missing.body.ok, true)
    assert.equal(missing.body.local, false)

    const aggByRun = await call('/api/progress-summary?runDir=' + q(top2))
    assert.equal(aggByRun.code, 200)
    assert.equal(aggByRun.body.local, true)
    assert.equal(aggByRun.body.project_dir, path.resolve(proj).replace(/\\/g, '/')) // derived root is slash-normalized
    assert.equal(aggByRun.body.totals.batches, 2)
    assert.equal(aggByRun.body.totals.sims_pending, 9) // Round1 8-3 + Round2 4

    const aggByProject = await call('/api/progress-summary?projectDir=' + q(proj))
    assert.equal(aggByProject.code, 200)
    assert.equal(aggByProject.body.totals.batches, 2)

    // POSIX remote-shaped path: derives but is not local → local:false
    const remoteish = await call('/api/progress-summary?runDir=' + q('/home/u/proj/sweep/Round1/top'))
    assert.equal(remoteish.code, 200)
    assert.equal(remoteish.body.local, false)

    assert.equal((await call('/api/progress')).code, 400)
    assert.equal((await call('/api/progress-summary')).code, 400)
  } finally {
    await rm(proj, { recursive: true, force: true })
  }
})
