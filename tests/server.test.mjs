// Unit tests for the host-half server modules (tier 2 mapping, task store, asset
// status, dsh-remote machine channel, remote-project model, check buttons).
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// The generated one-liners must be valid shell — a misplaced quote shipped once and
// only failed live (bash: -c: syntax error), so every built command is syntax-checked
// when bash is available (the Windows CI runner may not have Git Bash on PATH).
let bashAvailable = true
try { execFileSync('bash', ['--version'], { stdio: 'pipe' }) } catch { bashAvailable = false }
function assertValidShell(cmd) {
  if (!bashAvailable) return
  execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
}
import { sessionProject, readTasks, writeTasks, tasksPath } from '../src/server/project.js'
import { assetsStatus } from '../src/server/assets.js'
import { resultText, parseRwMachinesText, fetchMachines, findMirrorForMachine, sessionInMirror } from '../src/server/machines.js'
import {
  parseRwExecText, runRemoteCheckButton, REMOTE_CHECK_BUTTONS,
  parseLoadRow, parseBjobsRows, parseBatchRows, rootize,
} from '../src/server/checks.js'
import { remoteProjectFor, machineForProject, checkMachinesForLocal, findRemoteProjectForMachine, projectSessions, createRemoteProject } from '../src/server/remote.js'

test('project: sessionProject maps over the workspace registry', () => {
  const registry = {
    list: () => [
      { id: 'w1', path: 'D:/p1', title: 'P1', sessionIds: ['s1', 's2'] },
      { id: 'w2', path: 'D:/p2', title: 'P2', sessionIds: ['s3'] },
    ],
  }
  assert.deepEqual(sessionProject(registry, 's2').project, { id: 'w1', path: 'D:/p1', title: 'P1' })
  assert.equal(sessionProject(registry, 's404').project, null)
  assert.ok(sessionProject(registry, 's404').reason)
  assert.ok(sessionProject(null, 's1').reason) // service missing -> degrade, not throw
  assert.ok(sessionProject(registry, null).reason) // missing sessionId
})

test('tasks: read-missing is empty, write->read roundtrip, validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-tasks-'))
  try {
    assert.deepEqual((await readTasks(dir)).tasks, [])

    const r = await writeTasks(dir, [{ name: 'OTA migration', description: 'all flavors' }])
    assert.ok(!r.error, r.error)
    assert.match(r.tasks[0].id, /^task-/)
    const read1 = await readTasks(dir)
    assert.equal(read1.tasks.length, 1)
    assert.equal(read1.tasks[0].name, 'OTA migration')
    const firstId = read1.tasks[0].id
    const firstCreated = read1.tasks[0].created_at

    // rewrite keeps server-assigned identity and created_at
    const r2 = await writeTasks(dir, [{ id: firstId, name: 'OTA migration', description: 'updated' }, { name: 'new one' }])
    assert.ok(!r2.error, r2.error)
    const read2 = await readTasks(dir)
    assert.equal(read2.tasks.length, 2)
    assert.equal(read2.tasks[0].id, firstId)
    assert.equal(read2.tasks[0].created_at, firstCreated)
    assert.equal(read2.tasks[0].description, 'updated')

    assert.ok((await writeTasks(dir, [{ name: '' }])).error)
    assert.ok((await writeTasks(dir, 'nope')).error)
    assert.ok(path.basename(tasksPath(dir)), 'tasks.json')
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
    await writeFile(path.join(root, 'demo1', 'Analysis', 'xterm.js'), body)
    await writeFile(path.join(root, '.trash', 'xterm.js'), body) // dot dir: skipped
    await writeFile(path.join(root, 'node_modules', 'pkg', 'plotly.min.js'), body) // node_modules: skipped
    await writeFile(path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'plotly.min.js'), body) // beyond maxDepth: skipped
    await writeFile(path.join(root, 'assets', 'not-an-asset.js'), body) // other names: ignored

    const st = assetsStatus(root)
    assert.equal(st.packages.length, 4, 'exactly the vendored .js set is listed')
    const byFile = new Map(st.packages.map((p) => [p.file, p]))
    assert.equal(byFile.get('plotly.min.js').copies.length, 1)
    assert.ok(byFile.get('plotly.min.js').copies[0].path.endsWith(path.join('assets', 'plotly.min.js')))
    assert.equal(byFile.get('plotly.min.js').copies[0].bytes, 1000)
    assert.equal(byFile.get('xterm.js').copies.length, 1)
    assert.ok(byFile.get('xterm.js').copies[0].path.includes(path.join('demo1', 'Analysis')))
    assert.equal(byFile.get('xterm-addon-fit.js').copies.length, 0)
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

