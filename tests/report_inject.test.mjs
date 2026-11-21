// Tests for the sim_analysis(report=true) auto-registration target (D-008):
// locating the HarnessAMS session store above a project dir, the guarded
// single-session merge-write of sessions.json (v2), and the full
// tool.execute(args, exec) flow (collect -> report -> register) against a
// minimal sweep fixture — the calling session comes from exec.agent.id.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { analysisTools, findSessionsStore, registerReportIntoSession } from '../src/tools/sim_analysis.js'
import { makeTool } from '../src/tool.js'

const SID_A = 'session-aaaa1111-2222-3332-4444-555555555555'
const SID_B = 'session-bbbb1111-2222-3332-4444-555555555555'

async function makeWorkspace() {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-inject-'))
  const storeDir = path.join(ws, '.harnessams')
  await mkdir(storeDir, { recursive: true })
  await writeFile(path.join(storeDir, 'sessions.json'), JSON.stringify({
    version: 2,
    sessions: {
      [SID_A]: { display: 'session', reports: [], dashboard_selected: null },
      [SID_B]: {
        display: 'overview', reports: [], dashboard_selected: null,
        check_params: { rcl: { r: [1, 100], c: [1e-15, 1e-6], l: [1e-13, 1e-8] }, unit_check: true, bias_check: true, strict_includes: false },
      },
    },
  }, null, 2) + '\n', 'utf8')
  return { ws, storeDir }
}

test('inject: findSessionsStore walks up to the nearest .harnessams and returns null without one', async () => {
  const { ws } = await makeWorkspace()
  const deep = path.join(ws, 'proj', 'sub')
  await mkdir(deep, { recursive: true })
  assert.deepEqual(findSessionsStore(deep), { storeDir: path.join(ws, '.harnessams') })

  // nearest ancestor wins over a farther one
  const inner = path.join(deep, '.harnessams')
  await mkdir(inner, { recursive: true })
  assert.deepEqual(findSessionsStore(deep), { storeDir: inner })

  const bare = await mkdtemp(path.join(tmpdir(), 'hams-inject-bare-'))
  assert.equal(findSessionsStore(bare), null)
  await rm(bare, { recursive: true, force: true })
  await rm(ws, { recursive: true, force: true })
})

