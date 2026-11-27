// Tests for the gen_sweep_report tool and register_report: spec-driven report
// rendering, the file layout (report at the project root, its data JS in
// SimResults/<report name>/ — one directory per report, PNGs in Figs/ gated
// by the calling SESSION's report_figs option), the guarded single-session
// merge-write of the VERSIONLESS sessions.json, the full tool.execute(args, exec) flow —
// the calling session comes from exec.agent.id (a delegated subagent resolves
// to its topmost user-visible ancestor) — and register_report attaching ANY
// existing local HTML into the calling session's dashboard.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { genReportTools, sessionsStoreAt, registerReportIntoSession, sessionReportFigs } from '../src/tools/gen_report.js'
import { makeTool } from '../src/tool.js'

const SID_A = 'session-aaaa1111-2222-3332-4444-555555555555'
const SID_B = 'session-bbbb1111-2222-3332-4444-555555555555'

// Project anchoring: the report tool resolves the calling session's project
// through ctx.workspaceRegistry (no path walk-up) — a minimal registry mapping
// the fixture workspace to the session ids the tests use.
function registryCtx(ws) {
  return { workspaceRegistry: { list: () => [{ id: 'ws-inject', path: ws, title: 'inject', sessionIds: [SID_A, SID_B] }] } }
}

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
        check_params: { rcl: { r: [1, 100], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
          mult: { nf: [1, 128], m: [1, 1000] }, unit_check: true },
      },
    },
  }, null, 2) + '\n', 'utf8')
  return { ws, storeDir }
}

