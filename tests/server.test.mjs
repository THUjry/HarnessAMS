// Unit tests for the host-half server modules (tier 2 mapping, task store, asset
// status, the dsh-ssh machine channel, remote.js funnel contracts, check buttons).
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertValidShell, batchOf, firstCall, setRemoteMachines } from './helpers.mjs'
import { sessionProject, readTasks, writeTasks, tasksPath } from '../src/server/project.js'
import { assetsStatus } from '../src/server/assets.js'
import { fetchMachines, checkableMachines, remoteMachinesStatus } from '../src/server/machines.js'
import {
  callTool, execRemote, uploadFile, downloadFile, resolveMachine, listMachines,
  resultText, resultValue, attributeSshError,
} from '../src/remote.js'
import {
  runRemoteCheckButton, REMOTE_CHECK_BUTTONS,
  parseLoadRow, parseBjobsRows, parseBatchRows, rootize,
} from '../src/server/checks.js'

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
  const restore = setRemoteMachines({ node1: '/home/op/sim/AutoAnalog' })
  try {
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
    assert.equal(node1.workspace, '/home/op/sim/AutoAnalog') // merged from remote_machines
    assert.equal(node1.configured, true)
    const farm = r.machines.find((m) => m.id === 'farm')
    assert.equal(farm.configured, false)
    assert.equal(farm.workspace, undefined)
  } finally {
    restore()
  }
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