test('inject: registerReportIntoSession appends, selects, dedupes by path, preserves siblings + check_params', async () => {
  const { ws, storeDir } = await makeWorkspace()
  const reportPath = path.join(ws, 'demo1', 'Analysis', 'demo1_report.html')
  try {
    const r1 = await registerReportIntoSession(storeDir, SID_A, reportPath)
    assert.ok(!r1.error, r1.error)
    assert.equal(r1.session, SID_A)
    assert.match(r1.report.id, /^r-[\w-]{1,8}$/)
    assert.equal(r1.report.path, path.resolve(reportPath))
    assert.equal(r1.report.name, 'demo1_report.html')

    const store1 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    const a1 = store1.sessions[SID_A]
    assert.equal(a1.display, 'session') // untouched fields survive
    assert.equal(a1.reports.length, 1)
    assert.equal(a1.dashboard_selected, r1.report.id)
    // sibling entry untouched (single-session merge, not a full-file rewrite)
    assert.equal(store1.sessions[SID_B].check_params.rcl.r[0], 1)

    // same path again → same entry reused, still selected
    const r2 = await registerReportIntoSession(storeDir, SID_A, reportPath)
    assert.ok(!r2.error, r2.error)
    assert.equal(r2.report.id, r1.report.id)
    const store2 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store2.sessions[SID_A].reports.length, 1)

    // an UNKNOWN session gets its entry created on demand (the sidebar adopts
    // it later; check_params absent, display overview)
    const sidC = 'session-cccc1111-2222-3332-4444-555555555555'
    const r3 = await registerReportIntoSession(storeDir, sidC, path.join(ws, 'other.html'))
    assert.ok(!r3.error, r3.error)
    const store3 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store3.sessions[sidC].reports.length, 1)
    assert.equal(store3.version, 2)

    // 32-report cap on one session
    const sidFull = 'session-ffff1111-2222-3332-4444-555555555555'
    await writeFile(path.join(storeDir, 'sessions.json'), JSON.stringify({
      version: 2,
      sessions: {
        [sidFull]: {
          display: 'overview', dashboard_selected: null,
          reports: Array.from({ length: 32 }, (_, i) => ({ id: 'r-' + i, name: 'r' + i, path: path.join(ws, 'r' + i + '.html'), added_at: 'x' })),
        },
      },
    }), 'utf8')
    const cap = await registerReportIntoSession(storeDir, sidFull, path.join(ws, 'new.html'))
    assert.match(cap.error, /32 reports \(max\)/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('inject: sim_analysis e2e — collects, generates the report and registers it into the CALLING session', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    // minimal sweep fixture: one round, two points over one grouping param
    const top = path.join(ws, 'demoX', 'sweep', 'Round1', 'top')
    await mkdir(path.join(top, '00'), { recursive: true })
    await mkdir(path.join(top, '01'), { recursive: true })
    await writeFile(path.join(top, '.simulator'), 'spectre\n', 'utf8')
    await writeFile(path.join(top, '00', 'point_meta.json'), JSON.stringify({
      point_index: 0, point_name: '00', status: 'success',
      params: { vgs: 0.6 }, signals: { gain: 60.0 },
    }), 'utf8')
    await writeFile(path.join(top, '01', 'point_meta.json'), JSON.stringify({
      point_index: 1, point_name: '01', status: 'success',
      params: { vgs: 0.7 }, signals: { gain: 65.0 },
    }), 'utf8')

    const tool = makeTool(analysisTools().find((d) => d.name === 'sim_analysis'))
    // exec.agent.id IS the SessionId (D-008) — the registration target
    const res = await tool.execute({ run_dir: top, report: true }, { agent: { id: SID_A } })
    assert.equal(res.ok, true)
    assert.equal(res.simulator, 'spectre')
    assert.equal(res.summary.gain.n, 2)
    assert.match(res.results_file, /demoX[\\/]sweep[\\/]Round1[\\/]top[\\/]results\.json$/)
    assert.equal(res.registered, true)
    assert.equal(res.session, SID_A)
    assert.match(res.report_path, /demoX_report\.html$/)

    const reportOnDisk = await readFile(res.report_path, 'utf8') // throws if missing
    assert.match(reportOnDisk, /<!DOCTYPE html>/)
    // stdout line contract kept from the Python pipeline (report path parsed
    // from the tool result now, but the lines stay model-facing output)
    assert.match(res.output, /\[collect\] spectre: 2 success \/ 0 partial \/ 0 failed -> /)
    assert.match(res.output, /\[report\] 1 round\(s\) -> /)
    const store = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store.sessions[SID_A].reports.length, 1)
    assert.equal(store.sessions[SID_A].reports[0].path, path.resolve(res.report_path))
    assert.equal(store.sessions[SID_A].dashboard_selected, store.sessions[SID_A].reports[0].id)

    // collect-only (no report) → no registration fields, results.json still written
    const top2 = path.join(ws, 'demoY', 'sweep', 'Round2', 'top')
    await mkdir(path.join(top2, '00'), { recursive: true })
    await writeFile(path.join(top2, '00', 'point_meta.json'), JSON.stringify({
      point_index: 0, point_name: '00', status: 'success',
      params: { x: 1 }, signals: { m: 5 },
    }), 'utf8')
    const plain = await tool.execute({ run_dir: top2 }, { agent: { id: SID_A } })
    assert.equal(plain.ok, true)
    assert.equal(plain.registered, undefined)
    assert.equal(plain.report_path, undefined)

    // NO session identity in exec (direct server-side call) → analysis + report
    // ok, registration refused with a visible, actionable error
    const noAgent = await tool.execute({ run_dir: top, report: true })
    assert.equal(noAgent.ok, true)
    assert.equal(noAgent.registered, false)
    assert.match(noAgent.register_error, /no session identity/)

    // report=true + custom out → refused early (report reads the canonical location)
    await assert.rejects(() => tool.execute({
      run_dir: top, report: true, out: path.join(ws, 'elsewhere.json'),
    }, { agent: { id: SID_A } }), /requires the default results\.json location/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('sim_analysis: numeric point ordering (>=100 dirs) and report inline-JSON escaping', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-order-'))
  try {
    const top = path.join(ws, 'demoT', 'sweep', 'Round1', 'top')
    // lexicographic order would be 02, 100, 11 — numeric must win
    for (const [dir, idx, gain] of [['02', 2, 10.0], ['100', 100, 20.0], ['11', 11, 15.0]]) {
      await mkdir(path.join(top, dir), { recursive: true })
      await writeFile(path.join(top, dir, 'point_meta.json'), JSON.stringify({
        point_index: idx, point_name: dir, status: 'success',
        params: { vgs: 0.6 }, signals: { gain },
      }), 'utf8')
    }
    // hostile testbench name: '</' must never survive inside the inline MANIFEST
    await writeFile(path.join(top, 'cell_meta.json'), JSON.stringify({
      testbench: 'amp</script><script>alert(1)</script>',
      pdk: { name: 'sky130' },
    }), 'utf8')

    const tool = makeTool(analysisTools().find((d) => d.name === 'sim_analysis'))
    const res = await tool.execute({ run_dir: top, report: true }, { agent: { id: 'session-eeee1111-2222-3332-4444-555555555555' } })
    assert.equal(res.ok, true)

    const results = JSON.parse(await readFile(path.join(top, 'results.json'), 'utf8'))
    assert.deepEqual(results.points.map((p) => p.index), [2, 11, 100]) // numeric order
    assert.deepEqual(results.summary.gain, { min: 10, max: 20, mean: 15, n: 3 })

    // P1 #11: the inline MANIFEST line breaks '</' as '<\/' so the round title
    // cannot terminate the inline script; the EXTERNAL data script keeps the
    // raw title (it cannot inject there) — that boundary is the contract.
    const html = await readFile(res.report_path, 'utf8')
    const inline = html.split('\n').find((l) => l.includes('const MANIFEST')) ?? ''
    assert.ok(inline.includes('"Round1 - amp<\\/script><script>alert(1)<\\/script>"'), inline)
    assert.ok(!inline.includes('amp</script>'), inline)
    const data = await readFile(path.join(ws, 'demoT', 'Analysis', 'data', 'Round1.js'), 'utf8')
    assert.ok(data.includes('amp</script>'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('sim_analysis report: Sim* run dirs join the batch dropdown; psf curves add one trace per parameter combination', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-simdirs-'))
  try {
    const proj = path.join(ws, 'projAtt')
    const mkRun = async (name, points) => {
      const run = path.join(proj, name)
      for (const [idx, params] of points) {
        const nn = String(idx).padStart(2, '0')
        await mkdir(path.join(run, nn), { recursive: true })
        await writeFile(path.join(run, nn, 'point_meta.json'), JSON.stringify({
          point_index: idx, point_name: nn, status: 'success', params, signals: {},
        }), 'utf8')
      }
      return run
    }
    const run1 = await mkRun('Sim0_20260805_batch1', [[0, { SW: 0 }], [1, { SW: 1 }]])
    const run2 = await mkRun('Sim0_20260805_batch2', [[0, { SW: 0 }]])
    const run3 = await mkRun('Sim1_20260806_batch1', [[0, { SW: 0 }]])

    // spectre_parse outputs for run1: freq + a complex s21 per point
    await mkdir(path.join(run1, 'psf'), { recursive: true })
    for (const [nn, s21] of [['00', [[0.9, 0.1], [0.8, 0.2]]], ['01', [[0.5, 0.05], [0.4, 0.1]]]]) {
      await writeFile(path.join(run1, 'psf', `${nn}_psf.json`), JSON.stringify({
        point: nn, raw_dir: 'x', signals: {
          freq: { complex: false, values: [1e9, 2e9] },
          s21: { complex: true, values: s21 },
        },
      }), 'utf8')
    }

    const tool = makeTool(analysisTools().find((d) => d.name === 'sim_analysis'))
    // collect the sibling runs first (real flow: every batch is collected when
    // its own analysis runs; discovery requires a results.json per run dir)
    await tool.execute({ run_dir: run2 })
    await tool.execute({ run_dir: run3 })

    const res = await tool.execute({ run_dir: run1, report: true })
    assert.equal(res.ok, true)
    assert.match(res.report_dir, /projAtt[\\/]Analysis$/) // Sim layout derived, no project_dir

    const dataDir = path.join(res.report_dir, 'data')
    const rd = JSON.parse((await readFile(path.join(dataDir, 'Sim0_20260805_batch1.js'), 'utf8'))
      .replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    assert.equal(rd.curves.x_signal, 'freq')
    assert.deepEqual(rd.curves.signals, [{ name: 's21', dB: true }])
    assert.equal(rd.curves.points.length, 2)
    assert.equal(rd.curves.points[0].label, 'SW=0')
    assert.equal(rd.curves.points[1].label, 'SW=1')
    const want = 20 * Math.log10(Math.hypot(0.9, 0.1))
    assert.ok(Math.abs(rd.curves.points[0].y.s21[0] - want) < 1e-9)

    const html = await readFile(res.report_path, 'utf8')
    assert.match(html, /2b\. Sweep curves/)
    for (const f of ['Sim0_20260805_batch1.js', 'Sim0_20260805_batch2.js', 'Sim1_20260806_batch1.js']) {
      await readFile(path.join(dataDir, f)) // throws if a discovered batch is missing
      assert.match(html, new RegExp(f.replace(/\./g, '\.')))
    }
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
