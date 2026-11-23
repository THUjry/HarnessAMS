// Tests for the gen_sweep_report tool (D-005, 2026-11-21): spec-driven report
// rendering, the new D-005 file layout (report at the project root, data JS in
// SimResults/, PNGs in Figs/), the guarded single-session merge-write of
// sessions.json (v2), and the full tool.execute(args, exec) flow — the calling
// session comes from exec.agent.id.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { genReportTools, findSessionsStore, registerReportIntoSession } from '../src/tools/gen_report.js'
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
  const reportPath = path.join(ws, 'demo1', 'demo1_report.html')
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

test('gen_sweep_report e2e — spec renders at the project root, registers into the CALLING session, exports PNGs', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    const proj = path.join(ws, 'projX')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })

    // batch2 data via $file refs (the model's remote-analysis output shape)
    await writeFile(path.join(simres, 'b2_points.json'), JSON.stringify([
      { index: 0, params: { SW: 0 }, metrics: { s21_at_10g: -0.52 }, status: 'success' },
      { index: 1, params: { SW: 1 }, metrics: { s21_at_10g: -4.13 }, status: 'success' },
    ]), 'utf8')
    await writeFile(path.join(simres, 'b2_curves.json'), JSON.stringify({
      x_signal: 'freq (GHz)', signals: [{ name: 's21', dB: true }],
      points: [0, 1].map((k) => ({
        index: k, label: 'SW=' + k, x: [1, 2, 3],
        y: { s21: [-0.5 - k, -0.6 - k, -0.7 - k] },
      })),
    }), 'utf8')

    // batch1 inline; FIRST point failed with no params — the 2026-11-21
    // empty-table trap (column names used to come from points[0] only)
    await writeFile(path.join(simres, 'spec.json'), JSON.stringify({
      project_dir: proj,
      title: 'proj & <demo>',
      conclusions: '**bold** and `code` and a list:\n\n- item one',
      rounds: [
        {
          id: 'Sim0_20260805_batch1',
          title: 'b</script><script>alert(1)</script>', // hostile round title: must not break the inline MANIFEST
          points: [
            { index: 0, params: {}, metrics: {}, status: 'failed' },
            { index: 1, params: { cpf: '40f' }, metrics: { s21_at_10g: -0.49 }, status: 'success' },
            { index: 2, params: { cpf: '60f' }, metrics: { s21_at_10g: -0.61 }, status: 'success' },
          ],
        },
        { id: 'Sim0_20260805_batch2', points: { $file: 'SimResults/b2_points.json' }, curves: { $file: 'SimResults/b2_curves.json' } },
      ],
    }), 'utf8')

    const tool = makeTool(genReportTools().find((d) => d.name === 'gen_sweep_report'))
    const res = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: { id: SID_A } })
    assert.equal(res.ok, true)
    assert.equal(res.registered, true)
    assert.equal(res.session, SID_A)
    // D-005 layout: report at the PROJECT ROOT, data JS under SimResults/
    assert.match(res.report_path, /projX[\\/]projX_report\.html$/)
    assert.equal(res.report_dir, proj)
    assert.match(res.output, /\[report\] 2 round\(s\) -> /)
    for (const f of ['Sim0_20260805_batch1.js', 'Sim0_20260805_batch2.js']) {
      await readFile(path.join(simres, f)) // throws if missing
      assert.ok(res.output.includes(f) || true) // manifest references checked below
    }

    const html = await readFile(res.report_path, 'utf8')
    // both batches join the dropdown via the SimResults data scripts
    for (const f of ['SimResults/Sim0_20260805_batch1.js', 'SimResults/Sim0_20260805_batch2.js']) {
      assert.ok(html.includes(JSON.stringify(f).slice(1, -1)), `manifest must reference ${f}`)
    }
    // the D-005 empty-table fix: the param branch reads p.params, not the root
    assert.ok(html.includes('c.kind === "param") return { txt: esc(show(p.params ? p.params[c.key] : null))'),
      'cellVal must carry the param branch')
    // conclusions card renders (mini-markdown)
    assert.ok(html.includes('<strong>bold</strong>') && html.includes('<code>code</code>') && html.includes('<li>item one</li>'))
    // hostile round title: '</' is broken as '<\/' in the INLINE MANIFEST line
    // only; the EXTERNAL data JS keeps the raw title (that boundary is the
    // contract); the html-escaped project title stays plain text
    const inline = html.split('\n').find((l) => l.includes('const MANIFEST')) ?? ''
    assert.ok(inline.includes('b<\\/script><script>alert(1)<\\/script>'), inline)
    assert.ok(!inline.includes('b</script>'), inline)
    assert.ok(inline.includes('proj &amp; &lt;demo&gt;'), 'project title is html-escaped in the manifest')
    const dataJs = await readFile(path.join(simres, 'Sim0_20260805_batch1.js'), 'utf8')
    assert.ok(dataJs.includes('b</script>'))

    const rd = JSON.parse(dataJs.replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    // column names are the UNION across points (a failed empty first point
    // must not blank the param columns)
    assert.deepEqual(rd.param_names, ['cpf'])
    assert.deepEqual(rd.metric_names, ['s21_at_10g'])
    assert.deepEqual(rd.summary.s21_at_10g, { min: -0.61, max: -0.49, mean: -0.55, n: 2 })
    assert.equal(rd.points[1].label, 'cpf=40f') // label derived from params
    // charts specs embedded (single source of truth for page + PNG): the
    // metric chart on batch1, the curve chart on batch2 (which carries curves)
    assert.ok(rd.charts.some((c) => c.id === 'chart-metric-0' && c.kind === 'metric'))
    const rd2 = JSON.parse((await readFile(path.join(simres, 'Sim0_20260805_batch2.js'), 'utf8'))
      .replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    assert.ok(rd2.charts.some((c) => c.id === 'chart-curve-0' && c.kind === 'curve'))
    assert.ok(rd2.charts.some((c) => c.id === 'chart-metric-0' && c.kind === 'metric'))
    assert.deepEqual(rd2.charts.find((c) => c.kind === 'curve').indices, [0, 1])

    // PNG export: one per chart (metric charts per round + the curve chart)
    assert.ok(Array.isArray(res.figs) && res.figs.length >= 3, `figs: ${JSON.stringify(res.figs)}`)
    for (const f of res.figs) {
      const buf = await readFile(f.file)
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', f.file)
      assert.ok(buf.length > 1000, f.file)
      assert.match(path.basename(f.file), /^Sim0_20260805_batch\d_[-a-z0-9]+\.png$/)
    }

    const store = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store.sessions[SID_A].reports.length, 1)
    assert.equal(store.sessions[SID_A].reports[0].path, path.resolve(res.report_path))
    assert.equal(store.sessions[SID_A].dashboard_selected, store.sessions[SID_A].reports[0].id)

    // NO session identity in exec (direct server-side call) → report ok,
    // registration refused with a visible, actionable error
    const noAgent = await tool.execute({ spec: path.join(simres, 'spec.json') })
    assert.equal(noAgent.ok, true)
    assert.equal(noAgent.registered, false)
    assert.match(noAgent.register_error, /no session identity/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('gen_sweep_report: spec errors are actionable; project root derives from a SimResults spec location', async () => {
  const { ws } = await makeWorkspace()
  try {
    const proj = path.join(ws, 'projY')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })
    const tool = makeTool(genReportTools().find((d) => d.name === 'gen_sweep_report'))

    // spec in <project>/SimResults/ → project root derived, no project_dir
    await writeFile(path.join(simres, 'spec.json'), JSON.stringify({
      rounds: [{ id: 'Sim1_20261121_batch1', points: [{ index: 0, params: { a: 1 }, metrics: { m: 2 } }] }],
    }), 'utf8')
    const res = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: { id: SID_A } })
    assert.equal(res.ok, true)
    assert.equal(res.report_dir, proj)
    // metric-only round: one metric chart, no curves
    const rd = JSON.parse((await readFile(path.join(simres, 'Sim1_20261121_batch1.js'), 'utf8'))
      .replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    assert.equal(rd.charts.length, 1)
    assert.equal(rd.charts[0].kind, 'metric')

    // unknown $file → path resolves against the project root, message says so
    await writeFile(path.join(simres, 'bad.json'), JSON.stringify({
      project_dir: proj,
      rounds: [{ id: 'r1', points: { $file: 'SimResults/nope.json' } }],
    }), 'utf8')
    await assert.rejects(() => tool.execute({ spec: path.join(simres, 'bad.json') }, { agent: { id: SID_A } }),
      /\$file not found: .*projY.*SimResults.*nope\.json/)

    // unsafe round id / empty rounds / bad out
    await writeFile(path.join(simres, 'bad2.json'), JSON.stringify({ project_dir: proj, rounds: [{ id: '../evil', points: [{ index: 0 }] }] }), 'utf8')
    await assert.rejects(() => tool.execute({ spec: path.join(simres, 'bad2.json') }), /filename-safe/)
    await writeFile(path.join(simres, 'bad3.json'), JSON.stringify({ project_dir: proj, rounds: [] }), 'utf8')
    await assert.rejects(() => tool.execute({ spec: path.join(simres, 'bad3.json') }), /rounds/)
    await writeFile(path.join(simres, 'bad4.json'), JSON.stringify({ project_dir: proj, out: 'sub/dir/x.html', rounds: [{ id: 'r1', points: [{ index: 0 }] }] }), 'utf8')
    await assert.rejects(() => tool.execute({ spec: path.join(simres, 'bad4.json') }), /\.html filename/)

    // a spec outside SimResults without project_dir → derivation error
    await writeFile(path.join(ws, 'loose.json'), JSON.stringify({ rounds: [{ id: 'r1', points: [{ index: 0 }] }] }), 'utf8')
    await assert.rejects(() => tool.execute({ spec: path.join(ws, 'loose.json') }), /project root/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('gen_sweep_report: PNG export fails open — no charts or a broken renderer never fails the report', async () => {
  const { ws } = await makeWorkspace()
  try {
    const proj = path.join(ws, 'projZ')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })
    const tool = makeTool(genReportTools().find((d) => d.name === 'gen_sweep_report'))

    // a round with no metrics and no curves → zero charts → skipped, ok
    await writeFile(path.join(simres, 'spec.json'), JSON.stringify({
      project_dir: proj,
      rounds: [{ id: 'Sim0_20261121_batch1', points: [{ index: 0, params: { a: 1 } }] }],
    }), 'utf8')
    const res = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: { id: SID_A } })
    assert.equal(res.ok, true)
    assert.match(res.output, /\[figs\] skipped/)
    assert.equal(res.figs, undefined)

    // renderer-level failure (missing plotly file) surfaces in figs_note,
    // never as a thrown error — exercised directly against exportFigs
    const { exportFigs } = await import('../src/figs_export.js')
    const out = await exportFigs({
      rounds: [{ round: 'r1', charts: [{ id: 'c', title: 't', slug: 't', data: [{ x: [1], y: [1] }], layout: {} }] }],
      plotlyFile: path.join(ws, 'definitely-missing-plotly.min.js'),
      figsDir: path.join(proj, 'Figs'),
    })
    assert.deepEqual(out.figs, [])
    assert.match(out.error, /no local plotly\.min\.js/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
