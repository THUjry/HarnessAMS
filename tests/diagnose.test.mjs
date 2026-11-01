// Diagnosis-session surface (branch check-diagnose-session): prompt assembly and
// size caps (server/diagnose.js), the session-controller handoff, and the
// POST /api/checks/analyze route (route-level, through the apply()-registered
// handler, same discipline as dashboard.test.mjs). The client half is a
// combo-loaded classic script, so its contract is pinned against the source text.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sanitizeFailed, buildDiagnosisPrompt, createDiagnosisSession } from '../src/server/diagnose.js'
import { apply } from '../src/index.js'

test('diagnose: sanitizeFailed caps entries and text, drops unknown fields', () => {
  const big = 'x'.repeat(5000)
  const out = sanitizeFailed([
    { item: 'LSF jobs', cmd: 'bjobs', detail: big, result: 'r', rowsRaw: Array.from({ length: 40 }, (_, i) => 'line' + i), rows: [['a', 'b']], secret: 'nope', extraFn: () => {} },
    ...Array.from({ length: 12 }, (_, i) => ({ item: 'e' + i, detail: big })),
    'not-an-object',
  ])
  assert.equal(out.length, 8)
  assert.equal(out[0].detail.length, 1500 + '… (5000 chars total)'.length)
  assert.equal(out[0].rowsRaw.length, 20)
  assert.equal(out[0].rows[0].join(','), 'a,b')
  assert.equal(out[0].secret, undefined)
  assert.equal(out[1].item, 'e0')
  assert.ok(out.every((x) => x.ok === false))
  assert.equal(sanitizeFailed(null).length, 0)
})

test('diagnose: prompt body is English, context is complete, language line follows lang', () => {
  const base = {
    check: 'jobs',
    machine: { id: 'm1', name: 'node1', host: '10.0.0.1', port: 22, username: 'user' },
    remotePath: '/home/user/sim',
    mirrorDir: 'C:/u/.dsh/remote-workspaces/n1/2222/user/ws',
    projectTitle: 'broadband3 repro',
    failed: [{ item: 'LSF jobs', detail: 'bjobs: command not found' }],
  }
  const zh = buildDiagnosisPrompt({ ...base, lang: 'zh', auto: true })
  const en = buildDiagnosisPrompt({ ...base, lang: 'en', auto: false })
  for (const p of [zh, en]) {
    assert.ok(p.includes('Check: LSF jobs (id: jobs)'))
    assert.ok(p.includes('node1 (user@10.0.0.1:22)'))
    assert.ok(p.includes('Remote workspace path: /home/user/sim'))
    assert.ok(p.includes('Project: broadband3 repro'))
    assert.ok(p.includes('bjobs: command not found'))
    assert.ok(p.includes('READ-ONLY'))
    assert.ok(p.includes('rw_*'))
    assert.ok(p.endsWith('Answer in Chinese.') || p.endsWith('Answer in English.'))
  }
  assert.ok(zh.endsWith('Answer in Chinese.'))
  assert.ok(en.endsWith('Answer in English.'))
  assert.ok(zh.includes('automatic — the check run ended with failed entries'))
  assert.ok(en.includes('user button on the check results'))

  const local = buildDiagnosisPrompt({ check: 'local', failed: [{ item: 'Node', detail: 'boom' }], lang: 'zh' })
  assert.ok(local.includes('Machine: local (this host)'))
  assert.ok(!local.includes('rw_*'))
  const unknown = buildDiagnosisPrompt({ check: 'mystery', failed: [], lang: 'zh' })
  assert.ok(unknown.includes('Check: mystery (id: mystery)'))
})

