// Unit tests for the host-half server modules (tier 2 mapping, task store, asset
// status, the dsh-ssh machine channel, remote.js funnel contracts, local
// environment checks). Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { batchOf, firstCall } from './helpers.mjs'
import { sessionProject, readSessionConfigs, writeSessionConfig, sessionConfigsPath } from '../src/server/project.js'
import { assetsStatus } from '../src/server/assets.js'
import { fetchMachines, checkableMachines, remoteMachinesStatus } from '../src/server/machines.js'
import {
  callTool, execRemote, uploadFile, downloadFile, resolveMachine, listMachines,
  resultText, resultValue, attributeSshError,
} from '../src/remote.js'
import { runLocalChecks, localEnvFacts } from '../src/server/checks.js'

test('project: sessionProject maps over the workspace registry', async () => {
  const registry = {
    list: () => [
      { id: 'w1', path: 'D:/p1', title: 'P1', sessionIds: ['s1', 's2'] },
      { id: 'w2', path: 'D:/p2', title: 'P2', sessionIds: ['s3'] },
    ],
  }
  assert.deepEqual(sessionProject(registry, 's2').project, { id: 'w1', path: 'D:/p1', title: 'P1', initialized: false })
  assert.equal(sessionProject(registry, 's404').project, null)
  assert.ok(sessionProject(registry, 's404').reason)
  assert.ok(sessionProject(null, 's1').reason) // service missing -> degrade, not throw
  assert.ok(sessionProject(registry, null).reason) // missing sessionId
  // initialized keys the sidebar default-open policy: true only once the
  // workspace already has its .harnessams store (2026-11-18)
  const tmp = await mkdtemp(path.join(tmpdir(), 'hams-ws-'))
  const ws = { id: 'w3', path: tmp, title: 'W3', sessionIds: ['s9'] }
  try {
    assert.equal(sessionProject({ list: () => [ws] }, 's9').project.initialized, false)
    await mkdir(path.join(tmp, '.harnessams'))
    assert.equal(sessionProject({ list: () => [ws] }, 's9').project.initialized, true)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('session-config: v2 store read-missing is empty, write->read roundtrip, validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-sesscfg-'))
  const sid = 'session-aaaa1111-2222-3332-4444-555555555555'
  try {
    assert.deepEqual((await readSessionConfigs(dir)).sessions, {})
    assert.equal(path.basename(sessionConfigsPath(dir)), 'sessions.json')

    // empty tombstone entry (a brand-new session's first write, D-005)
    let w = await writeSessionConfig(dir, sid, { display: 'overview', reports: [], dashboard_selected: null })
    assert.ok(!w.error, w.error)
    assert.deepEqual(w.sessions[sid], { display: 'overview', reports: [], dashboard_selected: null })

    // reports ride in the session entry (legacy task payload, D-005); duplicate
    // paths dedupe; dashboard_selected only survives while it points at a report
    const rep = { id: 'r-ab12cd34', name: 'run1', path: path.join(dir, 'run1.html'), added_at: '2026-11-19T00:00:00.000Z' }
    w = await writeSessionConfig(dir, sid, {
      display: 'session', reports: [rep, { ...rep, id: 'r-dup0000' }], dashboard_selected: 'r-gone9999',
    })
    assert.equal(w.sessions[sid].reports.length, 1) // path dedupe
    assert.equal(w.sessions[sid].dashboard_selected, null) // dangling selected drops
    assert.equal(w.sessions[sid].display, 'session')

    // confirmed check_params persist with the entry (validated shape; the
    // 2026-11-25 table: rcl + mult + unit_check, legacy keys gone)
    w = await writeSessionConfig(dir, sid, {
      display: 'session', reports: [], dashboard_selected: null,
      check_params: { rcl: { r: [1, 100], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
        mult: { nf: [1, 128], m: [1, 1000] }, unit_check: false },
    })
    assert.equal(w.sessions[sid].check_params.unit_check, false)
    assert.deepEqual(w.sessions[sid].check_params.mult.nf, [1, 128])
    // invalid check_params -> whole write rejected
    assert.ok((await writeSessionConfig(dir, sid, { display: 'overview', reports: [], dashboard_selected: null, check_params: { rcl: { r: [9, 9] } } })).error)
    // a relative/non-html report path is rejected
    assert.ok((await writeSessionConfig(dir, sid, { display: 'overview', reports: [{ path: 'rel.html' }], dashboard_selected: null })).error)
    // bad display falls back to 'overview'
    w = await writeSessionConfig(dir, sid, { display: 'task-xxxx', reports: [], dashboard_selected: null })
    assert.equal(w.sessions[sid].display, 'overview')

    // versionless store (D-026): a legacy `version` key is ignored either way —
    // a versioned v2 file loads unchanged, and a task-era tasks.json shape has
    // no sessions map, reading as empty WITH a warning (nothing silently empty)
    const store = path.join(dir, '.harnessams', 'sessions.json')
    await writeFile(store, JSON.stringify({ version: 2, sessions: { [sid]: { display: 'overview', reports: [], dashboard_selected: null } } }), 'utf8')
    const r2 = await readSessionConfigs(dir)
    assert.deepEqual(r2.sessions[sid], { display: 'overview', reports: [], dashboard_selected: null })
    assert.deepEqual(r2.warnings, [])
    await writeFile(store, JSON.stringify({ version: 1, tasks: [{ id: 'task-ab12cd34' }] }), 'utf8')
    const r3 = await readSessionConfigs(dir)
    assert.deepEqual(r3.sessions, {})
    assert.equal(r3.warnings.length, 1)
    assert.match(r3.warnings[0], /no sessions map/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('session-config: D-026 loud skip — bad leaves warn and load partially, unknown fields ride, self-heal on write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-sessd26-'))
  const sid = 'session-bbbb1111-2222-3332-4444-555555555555'
  const C = 'session-cccc1111-2222-3332-4444-555555555555'
  const p = path.join(dir, '.harnessams', 'sessions.json')
  const good = { id: 'r-good0001', name: 'g', path: path.join(dir, 'g.html'), added_at: '2026-11-26T00:00:00.000Z' }
  try {
    await mkdir(path.join(dir, '.harnessams'), { recursive: true })
    // a hand-corrupted store: one session mixing good data with a bad report
    // entry and bad leaves plus an unknown future field; one bad-key session;
    // one non-object session
    await writeFile(p, JSON.stringify({ sessions: {
      [sid]: {
        display: 'session', dashboard_selected: 'r-good0001',
        reports: [good, { path: 'rel.html' }],
        report_figs: 'yes', max_points_per_scan: -3,
        future_field: { nested: true },
      },
      'bad key!': { display: 'overview', reports: [] },
      [C]: null,
    } }), 'utf8')
    const r = await readSessionConfigs(dir)
    // the good part loads: one bad report entry is skipped ALONE (its good
    // sibling survives), bad leaves drop, dashboard_selected still resolves
    assert.equal(r.sessions[sid].reports.length, 1)
    assert.equal(r.sessions[sid].reports[0].id, 'r-good0001')
    assert.equal(r.sessions[sid].dashboard_selected, 'r-good0001')
    assert.equal(r.sessions[sid].report_figs, undefined)
    assert.equal(r.sessions[sid].max_points_per_scan, undefined)
    // unknown fields ride through the read untouched (cross-version, D-026)
    assert.deepEqual(r.sessions[sid].future_field, { nested: true })
    // the junk sessions are skipped — LOUDLY (warnings, never silent)
    assert.ok(!r.sessions['bad key!'])
    assert.ok(!r.sessions[C])
    assert.equal(r.warnings.length, 5)
    assert.match(r.warnings[0], /reports\[1\]: report path must be absolute/)
    assert.match(r.warnings[1], /report_figs must be a boolean/)
    assert.match(r.warnings[2], /max_points_per_scan must be a positive integer/)
    assert.match(r.warnings[3], /bad key!.*does not match the session id shape/)
    assert.match(r.warnings[4], /entry is not an object/)
    assert.ok(r.warnings[4].includes(C), 'the skipped key names the non-object session')
    // self-heal (D-026): the next write rewrites from the lenient read view —
    // the junk sessions and bad leaves heal off disk, unknown fields survive,
    // and the file comes back VERSIONLESS
    const w = await writeSessionConfig(dir, 'session-dddd1111-2222-3332-4444-555555555555',
      { display: 'overview', reports: [], dashboard_selected: null })
    assert.ok(!w.error, w.error)
    assert.ok(w.sessions[sid])
    assert.ok(!w.sessions['bad key!'])
    assert.ok(!w.sessions[C])
    const r2 = await readSessionConfigs(dir)
    assert.deepEqual(r2.sessions[sid].future_field, { nested: true })
    assert.equal(r2.sessions[sid].report_figs, undefined)
    assert.deepEqual(r2.warnings, [])
    const raw = JSON.parse(await readFile(p, 'utf8'))
    assert.equal(raw.version, undefined)
    assert.ok(raw.sessions)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('assets: plotly status reflects the shipped file', async () => {
  const st = assetsStatus()
  assert.equal(typeof st.plotly.available, 'boolean')
  assert.equal(st.plotly.url, '/harnessams/assets/plotly.min.js')
  // in the repo checkout the file must be present and large
  assert.ok(st.plotly.available, 'plotly.min.js missing from src/assets')
  assert.ok(st.plotly.bytes > 4_000_000)
})

test('assets: bounded workspace scan lists stray vendored copies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hams-assets-'))
  try {
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await mkdir(path.join(root, 'demo1', 'Analysis'), { recursive: true })
    await mkdir(path.join(root, '.trash'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), { recursive: true })
    const body = 'x'.repeat(1000)
    await writeFile(path.join(root, 'assets', 'plotly.min.js'), body)
    await writeFile(path.join(root, 'demo1', 'Analysis', 'plotly.min.js'), body)
    await writeFile(path.join(root, '.trash', 'plotly.min.js'), body) // dot dir: skipped
    await writeFile(path.join(root, 'node_modules', 'pkg', 'plotly.min.js'), body) // node_modules: skipped
    await writeFile(path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'plotly.min.js'), body) // beyond maxDepth: skipped
    await writeFile(path.join(root, 'assets', 'not-an-asset.js'), body) // other names: ignored

    const st = assetsStatus(root)
    assert.equal(st.packages.length, 1, 'only plotly is vendored')
    const byFile = new Map(st.packages.map((p) => [p.file, p]))
    // both non-skipped copies surface (assets/ and demo1/Analysis/); the dot
    // dir, node_modules and beyond-maxDepth copies stay hidden
    assert.equal(byFile.get('plotly.min.js').copies.length, 2)
    assert.ok(byFile.get('plotly.min.js').copies.some((c) => c.path.endsWith(path.join('assets', 'plotly.min.js'))))
    assert.ok(byFile.get('plotly.min.js').copies.some((c) => c.path.endsWith(path.join('demo1', 'Analysis', 'plotly.min.js'))))
    assert.ok(byFile.get('plotly.min.js').copies.every((c) => c.bytes === 1000))
    for (const p of st.packages) {
      assert.equal(p.license, 'MIT')
      assert.ok(p.pkg && p.pkg.bytes > 0, 'the package copy itself must be listed')
      assert.equal(p.url, '/harnessams/assets/' + p.file)
    }
    // no workspace root: no scan, empty copy lists, no throw
    const bare = assetsStatus()
    assert.ok(bare.packages.every((p) => p.copies.length === 0))
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ---- dsh-ssh machine channel ----

const HOSTS = [
  { alias: 'node1', host: '192.0.2.11', port: 22, user: 'op', auth: 'key', keyReady: true },
  { alias: 'farm', host: '10.0.0.8', port: 2222, user: 'root', auth: 'agent', keyReady: false },
]

const hostsValue = (hosts) => ({ isError: false, value: { hosts } })

test('machines: ssh_list single channel carries the batch contract', async () => {
  const inputs = []
  const tools = {
    get: (name) => (name === 'ssh_list' ? { name } : undefined),
    execute: async (input) => {
      inputs.push(input)
      // regression pin: dsh-tools 0.2.2-rc.x takes ToolBatchInput — the 0.2.1
      // single-call shape {callId,name,arguments} crashes on calls.map wrapped
      // as "Tool batch execution failed", and without a signal the pipeline
      // crashes reading `signal.aborted`
      assert.ok(Array.isArray(input.calls) && input.calls.length === 1, 'one-entry calls[] required')
      const call = input.calls[0]
      assert.equal(call.type, 'tool-call')
      assert.equal(call.name, 'ssh_list')
      assert.ok(call.id, 'call id required')
      assert.deepEqual(JSON.parse(call.arguments || '{}'), {})
      assert.ok(input.signal instanceof AbortSignal, 'AbortSignal required')
      return batchOf(hostsValue(HOSTS))
    },
  }
  const r = await fetchMachines(tools)
  assert.ok(r.ok, r.reason)
  assert.equal(r.source, 'tool shell (ssh_list)')
  assert.equal(r.machines.length, 2)
  const node1 = r.machines.find((m) => m.id === 'node1')
  assert.equal(node1.alias, 'node1')
  assert.equal(node1.host, '192.0.2.11')
  assert.equal(node1.username, 'op')
  assert.equal(node1.auth, 'key')
  assert.equal(node1.keyReady, true)
  const farm = r.machines.find((m) => m.id === 'farm')
  assert.equal(farm.host, '10.0.0.8')
})

test('machines: absent tool and empty registry report reasons, never throw', async () => {
  const absent = await fetchMachines({ get: () => undefined })
  assert.ok(!absent.ok)
  assert.match(absent.reason, /ssh_list is not registered/)

  const empty = await fetchMachines({ get: () => ({}), execute: async (input) => batchOf(hostsValue([])) })
  assert.ok(!empty.ok)
  assert.match(empty.reason, /no hosts configured in dsh-ssh/)

  const thrown = await fetchMachines({ get: () => ({}), execute: async () => { throw new Error('boom') } })
  assert.ok(!thrown.ok)
  assert.match(thrown.reason, /boom/)
})

test('machines: checkableMachines projects the whole registry; remoteMachinesStatus is registry-only', async () => {
  const machines = [
    { id: 'node1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', auth: 'key', keyReady: true },
    { id: 'farm', name: 'farm', host: '10.0.0.8', port: 2222, username: 'root', auth: 'agent', keyReady: false },
  ]
  const checkable = checkableMachines(machines)
  assert.equal(checkable.length, 2) // picking a host = picking its alias; roots are per-project settings
  assert.deepEqual({ ...checkable[0] }, {
    id: 'node1', name: 'node1', host: '192.0.2.11', port: 22,
    username: 'op', auth: 'key', keyReady: true,
  })
  assert.deepEqual(checkableMachines([]), [])
  assert.deepEqual(checkableMachines(null), [])

  const tools = { get: () => ({}), execute: async () => batchOf(hostsValue(machines.map((m) => ({
    alias: m.id, host: m.host, port: m.port, user: m.username, auth: m.auth, keyReady: m.keyReady,
  })))) }
  const status = await remoteMachinesStatus(tools)
  assert.equal(status.installed, true)
  assert.equal(status.machines.length, 2)
  assert.deepEqual(status.machines[0], {
    id: 'node1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op',
    auth: 'key', keyReady: true,
  })

  const down = await remoteMachinesStatus({ get: () => undefined })
  assert.equal(down.installed, false)
  assert.match(down.reason, /ssh_list is not registered/)
})

// ---- remote.js funnel contracts ----

test('remote: resultText/resultValue extract the tool result payloads', () => {
  assert.equal(resultText('plain'), 'plain')
  assert.equal(resultText({ isError: false, value: { text: 'in value' }, content: [] }), 'in value')
  assert.equal(resultText({ isError: false, value: 'str value', content: [] }), 'str value')
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(resultText(null), '')

  assert.deepEqual(resultValue({ isError: false, value: { ok: true } }), { ok: true })
  assert.equal(resultValue({ isError: false, value: 's' }), 's')
  assert.equal(resultValue({ isError: true, value: { ok: true } }), null) // failures never carry a value
  assert.equal(resultValue(null), null)
})

test('remote: attributeSshError annotates the MaxSessions shape (live-sampled string)', () => {
  // sampled on node1 with 14 concurrent execs (2026-11-14): channels 11+ throw
  assert.match(
    attributeSshError('(SSH) Channel open failure: open failed'),
    /Channel open failure: open failed \[suspected MaxSessions/)
  assert.equal(attributeSshError('connect ETIMEDOUT 192.0.2.11:22'), 'connect ETIMEDOUT 192.0.2.11:22')
})

test('remote: execRemote wraps in timeout KILL and normalizes the value shapes', async () => {
  const calls = []
  const ctx = {
    tools: {
      get: (n) => (n === 'ssh_exec' ? { n } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        calls.push(args)
        if (args.command.includes('echo hi')) {
          return batchOf({ isError: false, value: { success: true, exitCode: 0, timedOut: false, stdout: 'hi\n', stderr: '', durationMs: 4 } })
        }
        if (args.command.includes('exit 9')) {
          return batchOf({ isError: false, value: { success: false, exitCode: 9, timedOut: false, stdout: 'out\n', stderr: 'err-9\n', durationMs: 4 } })
        }
        if (args.command.includes('sleep 5')) {
          // exit 137 = the remote `timeout -s KILL` deadline firing (128+SIGKILL)
          return batchOf({ isError: false, value: { success: false, exitCode: 137, timedOut: false, stdout: '', stderr: '', durationMs: 4 } })
        }
        if (args.command.includes('boom')) {
          // connect/channel errors ride on value.error with success:false
          return batchOf({ isError: false, value: { success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, error: '(SSH) Channel open failure: open failed' } })
        }
        return batchOf({ isError: true, content: [{ type: 'text', text: 'pipeline blew up' }] })
      },
    },
  }

  const good = await execRemote(ctx, 'node1', 'echo hi', { timeoutMs: 30_000 })
  assert.equal(good.ok, true)
  assert.equal(good.exitCode, 0)
  assert.equal(good.stdout, 'hi\n')
  // wrapper + tool budget + 3-attempt outer signal (replays reset the budget)
  assert.match(calls[0].command, /^timeout -s KILL 30s sh -c "echo hi"$/)
  assert.equal(calls[0].alias, 'node1')
  assert.equal(calls[0].timeoutMs, 120_000) // deadline + 90s connect margin

  const bad = await execRemote(ctx, 'node1', 'echo out; echo err-9 >&2; exit 9', { timeoutMs: 30_000 })
  assert.equal(bad.ok, false)
  assert.equal(bad.exitCode, 9)
  assert.equal(bad.stderr, 'err-9\n')

  const killed = await execRemote(ctx, 'node1', 'sleep 5', { timeoutMs: 30_000 })
  assert.equal(killed.ok, false)
  assert.equal(killed.timedOut, true, 'exit 137 is the remote deadline, not a command failure')

  const openFail = await execRemote(ctx, 'node1', 'boom', { timeoutMs: 30_000 })
  assert.equal(openFail.ok, false)
  assert.match(openFail.stderr, /suspected MaxSessions/)

  const piped = await execRemote(ctx, 'node1', 'pipeline', { timeoutMs: 30_000 })
  assert.equal(piped.ok, false)
  assert.equal(piped.isError, true)
  assert.match(piped.text, /pipeline blew up/)
})

test('remote: uploadFile/downloadFile read the structured ok flags', async () => {
  const seen = []
  const make = (uploadValue, downloadValue) => ({
    tools: {
      get: (n) => (['ssh_upload', 'ssh_download'].includes(n) ? { n } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        seen.push({ name: call.name, args })
        return batchOf({ isError: false, value: call.name === 'ssh_upload' ? uploadValue : downloadValue })
      },
    },
  })
  const okCtx = make({ ok: true, transferredBytes: 128, files: 1 }, { ok: true, bytes: 512 })
  const up = await uploadFile(okCtx, 'node1', 'C:/local/x', '/remote/x')
  assert.equal(up.ok, true)
  assert.match(up.text, /uploaded 1 file\(s\), 128 bytes/)
  const down = await downloadFile(okCtx, 'node1', '/remote/x', 'C:/local/x')
  assert.equal(down.ok, true)
  assert.match(down.text, /downloaded 512 bytes/)
  // tool argument shapes: alias + localPath/remotePath (no agent anywhere)
  assert.deepEqual(seen[0].args, { alias: 'node1', localPath: 'C:/local/x', remotePath: '/remote/x' })
  assert.deepEqual(seen[1].args, { alias: 'node1', remotePath: '/remote/x', localPath: 'C:/local/x' })

  const failCtx = make({ ok: false, error: 'upload denied' }, { ok: false, error: '(SSH) Channel open failure: open failed' })
  assert.equal((await uploadFile(failCtx, 'node1', 'a', 'b')).ok, false)
  const dl = await downloadFile(failCtx, 'node1', 'b', 'a')
  assert.equal(dl.ok, false)
  assert.match(dl.text, /suspected MaxSessions/)
})

test('remote: resolveMachine pins the alias + explicit remote-root contract', async () => {
  const ctx = {
    tools: {
      get: (n) => (n === 'ssh_list' ? { n } : undefined),
      execute: async () => batchOf(hostsValue([
        { alias: 'node1', host: '192.0.2.11', port: 22, user: 'op', auth: 'key', keyReady: true },
        { alias: 'lab9', host: '192.0.2.99', port: 22, user: 'op', auth: 'key', keyReady: true },
      ])),
    },
  }
  const t = await resolveMachine(ctx, 'node1', '/home/op/sim')
  assert.equal(t.alias, 'node1')
  assert.equal(t.remoteRoot, '/home/op/sim')
  assert.equal(t.machine.id, 'node1')

  // the root is a required explicit argument (the project's settings.remote_root)
  await assert.rejects(() => resolveMachine(ctx, undefined), /no machine configured for this project/)
  await assert.rejects(() => resolveMachine(ctx, 'node1'), /remote_root is required for host node1/)
  await assert.rejects(() => resolveMachine(ctx, 'node1', 'rel/path'), /remote_root is required for host node1/)
  await assert.rejects(() => resolveMachine(ctx, 'ghost', '/home/op/sim'), /no such dsh-ssh host: ghost \(known: node1, lab9\)/)
  // any registry alias resolves once a root is supplied (roots are per-project)
  const lab9 = await resolveMachine(ctx, 'lab9', '/home/op/sim')
  assert.equal(lab9.remoteRoot, '/home/op/sim')

  const broken = {
    tools: {
      get: (n) => (n === 'ssh_list' ? { n } : undefined),
      execute: async () => batchOf({ isError: true, content: [{ type: 'text', text: 'dsh-ssh down' }] }),
    },
  }
  await assert.rejects(() => resolveMachine(broken, 'node1', '/home/op/sim'), /dsh-ssh hosts unavailable: dsh-ssh down/)
})

test('remote: listMachines degrades when ssh_list is missing or empty', async () => {
  const absent = await listMachines({ tools: { get: () => undefined } })
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /ssh_list is not registered/)

  const empty = await listMachines({ tools: { get: () => ({}), execute: async () => batchOf(hostsValue([])) } })
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /no hosts configured/)
})

// ---- local environment checks (checks.js) ----

test('checks: localEnvFacts carries node version + absolute path, python degrades softly', async () => {
  const env = await localEnvFacts()
  assert.equal(env.node.version, process.version)
  assert.equal(env.node.path, process.execPath)
  assert.ok(path.isAbsolute(env.node.path))
  if (env.python.version) {
    assert.match(env.python.version, /^\d+\.\d+/)
    assert.equal(env.python.error, '')
  } else {
    assert.ok(env.python.error, 'a missing python must surface .error, not a silent fake')
  }
})

test('checks: runLocalChecks rows — no sky130, Node/Python carry absolute paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-localchk-'))
  try {
    const results = await runLocalChecks(dir)
    const items = results.map((r) => r.item)
    assert.deepEqual(items, ['Connectivity (local)', 'Node', 'Python', 'Disk capacity (workspace)', 'Workspace writable'])
    const node = results.find((r) => r.item === 'Node')
    assert.ok(node.ok, node.detail)
    assert.equal(node.result, process.version)
    assert.equal(node.detail, process.execPath) // version AND absolute path
    const py = results.find((r) => r.item === 'Python')
    if (py.ok) {
      assert.match(py.result, /^Python \d+\.\d+/)
      if (py.detail !== '(executable path not resolved)') assert.ok(path.isAbsolute(py.detail))
    }
    const disk = results.find((r) => r.item === 'Disk capacity (workspace)')
    assert.ok(disk.ok, disk.detail)
    assert.match(disk.result, /GiB/)
    const wr = results.find((r) => r.item === 'Workspace writable')
    assert.ok(wr.ok, wr.detail)
    // These rows ARE the harnessams_selfcheck action=env tool result: the tool
    // registry rejects any own key holding undefined as "not lossless JSON",
    // so a clean disk must carry no `warn` key at all.
    for (const row of results) {
      for (const [k, v] of Object.entries(row)) assert.notEqual(v, undefined, `${row.item}: key ${k} holds undefined`)
    }
    assert.equal(Object.hasOwn(disk, 'warn'), freeRatio(dir) < 0.1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// free/total of the volume holding `dir` — decides whether the disk row may carry `warn`
async function freeRatio(dir) {
  const st = await statfs(dir)
  return (Number(st.bavail) * Number(st.bsize)) / (Number(st.blocks) * Number(st.bsize))
}

test('session-config: single-session merge-write never clobbers siblings; prune + null-delete + corrupt degrade', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-sess-'))
  const A = 'session-aaaa1111-2222-3332-4444-555555555555'
  const B = 'session-bbbb1111-2222-3332-4444-555555555555'
  try {
    let w = await writeSessionConfig(dir, A, { display: 'session', reports: [], dashboard_selected: null })
    assert.ok(!w.error, w.error)
    // sibling session survives a second merge-write (no clobber)
    w = await writeSessionConfig(dir, B, { display: 'overview', reports: [], dashboard_selected: null })
    let r1 = await readSessionConfigs(dir)
    assert.ok(r1.sessions[A] && r1.sessions[B])
    assert.equal(Object.keys(r1.sessions).length, 2)
    // bad sessionId rejected
    assert.ok((await writeSessionConfig(dir, '', null)).error)
    assert.ok((await writeSessionConfig(dir, 'not an id!', null)).error)
    // null state deletes the entry
    await writeSessionConfig(dir, B, null)
    const r2 = await readSessionConfigs(dir)
    assert.ok(!r2.sessions[B] && r2.sessions[A])
    // pruning: oldest entries drop beyond 200 (insertion order = recency)
    for (let i = 0; i < 205; i++) {
      const err = await writeSessionConfig(dir, `session-${String(i).padStart(8, '0')}-2222-3332-4444-555555555555`,
        { display: 'overview', reports: [], dashboard_selected: null })
      assert.ok(!err.error, err.error)
    }
    const r3 = await readSessionConfigs(dir)
    assert.equal(Object.keys(r3.sessions).length, 200)
    assert.ok(!r3.sessions[A]) // oldest dropped
    assert.ok(r3.sessions['session-00000204-2222-3332-4444-555555555555'])
    // corrupt file degrades to empty, never throws — with a visible warning (D-026)
    await writeFile(path.join(dir, '.harnessams', 'sessions.json'), '{not json', 'utf8')
    const rc = await readSessionConfigs(dir)
    assert.deepEqual(rc.sessions, {})
    assert.equal(rc.warnings.length, 1)
    assert.match(rc.warnings[0], /sessions\.json is not readable/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