// The PNG gate is the calling SESSION's option (the "Report figures" switch in
// the HarnessAMS session panel): a flag on that session's sessions.json entry.
async function setSessionFigs(storeDir, sid, on) {
  const file = path.join(storeDir, 'sessions.json')
  const store = JSON.parse(await readFile(file, 'utf8'))
  if (on) store.sessions[sid].report_figs = true
  else delete store.sessions[sid].report_figs
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

test('inject: sessionsStoreAt anchors at a GIVEN project root (no walk-up)', async () => {
  const { ws } = await makeWorkspace()
  try {
    // the store dir is always <projectRoot>/.harnessams — a nested design
    // folder is NOT discovered (the caller passes the session-resolved root)
    assert.deepEqual(sessionsStoreAt(ws), { storeDir: path.join(ws, '.harnessams') })
    const design = path.join(ws, 'Pi12dB')
    assert.deepEqual(sessionsStoreAt(design), { storeDir: path.join(design, '.harnessams') })
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
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
    // versionless: the tool's own write heals the legacy `version` key
    // off the fixture file
    assert.equal(store3.version, undefined)

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
    // PNG export is opt-in (the calling session's report_figs option): this
    // e2e fixture turns it on for SID_A
    await setSessionFigs(storeDir, SID_A, true)
    const proj = path.join(ws, 'projX')
    const simres = path.join(proj, 'SimResults')
    // the report's own data directory (the default report name of project projX)
    const dataDir = path.join(simres, 'projX_report')
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

    // batch1 inline; FIRST point failed with no params — the empty-table
    // trap: column names must come from the union, never points[0] alone
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

    const tool = makeTool(genReportTools(registryCtx(ws)).find((d) => d.name === 'gen_sweep_report'))
    const res = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: { id: SID_A } })
    assert.equal(res.ok, true)
    assert.equal(res.registered, true)
    assert.equal(res.session, SID_A)
    // layout: report at the PROJECT ROOT, its data JS in a directory of
    // its own under SimResults/ (named after the HTML file)
    assert.match(res.report_path, /projX[\\/]projX_report\.html$/)
    assert.equal(res.report_dir, proj)
    assert.match(res.output, /\[report\] 2 round\(s\) -> /)
    for (const f of ['Sim0_20260805_batch1.js', 'Sim0_20260805_batch2.js']) {
      await readFile(path.join(dataDir, f)) // throws if missing
    }

    const html = await readFile(res.report_path, 'utf8')
    // both batches join the dropdown via the report's own data scripts
    for (const f of ['SimResults/projX_report/Sim0_20260805_batch1.js', 'SimResults/projX_report/Sim0_20260805_batch2.js']) {
      assert.ok(html.includes(JSON.stringify(f).slice(1, -1)), `manifest must reference ${f}`)
    }
    // plotly chain: the server's route to the packaged
    // copy is the DEFAULT src; the project copy rides as the in-page fallback
    // line (seeded on demand by the open-outside-sidebar path, not here); the
    // CDN is the last resort. Generation must NOT seed the project copy.
    assert.ok(html.includes('<script src="/harnessams/assets/plotly.min.js"></script>'), 'route step must be the default src')
    assert.ok(html.includes('window.Plotly || document.write(\'<script src="../.harnessams/assets/plotly.min.js"><\\/script>\');'),
      'project-copy fallback line must reference the copy relatively')
    assert.ok(html.includes('window.Plotly || document.write(\'<script src="https://cdn.plot.ly/plotly-3.0.1.min.js"><\\/script>\');'),
      'CDN fallback line')
    assert.ok(!existsSync(path.join(ws, '.harnessams', 'assets', 'plotly.min.js')), 'generation must not seed the project copy')
    // newest-first manifest: batch2 precedes batch1 (natural id order, desc)
    const mLine = html.split('\n').find((l) => l.includes('const MANIFEST')) ?? ''
    assert.ok(mLine.includes('Sim0_20260805_batch2') && mLine.indexOf('Sim0_20260805_batch2') < mLine.indexOf('Sim0_20260805_batch1'),
      'manifest must list the newest round first')
    // the param branch reads p.params, not the root
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
    const dataJs = await readFile(path.join(dataDir, 'Sim0_20260805_batch1.js'), 'utf8')
    assert.ok(dataJs.includes('b</script>'))

    const rd = JSON.parse(dataJs.replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    // column names are the UNION across points (a failed empty first point
    // must not blank the param columns)
    assert.deepEqual(rd.param_names, ['cpf'])
    assert.deepEqual(rd.metric_names, ['s21_at_10g'])
    assert.deepEqual(rd.summary.s21_at_10g, { min: -0.61, max: -0.49, mean: -0.55, n: 2 })
    assert.equal(rd.points[1].label, 'cpf=40f') // label derived from params
    // charts specs embedded (single source of truth for page + PNG): curve
    // charts ONLY — the points-only batch1 renders no charts at all (scalars
    // live in the table), batch2's curves yield exactly one curve chart with
    // the trace-order -> point-index map
    assert.deepEqual(rd.charts, [])
    const rd2 = JSON.parse((await readFile(path.join(dataDir, 'Sim0_20260805_batch2.js'), 'utf8'))
      .replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    assert.equal(rd2.charts.length, 1)
    assert.equal(rd2.charts[0].id, 'chart-curve-0')
    assert.equal(rd2.charts[0].kind, 'curve')
    assert.deepEqual(rd2.charts[0].indices, [0, 1])

    // PNG export (the calling session's option on): one PNG per curve chart — exactly one here
    assert.ok(Array.isArray(res.figs) && res.figs.length === 1, `figs: ${JSON.stringify(res.figs)}`)
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

// seedProjectPlotly: the ONLY writer of the project
// plotly copy — the open-outside-sidebar path calls it right before the OS
// viewer launches. Copy-if-missing; a size mismatch refreshes from the
// packaged copy (plotly version bump); http(s)/custom plotly_url targets are
// the user's own file and stay untouched. Every path where the copy EXISTS at
// the default target afterwards carries present:true (the route then declares
// plotly_url in workspace_config.json); refusal paths omit the flag.
test('seedProjectPlotly: copy-if-missing, size-refresh, no-op and override semantics', async () => {
  const { seedProjectPlotly } = await import('../src/core/report_render.js')
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-seed-'))
  try {
    const copy = path.join(ws, '.harnessams', 'assets', 'plotly.min.js')
    // default target (no workspace_config.json): missing → copied from the packaged copy
    const r1 = seedProjectPlotly(ws)
    assert.equal(r1.seeded, true, JSON.stringify(r1))
    assert.equal(r1.present, true)
    assert.ok(existsSync(copy))
    const seededBytes = (await readFile(copy)).length
    assert.ok(seededBytes > 1000, 'the seeded copy is the packaged plotly, not a stub')
    // already present, same size → no-op
    const r2 = seedProjectPlotly(ws)
    assert.equal(r2.seeded, false)
    assert.equal(r2.present, true)
    assert.match(r2.reason, /already present/)
    // size mismatch → refreshed from the packaged copy
    await writeFile(copy, 'stale', 'utf8')
    const r3 = seedProjectPlotly(ws)
    assert.equal(r3.seeded, true)
    assert.equal(r3.refreshed, true)
    assert.equal(r3.present, true)
    assert.equal((await readFile(copy)).length, seededBytes)

    // explicit http(s) plotly_url → untouched, no copy created, nothing declared
    await writeFile(path.join(ws, '.harnessams', 'workspace_config.json'), JSON.stringify({
      version: 1, workspace: { plotly_url: 'https://cdn.plot.ly/plotly-3.0.1.min.js' }, settings: {},
    }, null, 2) + '\n', 'utf8')
    await rm(copy)
    const r4 = seedProjectPlotly(ws)
    assert.equal(r4.seeded, false)
    assert.equal(r4.present, undefined)
    assert.match(r4.reason, /http\(s\)/)
    assert.ok(!existsSync(copy))

    // custom local target → untouched (the user manages their own file)
    await writeFile(path.join(ws, '.harnessams', 'workspace_config.json'), JSON.stringify({
      version: 1, workspace: { plotly_url: 'shared/plotly.min.js' }, settings: {},
    }, null, 2) + '\n', 'utf8')
    const r5 = seedProjectPlotly(ws)
    assert.equal(r5.seeded, false)
    assert.equal(r5.present, undefined)
    assert.match(r5.reason, /custom plotly_url/)

    // no project root at all
    const r6 = seedProjectPlotly(null)
    assert.equal(r6.seeded, false)
    assert.equal(r6.present, undefined)
    assert.match(r6.reason, /no project root/)
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
    const tool = makeTool(genReportTools(registryCtx(ws)).find((d) => d.name === 'gen_sweep_report'))

    // spec in <project>/SimResults/ → project root derived, no project_dir
    await writeFile(path.join(simres, 'spec.json'), JSON.stringify({
      rounds: [{ id: 'Sim1_20261121_batch1', points: [{ index: 0, params: { a: 1 }, metrics: { m: 2 } }] }],
    }), 'utf8')
    const res = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: { id: SID_A } })
    assert.equal(res.ok, true)
    assert.equal(res.report_dir, proj)
    // points-only round: a table-only round — zero charts (curve charts
    // only; scalar metrics render in the table, never as charts)
    const rd = JSON.parse((await readFile(path.join(simres, 'projY_report', 'Sim1_20261121_batch1.js'), 'utf8'))
      .replace(/^var ROUND_DATA = /, '').replace(/;$/, ''))
    assert.equal(rd.charts.length, 0)

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
    await assert.rejects(() => tool.execute({ spec: path.join(ws, 'loose.json') }), /output root/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('gen_sweep_report: PNG export fails open — no charts or a broken renderer never fails the report', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    // export enabled (the calling session's option), but the round has nothing chartable
    await setSessionFigs(storeDir, SID_A, true)
    const proj = path.join(ws, 'projZ')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })
    const tool = makeTool(genReportTools(registryCtx(ws)).find((d) => d.name === 'gen_sweep_report'))

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
    const { exportFigs } = await import('../src/core/figs_export.js')
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

test('gen_sweep_report: the PNG gate is the CALLING session\'s option — per session, strictly boolean, survives registration', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    // off by default, and only exactly true turns it on
    assert.equal(await sessionReportFigs(storeDir, SID_A), false)
    await setSessionFigs(storeDir, SID_A, true)
    assert.equal(await sessionReportFigs(storeDir, SID_A), true)
    assert.equal(await sessionReportFigs(storeDir, SID_B), false, 'the option is per session — the sibling stays off')
    assert.equal(await sessionReportFigs(storeDir, 'session-zzzz0000-0000-0000-0000-000000000000'), false, 'unknown session = off')

    // validateSessionState (the store's single gate): non-boolean refused, false
    // and absent both drop the key (stored only while on)
    const { validateSessionState, writeSessionConfig, readSessionConfigs } = await import('../src/core/project.js')
    assert.match(validateSessionState({ display: 'session', reports: [], report_figs: 'on' }).error, /report_figs must be a boolean/)
    assert.ok(!('report_figs' in validateSessionState({ display: 'session', reports: [], report_figs: false }).state))
    assert.ok(!('report_figs' in validateSessionState({ display: 'session', reports: [] }).state))
    assert.equal(validateSessionState({ display: 'session', reports: [], report_figs: true }).state.report_figs, true)
    // the route-level writer round-trips it beside check_params
    const w = await writeSessionConfig(ws, SID_B, {
      display: 'overview', reports: [], dashboard_selected: null, report_figs: true,
      check_params: { rcl: { r: [1, 100], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
        mult: { nf: [1, 128], m: [1, 1000] }, unit_check: false },
    })
    assert.ok(!w.error, w.error)
    const back = (await readSessionConfigs(ws)).sessions[SID_B]
    assert.equal(back.report_figs, true)
    assert.equal(back.check_params.unit_check, false)

    // registration (the tool's own write into the same entry) preserves the option
    const r = await registerReportIntoSession(storeDir, SID_A, path.join(ws, 'keep.html'))
    assert.ok(!r.error, r.error)
    assert.equal(await sessionReportFigs(storeDir, SID_A), true)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('gen_sweep_report: two reports of one project keep separate data', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    const proj = path.join(ws, 'projV')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })
    const tool = makeTool(genReportTools(registryCtx(ws)).find((d) => d.name === 'gen_sweep_report'))
    // the SAME round id with different numbers: v1 says m=1, v2 says m=2
    const spec = (metric, out) => JSON.stringify({
      project_dir: proj, ...(out ? { out } : {}),
      rounds: [{ id: 'Sim0_20261124_batch1', points: [{ index: 0, params: { a: 1 }, metrics: { m: metric } }] }],
    })
    await writeFile(path.join(simres, 'spec_v1.json'), spec(1, 'att_report.html'), 'utf8')
    await writeFile(path.join(simres, 'spec_v2.json'), spec(2, 'att_report_v2.html'), 'utf8')
    const dataOf = async (dir) => JSON.parse((await readFile(path.join(simres, dir, 'Sim0_20261124_batch1.js'), 'utf8'))
      .replace(/^var ROUND_DATA = /, '').replace(/;$/, '')).points[0].metrics.m

    const v1 = await tool.execute({ spec: path.join(simres, 'spec_v1.json') }, { agent: { id: SID_A } })
    assert.equal(v1.ok, true, JSON.stringify(v1))
    const v2 = await tool.execute({ spec: path.join(simres, 'spec_v2.json') }, { agent: { id: SID_A } })
    assert.equal(v2.ok, true, JSON.stringify(v2))

    // each HTML references its own data directory, and v1's numbers survive v2
    const h1 = await readFile(v1.report_path, 'utf8')
    const h2 = await readFile(v2.report_path, 'utf8')
    assert.ok(h1.includes('SimResults/att_report/Sim0_20261124_batch1.js'))
    assert.ok(h2.includes('SimResults/att_report_v2/Sim0_20261124_batch1.js'))
    assert.ok(!h1.includes('SimResults/att_report_v2/'))
    assert.equal(await dataOf('att_report'), 1, 'v1 data intact after v2 was generated')
    assert.equal(await dataOf('att_report_v2'), 2)
    assert.ok(!existsSync(path.join(simres, 'Sim0_20261124_batch1.js')), 'no shared flat data file')

    // both reports are registered side by side on the session, newest selected
    const store = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.deepEqual(store.sessions[SID_A].reports.map((r) => r.path), [path.resolve(v1.report_path), path.resolve(v2.report_path)])
    assert.equal(store.sessions[SID_A].dashboard_selected, store.sessions[SID_A].reports[1].id)

    // the SAME out name is one report: regenerating overwrites HTML and data
    await writeFile(path.join(simres, 'spec_v3.json'), spec(3, 'att_report.html'), 'utf8')
    const v3 = await tool.execute({ spec: path.join(simres, 'spec_v3.json') }, { agent: { id: SID_A } })
    assert.equal(v3.ok, true)
    assert.equal(await dataOf('att_report'), 3)
    assert.equal(await dataOf('att_report_v2'), 2, 'the sibling report is untouched')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// Subagent policy (src/subagent.js): a delegated subagent's report
// registers into its TOPMOST USER-VISIBLE ancestor's entry (sessions.json
// stays keyed by user-visible sessions only); a subagent whose lineage does
// not resolve gets no orphan entry — the report renders, registration says
// why it was skipped.
test('gen_sweep_report: a subagent registers into the ancestor session; a broken lineage writes no orphan entry', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    const proj = path.join(ws, 'projS')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })
    await writeFile(path.join(simres, 'spec.json'), JSON.stringify({
      project_dir: proj,
      rounds: [{ id: 'Sim0_20261126_batch1', points: [{ index: 0, params: { a: 1 }, metrics: { m: 7 } }] }],
    }), 'utf8')
    const SID_CHILD = 'session-child1111-2222-3332-4444-555555555555'
    const userAgent = { id: SID_A, session: { header: {} } }
    const agents = new Map([[SID_A, userAgent]])
    const ctx = { ...registryCtx(ws), agents: { get: (id) => agents.get(id) } }
    const tool = makeTool(genReportTools(ctx).find((d) => d.name === 'gen_sweep_report'))

    // seeded child of the accounted user session: the ancestor's entry takes
    // the report, the child id never appears as a sessions.json key
    const child = { id: SID_CHILD,
      session: { header: { origin: 'subagent', parentSession: SID_A, isSeeded: true } } }
    const ok = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: child })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(ok.registered, true)
    assert.equal(ok.session, SID_A)
    const store1 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store1.sessions[SID_CHILD], undefined, 'no child-id entry')
    assert.equal(store1.sessions[SID_A].reports.length, 1)

    // broken lineage (ancestor not live): the report still renders, but no
    // orphan entry is written — the result explains the skip
    const orphan = { id: SID_CHILD,
      session: { header: { origin: 'subagent', parentSession: 'session-gone1111-2222-3332-4444-555555555555', isSeeded: true } } }
    const skip = await tool.execute({ spec: path.join(simres, 'spec.json') }, { agent: orphan })
    assert.equal(skip.ok, true, JSON.stringify(skip))
    assert.equal(skip.registered, false)
    assert.match(skip.register_error, /subagent identity did not resolve/)
    const store2 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store2.sessions[SID_CHILD], undefined, 'still no child-id entry')
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// register_report: the standalone registration tool — an
// EXISTING local HTML (typically NOT gen_sweep_report's output) into the
// CALLING session's dashboard; every missing value (entry key, store location,
// id/name/added_at) is filled from the caller.
test('register_report: registers an EXISTING html into the CALLING session — fields auto-filled, idempotent, name override, store_warnings', async () => {
  const { ws, storeDir } = await makeWorkspace()
  const html = path.join(ws, 'external', 'hand.html')
  await mkdir(path.dirname(html), { recursive: true })
  await writeFile(html, '<html><body>external report</body></html>', 'utf8')
  try {
    const tool = makeTool(genReportTools(registryCtx(ws)).find((d) => d.name === 'register_report'))
    // external (non-gen) HTML: only the path is required
    const res = await tool.execute({ report_path: html }, { agent: { id: SID_A } })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.registered, true)
    assert.equal(res.session, SID_A)
    assert.equal(res.report.path, path.resolve(html))
    assert.equal(res.report.name, 'hand.html') // defaults to the basename
    assert.match(res.report.id, /^r-[\w-]{1,8}$/)
    assert.ok(res.report.added_at)
    assert.match(res.output, /\[register\]/)

    const store1 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store1.sessions[SID_A].reports.length, 1)
    assert.equal(store1.sessions[SID_A].dashboard_selected, res.report.id)
    assert.equal(store1.version, undefined, 'the tool\'s write is versionless')

    // same path again → same entry (idempotent); a name arg cannot rename a
    // reused entry
    const res2 = await tool.execute({ report_path: html, name: 'ignored' }, { agent: { id: SID_A } })
    assert.equal(res2.report.id, res.report.id)
    assert.equal(res2.report.name, 'hand.html', 'a reused entry keeps its original name')

    // a NEW path with a name override takes it (trimmed, ≤80 chars)
    const html2 = path.join(ws, 'external', 'second.htm')
    await writeFile(html2, '<html></html>', 'utf8')
    const res3 = await tool.execute({ report_path: html2, name: '  my second report  ' }, { agent: { id: SID_A } })
    assert.equal(res3.report.name, 'my second report')
    const store2 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store2.sessions[SID_A].reports.length, 2)
    assert.equal(store2.sessions[SID_A].dashboard_selected, res3.report.id)

    // a corrupted sibling session in the same store → the read-side skip
    // warning rides the result as store_warnings (loud skip)
    const raw = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    raw.sessions['bad key!'] = { display: 'overview', reports: [] }
    await writeFile(path.join(storeDir, 'sessions.json'), JSON.stringify(raw, null, 2) + '\n', 'utf8')
    const html3 = path.join(ws, 'external', 'third.html')
    await writeFile(html3, '<html></html>', 'utf8')
    const res4 = await tool.execute({ report_path: html3 }, { agent: { id: SID_A } })
    assert.equal(res4.registered, true)
    assert.ok(Array.isArray(res4.store_warnings) && res4.store_warnings.length === 1, JSON.stringify(res4.store_warnings))
    assert.match(res4.store_warnings[0], /bad key!/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('register_report: validation and identity failures throw actionable errors', async () => {
  const { ws } = await makeWorkspace()
  try {
    const tool = makeTool(genReportTools(registryCtx(ws)).find((d) => d.name === 'register_report'))
    await assert.rejects(() => tool.execute({ report_path: path.join(ws, 'missing.html') }), /report file not found/)
    const dirPath = path.join(ws, 'not-a-file.html')
    await mkdir(dirPath, { recursive: true })
    await assert.rejects(() => tool.execute({ report_path: dirPath }), /not a regular file/)
    const txt = path.join(ws, 'plain.txt')
    await writeFile(txt, 'x', 'utf8')
    await assert.rejects(() => tool.execute({ report_path: txt }), /must end in \.html/)
    // no session identity → nothing to key the registration on. Unlike
    // gen_sweep_report (whose report is already on disk) there is no partial
    // artifact to salvage — this tool's whole purpose is the write, so it throws
    const html = path.join(ws, 'ok.html')
    await writeFile(html, '<html></html>', 'utf8')
    await assert.rejects(() => tool.execute({ report_path: html }), /no session identity/)
    // a session unknown to the registry → anchor error listing the candidates
    await assert.rejects(() => tool.execute({ report_path: html }, { agent: { id: 'session-zzzz0000-0000-0000-0000-000000000000' } }),
      /not accounted in any workspace/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('register_report: a subagent registers into the ancestor session; a broken lineage throws instead of writing an orphan', async () => {
  const { ws, storeDir } = await makeWorkspace()
  const html = path.join(ws, 'sub.html')
  await writeFile(html, '<html></html>', 'utf8')
  try {
    const SID_CHILD = 'session-child2222-2222-3332-4444-555555555555'
    const userAgent = { id: SID_A, session: { header: {} } }
    const agents = new Map([[SID_A, userAgent]])
    const ctx = { ...registryCtx(ws), agents: { get: (id) => agents.get(id) } }
    const tool = makeTool(genReportTools(ctx).find((d) => d.name === 'register_report'))
    // seeded child of the accounted user session → lands in the ancestor's entry
    const child = { id: SID_CHILD,
      session: { header: { origin: 'subagent', parentSession: SID_A, isSeeded: true } } }
    const res = await tool.execute({ report_path: html }, { agent: child })
    assert.equal(res.registered, true)
    assert.equal(res.session, SID_A)
    const store = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store.sessions[SID_CHILD], undefined, 'no child-id entry')
    assert.equal(store.sessions[SID_A].reports.length, 1)
    // broken lineage (ancestor not live) → throws; no orphan entry
    const orphan = { id: SID_CHILD,
      session: { header: { origin: 'subagent', parentSession: 'session-gone2222-2222-3332-4444-555555555555', isSeeded: true } } }
    await assert.rejects(() => tool.execute({ report_path: html }, { agent: orphan }), /subagent identity did not resolve/)
    const store2 = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store2.sessions[SID_CHILD], undefined)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('gen_sweep_report register:false renders WITHOUT registering — the deferred attach goes through register_report', async () => {
  const { ws, storeDir } = await makeWorkspace()
  try {
    const proj = path.join(ws, 'projR')
    const simres = path.join(proj, 'SimResults')
    await mkdir(simres, { recursive: true })
    await writeFile(path.join(simres, 'spec.json'), JSON.stringify({
      project_dir: proj,
      rounds: [{ id: 'Sim0_20261126_batch1', points: [{ index: 0, params: { a: 1 }, metrics: { m: 5 } }] }],
    }), 'utf8')
    const ctx = registryCtx(ws)
    const gen = makeTool(genReportTools(ctx).find((d) => d.name === 'gen_sweep_report'))
    const reg = makeTool(genReportTools(ctx).find((d) => d.name === 'register_report'))
    const res = await gen.execute({ spec: path.join(simres, 'spec.json'), register: false }, { agent: { id: SID_A } })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.registered, false)
    assert.match(res.register_note, /register=false/)
    assert.equal(res.register_error, undefined)
    assert.ok(existsSync(res.report_path), 'the report still renders')
    let store = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store.sessions[SID_A].reports.length, 0, 'register:false leaves the session unregistered')
    // the deferred attach: register_report picks the rendered file up
    const r2 = await reg.execute({ report_path: res.report_path }, { agent: { id: SID_A } })
    assert.equal(r2.registered, true)
    store = JSON.parse(await readFile(path.join(storeDir, 'sessions.json'), 'utf8'))
    assert.equal(store.sessions[SID_A].reports.length, 1)
    assert.equal(store.sessions[SID_A].reports[0].path, path.resolve(res.report_path))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