test('diagnose: createDiagnosisSession drives create→prompt→rename and degrades soft', async () => {
  const calls = []
  const sc = {
    create: async (req) => { calls.push(['create', req]); return { sessionId: 'sess-new' } },
    prompt: async (req, signal) => { calls.push(['prompt', req, signal]) },
    rename: async (req) => { calls.push(['rename', req]) },
  }
  const ctx = { get: (n) => (n === 'sessionController' ? sc : null) }
  const r = await createDiagnosisSession(ctx, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.deepEqual(r, { sessionId: 'sess-new' })
  assert.deepEqual(calls[0], ['create', { workspaceId: 'ws-1' }])
  assert.equal(calls[1][0], 'prompt')
  assert.equal(calls[1][1].sessionId, 'sess-new')
  assert.match(calls[1][1].requestId, /^hams-diag-/)
  assert.deepEqual(calls[1][1].content, [{ type: 'text', text: 'P' }])
  // the public prompt(request, signal) requires a live cancellation signal
  assert.ok(calls[1][2] instanceof AbortSignal, 'prompt must be called with a signal (throwIfAborted)')
  assert.deepEqual(calls[2], ['rename', { sessionId: 'sess-new', title: 'T' }])

  // create failure → error, no prompt
  const ctxFail = { get: () => ({ create: async () => { throw new Error('workspace not found') }, prompt: async () => {} }) }
  const f = await createDiagnosisSession(ctxFail, { workspaceId: 'ws-x', title: 'T', prompt: 'P' })
  assert.match(f.error, /session create failed/)
  assert.equal(f.sessionId, undefined)

  // prompt failure after create → 502-shaped { error, sessionId }
  const ctxPromptFail = { get: () => ({ create: async () => ({ sessionId: 'sess-9' }), prompt: async () => { throw new Error('busy') } }) }
  const p = await createDiagnosisSession(ctxPromptFail, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.match(p.error, /prompt delivery failed/)
  assert.equal(p.sessionId, 'sess-9')

  // rename throwing must not fail the handoff
  const ctxRenameFail = { get: () => ({ create: async () => ({ sessionId: 'sess-8' }), prompt: async () => {}, rename: async () => { throw new Error('title service') } }) }
  const rr = await createDiagnosisSession(ctxRenameFail, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.deepEqual(rr, { sessionId: 'sess-8' })

  // missing controller → soft error (503 at the route)
  const miss = await createDiagnosisSession({ get: () => null }, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.match(miss.error, /sessionController service unavailable/)
})

// ---- route level: POST /api/checks/analyze through the apply()-registered handler ----

function postHandler(routes) {
  return async (body) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
    const data = Buffer.from(JSON.stringify(body))
    const req = {
      method: 'POST',
      url: 'http://127.0.0.1/harnessams/api/checks/analyze',
      headers: {},
      async *[Symbol.asyncIterator]() { yield data },
    }
    routes[0].handler(req, res)
    for (let i = 0; i < 100 && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
    return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
  }
}

// rw_machines text listing in the dsh-remote 0.8.54 shape (parseRwMachinesText contract).
const MACHINES_TEXT = '- m1  "node1"  [native]  user@10.0.0.1:22\n    auth: key:xx + agent  workspace=/home/user/sim\nconnect with rw_connect(...)\n'

test('diagnose route: 400 contract (bad JSON shape, unknown check, empty failed)', async () => {
  const routes = []
  await apply({
    effect: (fn) => { fn() },
    webServer: { register: (r) => routes.push(r) },
    workspaceRegistry: { list: () => [] },
    tools: { register: () => {} },
    get: () => null,
  })
  const call = postHandler(routes)
  const bad = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  routes[0].handler({ method: 'POST', url: 'http://127.0.0.1/harnessams/api/checks/analyze', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{oops') } }, bad)
  for (let i = 0; i < 50 && bad.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(bad.code, 400)
  assert.match(bad.body, /bad JSON body/)

  assert.equal((await call({ check: 'jobs', failed: [{ item: 'x' }] })).code, 400) // missing sessionId
  assert.equal((await call({ sessionId: 's1', check: 'nope', failed: [{ item: 'x' }] })).code, 400)
  assert.equal((await call({ sessionId: 's1', check: 'jobs' })).code, 400) // missing failed
  assert.equal((await call({ sessionId: 's1', check: 'jobs', failed: [] })).code, 400)
  assert.equal((await call({ sessionId: 's1', check: 'jobs', failed: [{ item: 'x' }] })).code, 404) // session in no workspace
  // GET still rejected; the 405 hint names the new route
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  routes[0].handler({ method: 'POST', url: 'http://127.0.0.1/harnessams/api/other' }, res)
  for (let i = 0; i < 50 && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(res.code, 405)
  assert.ok(res.body.includes('/api/checks/analyze'))
})

test('diagnose route: local check anchors the current project workspace and creates the session', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-diag-local-'))
  try {
    const calls = []
    const sc = {
      create: async (req) => { calls.push(['create', req]); return { sessionId: 'sess-diag' } },
      prompt: async (req) => { calls.push(['prompt', req]) },
      rename: async (req) => { calls.push(['rename', req]) },
    }
    const routes = []
    await apply({
      effect: (fn) => { fn() },
      webServer: { register: (r) => routes.push(r) },
      workspaceRegistry: { list: () => [{ id: 'ws-local', path: ws, title: 'harnessams-workspace', sessionIds: ['sess-local'] }] },
      tools: { register: () => {} },
      get: (n) => (n === 'sessionController' ? sc : null),
    })
    const call = postHandler(routes)
    const r = await call({
      sessionId: 'sess-local', check: 'local', machineId: null, lang: 'zh', auto: false,
      failed: [{ item: 'Node', detail: 'node missing', ok: false, ms: 3 }],
    })
    assert.equal(r.code, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.sessionId, 'sess-diag')
    assert.equal(calls[0][1].workspaceId, 'ws-local')
    const prompt = calls[1][1].content[0].text
    assert.ok(prompt.includes('Machine: local (this host)'))
    assert.ok(prompt.includes('node missing'))
    assert.ok(prompt.endsWith('Answer in Chinese.'))
    assert.equal(calls[2][0], 'rename')

    // a session outside every workspace keeps the 404 contract
    const miss = await call({ sessionId: 'sess-stranger', check: 'local', failed: [{ item: 'x' }] })
    assert.equal(miss.code, 404)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('diagnose route: remote check anchors the machine remote-project workspace; 404/409/503 paths', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hams-diag-remote-'))
  const oldDSH = process.env.DSH_HOME
  process.env.DSH_HOME = tmp // remoteWorkspacesRoot() resolves mirrors under $DSH_HOME/remote-workspaces
  try {
    const mirror = path.join(tmp, 'remote-workspaces', 'n1', '2222', 'user', 'ws1')
    await mkdir(mirror, { recursive: true })
    await writeFile(path.join(mirror, '.dsh-remote-meta.json'),
      JSON.stringify({ host: '10.0.0.1', port: 22, username: 'user', remotePath: '/home/user/sim' }))

    const calls = []
    const sc = {
      create: async (req) => { calls.push(['create', req]); return { sessionId: 'sess-r' } },
      prompt: async (req) => { calls.push(['prompt', req]) },
    }
    // The checking session lives in a LOCAL project (checks run from a local
    // project's Overview); the mirror workspace is registered separately and
    // carries no session — findRemoteProjectForMachine matches it by machine.
    const localWs = path.join(tmp, 'local-ws')
    await mkdir(localWs, { recursive: true })
    const ws = mirror // the remote-project workspace IS the mirror ws1 dir
    const makeCtx = (controller, registryList) => ({
      effect: (fn) => { fn() },
      webServer: { register: (r) => routes.push(r) },
      workspaceRegistry: { list: () => registryList ?? [
        { id: 'ws-local', path: localWs, title: 'harnessams-workspace', sessionIds: ['sess-local'] },
        { id: 'ws-remote', path: ws, title: 'node1 (remote)' },
      ] },
      tools: {
        register: () => {},
        get: (n) => (n === 'rw_machines' ? {} : undefined),
        execute: async () => ({ value: MACHINES_TEXT, content: [] }),
      },
      get: (n) => (n === 'sessionController' ? controller : null),
    })
    let routes = []
    await apply(makeCtx(sc))
    const call = postHandler(routes)

    const ok = await call({
      sessionId: 'sess-local', check: 'jobs', machineId: 'm1', lang: 'en', auto: true,
      failed: [{ item: 'LSF jobs', detail: 'bjobs: not found', ok: false, ms: 12 }],
    })
    assert.equal(ok.code, 200)
    assert.equal(ok.body.sessionId, 'sess-r')
    assert.equal(calls[0][1].workspaceId, 'ws-remote')
    const prompt = calls[1][1].content[0].text
    assert.ok(prompt.includes('node1 (user@10.0.0.1:22)'))
    assert.ok(prompt.includes('Remote workspace path: /home/user/sim'))
    assert.ok(prompt.includes('automatic — the check run ended with failed entries'))
    assert.ok(prompt.endsWith('Answer in English.'))

    // unknown machine → 404
    assert.equal((await call({ sessionId: 'sess-local', check: 'load', machineId: 'ghost', failed: [{ item: 'x' }] })).code, 404)
    // machine without a remote project (registry holds only the local workspace) → 409
    routes = []
    await apply(makeCtx(sc, [{ id: 'ws-local', path: localWs, title: 'harnessams-workspace', sessionIds: ['sess-local'] }]))
    const call2 = postHandler(routes)
    const noRp = await call2({ sessionId: 'sess-local', check: 'load', machineId: 'm1', failed: [{ item: 'x' }] })
    assert.equal(noRp.code, 409)
    assert.match(noRp.body.error, /no remote project for machine/)
    // controller missing → 503
    routes = []
    await apply(makeCtx(null))
    const call3 = postHandler(routes)
    const noSc = await call3({ sessionId: 'sess-local', check: 'jobs', machineId: 'm1', failed: [{ item: 'x' }] })
    assert.equal(noSc.code, 503)
    assert.match(noSc.body.error, /sessionController/)
  } finally {
    if (oldDSH === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldDSH
    await rm(tmp, { recursive: true, force: true })
  }
})

// ---- client static contract (classic script: asserted against the source text) ----

const src = await (async () => {
  const { readFile } = await import('node:fs/promises')
  return readFile(new URL('../src/client.js', import.meta.url), 'utf8')
})()

test('diagnose client: analyze keys exist in both languages, clipboard keys are gone', () => {
  for (const key of ['chk.analyze', 'chk.analyzing', 'chk.analyzeDone', 'chk.analyzeAuto', 'chk.analyzeFail']) {
    const hits = src.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `dictionary key ${key} must exist exactly twice (zh + en), found ${hits}`)
  }
  assert.ok(!src.includes('chk.diagnose'), 'the clipboard diagnose flow must be fully removed')
  assert.ok(!src.includes('chk.promptCopied') && !src.includes('chk.copyPrompt'), 'clipboard prompt keys must be gone')
})

test('diagnose client: handoff wiring — run-level button, auto path, language probe', () => {
  assert.ok(src.includes("API + '/checks/analyze'"), 'client must post to the analyze route')
  assert.ok(/const AUTO_ANALYZE_REMOTE = true/.test(src), 'auto-handoff policy constant present (button-only when false)')
  assert.ok(/void analyzeRun\(\{ machineId: mid, check: id, results: r\.results \}, true\)/.test(src),
    'a failed REMOTE run must auto-fire the handoff')
  assert.ok(src.includes('lang: effectiveLang()'), 'the answer-language must follow the effective UI language')
  assert.ok(/function effectiveLang\(\)/.test(src) && src.includes("boundLocaleTr('common.sectionFailed')"),
    'effectiveLang probes the DSH-bound translator')
  assert.ok(/onAnalyze\(run, false\)/.test(src), 'the run-level button is the manual path (auto=false)')
  assert.ok(!/diagnose\(x\.item\)/.test(src), 'no per-entry clipboard buttons remain')
})
