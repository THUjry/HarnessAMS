// Unit tests for the Dashboard viewer surface: session-attached report store
// (project.js reports[]/dashboard_selected inside sessions.json v2), report
// file resolution + MIME (dashboard.js), the add-report directory browser,
// the /api/report-stat auto-refresh endpoint, the system-browser open action
// (openlocal.js + POST /api/open-local; route-level, through the
// apply()-registered handler), and the picking surface (picker.js: the
// host-borrowed folder chooser POST /api/pick-directory, our own native FILE
// dialog POST /api/pick-file — the add button's file-first flow, ANY failure
// silently falling back to the listing).
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { writeSessionConfig, readSessionConfigs } from '../src/core/project.js'
import { mimeFor, resolveReportFile } from '../src/server/dashboard.js'
import { resolveOpenableFile, openWithDefaultApp } from '../src/channel/openlocal.js'
import { pickDirectory, pickFile, browseDir } from '../src/channel/picker.js'
import { registerRoutes, callGet, fakeRes, clientSrc } from './helpers.mjs'

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

// ---- system-browser open (openlocal.js + POST /api/open-local) -------------

test('openlocal: resolveOpenableFile enforces the viewable fence', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-open-'))
  try {
    const html = path.join(ws, 'r.html')
    const png = path.join(ws, 'fig.png')
    const exe = path.join(ws, 'evil.exe')
    await writeFile(html, '<html></html>')
    await writeFile(png, 'x')
    await writeFile(exe, 'x')
    await mkdir(path.join(ws, 'dir.html'))

    // happy path: viewable existing files, forward slashes resolve on win32
    assert.equal((await resolveOpenableFile(html)).abs, path.resolve(html))
    assert.equal((await resolveOpenableFile(png)).abs, path.resolve(png))
    assert.equal((await resolveOpenableFile(html.split(path.sep).join('/'))).abs, path.resolve(html))

    // fence: relative / missing / directory / non-viewable / unsafe chars / bad input
    assert.equal((await resolveOpenableFile('r.html')).code, 400)
    assert.equal((await resolveOpenableFile(path.join(ws, 'nope.html'))).code, 404)
    assert.match((await resolveOpenableFile(path.join(ws, 'dir.html'))).error, /not a regular file/)
    assert.match((await resolveOpenableFile(exe)).error, /not a viewable file type/)
    assert.match((await resolveOpenableFile(path.join(ws, 'p%th.html'))).error, /quote safely/)
    assert.match((await resolveOpenableFile(path.join(ws, 'q"r.html'))).error, /quote safely/)
    assert.equal((await resolveOpenableFile('')).code, 400)
    assert.equal((await resolveOpenableFile(null)).code, 400)
    assert.equal((await resolveOpenableFile(42)).code, 400)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('openlocal: openWithDefaultApp composes the platform arg vector and surfaces launcher failure', async () => {
  const launches = []
  const okCtx = { openLauncher: async (file, args) => { launches.push({ file, args }); return { ok: true } } }
  const r = await openWithDefaultApp(okCtx, 'C:\\proj\\demo r.html')
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal(launches.length, 1)
  const expect = process.platform === 'win32'
    ? { file: 'cmd', args: ['/c', 'start', '', 'C:\\proj\\demo r.html'] }
    : process.platform === 'darwin'
      ? { file: 'open', args: ['C:\\proj\\demo r.html'] }
      : { file: 'xdg-open', args: ['C:\\proj\\demo r.html'] }
  assert.deepEqual(launches[0], expect)

  // no injected launcher -> the REAL spawn runs on a missing file (nothing
  // opens): the value contract still holds — ok or error, never a throw
  const bare = await openWithDefaultApp({}, path.join(tmpdir(), 'hams-open-missing-file.html'))
  assert.ok(bare && (bare.ok === true || typeof bare.error === 'string'), JSON.stringify(bare))

  // the REAL cordis ctx is a proxy that THROWS on reads of undeclared
  // properties ("cannot get property ... without inject") — the seam probe
  // must survive it and fall back to the real spawn, value-shaped, never a throw
  const throwingCtx = new Proxy({}, {
    get: (t, k) => { throw new Error(`cannot get property "${String(k)}" without inject`) },
  })
  const proxied = await openWithDefaultApp(throwingCtx, path.join(tmpdir(), 'hams-open-missing-file.html'))
  assert.ok(proxied && (proxied.ok === true || typeof proxied.error === 'string'), JSON.stringify(proxied))

  // an erroring / throwing launcher surfaces in the returned value
  const r2 = await openWithDefaultApp({ openLauncher: async () => ({ error: 'open failed on win32: spawn ENOENT xdg-open' }) }, '/tmp/x.html')
  assert.match(r2.error, /spawn ENOENT/)
  const r3 = await openWithDefaultApp({ openLauncher: async () => { throw new Error('boom') } }, '/tmp/x.html')
  assert.match(r3.error, /open failed .*boom/)
})

test('openlocal: POST /api/open-local guards origin, fences the path, launches the direct spawn, declares plotly', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-open-route-'))
  try {
    const htmlPath = path.join(ws, 'demo', 'r.html')
    await mkdir(path.dirname(htmlPath), { recursive: true })
    await writeFile(htmlPath, '<html></html>')
    await writeSessionConfig(ws, SID, { display: 'session', reports: [{ id: 'rep-1', path: htmlPath }], dashboard_selected: 'rep-1' })
    const exePath = path.join(ws, 'evil.exe')
    await writeFile(exePath, 'x')

    // The launcher seam replaces the real spawn (production always runs
    // node:child_process, openlocal.js); tests inject through ctx.
    const launches = []
    const openLauncher = async (file, args) => { launches.push({ file, args }); return { ok: true } }
    const handler = await registerRoutes({ workspaceRegistry: { list: () => [{ id: 'w-dash', path: ws, title: 'dash', sessionIds: [SID] }] }, openLauncher })
    const post = (payload, headers = {}) => ({
      method: 'POST', url: 'http://127.0.0.1/harnessams/api/open-local', headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) },
    })
    const call = async (payload, headers) => {
      const res = fakeRes()
      handler(post(payload, headers), res)
      for (let i = 0; i < 200 && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
      assert.ok(res.code, `route never responded: ${JSON.stringify(payload)}`)
      return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
    }

    // happy path: same-origin browser headers, known session, viewable file
    const sameOrigin = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' }
    const ok = await call({ sessionId: SID, path: htmlPath }, sameOrigin)
    assert.equal(ok.code, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.path, path.resolve(htmlPath))
    assert.equal(launches.length, 1)
    if (process.platform === 'win32') {
      assert.deepEqual(launches[0], { file: 'cmd', args: ['/c', 'start', '', path.resolve(htmlPath)] })
    }

    // seed-on-open: a report document seeds the project copy copy-if-missing
    // just before the viewer launches — the open action is the ONLY writer of
    // the project copy. A successful seed (or an existing copy — the present
    // flag) also DECLARES plotly_url in workspace_config.json: the config stays
    // plotly-free until this click.
    assert.equal(ok.body.plotly_seed.seeded, true)
    assert.equal(ok.body.plotly_seed.present, true)
    assert.equal(ok.body.plotly_seed.declared, true)
    const seededCopy = path.join(ws, '.harnessams', 'assets', 'plotly.min.js')
    assert.ok(existsSync(seededCopy), 'open-local must seed the project plotly copy')
    const cfg = JSON.parse(readFileSync(path.join(ws, '.harnessams', 'workspace_config.json'), 'utf8'))
    assert.equal(cfg.workspace.plotly_url, '.harnessams/assets/plotly.min.js')
    const ok2 = await call({ sessionId: SID, path: htmlPath }, sameOrigin)
    assert.equal(ok2.code, 200)
    assert.equal(ok2.body.plotly_seed.seeded, false, 'second open is a copy-if-missing no-op')
    assert.equal(ok2.body.plotly_seed.present, true)
    assert.equal(ok2.body.plotly_seed.declared, false, 'the declaration is already in place')
    assert.match(ok2.body.plotly_seed.reason, /already present/)

    // non-report documents open without seeding or declaring
    const pngPath = path.join(ws, 'fig.png')
    await writeFile(pngPath, 'x')
    const png = await call({ sessionId: SID, path: pngPath }, sameOrigin)
    assert.equal(png.code, 200)
    assert.equal(png.body.plotly_seed, null)

    // cross-site metadata / mismatched origin rejected before anything launches
    assert.equal((await call({ sessionId: SID, path: htmlPath }, { 'sec-fetch-site': 'cross-site' })).code, 403)
    assert.equal((await call({ sessionId: SID, path: htmlPath }, { origin: 'http://evil.example', host: '127.0.0.1:1' })).code, 403)
    assert.equal(launches.length, 3)

    // no browser headers (curl/tests) pass; session + fence rejections never launch
    assert.equal((await call({ sessionId: 'session-nope-0000-0000-0000-000000000000', path: htmlPath })).code, 404)
    assert.equal((await call({ sessionId: SID, path: 'relative.html' })).code, 400)
    assert.equal((await call({ sessionId: SID, path: path.join(ws, 'missing.html') })).code, 404)
    assert.equal((await call({ sessionId: SID, path: exePath })).code, 400)
    assert.equal((await call({ sessionId: SID })).code, 400)
    assert.equal((await call({})).code, 400)
    assert.equal(launches.length, 3)

    // a failing launcher surfaces as a 500 value error, never a throw
    const failing = await registerRoutes({ workspaceRegistry: { list: () => [{ id: 'w-dash', path: ws, title: 'dash', sessionIds: [SID] }] }, openLauncher: async () => ({ error: 'open failed on win32: spawn ENOENT xdg-open' }) })
    const res2 = fakeRes()
    failing(post({ sessionId: SID, path: htmlPath }, {}), res2)
    for (let i = 0; i < 200 && res2.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(res2.code, 500)
    assert.match(JSON.parse(res2.body).error, /open failed/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

// ---- system pickers (picker.js: POST /api/pick-directory — the host's
// folder chooser; POST /api/pick-file — OUR native file dialog, the add
// button's file-first flow with silent fallback to the listing) ------------

test('pickdir: pickDirectory drives the capability object without inject, value-shaped', async () => {
  const seen = { signal: null }
  // the seam is ctx.get('directoryPicker') — read WITHOUT an inject
  // declaration (a static one would leave the plugin PENDING in headless);
  // the pick itself lives on the CAPABILITY object (service.pick is undefined —
  // the live first-build 503 while the kind probe said 'native')
  const ctxOf = (picker) => ({ get: (name) => (name === 'directoryPicker' ? picker : undefined) })
  const nativeCap = () => ({
    kind: 'native',
    pick: async (signal) => { seen.signal = signal; return 'D:\\picked dir' },
  })

  const r = await pickDirectory(ctxOf({ capability: nativeCap }))
  assert.equal(r.path, 'D:\\picked dir')
  assert.ok(seen.signal instanceof AbortSignal, 'pick must receive an abort signal (the timeout fence)')
  assert.ok(!seen.signal.aborted)

  // user cancel resolves null -> { canceled }, never an error
  assert.deepEqual(
    await pickDirectory(ctxOf({ capability: () => ({ kind: 'native', pick: async () => null }) })),
    { canceled: true })

  // browse backend / capability without pick / throwing capability / malformed
  // service -> 503, no throw (the client turns ANY failure into the fallback)
  assert.equal((await pickDirectory(ctxOf({ capability: () => ({ kind: 'browse', list: async () => ({}) }) }))).code, 503)
  assert.equal((await pickDirectory(ctxOf({ capability: () => ({ kind: 'native' }) }))).code, 503)
  assert.equal((await pickDirectory(ctxOf({ capability: () => { throw new Error('kaput') } }))).code, 503)
  assert.equal((await pickDirectory({})).code, 503)
  assert.equal((await pickDirectory(null)).code, 503)

  // a failing / lying pick surfaces as a 500 value error
  assert.equal((await pickDirectory(ctxOf({ capability: () => ({ kind: 'native', pick: async () => { throw new Error('dialog crashed') } }) }))).code, 500)
  assert.match((await pickDirectory(ctxOf({ capability: () => ({ kind: 'native', pick: async () => 42 }) }))).error, /invalid path/)

  // the REAL cordis ctx is a proxy that THROWS on reads of undeclared
  // properties — the ctx.get probe itself must survive it: value-shaped,
  // never a throw
  const throwingCtx = new Proxy({}, {
    get: (t, k) => { throw new Error(`cannot get property "${String(k)}" without inject`) },
  })
  assert.equal((await pickDirectory(throwingCtx)).code, 503)
})

test('pickdir: POST /api/pick-directory picks, cancels, guards origin, falls back value-shaped', async () => {
  // mutable pick outcome: path -> canceled across calls
  let outcome = 'D:\\Reports\\Pi11dB'
  const picker = { capability: () => ({ kind: 'native', pick: async () => outcome }) }
  const handler = await registerRoutes({ get: (name) => (name === 'directoryPicker' ? picker : undefined) })

  const postCall = async (hdl, url, headers = {}) => {
    const res = fakeRes()
    hdl({ method: 'POST', url, headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } }, res)
    for (let i = 0; 200 > i && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(res.code, `route never responded: ${url}`)
    return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
  }
  const url = 'http://127.0.0.1/harnessams/api/pick-directory'

  // happy path: same-origin browser headers; no sessionId requirement by design
  const sameOrigin = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' }
  const ok = await postCall(handler, url, sameOrigin)
  assert.equal(ok.code, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.path, 'D:\\Reports\\Pi11dB')

  // user cancel is a 200 no-op payload
  outcome = null
  const canceled = await postCall(handler, url, sameOrigin)
  assert.equal(canceled.code, 200)
  assert.equal(canceled.body.canceled, true)

  // cross-site metadata / mismatched origin rejected before any dialog pops
  assert.equal((await postCall(handler, url, { 'sec-fetch-site': 'cross-site' })).code, 403)
  assert.equal((await postCall(handler, url, { origin: 'http://evil.example', host: '127.0.0.1:1' })).code, 403)

  // no browser headers (curl/tests) pass; the browse backend has no pick -> 503
  const browse = await registerRoutes({ get: () => ({ capability: () => ({ kind: 'browse', list: async () => ({}) }) }) })
  const declined = await postCall(browse, url)
  assert.equal(declined.code, 503)
  assert.match(declined.body.error, /not native/)

  // default fake ctx (no ctx.get at all — headless/hand-rolled embeds) -> 503
  const bare = await registerRoutes({})
  assert.equal((await postCall(bare, url)).code, 503)

  // the 405 hint lists the POST route
  const wrong = await postCall(handler, 'http://127.0.0.1/harnessams/api/browse')
  assert.equal(wrong.code, 405)
  assert.match(wrong.body.error, /pick-directory/)
})

test('dashboard: the add button pops the system FILE picker first, then silently falls back (static contract)', async () => {
  const src = await clientSrc()
  // add flow (file-first): POST /api/pick-file — the picked path
  // IS a single html file (the dialog filter + the route's extension gate),
  // so it registers directly; ANY failure opens the listing without
  // surfacing an error, a cancel keeps it shut
  assert.match(src, /fetchJson\(API \+ '\/pick-file', \{/)
  assert.ok(!src.includes("fetchJson(API + '/pick-directory'"), 'the folder chooser stays out of the add flow')
  assert.match(src, /setDialogCwd\(null\); setDialogOpen\(true\) \/\/ silent fallback/)
  // the manual path field carries its own .html gate (the client-side half
  // of the forced single-html contract)
  assert.match(src, /'dash\.addBadExt'/)
  // the listing dialog is purely local: no in-dialog system affordance
  assert.ok(!src.includes('dash.sysBrowse'), 'no system-browse button inside the listing dialog')
})

// ---- our own native FILE dialog (picker.js pickFile + POST /api/pick-file:
// the file-first add flow — the dialog contract is exit 0 = the chosen
// absolute path on stdout, exit 2 = cancel, exit 1 = script error) ----------

// A fake child for the pickFile internals seam: PassThrough pipes plus an
// event emitter; `drive` scripts the dialog outcome asynchronously (the
// listeners attach synchronously right after spawnImpl returns).
function fakeChild(drive) {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  if (drive) queueMicrotask(() => drive(child))
  return child
}

test('picker: pickFile maps the spike contract — picked / canceled / error, value-shaped', async () => {
  const spawns = []
  const implOf = (drive) => (cmd, args, opts) => {
    spawns.push({ cmd, args, opts })
    return fakeChild(cmd === 'taskkill' ? null : drive)
  }

  const picked = await pickFile({}, { platform: 'win32', spawnImpl: implOf((c) => { c.stdout.end('D:\\Reports\\Pi14dB_report.html'); c.emit('exit', 0) }) })
  assert.equal(picked.path, 'D:\\Reports\\Pi14dB_report.html')
  // powershell 5.1 STA + the shipped dialog script beside picker.js
  const s = spawns[0]
  assert.equal(s.cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(s.args[0], '-NoProfile')
  assert.ok(s.args.includes('-STA'), 'the forms dialog requires -STA on powershell.exe')
  assert.ok(String(s.args[5]).endsWith('picker.ps1'), 'the dialog script ships with the package')
  assert.equal(s.opts.windowsHide, true)

  // canceled: exit 2, empty stdout
  assert.deepEqual(
    await pickFile({}, { platform: 'win32', spawnImpl: implOf((c) => c.emit('exit', 2)) }),
    { canceled: true })

  // script error: exit 1 + stderr — a 500 value error, never a throw
  const errored = await pickFile({}, { platform: 'win32', spawnImpl: implOf((c) => { c.stderr.end('boom'); c.emit('exit', 1) }) })
  assert.equal(errored.code, 500)
  assert.match(errored.error, /boom/)

  // exit 0 with no stdout violates the contract -> 500
  const empty = await pickFile({}, { platform: 'win32', spawnImpl: implOf((c) => c.emit('exit', 0)) })
  assert.equal(empty.code, 500)
  assert.match(empty.error, /no path/)

  // an unsupported platform reports 503 — the client's silent fallback
  const mac = await pickFile({}, { platform: 'darwin' })
  assert.equal(mac.code, 503)
  assert.match(mac.error, /unsupported on darwin/)
})

test('picker: a hung dialog is killed tree-wide at the deadline', async () => {
  const kills = []
  let dialog
  const spawnImpl = (cmd, args) => {
    if (cmd === 'taskkill') {
      kills.push(args)
      // the real taskkill dies asynchronously; so must the fake (the exit
      // listener registers synchronously after kill() returns)
      queueMicrotask(() => dialog?.emit('exit', null))
      return fakeChild(null)
    }
    dialog = fakeChild(null) // never exits on its own: a stuck modal
    return dialog
  }
  const r = await pickFile({ timeoutMs: 80 }, { platform: 'win32', spawnImpl })
  assert.equal(r.code, 500)
  assert.match(r.error, /timed out/)
  assert.deepEqual(kills, [['/PID', '4242', '/T', '/F']])
})

test('picker: the linux arm tries zenity then kdialog; a missing binary falls through', async () => {
  const cmds = []
  const spawnImpl = (cmd) => {
    cmds.push(cmd)
    if (cmd === 'zenity') {
      // ENOENT: the child 'error' event, no exit code at all
      const child = fakeChild(null)
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn zenity ENOENT'), { code: 'ENOENT' })))
      return child
    }
    return fakeChild((c) => { c.stdout.end('/home/op/report.html'); c.emit('exit', 0) })
  }
  const r = await pickFile({}, { platform: 'linux', spawnImpl })
  assert.equal(r.path, '/home/op/report.html')
  assert.deepEqual(cmds, ['zenity', 'kdialog'])

  // zenity present, user cancels (exit 1, empty stdout)
  assert.deepEqual(
    await pickFile({}, { platform: 'linux', spawnImpl: () => fakeChild((c) => c.emit('exit', 1)) }),
    { canceled: true })

  // neither binary exists -> 503 with install guidance (still value-shaped)
  const missing = await pickFile({}, {
    platform: 'linux',
    spawnImpl: (cmd) => {
      const child = fakeChild(null)
      queueMicrotask(() => child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })))
      return child
    },
  })
  assert.equal(missing.code, 503)
  assert.match(missing.error, /zenity or kdialog/)
})

test('picker: POST /api/pick-file picks, cancels, guards origin, enforces the html single-file contract', async () => {
  // the ctx seam (the openLauncher pattern): a plain-object harness injects
  // the dialog spawn; the real host ctx is a proxy that throws on undeclared
  // reads, so production always lands on the real dialog
  let drive = (c) => { c.stdout.end('D:\\Reports\\Pi14dB_report.html'); c.emit('exit', 0) }
  const spawnImpl = (cmd) => {
    if (cmd === 'taskkill') return fakeChild(null)
    return fakeChild(drive)
  }
  const handler = await registerRoutes({ harnessPickFileInternals: { platform: 'win32', spawnImpl } })

  const postCall = async (hdl, url, headers = {}) => {
    const res = fakeRes()
    hdl({ method: 'POST', url, headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') } }, res)
    for (let i = 0; 200 > i && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(res.code, `route never responded: ${url}`)
    return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
  }
  const url = 'http://127.0.0.1/harnessams/api/pick-file'
  const sameOrigin = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' }

  // happy path: the picked path registers directly — no one-html-per-folder
  // judgment anywhere
  const ok = await postCall(handler, url, sameOrigin)
  assert.equal(ok.code, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.path, 'D:\\Reports\\Pi14dB_report.html')

  // a non-html pick is a 400 (the server-side half of the forced contract)
  drive = (c) => { c.stdout.end('D:\\Notes\\plain.txt'); c.emit('exit', 0) }
  const txt = await postCall(handler, url, sameOrigin)
  assert.equal(txt.code, 400)
  assert.match(txt.body.error, /must end in \.html/)

  // user cancel is a 200 no-op payload
  drive = (c) => c.emit('exit', 2)
  const canceled = await postCall(handler, url, sameOrigin)
  assert.equal(canceled.code, 200)
  assert.equal(canceled.body.canceled, true)

  // cross-site metadata / mismatched origin rejected before any dialog pops
  assert.equal((await postCall(handler, url, { 'sec-fetch-site': 'cross-site' })).code, 403)
  assert.equal((await postCall(handler, url, { origin: 'http://evil.example', host: '127.0.0.1:1' })).code, 403)

  // the 405 hint lists the POST route
  const wrong = await postCall(handler, 'http://127.0.0.1/harnessams/api/browse')
  assert.equal(wrong.code, 405)
  assert.match(wrong.body.error, /pick-file/)
})
