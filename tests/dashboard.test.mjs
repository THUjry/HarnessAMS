// Unit tests for the Dashboard viewer surface: session-attached report store
// (project.js reports[]/dashboard_selected inside sessions.json v2), report
// file resolution + MIME (dashboard.js), the add-report directory browser, and
// the /api/report-stat auto-refresh endpoint (route-level, through the
// apply()-registered handler).
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeSessionConfig, readSessionConfigs } from '../src/server/project.js'
import { mimeFor, resolveReportFile, browseDir } from '../src/server/dashboard.js'
import { registerRoutes, callGet } from './helpers.mjs'

const SID = 'session-dash1111-2222-3332-4444-555555555555'

test('dashboard: MIME by extension (a blanket text/html kills data/*.js scripts)', () => {
  assert.equal(mimeFor('r.html'), 'text/html; charset=utf-8')
  assert.equal(mimeFor('d/Round4.js'), 'text/javascript; charset=utf-8')
  assert.equal(mimeFor('style.CSS'), 'text/css; charset=utf-8') // case-insensitive
  assert.equal(mimeFor('plot.png'), 'image/png')
  assert.equal(mimeFor('blob.bin'), 'application/octet-stream') // unknown → download, not html
})

test('dashboard: writeSessionConfig normalizes the session report list (ids, absolute paths, dedupe, name default)', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-dash-'))
  try {
    const htmlPath = path.join(ws, 'demo', 'Analysis', 'round4_report.html')
    const w = await writeSessionConfig(ws, SID, {
      display: 'session',
      reports: [
        { path: htmlPath, name: 'R4 report' },
        { path: path.join(ws, 'demo', 'Analysis', '..', 'Analysis', 'round4_report.html') }, // dup by path → dropped (first wins)
      ],
      dashboard_selected: 'nowhere', // dangling → dropped
    })
    assert.ok(!w.error, w.error)
    const entry = w.sessions[SID]
    assert.equal(entry.reports.length, 1) // deduped
    assert.equal(entry.reports[0].path, path.resolve(htmlPath))
    assert.ok(/^[\w-]{1,64}$/.test(entry.reports[0].id))
    assert.equal(entry.reports[0].name, 'R4 report')
    assert.equal(entry.dashboard_selected, null) // dangling selection cleared

    // round-trip keeps ids and a matching selection
    const id = entry.reports[0].id
    const w2 = await writeSessionConfig(ws, SID, { display: 'session', reports: [{ ...entry.reports[0] }], dashboard_selected: id })
    assert.ok(!w2.error, w2.error)
    assert.equal(w2.sessions[SID].reports[0].id, id)
    assert.equal(w2.sessions[SID].dashboard_selected, id)

    // rejects non-absolute / non-html paths
    const bad1 = await writeSessionConfig(ws, SID, { display: 'overview', reports: [{ path: 'relative/r.html' }], dashboard_selected: null })
    assert.match(bad1.error, /absolute/)
    const bad2 = await writeSessionConfig(ws, SID, { display: 'overview', reports: [{ path: path.join(ws, 'r.txt') }], dashboard_selected: null })
    assert.match(bad2.error, /\.html/)

    // the store reads back through the v2 shape
    assert.equal((await readSessionConfigs(ws)).sessions[SID].reports.length, 1)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('dashboard: resolveReportFile finds the session store and bounds rel to the report dir', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-dash-ws-'))
  try {
    const analysis = path.join(ws, 'broadband3_round4_repro', 'Analysis')
    await mkdir(path.join(analysis, 'data'), { recursive: true })
    const htmlPath = path.join(analysis, 'round4_report.html')
    await writeFile(htmlPath, '<html></html>')
    await writeFile(path.join(analysis, 'data', 'Round4.js'), 'var ROUND_DATA = {};')
    await writeSessionConfig(ws, SID, { display: 'session', reports: [{ id: 'rep-1', path: htmlPath }], dashboard_selected: 'rep-1' })

    const registry = { list: () => [{ path: ws }, { path: path.join(ws, 'not-a-workspace') }] }
    const doc = await resolveReportFile(registry, SID, 'rep-1', '')
    assert.equal(doc.abs, path.resolve(htmlPath))
    const data = await resolveReportFile(registry, SID, 'rep-1', 'data/Round4.js')
    assert.equal(data.abs, path.join(path.resolve(analysis), 'data', 'Round4.js'))

    const esc1 = await resolveReportFile(registry, SID, 'rep-1', '../secret.txt')
    assert.equal(esc1.code, 403)
    const esc2 = await resolveReportFile(registry, SID, 'rep-1', 'data/../../x.js')
    assert.equal(esc2.code, 403)
    const miss = await resolveReportFile(registry, SID, 'rep-9', '')
    assert.equal(miss.code, 404)
    const noRegistry = await resolveReportFile(null, SID, 'rep-1', '')
    assert.equal(noRegistry.code, 503)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('dashboard: /api/report-stat answers the report mtime+size for the auto-refresh poll', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-dash-stat-'))
  try {
    const htmlPath = path.join(ws, 'demo', 'Analysis', 'r.html')
    await mkdir(path.dirname(htmlPath), { recursive: true })
    await writeFile(htmlPath, '<html></html>')
    await writeSessionConfig(ws, SID, { display: 'session', reports: [{ id: 'rep-1', path: htmlPath }], dashboard_selected: 'rep-1' })

    const handler = await registerRoutes({ workspaceRegistry: { list: () => [{ path: ws }] } })
    const call = (query) => callGet(handler, 'http://127.0.0.1/harnessams/api/report-stat' + query)

    const ok = await call('?sessionId=' + SID + '&reportId=rep-1')
    assert.equal(ok.code, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(typeof ok.body.mtime_ms, 'number')
    assert.equal(ok.body.size, '<html></html>'.length)

    // missing params / unknown ids keep the 4xx contract
    assert.equal((await call('?sessionId=' + SID)).code, 400)
    assert.equal((await call('?sessionId=' + SID + '&reportId=nope')).code, 404)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('dashboard: browseDir lists dirs + *.html, hides dot entries, reports parent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-dash-browse-'))
  try {
    await mkdir(path.join(dir, 'subdir'))
    await mkdir(path.join(dir, '.git'))
    await writeFile(path.join(dir, 'a.html'), 'x')
    await writeFile(path.join(dir, 'B.HTML'), 'x')
    await writeFile(path.join(dir, 'notes.txt'), 'x')
    const r = await browseDir(path.join(dir, 'SUBDIR'), dir) // resolves through case
    assert.deepEqual(r.dirs, [])
    assert.deepEqual(r.htmls, [])
    const root = await browseDir(dir)
    assert.deepEqual(root.dirs, ['subdir']) // .git hidden
    assert.deepEqual(root.htmls.map((f) => f.name).sort(), ['B.HTML', 'a.html'].sort())
    assert.equal(root.parent, path.dirname(path.resolve(dir)))
    const bad = await browseDir(path.join(dir, 'missing'))
    assert.match(bad.error, /cannot list/)
    const fallback = await browseDir('', dir) // empty target → fallback
    assert.equal(fallback.path, path.resolve(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