test('machines: checkableMachines filters to configured hosts; remoteMachinesStatus projects roots', async () => {
  const machines = [
    { id: 'node1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op', auth: 'key', keyReady: true, workspace: '/home/op/sim', configured: true },
    { id: 'farm', name: 'farm', host: '10.0.0.8', port: 2222, username: 'root', auth: 'agent', keyReady: false, workspace: undefined, configured: false },
  ]
  const checkable = checkableMachines(machines)
  assert.equal(checkable.length, 1)
  assert.deepEqual({ ...checkable[0] }, {
    id: 'node1', name: 'node1', host: '192.0.2.11', port: 22,
    username: 'op', auth: 'key', keyReady: true, remotePath: '/home/op/sim',
  })
  assert.deepEqual(checkableMachines([]), [])
  assert.deepEqual(checkableMachines(null), [])

  const tools = { get: () => ({}), execute: async () => batchOf(hostsValue(machines.map((m) => ({
    alias: m.id, host: m.host, port: m.port, user: m.username, auth: m.auth, keyReady: m.keyReady,
  })))) }
  const restore = setRemoteMachines({ node1: '/home/op/sim' })
  try {
    const status = await remoteMachinesStatus(tools)
    assert.equal(status.installed, true)
    assert.equal(status.machines.length, 2)
    assert.deepEqual(status.machines[0], {
      id: 'node1', name: 'node1', host: '192.0.2.11', port: 22, username: 'op',
      auth: 'key', keyReady: true, remoteRoot: '/home/op/sim', configured: true,
    })
    assert.equal(status.machines[1].remoteRoot, null)
    assert.equal(status.machines[1].configured, false)
  } finally {
    restore()
  }

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

test('remote: resolveMachine pins the alias + remote-root contract', async () => {
  const restore = setRemoteMachines({ node1: '/home/op/sim', lab9: '' })
  try {
    const ctx = {
      tools: {
        get: (n) => (n === 'ssh_list' ? { n } : undefined),
        execute: async () => batchOf(hostsValue([
          { alias: 'node1', host: '192.0.2.11', port: 22, user: 'op', auth: 'key', keyReady: true },
          { alias: 'lab9', host: '192.0.2.99', port: 22, user: 'op', auth: 'key', keyReady: true },
        ])),
      },
    }
    const t = await resolveMachine(ctx, 'node1')
    assert.equal(t.alias, 'node1')
    assert.equal(t.remoteRoot, '/home/op/sim')
    assert.equal(t.machine.id, 'node1')

    await assert.rejects(() => resolveMachine(ctx, undefined), /machine_id .* required/)
    await assert.rejects(() => resolveMachine(ctx, 'ghost'), /no such dsh-ssh host: ghost \(known: node1, lab9\)/)
    await assert.rejects(() => resolveMachine(ctx, 'lab9'), /no remote root configured for host lab9/)
  } finally {
    restore()
  }

  const broken = {
    tools: {
      get: (n) => (n === 'ssh_list' ? { n } : undefined),
      execute: async () => batchOf({ isError: true, content: [{ type: 'text', text: 'dsh-ssh down' }] }),
    },
  }
  await assert.rejects(() => resolveMachine(broken, 'node1'), /dsh-ssh hosts unavailable: dsh-ssh down/)
})

test('remote: listMachines degrades when ssh_list is missing or empty', async () => {
  const absent = await listMachines({ tools: { get: () => undefined } })
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /ssh_list is not registered/)

  const restore = setRemoteMachines(undefined)
  try {
    const empty = await listMachines({ tools: { get: () => ({}), execute: async () => batchOf(hostsValue([])) } })
    assert.equal(empty.ok, false)
    assert.match(empty.reason, /no hosts configured/)
  } finally {
    restore()
  }
})

// ---- check buttons (checks.js) ----

test('checks: the button surface is the four Overview buttons', () => {
  assert.deepEqual(REMOTE_CHECK_BUTTONS.map((b) => b.id), ['load', 'jobs', 'batches', 'scripts'])
})

// ssh_exec mock: unwraps the timeout-KILL wrapper for behavior routing and
// replies with structured ExecResult values.
function makeCheckCtx(route) {
  return {
    tools: {
      get: (name) => (name === 'ssh_exec' ? { name } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        const v = route(String(args.command).replace(/\\"/g, '"'), args)
        return batchOf({ isError: false, value: v })
      },
    },
  }
}
const execOk = (stdout) => ({ success: true, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 2 })
const MACHINE = { id: 'node1', name: 'node1', alias: 'node1', host: '192.0.2.11', port: 22, username: 'op', auth: 'key', keyReady: true, workspace: '/home/op/sim' }

test('checks: runRemoteCheckButton load targets the alias through the wrapper', async () => {
  const inputs = []
  const ctx = makeCheckCtx((cmd) => {
    assert.match(cmd, /cat \/proc\/loadavg && nproc/)
    return execOk('0.42 0.51 0.55 3/900 12345\n48\n')
  })
  ctx.tools.execute = async (input) => {
    inputs.push(input)
    const call = input.calls[0]
    const args = JSON.parse(call.arguments)
    return batchOf({ isError: false, value: execOk('0.42 0.51 0.55 3/900 12345\n48\n') })
  }
  const r = await runRemoteCheckButton(ctx, 'load', { machine: MACHINE })
  assert.equal(r.channel, 'dsh-ssh (node1)')
  assert.equal(r.results.length, 1)
  assert.ok(r.results[0].ok, r.results[0].detail)
  assert.match(r.results[0].cmd, /cat \/proc\/loadavg && nproc/)
  assert.deepEqual(r.results[0].rows, [['0.42', '0.51', '0.55', '3/900', '48']])
  assert.match(r.results[0].result, /load 0\.42 \/ 48 cpu/)
  const call = firstCall(inputs[0]) // batch contract: {name, arguments(object)}
  assert.equal(call.name, 'ssh_exec')
  assert.equal(call.arguments.alias, 'node1') // zero gating: alias only, no agent
  assert.match(call.arguments.command, /^timeout -s KILL 40s sh -c /)
  assert.equal(call.arguments.timeoutMs, 130_000) // deadline + 90s margin
  assert.ok(inputs[0].signal instanceof AbortSignal && call.id !== undefined)
})

test('checks: runRemoteCheckButton jobs surfaces a missing bjobs and an empty queue', async () => {
  const missing = makeCheckCtx(() => ({ success: false, exitCode: 127, timedOut: false, stdout: 'bash: bjobs: command not found\n', stderr: '', durationMs: 2 }))
  const r = await runRemoteCheckButton(missing, 'jobs', { machine: MACHINE })
  assert.equal(r.channel, 'dsh-ssh (node1)')
  assert.equal(r.results[0].ok, false)
  assert.match(r.results[0].result, /command not found/)
  assert.match(r.results[0].detail, /exit code 127/)
  assert.equal(r.results[0].rows, undefined) // no table for a failed run

  // LSF bjobs exits 255 with "No job found" on an empty queue — healthy, not a failure
  const empty = makeCheckCtx(() => ({ success: false, exitCode: 255, timedOut: false, stdout: 'No job found\n', stderr: '', durationMs: 2 }))
  const r2 = await runRemoteCheckButton(empty, 'jobs', { machine: MACHINE })
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
    '15324999 op PEND  normal   login01               wait_job   Feb 12 2025',
    'garbage line without columns',
  ].join('\n')
  const ctx = makeCheckCtx(() => execOk(bjobsOut))
  const r = await runRemoteCheckButton(ctx, 'jobs', { machine: MACHINE })
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
  const ctx = makeCheckCtx(() => execOk(
    '/home/op/sim/AutoAnalog/b1  [completed] 32/32\n'
    + '/home/op/sim/AutoAnalog/b2  [running] 4/16\n'
    + '/elsewhere/b3  [failed] 1/8\n'))
  ctx.tools.execute = async (input) => {
    inputs.push(input)
    return batchOf({ isError: false, value: execOk(
      '/home/op/sim/AutoAnalog/b1  [completed] 32/32\n'
      + '/home/op/sim/AutoAnalog/b2  [running] 4/16\n'
      + '/elsewhere/b3  [failed] 1/8\n') })
  }
  const r = await runRemoteCheckButton(ctx, 'batches', { machine: { ...MACHINE, workspace: '/home/op/sim/AutoAnalog' } })
  const e = r.results[0]
  assert.ok(e.ok, e.detail)
  assert.equal(e.result, '3 batch dir(s)')
  assert.deepEqual(e.rows, [
    ['$ROOT/b1', 'completed', '32/32'],
    ['$ROOT/b2', 'running', '4/16'],
    ['/elsewhere/b3', 'failed', '1/8'], // outside the scope — verbatim
  ])
  assert.match(e.cmd, /find "\/home\/op\/sim\/AutoAnalog" -maxdepth 4 -name sweep_progress\.json/)
  assertValidShell(firstCall(inputs[0]).arguments.command)

  // empty result is still a pass — it reports "none found", no table
  const empty = makeCheckCtx(() => execOk(''))
  const r2 = await runRemoteCheckButton(empty, 'batches', { machine: MACHINE })
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
    const ctx = makeCheckCtx(() => execOk(
      md5('AAA') + '  spectre/a.py\n'
      + 'deadbeefdeadbeefdeadbeefdeadbeef' + '  snp/b.py\n'
      + '__REMOTE_PY__\nspectre/a.py\nsnp/b.py\ncommon/c.py\n'))
    ctx.tools.execute = async (input) => {
      inputs.push(input)
      return batchOf({ isError: false, value: execOk(
        md5('AAA') + '  spectre/a.py\n'
        + 'deadbeefdeadbeefdeadbeefdeadbeef' + '  snp/b.py\n'
        + '__REMOTE_PY__\nspectre/a.py\nsnp/b.py\ncommon/c.py\n') })
    }
    const r = await runRemoteCheckButton(ctx, 'scripts',
      { machine: MACHINE, ws: { config: { sim_scripts_dir: dir } } })
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
    // relative POSIX paths, recursive remote listing, default root = the machine's
    // remote root; the wrapper escapes inner quotes — flatten before matching
    const scriptCmd = String(firstCall(inputs[0]).arguments.command).replace(/\\"/g, '"')
    assert.match(scriptCmd, /cd "\/home\/op\/sim" && md5sum "snp\/b\.py" "spectre\/a\.py"/)
    assert.match(scriptCmd, /find \. -maxdepth 4 -name '\*\.py'/)
    assertValidShell(scriptCmd)

    // an explicit remote_scripts_dir (a REMOTE absolute path) replaces the root
    const rRoot = await runRemoteCheckButton(ctx, 'scripts',
      { machine: MACHINE, ws: { config: {
        sim_scripts_dir: dir, remote_scripts_dir: '/home/op/sim/HarnessAMS/scripts' } } })
    assert.match(rRoot.results[0].cmd, /cd "\/home\/op\/sim\/HarnessAMS\/scripts"/)

    // an unconfigured scripts dir fails with guidance, not a crash
    const r2 = await runRemoteCheckButton(ctx, 'scripts', { machine: MACHINE, ws: {} })
    assert.equal(r2.results[0].ok, false)
    assert.match(r2.results[0].detail, /sim_scripts_dir/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('checks: unknown button, missing ssh_exec and a missing machine are hard errors', async () => {
  const ctx = makeCheckCtx(() => execOk('x'))
  await assert.rejects(() => runRemoteCheckButton(ctx, 'nope', { machine: MACHINE }), /unknown check button/)
  await assert.rejects(() => runRemoteCheckButton({ tools: { get: () => undefined } }, 'load', { machine: MACHINE }), /ssh_exec tool not registered/)
  await assert.rejects(() => runRemoteCheckButton(ctx, 'load', {}), /opts\.machine/)
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