// ---- dsh-remote machine channel ----

const RW_MACHINES_TEXT = [
  '- m-1  "node1"  [native]  op@192.0.2.11:22  [CURRENT]',
  '    auth: key:C:\\Users\\x\\.ssh\\id_ed25519  workspace=/home/op/sim/AutoAnalog',
  '- m-2  "build farm"  [openssh]  root@10.0.0.8:2222',
  '    auth: agent',
  '',
  'connect with rw_connect(machineId=<id>) to reuse a machine\'s full stored settings.',
].join('\n')

test('machines: parseRwMachinesText reads the rw_machines text listing', () => {
  const ms = parseRwMachinesText(RW_MACHINES_TEXT)
  assert.equal(ms.length, 2)
  assert.deepEqual(
    { ...ms[0] },
    { id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', current: true, workspace: '/home/op/sim/AutoAnalog' })
  assert.equal(ms[1].current, false)
  assert.equal(ms[1].port, 2222)
  assert.equal(ms[1].username, 'root')
  assert.deepEqual(parseRwMachinesText('No saved machines yet — add one in Settings.'), [])
})

test('machines: resultText extracts the tool result payload', () => {
  assert.equal(resultText('plain'), 'plain')
  assert.equal(resultText({ isError: false, value: { text: 'in value' }, content: [] }), 'in value')
  assert.equal(resultText({ isError: false, value: 'str value', content: [] }), 'str value')
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(resultText(null), '')
})

test('machines: execute must carry callId+signal; text listing wins over HTTP', async () => {
  const seen = []
  const tools = {
    get: (name) => (name === 'rw_machines' ? { name } : undefined),
    execute: async (input) => {
      seen.push(input)
      // regression: the 2026-10-25 crash was execute() reading signal.aborted
      assert.ok(input.callId, 'callId required')
      assert.ok(input.signal instanceof AbortSignal, 'AbortSignal required')
      return { isError: false, value: { text: RW_MACHINES_TEXT }, content: [] }
    },
  }
  const r = await fetchMachines(tools, { headers: { host: '127.0.0.1:3187' } }, async () => { throw new Error('HTTP must not be reached') })
  assert.ok(r.ok, r.reason)
  assert.equal(r.source, 'tool shell (rw_machines)')
  assert.equal(r.machines[0].name, 'node1')
})

test('machines: a thrown tool shell falls through to HTTP with forwarded credentials', async () => {
  const tools = { get: () => ({}), execute: async () => { throw new Error("Cannot read properties of undefined (reading 'aborted')") } }
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers })
    return { ok: true, json: async () => ({ machines: [{ id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', workspace: '/w', lastConnectedAt: '2026-10-26T08:00:00Z', latencyMs: 41 }], currentId: 'm-1' }) }
  }
  const req = { headers: { host: '127.0.0.1:3187', cookie: 'session=abc', authorization: 'Bearer t' } }
  const r = await fetchMachines(tools, req, fetchImpl)
  assert.ok(r.ok, r.reason)
  assert.equal(r.source, 'HTTP /dsh-remote/machines')
  assert.equal(r.machines[0].current, true)
  assert.equal(r.machines[0].lastConnectedAt, '2026-10-26T08:00:00Z') // registry extras pass through
  assert.equal(r.machines[0].latencyMs, 41)
  assert.equal(calls[0].headers.cookie, 'session=abc')
  assert.equal(calls[0].headers.authorization, 'Bearer t')
  assert.match(calls[0].url, /\/dsh-remote\/machines$/)
})

test('machines: both channels failing reports both reasons', async () => {
  const tools = { get: () => undefined } // tool absent
  const r = await fetchMachines(tools, null, async () => ({ ok: false, status: 401 }))
  assert.ok(!r.ok)
  assert.match(r.reason, /rw_machines tool not registered/)
  assert.match(r.reason, /HTTP fallback/)
})

test('machines: findMirrorForMachine matches host+port+user from meta files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hams-mirrors-'))
  try {
    const mk = async (dir, meta) => {
      await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(path.join(root, dir, '.dsh-remote-meta.json'), JSON.stringify(meta), 'utf8')
    }
    await mk('192.0.2.11-op-22/AutoAnalog', { host: '192.0.2.11', port: 22, username: 'op', remotePath: '/home/op/sim/AutoAnalog' })
    await mk('10.0.0.8-root-2222/farm', { host: '10.0.0.8', port: 2222, username: 'root', remotePath: '/farm' })

    const hit = findMirrorForMachine({ host: '192.0.2.11', port: 22, username: 'op' }, root)
    assert.ok(hit, 'mirror not found')
    assert.equal(hit.remotePath, '/home/op/sim/AutoAnalog')
    assert.match(hit.mirrorDir.replace(/\\/g, '/'), /192\.0\.2\.11-op-22\/AutoAnalog$/)

    assert.equal(findMirrorForMachine({ host: '192.0.2.11', port: 2222, username: 'op' }, root), null) // wrong port
    assert.equal(findMirrorForMachine({ host: '192.0.2.11', port: 22, username: 'other' }, root), null) // wrong user
    assert.equal(findMirrorForMachine({ host: 'nope', port: 22 }, root), null)
    assert.equal(findMirrorForMachine({ host: 'x' }, path.join(root, 'missing')), null) // missing root degrades
    assert.equal(findMirrorForMachine(null, root), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('machines: sessionInMirror borrows a live session rooted in the mirror', () => {
  const svc = { list: () => [
    { id: 's-local', header: { cwd: 'D:/proj/harnessams-workspace' } },
    { id: 's-remote', header: { cwd: 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog/sub' } },
  ] }
  const hit = sessionInMirror(null, 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog', svc)
  assert.ok(hit, 'no session borrowed')
  assert.equal(hit.agent.id, 's-remote') // rw_exec's background-job owner
  assert.equal(hit.agent.session.header.cwd, 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog/sub')
  assert.equal(sessionInMirror(null, 'C:/other', svc), null)
  assert.equal(sessionInMirror(null, 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog', { list: () => [] }), null)
  assert.equal(sessionInMirror(null, 'C:/x', null), null) // no sessions service -> null, not throw
  assert.equal(sessionInMirror(null, null, svc), null)
})

// ---- remote-project model (remote.js) ----

test('remote: remoteProjectFor walks up to the nearest mirror meta', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hams-rp-'))
  try {
    const meta = { host: '192.0.2.11', port: 22, username: 'op', remotePath: '/home/op/sim/AutoAnalog' }
    const mirror = path.join(root, '192.0.2.11-op-22', 'AutoAnalog')
    await mkdir(path.join(mirror, 'sub', 'deep'), { recursive: true })
    await writeFile(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify(meta), 'utf8')

    const hit = remoteProjectFor(path.join(mirror, 'sub', 'deep'), root)
    assert.ok(hit, 'remote project not detected')
    assert.equal(hit.host, '192.0.2.11')
    assert.equal(hit.port, 22)
    assert.equal(hit.remotePath, '/home/op/sim/AutoAnalog')
    assert.equal(path.resolve(hit.mirrorDir), path.resolve(mirror))

    assert.equal(remoteProjectFor(path.join(root, 'plain-ws'), root), null) // no meta anywhere above
    assert.equal(remoteProjectFor(root, root), null) // the root itself is not inside
    assert.equal(remoteProjectFor('D:/proj/unrelated', root), null) // outside the mirror root
    assert.equal(remoteProjectFor(null, root), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('remote: machineForProject matches host+port+user', () => {
  const list = [
    { id: 'm-1', host: '192.0.2.11', port: 22, username: 'op' },
    { id: 'm-2', host: '10.0.0.8', port: 2222, username: 'root' },
  ]
  const rp = { host: '192.0.2.11', port: 22, username: 'op' }
  assert.equal(machineForProject(list, rp).id, 'm-1')
  assert.equal(machineForProject(list, { ...rp, port: 2222 }), null)
  assert.equal(machineForProject(list, { ...rp, username: 'root' }), null)
  assert.equal(machineForProject([], rp), null)
  assert.equal(machineForProject(list, null), null)
})

test('remote: checkMachinesForLocal joins machines with remote projects and live sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hams-cml-'))
  try {
    const meta = { host: '192.0.2.11', port: 22, username: 'op', remotePath: '/home/op/sim/AutoAnalog' }
    const mirror = path.join(root, '192.0.2.11-op-22', 'AutoAnalog')
    await mkdir(path.join(mirror, 'sub'), { recursive: true })
    await writeFile(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify(meta), 'utf8')
    const ctx = {
      workspaceRegistry: { list: () => [
        { id: 'w1', path: 'D:/local-ws', title: 'Local' },
        { id: 'w2', path: mirror, title: 'node1 (remote)' },
      ] },
      get: (n) => (n === 'sessions' ? { list: () => [{ id: 's-live-1', header: { cwd: path.join(mirror, 'sub') } }] } : null),
    }
    const machines = [
      { id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', current: true,
        workspace: '/home/op/sim/AutoAnalog', lastConnectedAt: '2026-10-27T08:00:00Z', latencyMs: 12 },
      { id: 'm-2', name: 'farm', host: '10.0.0.8', port: 2222, username: 'root' }, // no remote project -> not listed
    ]
    const out = checkMachinesForLocal(ctx, machines, root)
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'm-1')
    assert.equal(out[0].name, 'node1')
    assert.equal(out[0].remotePath, '/home/op/sim/AutoAnalog')
    assert.match(out[0].mirrorDir.replace(/\\/g, '/'), /AutoAnalog$/)
    assert.equal(out[0].projectTitle, 'node1 (remote)')
    assert.equal(out[0].liveSessions, 1)
    assert.equal(out[0].sessionId, 's-live-1') // remote-terminal binding hint
    assert.equal(out[0].current, true)
    assert.equal(out[0].latencyMs, 12)
    assert.equal(out[0].lastConnectedAt, '2026-10-27T08:00:00Z')

    assert.equal(findRemoteProjectForMachine(ctx, { host: '10.0.0.8', port: 2222, username: 'root' }, root), null)
    assert.equal(findRemoteProjectForMachine({ workspaceRegistry: { list: () => { throw new Error('down') } } }, machines[0], root), null)
    assert.deepEqual(checkMachinesForLocal(null, machines, root), [])
    assert.deepEqual(checkMachinesForLocal(ctx, [], root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('remote: projectSessions counts live sessions rooted in the workspace', () => {
  const svc = { list: () => [
    { header: { cwd: 'D:/ws/sub' } },
    { header: { cwd: 'D:/ws' } },
    { header: { cwd: 'D:/other' } },
  ] }
  const ctx = { get: (n) => (n === 'sessions' ? svc : null) }
  assert.equal(projectSessions(ctx, 'D:/ws').length, 2)
  assert.equal(projectSessions(null, 'D:/ws').length, 0) // no service -> empty, not throw
  assert.equal(projectSessions(ctx, '').length, 0)
})

test('remote: createRemoteProject registers the mirror as a workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hams-crproj-'))
  try {
    const meta = { host: '192.0.2.11', port: 22, username: 'op', remotePath: '/home/op/sim/AutoAnalog' }
    const mirror = path.join(root, '192.0.2.11-op-22', 'AutoAnalog')
    await mkdir(mirror, { recursive: true })
    await writeFile(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify(meta), 'utf8')

    const calls = []
    const registry = {
      list: () => [],
      create: async (p, title) => { calls.push({ p, title }); return { id: 'w9', path: p, title } },
    }
    const r = await createRemoteProject({ workspaceRegistry: registry },
      { id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op' }, root)
    assert.ok(r.created, JSON.stringify(r))
    assert.equal(r.workspace.id, 'w9')
    assert.equal(calls[0].title, 'node1 (remote)')
    assert.match(calls[0].p.replace(/\\/g, '/'), /AutoAnalog$/)

    // an already-registered workspace (or one inside the mirror) is not recreated
    const registry2 = {
      list: () => [{ id: 'w1', path: path.join(mirror, 'sub'), title: 'existing' }],
      create: async () => { throw new Error('must not be called') },
    }
    const r2 = await createRemoteProject({ workspaceRegistry: registry2 },
      { id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op' }, root)
    assert.equal(r2.created, false)
    assert.equal(r2.workspace.id, 'w1')

    // no mirror -> actionable error pointing at dsh-remote, no throw, no create
    const r3 = await createRemoteProject({ workspaceRegistry: registry },
      { id: 'm-2', name: 'farm', host: '10.0.0.8', port: 2222, username: 'root' }, root)
    assert.match(r3.error, /no local mirror/)
    assert.match(r3.error, /rw_pick_workspace|dsh-remote/)
    assert.equal(calls.length, 1) // no second create
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ---- check buttons (checks.js) ----

test('checks: parseRwExecText splits stdout/stderr and reads exit markers', () => {
  const clean = parseRwExecText('0.12 0.34 0.45 3/812 12345\n8\n')
  assert.equal(clean.exitCode, 0)
  assert.equal(clean.stderr, '')
  assert.ok(clean.stdout.startsWith('0.12'))

  const failed = parseRwExecText('boom\n-- stderr --\nbash: xyz: command not found\n[exit code: 127]')
  assert.equal(failed.exitCode, 127)
  assert.match(failed.stderr, /command not found/)
  assert.equal(failed.stdout, 'boom')

  const slow = parseRwExecText('partial\n[command timed out after 20000ms]')
  assert.equal(slow.timedOut, true)
  assert.equal(slow.exitCode, 0) // no exit marker — timedOut carries the failure
  assert.equal(slow.stdout, 'partial')

  // dsh-remote 0.8.53+ promotion (jobs service present): the whole result is the
  // marker + guidance — the command is STILL RUNNING and must never read as ok.
  const promoted = parseRwExecText('[still running after 20000ms; moved to background job job-ab12cd]\n'
    + 'Read its output with job_output (job_id="job-ab12cd") and stop it with job_kill.')
  assert.equal(promoted.promotedJob, 'job-ab12cd')
  assert.equal(promoted.stdout, '')
  assert.equal(promoted.stderr, '')
  assert.equal(promoted.timedOut, false)
  assert.equal(promoted.exitCode, 0)
})

test('checks: the button surface is the four Overview buttons', () => {
  assert.deepEqual(REMOTE_CHECK_BUTTONS.map((b) => b.id), ['load', 'jobs', 'batches', 'scripts'])
})

test('checks: runRemoteCheckButton load runs with the borrowed session agent', async () => {
  const inputs = []
  const tools = {
    get: (name) => (name === 'rw_exec' ? { name } : undefined),
    execute: async (input) => {
      inputs.push(input)
      return { isError: false, value: { text: '0.42 0.51 0.55 3/900 12345\n48\n[exit code: 0]' }, content: [] }
    },
  }
  const agent = { session: { header: { cwd: 'MIRROR/DIR' } } }
  const r = await runRemoteCheckButton(tools, 'load', { agent, remotePath: '/home/op/sim' })
  assert.equal(r.channel, 'dsh-remote (remote project session)')
  assert.equal(r.results.length, 1)
  assert.ok(r.results[0].ok, r.results[0].detail)
  assert.match(r.results[0].cmd, /cat \/proc\/loadavg && nproc/)
  assert.deepEqual(r.results[0].rows, [['0.42', '0.51', '0.55', '3/900', '48']])
  assert.match(r.results[0].result, /load 0\.42 \/ 48 cpu/)
  assert.equal(inputs[0].agent.session.header.cwd, 'MIRROR/DIR') // binding context
  assert.equal(inputs[0].arguments.promoteOnTimeout, false) // no background-job owner needed
  assert.equal(inputs[0].arguments.timeoutMs, 40000)
  assert.ok(inputs[0].signal instanceof AbortSignal && inputs[0].callId)
  assert.equal(inputs[0].name, 'rw_exec')
})

test('checks: runRemoteCheckButton jobs surfaces a missing bjobs and an empty queue', async () => {
  const tools = {
    get: () => ({}),
    execute: async () => ({ isError: false, value: { text: 'bash: bjobs: command not found\n[exit code: 127]' }, content: [] }),
  }
  const r = await runRemoteCheckButton(tools, 'jobs', {})
  assert.equal(r.channel, 'dsh-remote (active machine)') // no agent -> active machine
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].result, /command not found/)
  assert.match(r.results[0].detail, /exit code 127/)
  assert.equal(r.results[0].rows, undefined) // no table for a failed run

  // LSF bjobs exits 255 with "No job found" on an empty queue — healthy, not a failure
  const tools2 = {
    get: () => ({}),
    execute: async () => ({ isError: false, value: { text: 'No job found\n[exit code: 255]' }, content: [] }),
  }
  const r2 = await runRemoteCheckButton(tools2, 'jobs', {})
  assert.equal(r2.results[0].ok, true)
  assert.match(r2.results[0].result, /No job found/)
  assert.equal(r2.results[0].detail, undefined)
  assert.deepEqual(r2.results[0].rows, []) // empty table; the client falls back to the text
})

test('checks: runRemoteCheckButton jobs parses bjobs -a into columned rows', async () => {
  const bjobsOut = [
    'JOBID   USER STAT  QUEUE    FROM_HOST  EXEC_HOST  JOB_NAME   SUBMIT_TIME',
    '15326201 op RUN   normal   login01    node3      sp_00001   Oct 26 21:04',
    '15325000 op DONE  normal   login01    node4      sweep_ctl  Sep 30 08:15',
    '15324999 op PEND  normal   login01               wait_job   Feb 12  2025',
    'garbage line without columns',
  ].join('\n')
  const tools = {
    get: () => ({}),
    execute: async () => ({ isError: false, value: { text: bjobsOut + '\n[exit code: 0]' }, content: [] }),
  }
  const r = await runRemoteCheckButton(tools, 'jobs', { remotePath: '/w' })
  const e = r.results[0]
  assert.ok(e.ok, e.detail)
  assert.equal(e.result, '3 job(s)')
  // display columns [jobid, stat, exec host, name, submit time]; the PEND row's empty
  // exec-host cell is recovered by the all-time-tail heuristic (exec host -> '')
  assert.deepEqual(e.rows[0], ['15326201', 'RUN', 'node3', 'sp_00001', 'Oct 26 21:04'])
  assert.deepEqual(e.rows[1], ['15325000', 'DONE', 'node4', 'sweep_ctl', 'Sep 30 08:15'])
  assert.deepEqual(e.rows[2], ['15324999', 'PEND', '', 'wait_job', 'Feb 12 2025'])
  assert.equal(e.rows.length, 3) // header + garbage skipped
  assert.ok(e.rowsRaw[0].startsWith('15326201'))
  assert.equal(e.truncated, false)
})

test('checks: runRemoteCheckButton batches lists progress files with $ROOT paths', async () => {
  const inputs = []
  const tools = {
    get: () => ({}),
    execute: async (input) => {
      inputs.push(input)
      return { isError: false, value: { text:
        '/home/op/sim/AutoAnalog/b1  [completed] 32/32\n'
        + '/home/op/sim/AutoAnalog/b2  [running] 4/16\n'
        + '/elsewhere/b3  [failed] 1/8\n[exit code: 0]' }, content: [] }
    },
  }
  const r = await runRemoteCheckButton(tools, 'batches', { remotePath: '/home/op/sim/AutoAnalog' })
  const e = r.results[0]
  assert.ok(e.ok, e.detail)
  assert.equal(e.result, '3 batch dir(s)')
  assert.deepEqual(e.rows, [
    ['$ROOT/b1', 'completed', '32/32'],
    ['$ROOT/b2', 'running', '4/16'],
    ['/elsewhere/b3', 'failed', '1/8'], // outside the scope — verbatim
  ])
  assert.match(e.cmd, /find "\/home\/op\/sim\/AutoAnalog" -maxdepth 4 -name sweep_progress\.json/)
  assertValidShell(inputs[0].arguments.command)

  // empty result is still a pass — it reports "none found", no table
  const tools2 = { get: () => ({}), execute: async () => ({ isError: false, value: { text: '[exit code: 0]' }, content: [] }) }
  const r2 = await runRemoteCheckButton(tools2, 'batches', { remotePath: '/w' })
  assert.ok(r2.results[0].ok)
  assert.match(r2.results[0].result, /no sweep_progress\.json found/)
  assert.equal(r2.results[0].rows, undefined)
})

test('checks: runRemoteCheckButton scripts compares the nested local tree against the remote scripts root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-scripts-'))
  try {
    await mkdir(path.join(dir, 'spectre'))
    await mkdir(path.join(dir, 'snp'))
    await writeFile(path.join(dir, 'spectre', 'a.py'), 'AAA', 'utf8')
    await writeFile(path.join(dir, 'snp', 'b.py'), 'BBB', 'utf8')
    await writeFile(path.join(dir, '__pycache__'), '', 'utf8').catch(() => {})
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
    const inputs = []
    const tools = {
      get: () => ({}),
      execute: async (input) => {
        inputs.push(input)
        return { isError: false, value: { text:
          md5('AAA') + '  spectre/a.py\n'
          + 'deadbeefdeadbeefdeadbeefdeadbeef' + '  snp/b.py\n'
          + '__REMOTE_PY__\nspectre/a.py\nsnp/b.py\ncommon/c.py\n[exit code: 0]',
        }, content: [] }
      },
    }
    const r = await runRemoteCheckButton(tools, 'scripts',
      { remotePath: '/home/op/sim', ws: { config: { sim_scripts_dir: dir } } })
    const e = r.results[0]
    assert.ok(e.ok, e.detail)
    assert.match(e.result, /1 in sync, 1 differ, 0 only local, 1 only remote/)
    assert.deepEqual(e.rows, [
      ['snp/b.py', 'differs'],
      ['spectre/a.py', 'in-sync'],
      ['common/c.py', 'only-remote'],
    ])
    assert.equal(e.truncated, false)
    assert.match(e.warn, /drift/)
    assert.match(e.detail, /snp\/b\.py — differs/)
    assert.match(e.detail, /common\/c\.py — only-remote/)
    // relative POSIX paths, recursive remote listing, default root = remote workspace
    assert.match(inputs[0].arguments.command,
      /cd "\/home\/op\/sim" && md5sum "snp\/b\.py" "spectre\/a\.py"/)
    assert.match(inputs[0].arguments.command, /find \. -maxdepth 4 -name '\*\.py'/)
    assertValidShell(inputs[0].arguments.command)

    // an explicit remote_scripts_dir (a REMOTE absolute path) replaces the workspace root
    const rRoot = await runRemoteCheckButton(tools, 'scripts',
      { remotePath: '/home/op/sim', ws: { config: {
        sim_scripts_dir: dir, remote_scripts_dir: '/home/op/sim/HarnessAMS/scripts' } } })
    assert.match(rRoot.results[0].cmd, /cd "\/home\/op\/sim\/HarnessAMS\/scripts"/)

    // an unconfigured scripts dir fails with guidance, not a crash
    const r2 = await runRemoteCheckButton(tools, 'scripts', { remotePath: '/w', ws: {} })
    assert.equal(r2.results[0].ok, false)
    assert.match(r2.results[0].detail, /sim_scripts_dir/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('checks: unknown button and missing rw_exec are hard errors', async () => {
  const tools = { get: () => ({}), execute: async () => ({ isError: false, value: { text: 'x' }, content: [] }) }
  await assert.rejects(() => runRemoteCheckButton(tools, 'nope', {}), /unknown check button/)
  await assert.rejects(() => runRemoteCheckButton({ get: () => undefined }, 'load', {}), /rw_exec tool not registered/)
})

// ---- result parsers (structured rows for the columned tables) ----

test('checks: parseLoadRow takes loadavg + nproc and drops the last-pid field', () => {
  assert.deepEqual(parseLoadRow('0.42 0.51 0.55 3/900 12345\n48\n'), ['0.42', '0.51', '0.55', '3/900', '48'])
  assert.equal(parseLoadRow('0.42 0.51 0.55 3/900\n'), null) // no nproc line
  assert.equal(parseLoadRow('not a loadavg line\n48\n'), null)
  assert.equal(parseLoadRow(''), null)
  assert.equal(parseLoadRow(null), null)
})

test('checks: parseBjobsRows handles header, formats, empty queue and garbage', () => {
  const parsed = parseBjobsRows('JOBID USER STAT QUEUE FROM_HOST EXEC_HOST JOB_NAME SUBMIT_TIME\n'
    + '1 op RUN normal login01 node3 job_a Oct 26 21:04\n')
  assert.deepEqual(parsed.rows, [['1', 'RUN', 'node3', 'job_a', 'Oct 26 21:04']])
  assert.equal(parsed.total, 1)
  assert.equal(parsed.truncated, false)

  // the target cluster's zscheduler bjobs adds FROM_CLUSTER/EXEC_CLUSTER columns —
  // the layout is taken from the header line, not a fixed column count
  const zsched = parseBjobsRows(
    'JOBID USER STAT QUEUE FROM_CLUSTER FROM_HOST EXEC_CLUSTER EXEC_HOST JOB_NAME SUBMIT_TIME\n'
    + '15350701 test_user RUN normal zscheduler node1 zscheduler node3 virtuoso Oct 26 16:43\n')
  assert.deepEqual(zsched.rows, [['15350701', 'RUN', 'node3', 'virtuoso', 'Oct 26 16:43']])

  const empty = parseBjobsRows('No job found')
  assert.deepEqual(empty, { rows: [], raw: [], total: 0, truncated: false })

  // numeric job names must not be peeled into the date tail
  const numeric = parseBjobsRows('2 u RUN q h e 12345 Oct 26 21:04')
  assert.deepEqual(numeric.rows, [['2', 'RUN', 'e', '12345', 'Oct 26 21:04']])

  // a tail without any time shape stays part of the job name
  const named = parseBjobsRows('3 u RUN q h e my job name')
  assert.deepEqual(named.rows, [['3', 'RUN', 'e', 'my job name', '']])

  // a tail without any time shape stays part of the job name; nothing parses -> null
  assert.equal(parseBjobsRows('only garbage here'), null)
  assert.equal(parseBjobsRows(''), null)

  // >maxRows entries are capped and flagged
  const many = Array.from({ length: 35 }, (_, i) => `${1000 + i} u RUN q h e job_${i} Oct 26 21:04`).join('\n')
  const capped = parseBjobsRows(many)
  assert.equal(capped.rows.length, 30)
  assert.equal(capped.total, 35)
  assert.equal(capped.truncated, true)
})

test('checks: rootize collapses the workspace-scope prefix only', () => {
  assert.equal(rootize('/home/op/sim/AutoAnalog/b1', '/home/op/sim/AutoAnalog'), '$ROOT/b1')
  assert.equal(rootize('/home/op/sim/AutoAnalog', '/home/op/sim/AutoAnalog'), '$ROOT')
  assert.equal(rootize('/home/op/sim/AutoAnalogX/b1', '/home/op/sim/AutoAnalog'), '/home/op/sim/AutoAnalogX/b1') // prefix boundary
  assert.equal(rootize('/elsewhere/b1', '/home/op/sim/AutoAnalog'), '/elsewhere/b1')
  assert.equal(rootize('/b1', ''), '/b1') // no scope -> verbatim
})

test('checks: parseBatchRows turns one-liner lines into [dir, status, progress]', () => {
  const rows = parseBatchRows(
    '/w/b1  [completed] 18/18\n/w/b2  [?] ?/?\nnot a batch line\n',
    '/w')
  assert.deepEqual(rows, [['$ROOT/b1', 'completed', '18/18'], ['$ROOT/b2', '?', '?/?']])
  assert.deepEqual(parseBatchRows('', '/w'), [])
})
