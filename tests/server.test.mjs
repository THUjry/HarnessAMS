// Unit tests for the host-half server modules (tier 2 mapping, task store,
// nodes.yaml roundtrip, asset status). Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseNodesYaml, validateNodes, writeNodes, readNodes } from '../src/server/workspace.js'
import { sessionProject, readTasks, writeTasks, tasksPath } from '../src/server/project.js'
import { assetsStatus } from '../src/server/assets.js'
import { resultText, parseRwMachinesText, fetchMachines, findMirrorForMachine, sessionInMirror } from '../src/server/machines.js'
import { parseRwExecText, runMachineChecksViaToolShell } from '../src/server/checks.js'

test('nodes: parse -> validate -> write -> re-read roundtrip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-nodes-'))
  try {
    const yaml = [
      '# comment that will be lost on rewrite',
      'nodes:',
      '  - HOST: login',
      '    HOSTNAME: 192.0.2.9',
      '    PORT: 22',
      '    WORKSPACE: /home/user/sim',
      '    reserved: false',
    ].join('\n')
    const file = path.join(dir, 'nodes.yaml')
    await writeFile(file, yaml, 'utf8')
    const parsed = parseNodesYaml(await readFile(file, 'utf8'))
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].HOST, 'login')

    const v = validateNodes([{ HOST: 'login', HOSTNAME: '192.0.2.9', PORT: 22, WORKSPACE: '/home/user/sim', reserved: 'false' }])
    assert.ok(!v.error, v.error)
    writeNodes(file, v.nodes)
    const again = readNodes(dir).nodes
    assert.equal(again.length, 1)
    assert.equal(again[0].HOST, 'login')
    assert.equal(again[0].PORT, '22') // numbers normalize to strings
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('nodes: validation rejects bad input', () => {
  assert.ok(validateNodes([]).nodes)
  assert.ok(validateNodes([{ HOST: '' }]).error)
  assert.ok(validateNodes([{ HOST: 'a' }, { HOST: 'a' }]).error) // duplicate
  assert.ok(validateNodes([{ HOST: 'a; rm -rf' }]).error) // charset
  assert.ok(validateNodes([{ HOST: 'a', PORT: 'abc' }]).error)
  assert.ok(validateNodes([{ HOST: 'a', reserved: 'maybe' }]).error)
  assert.ok(validateNodes('nope').error)
})

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

// ---- dsh-remote channel (route A: rw_machines listing + rw_exec checks) ----

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
    return { ok: true, json: async () => ({ machines: [{ id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', workspace: '/w' }], currentId: 'm-1' }) }
  }
  const req = { headers: { host: '127.0.0.1:3187', cookie: 'session=abc', authorization: 'Bearer t' } }
  const r = await fetchMachines(tools, req, fetchImpl)
  assert.ok(r.ok, r.reason)
  assert.equal(r.source, 'HTTP /dsh-remote/machines')
  assert.equal(r.machines[0].current, true)
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
    { header: { cwd: 'D:/proj/harnessams-workspace' } },
    { header: { cwd: 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog/sub' } },
  ] }
  const hit = sessionInMirror(null, 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog', svc)
  assert.ok(hit, 'no session borrowed')
  assert.equal(hit.agent.session.header.cwd, 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog/sub')
  assert.equal(sessionInMirror(null, 'C:/other', svc), null)
  assert.equal(sessionInMirror(null, 'C:/Users/x/.dsh/remote-workspaces/192.0.2.11-op-22/AutoAnalog', { list: () => [] }), null)
  assert.equal(sessionInMirror(null, 'C:/x', null), null) // no sessions service -> null, not throw
  assert.equal(sessionInMirror(null, null, svc), null)
})

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
})

test('checks: runMachineChecksViaToolShell injects the mirror cwd and parses results', async () => {
  const inputs = []
  const tools = {
    get: (name) => (name === 'rw_exec' ? { name } : undefined),
    execute: async (input) => {
      inputs.push(input)
      if (input.arguments.command.startsWith('echo ok')) {
        assert.equal(input.agent.session.header.cwd, 'MIRROR/DIR') // route A: binding context
        return { isError: false, value: { text: 'ok' }, content: [] }
      }
      if (input.arguments.command.startsWith('which ngspice')) {
        return { isError: false, value: { text: '/usr/bin/ngspice\n[exit code: 0]' }, content: [] }
      }
      if (input.arguments.command.startsWith('ls -ld')) {
        return { isError: false, value: { text: 'drwxr-xr-x 8 op users 4096 Oct 25 10:00 /home/op/sim/AutoAnalog' }, content: [] }
      }
      return { isError: false, value: { text: '1.2 3.4 5/900 777\n-- stderr --\nnothing\n[exit code: 0]' }, content: [] }
    },
  }
  const machine = { id: 'm-1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', workspace: '/home/op/sim/AutoAnalog' }
  const r = await runMachineChecksViaToolShell(tools, machine,
    { mirror: { mirrorDir: 'MIRROR/DIR', remotePath: '/home/op/sim/AutoAnalog' }, agent: { session: { header: { cwd: 'MIRROR/DIR' } } } })
  assert.equal(r.channel, 'dsh-remote (mirror)')
  assert.equal(r.results.length, 7)
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results.map((x) => [x.item, x.ok, x.detail])))
  assert.ok(r.results.every((x) => x.channel === 'dsh-remote (mirror)'))
  assert.match(r.results[0].cmd, /rw_exec node1: /)
  // workspace interpolation uses the mirror's remotePath
  assert.match(r.results.find((x) => x.item === 'Workspace reachable').cmd, /\/home\/op\/sim\/AutoAnalog/)
  assert.ok(inputs.every((i) => i.signal instanceof AbortSignal && i.callId))
  assert.ok(inputs.every((i) => i.name === 'rw_exec'))
})

test('checks: rw_exec failures surface exit codes and errors per item', async () => {
  const tools = {
    get: () => ({}),
    execute: async (input) => {
      if (input.arguments.command.startsWith('echo ok')) return { isError: false, value: { text: 'ok' }, content: [] }
      if (input.arguments.command.startsWith('which ngspice')) {
        return { isError: true, value: undefined, content: [{ type: 'text', text: 'rw_exec: no ngspice' }] }
      }
      return { isError: false, value: { text: 'du: permission denied\n[exit code: 1]' }, content: [] }
    },
  }
  const r = await runMachineChecksViaToolShell(tools, { name: 'node1', host: 'h', port: 22 }, {})
  assert.equal(r.channel, 'dsh-remote (active machine)')
  const byItem = Object.fromEntries(r.results.map((x) => [x.item, x]))
  assert.equal(byItem['Connectivity'].ok, true)
  assert.equal(byItem['ngspice present'].ok, false)
  assert.match(byItem['ngspice present'].detail, /no ngspice/)
  assert.equal(byItem['Disk usage detail'].ok, false)
  assert.match(byItem['Disk usage detail'].detail, /exit code 1/)
})
