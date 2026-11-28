// Automation store + runner contracts: the shared .txt command library under
// .harnessams/automation/, the automation.json task list (lenient read /
// strict write), the key format, the entry's execution mode, the oversize
// warning, the seeded default demo, and the sequential runner (remote: the
// dsh-ssh exec funnel; local: one tool call per line through the registered
// tool surface; the last run's status/result stays in process memory) — plus
// the config_automation / run_automation / local_exec tool faces and their
// routes (list / run / delete / result). The tool shells are mocks speaking
// the dsh-tools batch contract; the route driver is the shared helpers one.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerRoutes, callRoute, callGet, callPost } from './helpers.mjs'
import { makeTool } from '../src/tool.js'
import { automationTools } from '../src/tools/automation.js'
import {
  addAutomation, updateAutomation, deleteAutomation, readAutomations,
  writeCommandFile, runAutomation, makeAutomationKey, ensureDefaultAutomation,
  automationPath, commandDirPath, readRunMemory, readRunStatus,
} from '../src/core/automation.js'

const rmrf = (dir) => fsp.rm(dir, { recursive: true, force: true })

// ctx.shell stub for the local_exec tool face: resolve() passes the spec
// through, execute() answers with a scripted result in the shape execLocal
// reads (stdout/stderr as { text }, exitCode, timedOut, aborted).
function makeShellCtx(result) {
  const specs = []
  const ctx = {
    shell: {
      resolve: (spec) => spec,
      execute: async (spec) => {
        specs.push(spec)
        return { result: async () => (typeof result === 'function' ? result(spec) : result) }
      },
    },
  }
  return { ctx, specs }
}

// The compiled local_exec tool over a shell stub.
const localExecTool = (ctx) => automationTools(ctx).map((d) => makeTool(d)).find((x) => x.name === 'local_exec')

// A project with .harnessams/ and a configured machine_id (the automation
// runner's target); machineId null leaves the runner refused.
async function makeProject({ machineId = 'node1' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hams-auto-'))
  const store = path.join(dir, '.harnessams')
  await fsp.mkdir(store, { recursive: true })
  await fsp.writeFile(path.join(store, 'workspace_config.json'), JSON.stringify({
    version: 1,
    workspace: { sim_scripts_dir: path.join(dir, 'scripts'), trash_dir: '.harnessams/trash' },
    settings: { machine_id: machineId },
  }, null, 2) + '\n')
  return dir
}

// ssh tool shell mock: records every batch call, answers each ssh_exec with
// the handle()'s result entry ({ value } or { isError, text }).
function makeSshCtx(handle) {
  const calls = []
  const ctx = {
    tools: {
      register: () => {},
      get: (name) => ({ name }),
      execute: async (input) => {
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        calls.push({ id: call.id, name: call.name, args, signal: input.signal })
        const result = call.name === 'ssh_exec'
          ? await handle(args, calls)
          : { isError: true, text: `unexpected tool call: ${call.name}` }
        return { results: [{ callId: call.id, result }] }
      },
    },
  }
  return { ctx, calls }
}

const okExec = () => ({ value: { success: true, stdout: 'done', stderr: '', exitCode: 0 } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Local-mode tool-surface mock: get() answers the registry lookup (the demo
// tools declare a `project` parameter, so the runner's project injection
// fires), execute() records every batch call and answers from per-tool
// handlers; a tool with no handler reads as unregistered.
function makeToolCtx(handlers, { declareProject = true } = {}) {
  const calls = []
  const ctx = {
    tools: {
      register: () => {},
      get: (name) => (handlers[name]
        ? { name, parameters: { properties: declareProject ? { project: {} } : {} } }
        : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        calls.push({ id: call.id, name: call.name, args, signal: input.signal })
        const handler = handlers[call.name]
        const result = handler ? await handler(args, calls) : { isError: true, text: `unexpected tool call: ${call.name}` }
        return { results: [{ callId: call.id, result }] }
      },
    },
  }
  return { ctx, calls }
}

test('store: add writes the shared command files and registers the task with its key and order', async () => {
  const dir = await makeProject()
  try {
    const r = await addAutomation(dir, {
      sessionId: 'session-abc123',
      name: 'clean tmp',
      description: 'removes ~/tmp/*',
      commands: [
        { file: 'clean_tmp.txt', content: 'rm ~/tmp/*' },
        { file: 'report.txt', content: 'echo cleaned' },
      ],
    })
    assert.equal(r.ok, true)
    assert.match(r.key, /^session-abc123-\d{12}$/, 'key = creating session id + yymmddhhmmss stamp')
    assert.deepEqual(r.files, ['clean_tmp.txt', 'report.txt'])
    assert.equal(await fsp.readFile(path.join(commandDirPath(dir), 'clean_tmp.txt'), 'utf8'), 'rm ~/tmp/*')
    assert.equal(await fsp.readFile(path.join(commandDirPath(dir), 'report.txt'), 'utf8'), 'echo cleaned')
    const { automations, warnings } = await readAutomations(dir)
    assert.deepEqual(warnings, [])
    assert.equal(automations.length, 1)
    assert.equal(automations[0].name, 'clean tmp')
    assert.equal(automations[0].description, 'removes ~/tmp/*')
    assert.equal(automations[0].created_by_session, 'session-abc123')
    assert.equal(automations[0].created_at, automations[0].updated_at)
    assert.deepEqual(automations[0].files, ['clean_tmp.txt', 'report.txt'])
    // key minting: same-second collisions get a numeric suffix (clock injected)
    const t = new Date(2026, 10, 28, 10, 15, 0)
    assert.equal(makeAutomationKey('s', new Set(), t), 's-261128101500')
    assert.equal(makeAutomationKey('s', new Set(['s-261128101500']), t), 's-261128101500-2')
    assert.equal(makeAutomationKey('s', new Set(['s-261128101500', 's-261128101500-2']), t), 's-261128101500-3')
  } finally { await rmrf(dir) }
})

test('store: command files are a decoupled shared library — tasks reuse them and deletes keep them', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, { sessionId: 's1', name: 't1', commands: [{ file: 'shared.txt', content: 'echo shared' }] })
    // reuse without content: the reference-only path
    const r2 = await addAutomation(dir, { sessionId: 's1', name: 't2', commands: [{ file: 'shared.txt' }] })
    assert.equal(r2.ok, true)
    // identical content is an idempotent no-op; different content overwrites
    const w1 = await writeCommandFile(dir, 'shared.txt', 'echo shared')
    assert.equal(w1.written, false)
    const w2 = await writeCommandFile(dir, 'shared.txt', 'echo changed')
    assert.equal(w2.written, true)
    assert.equal(await fsp.readFile(path.join(commandDirPath(dir), 'shared.txt'), 'utf8'), 'echo changed')
    // both tasks point at the same file (cross-task reuse)
    const { automations } = await readAutomations(dir)
    assert.deepEqual(automations.map((a) => a.files), [['shared.txt'], ['shared.txt']])
    // deleting one task keeps the shared file on disk
    const d = await deleteAutomation(dir, { key: automations[0].key })
    assert.equal(d.ok, true)
    assert.deepEqual(d.files_kept, ['shared.txt'])
    await fsp.access(path.join(commandDirPath(dir), 'shared.txt'))
    const after = await readAutomations(dir)
    assert.equal(after.automations.length, 1)
    // a reference to a file nobody created is refused up front
    const ghost = await addAutomation(dir, { sessionId: 's1', name: 't3', commands: [{ file: 'ghost.txt' }] })
    assert.match(ghost.error, /does not exist/)
  } finally { await rmrf(dir) }
})

test('store: command file names are fenced and the payload is validated', async () => {
  const dir = await makeProject()
  try {
    for (const bad of ['../evil.txt', 'sub/dir.txt', 'noext', '', 'with space.txt', '.hidden.txt']) {
      const r = await addAutomation(dir, { sessionId: 's', name: 'x', commands: [{ file: bad, content: 'echo x' }] })
      assert.ok(r.error, `name must be refused: ${JSON.stringify(bad)}`)
      assert.match(r.error, /command file name/)
    }
    for (const bad of [
      undefined, [], 'notarray', [{ file: 'ok.txt' }, { file: 'ok2.txt', content: '' }],
      [{ content: 'no file' }], [{ file: 'ok.txt', content: 5 }],
    ]) {
      const r = await addAutomation(dir, { sessionId: 's', name: 'x', commands: bad })
      assert.ok(r.error, `commands must be refused: ${JSON.stringify(bad)}`)
    }
    const noName = await addAutomation(dir, { sessionId: 's', commands: [{ file: 'ok.txt', content: 'x' }] })
    assert.match(noName.error, /name is required/)
    // nothing above may have registered an entry or written a file
    const { automations } = await readAutomations(dir)
    assert.equal(automations.length, 0)
    const written = await fsp.readdir(commandDirPath(dir)).catch(() => [])
    assert.deepEqual(written, [])
  } finally { await rmrf(dir) }
})

test('store: update rewrites the task (fields and command set) and bumps updated_at', async () => {
  const dir = await makeProject()
  try {
    const a = await addAutomation(dir, {
      sessionId: 's', name: 'old', description: 'd0',
      commands: [{ file: 'one.txt', content: 'echo one' }],
    })
    await sleep(10)
    const u = await updateAutomation(dir, { key: a.key, name: 'new', commands: [
      { file: 'one.txt', content: 'echo one-v2' },
      { file: 'two.txt', content: 'echo two' },
    ] })
    assert.equal(u.ok, true)
    assert.equal(u.name, 'new')
    assert.deepEqual(u.files, ['one.txt', 'two.txt'])
    const { automations } = await readAutomations(dir)
    assert.equal(automations[0].description, 'd0', 'untouched fields survive')
    assert.ok(automations[0].updated_at > automations[0].created_at)
    assert.equal(await fsp.readFile(path.join(commandDirPath(dir), 'one.txt'), 'utf8'), 'echo one-v2')
    // the replaced-away file stays on disk (shared library, delete is manual)
    await fsp.access(path.join(commandDirPath(dir), 'one.txt'))
    const ghostUpd = await updateAutomation(dir, { key: 'nope', name: 'x' })
    assert.equal(ghostUpd.code, 404)
  } finally { await rmrf(dir) }
})

test('store: lenient read skips bad entries and command names, unknown fields ride through', async () => {
  const dir = await makeProject()
  try {
    await fsp.mkdir(path.join(dir, '.harnessams'), { recursive: true })
    await fsp.writeFile(automationPath(dir), JSON.stringify({
      futureTop: 7,
      automations: [
        { key: 'session-x-261128101500', name: 'ok', files: ['a.txt', 'bad/name.txt'], custom: 1 },
        { key: 'bad', name: 'x' },
        'notanobject',
        { key: 'session-x-261128101500', name: 'dup' },
      ],
    }))
    const { automations, warnings, rest } = await readAutomations(dir)
    assert.equal(automations.length, 1)
    assert.deepEqual(automations[0].files, ['a.txt'])
    assert.equal(automations[0].custom, 1, 'unknown entry fields ride through')
    assert.equal(warnings.length, 4, 'bad command name, bad key, non-object entry, duplicate key')
    assert.equal(rest.futureTop, 7, 'unknown root fields ride through')
    // a later write self-heals the skipped entries off disk and keeps the root rest
    await deleteAutomation(dir, { key: 'session-x-261128101500' })
    const raw = JSON.parse(await fsp.readFile(automationPath(dir), 'utf8'))
    assert.equal(raw.futureTop, 7)
    assert.deepEqual(raw.automations, [])
  } finally { await rmrf(dir) }
})

test('runner: commands execute sequentially from disk on the project machine, results echo per command', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, {
      sessionId: 's-seq', name: 'seq',
      commands: [
        { file: 'one.txt', content: 'echo one' },
        { file: 'two.txt', content: 'echo two' },
      ],
    })
    const { automations } = await readAutomations(dir)
    const key = automations[0].key
    let releaseFirst
    const gate = new Promise((r) => { releaseFirst = r })
    const dispatched = []
    const { ctx, calls } = makeSshCtx(async (args) => {
      dispatched.push(args.command)
      if (dispatched.length === 1) await gate
      return okExec()
    })
    const runP = runAutomation(ctx, { project: { path: dir }, key })
    await sleep(20)
    assert.equal(dispatched.length, 1, 'the second command dispatches only after the first settles')
    releaseFirst()
    const r = await runP
    assert.equal(r.status, 'done')
    assert.equal(r.ok, true)
    assert.equal(r.machine, 'node1')
    assert.deepEqual(r.results.map((x) => x.file), ['one.txt', 'two.txt'])
    assert.equal(r.results[0].ok, true)
    for (const c of calls) {
      assert.equal(c.name, 'ssh_exec')
      assert.equal(c.args.alias, 'node1', 'the project machine_id is the target')
      assert.match(c.args.command, /^timeout -s KILL 120s sh -c /, 'the guaranteed-kill wrapper with the per-command budget')
      assert.ok(c.signal instanceof AbortSignal, 'a live abort signal rides the batch input')
    }
    assert.match(calls[0].args.command, /echo one/)
    assert.match(calls[1].args.command, /echo two/)
  } finally { await rmrf(dir) }
})

test('runner: a failed command reports independently and the rest still run; overall status fails', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, {
      sessionId: 's', name: 'mixed',
      commands: [
        { file: 'bad.txt', content: 'failcmd' },
        { file: 'good.txt', content: 'okcmd' },
      ],
    })
    const { automations } = await readAutomations(dir)
    const { ctx, calls } = makeSshCtx((args) =>
      (/failcmd/.test(args.command)
        ? { value: { success: false, stdout: '', stderr: 'boom', exitCode: 1 } }
        : okExec()))
    const r = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(r.status, 'failed')
    assert.equal(r.ok, false)
    assert.equal(r.results[0].ok, false)
    assert.equal(r.results[0].exitCode, 1)
    assert.match(r.results[0].error, /boom/)
    assert.equal(r.results[1].ok, true, 'the failure does not stop the rest')
    assert.equal(calls.length, 2)
  } finally { await rmrf(dir) }
})

test('runner: a missing command file or an unconfigured machine refuses with a clear error', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, { sessionId: 's', name: 'x', commands: [{ file: 'gone.txt', content: 'echo x' }] })
    const { automations } = await readAutomations(dir)
    const { ctx } = makeSshCtx(okExec)
    await fsp.rm(path.join(commandDirPath(dir), 'gone.txt'))
    const r = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(r.status, 'failed')
    assert.match(r.results[0].error, /command file unreadable/)
    const unknown = await runAutomation(ctx, { project: { path: dir }, key: 'nope' })
    assert.equal(unknown.code, 404)
    assert.match(unknown.error, /no such automation/)
  } finally { await rmrf(dir) }
  const noMachine = await makeProject({ machineId: null })
  try {
    await addAutomation(noMachine, { sessionId: 's', name: 'x', commands: [{ file: 'a.txt', content: 'echo a' }] })
    const { automations } = await readAutomations(noMachine)
    const { ctx } = makeSshCtx(okExec)
    const r = await runAutomation(ctx, { project: { path: noMachine }, key: automations[0].key })
    assert.equal(r.code, 400)
    assert.match(r.error, /machine_id is not configured/)
  } finally { await rmrf(noMachine) }
})

test('runner: aborting the caller signal marks the run aborted with the uncertain-remote note', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, { sessionId: 's', name: 'x', commands: [
      { file: 'hang.txt', content: 'echo hang' },
      { file: 'rest.txt', content: 'echo rest' },
    ] })
    const { automations } = await readAutomations(dir)
    const ac = new AbortController()
    const { ctx } = makeSshCtx(() => new Promise(() => {})) // never settles
    const runP = runAutomation(ctx, { project: { path: dir }, key: automations[0].key, signal: ac.signal })
    await sleep(20)
    ac.abort()
    const r = await runP
    assert.equal(r.status, 'aborted')
    assert.equal(r.ok, false)
    assert.equal(r.results[0].aborted, true)
    assert.match(r.results[0].error, /uncertain/, 'the race-abort face says the remote state is uncertain')
    // an already-aborted signal short-circuits the remaining commands
    assert.equal(r.results[1].aborted, true)
  } finally { await rmrf(dir) }
})

test('store: mode rides entries — local persists, absent reads as remote, unknown values warn', async () => {
  const dir = await makeProject()
  try {
    const a = await addAutomation(dir, {
      sessionId: 's', name: 'loc', mode: 'local',
      commands: [{ file: 'a.txt', content: 'safe_trash {"action":"list"}' }],
    })
    assert.equal(a.mode, 'local')
    const b = await addAutomation(dir, { sessionId: 's', name: 'rem', commands: [{ file: 'b.txt', content: 'echo x' }] })
    assert.equal(b.mode, 'remote', 'no mode given = the remote default')
    const u = await updateAutomation(dir, { key: b.key, mode: 'local' })
    assert.equal(u.mode, 'local', 'an update switches the channel')
    const keep = await updateAutomation(dir, { key: a.key, name: 'loc2' })
    assert.equal(keep.mode, 'local', 'an update without mode keeps the channel')
    const bad = await addAutomation(dir, { sessionId: 's', name: 'x', mode: 'weird', commands: [{ file: 'c.txt', content: 'echo c' }] })
    assert.match(bad.error, /mode must be 'remote' or 'local'/)
    // the lenient read: an unknown stored value warns and reads back remote
    await fsp.writeFile(automationPath(dir), JSON.stringify({ automations: [
      { key: 'k-weird-000001', name: 'w', files: ['a.txt'], mode: 'weird' },
      { key: 'k-loc-000002', name: 'l', files: ['a.txt'], mode: 'local' },
    ] }))
    const { automations, warnings } = await readAutomations(dir)
    assert.equal(automations[0].mode, 'remote')
    assert.equal(automations[1].mode, 'local')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /mode is not 'remote' or 'local'/)
  } finally { await rmrf(dir) }
})

test('runner: local-mode tasks call tools line by line with project injected, no machine needed', async () => {
  const dir = await makeProject({ machineId: null })
  try {
    await addAutomation(dir, {
      sessionId: 's-loc', name: 'clean trash', mode: 'local',
      commands: [{
        file: 'clean.txt',
        content: '# one tool call per line\nsafe_trash {"action":"empty"}\nbatch_submit {"run_dir":"r1"}',
      }],
    })
    const { automations } = await readAutomations(dir)
    assert.equal(automations[0].mode, 'local')
    const { ctx, calls } = makeToolCtx({
      safe_trash: () => ({ value: { ok: true, purged: 2, output: 'emptied 2 entries' } }),
      batch_submit: () => ({ value: { ok: true, job_id: 'j1' } }),
    })
    const r = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(r.status, 'done')
    assert.equal(r.mode, 'local')
    assert.equal(r.machine, null, 'local runs need no machine_id')
    assert.equal(calls.length, 2, 'comment lines are skipped, one call per line')
    assert.deepEqual(calls.map((c) => c.name), ['safe_trash', 'batch_submit'])
    assert.equal(calls[0].args.action, 'empty')
    assert.equal(calls[0].args.project, dir, 'the project path is injected for tools that declare it')
    assert.equal(calls[1].args.run_dir, 'r1')
    assert.ok(calls[0].signal instanceof AbortSignal, 'a live abort signal rides the batch input')
    assert.equal(r.results[0].tool, 'safe_trash')
    assert.equal(r.results[0].ok, true)
    assert.equal(r.results[0].line, 2, 'the line number of the call')
    assert.match(r.results[0].text, /emptied 2 entries/, 'a JSON value result echoes as text')
    assert.equal(r.results[1].line, 3)
  } finally { await rmrf(dir) }
})

test('runner: local-mode bad lines and unknown tools report per line, the rest still run', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, {
      sessionId: 's', name: 'mixed', mode: 'local',
      commands: [{ file: 'mixed.txt', content: 'safe_trash\nnope {"x":1}\nsafe_trash {"action":"list"}\nsafe_trash not-json' }],
    })
    const { automations } = await readAutomations(dir)
    const { ctx, calls } = makeToolCtx({
      safe_trash: () => ({ value: { ok: true, output: 'listed' } }),
    })
    const r = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(r.status, 'failed', 'a bad line fails the overall status')
    assert.match(r.results[0].error, /no arguments found/, 'a tool name without JSON args')
    assert.equal(r.results[1].tool, 'nope')
    assert.match(r.results[1].error, /not registered/)
    assert.equal(r.results[2].ok, true, 'the failure does not stop the rest')
    assert.match(r.results[3].error, /not valid JSON/)
    assert.equal(calls.length, 1, 'only the well-formed registered line dispatches')
  } finally { await rmrf(dir) }
})

test('store: oversize command files (>50 lines) warn through add, run and the list route', async () => {
  const dir = await makeProject()
  try {
    const big = Array.from({ length: 51 }, (_, i) => `echo line ${i + 1}`).join('\n')
    const r = await addAutomation(dir, { sessionId: 's', name: 'big', commands: [{ file: 'big.txt', content: big }] })
    assert.equal(r.ok, true)
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0], /big\.txt is 51 lines/)
    assert.match(r.warnings[0], /uploading heavy content/)
    // the warning points at the bundled skill that documents the workflow
    assert.match(r.warnings[0], /see the automation skill/)
    const { automations } = await readAutomations(dir)
    const { ctx } = makeSshCtx(okExec)
    const run = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(run.status, 'done')
    assert.equal(run.results[0].lines, 51)
    assert.equal(run.results[0].oversize, true)
    // a 50-line file does not warn (the boundary is exclusive)
    const fifty = Array.from({ length: 50 }, (_, i) => `echo ${i}`).join('\n')
    const ok = await addAutomation(dir, { sessionId: 's', name: 'ok50', commands: [{ file: 'fifty.txt', content: fifty }] })
    assert.equal(ok.warnings, undefined)
    // the list route enriches each file reference with its line metadata
    ctx.workspaceRegistry = { list: () => [{ id: 'w1', path: dir, title: 'w', sessionIds: ['session-o'] }] }
    const handler = await registerRoutes(ctx)
    const got = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation?sessionId=session-o')
    assert.equal(got.code, 200)
    const bigEntry = got.body.automations.find((a) => a.name === 'big')
    assert.deepEqual(bigEntry.files, [{ file: 'big.txt', lines: 51, oversize: true }])
    const okEntry = got.body.automations.find((a) => a.name === 'ok50')
    assert.deepEqual(okEntry.files, [{ file: 'fifty.txt', lines: 50, oversize: false }])
  } finally { await rmrf(dir) }
})

test('store: fresh projects seed the default local demo task, idempotently', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hams-auto-'))
  try {
    const first = await ensureDefaultAutomation(dir)
    assert.equal(first.created, true)
    assert.match(first.key, /^seed-\d{12}$/)
    const again = await ensureDefaultAutomation(dir)
    assert.equal(again.created, false, 'an existing store is never re-seeded')
    const { automations, warnings } = await readAutomations(dir)
    assert.deepEqual(warnings, [])
    assert.equal(automations.length, 1)
    const demo = automations[0]
    assert.equal(demo.mode, 'local')
    assert.equal(demo.name, 'Empty project trash')
    assert.deepEqual(demo.files, ['empty-trash.txt'])
    assert.equal(await fsp.readFile(path.join(commandDirPath(dir), 'empty-trash.txt'), 'utf8'),
      'safe_trash {"action":"empty"}')
    // the demo runs as a local task: one safe_trash call with project injected
    const { ctx, calls } = makeToolCtx({
      safe_trash: () => ({ value: { ok: true, purged: 0, output: 'trash is already empty' } }),
    })
    const r = await runAutomation(ctx, { project: { path: dir }, key: demo.key })
    assert.equal(r.status, 'done')
    assert.equal(calls[0].name, 'safe_trash')
    assert.equal(calls[0].args.action, 'empty')
    assert.equal(calls[0].args.project, dir)
    // deleting the task (the store file then exists) does not resurrect it
    await deleteAutomation(dir, { key: demo.key })
    const third = await ensureDefaultAutomation(dir)
    assert.equal(third.created, false)
  } finally { await rmrf(dir) }
})

test('routes: POST /api/automation/delete removes the entry, keeps the files, fences errors and cross-site', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, { sessionId: 'session-d', name: 'd1', commands: [{ file: 'del.txt', content: 'echo x' }] })
    const { automations } = await readAutomations(dir)
    const registry = { list: () => [{ id: 'w1', path: dir, title: 'w', sessionIds: ['session-d'] }] }
    const { ctx } = makeSshCtx(okExec)
    ctx.workspaceRegistry = registry
    const handler = await registerRoutes(ctx)
    const del = await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/delete',
      { sessionId: 'session-d', key: automations[0].key })
    assert.equal(del.code, 200)
    assert.equal(del.body.ok, true)
    assert.deepEqual(del.body.files_kept, ['del.txt'])
    // the shared command file stays on disk
    await fsp.access(path.join(commandDirPath(dir), 'del.txt'))
    const gone = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation?sessionId=session-d')
    assert.equal(gone.body.automations.length, 0)
    const unknown = await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/delete',
      { sessionId: 'session-d', key: 'nope' })
    assert.equal(unknown.code, 404)
    const noKey = await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/delete',
      { sessionId: 'session-d' })
    assert.equal(noKey.code, 400)
    const cross = await callRoute(handler, {
      method: 'POST', url: 'http://127.0.0.1/harnessams/api/automation/delete',
      headers: { 'sec-fetch-site': 'cross-site' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
    })
    assert.equal(cross.code, 403)
  } finally { await rmrf(dir) }
})

test('tools: run_automation takes only the key; config_automation is the action runner', async () => {
  const [configDef, runDef] = automationTools({})
  const configTool = makeTool(configDef)
  const runTool = makeTool(runDef)
  assert.deepEqual(Object.keys(runTool.parameters.properties), ['key'], 'the index key is the only field')
  assert.deepEqual(runTool.parameters.required, ['key'])
    assert.deepEqual(configTool.parameters.properties.action.enum, ['add', 'update', 'delete'])
    assert.deepEqual(configTool.parameters.properties.mode.enum, ['remote', 'local'], 'the execution channel switch')
  // the config tool never runs anything; the run tool runs by key through the
  // session-anchored project
  const dir = await makeProject()
  try {
    const registry = { list: () => [{ id: 'w1', path: dir, title: 'w', sessionIds: ['session-tool'] }] }
    const { ctx } = makeSshCtx(okExec)
    ctx.workspaceRegistry = registry
    const tools = automationTools(ctx).map((d) => makeTool(d))
    const [configT, runT] = tools
    const added = await configT.execute({ action: 'add', name: 'echo task', commands: [{ file: 'hi.txt', content: 'echo hi' }] }, { agent: { id: 'session-tool' } })
    assert.equal(added.ok, true)
    assert.match(added.key, /^session-tool-\d{12}/, 'the key carries the creating session id (subagent-resolved)')
    const run = await runT.execute({ key: added.key }, { agent: { id: 'session-tool' } })
    assert.equal(run.status, 'done')
    assert.deepEqual(run.results.map((x) => x.file), ['hi.txt'])
    // a bogus action never reaches execute — the compiled enum fences it
    await assert.rejects(() => configT.execute({ action: 'nuke' }, { agent: { id: 'session-tool' } }), /must be one of/)
    await assert.rejects(() => configT.execute({ action: 'add', name: 'x', mode: 'vm', commands: [{ file: 'x.txt', content: 'echo x' }] }, { agent: { id: 'session-tool' } }), /must be one of/)
    const unknown = await runT.execute({ key: 'nope' }, { agent: { id: 'session-tool' } })
    assert.match(unknown.error, /no such automation/)
  } finally { await rmrf(dir) }
})

test('routes: GET /api/automation lists tasks; POST /api/automation/run runs, fences errors, refuses cross-site', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, { sessionId: 'session-r', name: 'r1', commands: [{ file: 'hi.txt', content: 'echo hi' }] })
    const { automations } = await readAutomations(dir)
    const registry = { list: () => [{ id: 'w1', path: dir, title: 'w', sessionIds: ['session-r'] }] }
    const { ctx } = makeSshCtx(okExec)
    ctx.workspaceRegistry = registry
    const handler = await registerRoutes(ctx)
    const got = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation?sessionId=session-r')
    assert.equal(got.code, 200)
    assert.equal(got.body.automations.length, 1)
    assert.equal(got.body.machine_id, 'node1')
    const run = await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/run',
      { sessionId: 'session-r', key: automations[0].key })
    assert.equal(run.code, 200)
    assert.equal(run.body.status, 'done')
    assert.equal(run.body.results[0].file, 'hi.txt')
    const unknown = await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/run',
      { sessionId: 'session-r', key: 'nope' })
    assert.equal(unknown.code, 404)
    const noKey = await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/run',
      { sessionId: 'session-r' })
    assert.equal(noKey.code, 400)
    // the run route executes remote commands — a cross-site POST is refused
    const cross = await callRoute(handler, {
      method: 'POST', url: 'http://127.0.0.1/harnessams/api/automation/run',
      headers: { 'sec-fetch-site': 'cross-site' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
    })
    assert.equal(cross.code, 403)
    const badSession = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation?sessionId=ghost')
    assert.equal(badSession.code, 404)
  } finally { await rmrf(dir) }
})

test('local_exec: one command through the host shell seam with the project as cwd', async () => {
  const dir = await makeProject()
  try {
    const { ctx, specs } = makeShellCtx({ stdout: { text: 'hi' }, stderr: { text: '' }, exitCode: 0 })
    const t = localExecTool(ctx)
    const r = await t.execute({ command: 'echo hi', project: dir }, { callId: 'hams-sim-test-1' })
    assert.equal(r.ok, true)
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'hi')
    assert.match(r.text, /exit 0/, 'the value text carries the line payload for run results')
    assert.match(r.text, /hi/)
    assert.equal(specs.length, 1)
    assert.equal(specs[0].workdir, dir, 'the project path is the working directory')
    assert.equal(specs[0].timeoutMs, 60_000, 'the default deadline')
    assert.equal(specs[0].onExpiry, 'kill')
    // a custom budget rides the spec
    await t.execute({ command: 'echo x', project: dir, timeout_sec: 5 }, { callId: 'hams-sim-test-2' })
    assert.equal(specs[1].timeoutMs, 5_000)
    // an out-of-range budget is refused before the shell
    const bad = await t.execute({ command: 'echo x', project: dir, timeout_sec: 0 }, { callId: 'hams-sim-test-3' })
    assert.match(bad.error, /timeout_sec must be an integer 1\.\.110/)
    assert.equal(specs.length, 2)
  } finally { await rmrf(dir) }
})

test('local_exec: exit codes, deadlines and a pre-aborted signal map onto the value', async () => {
  const dir = await makeProject()
  try {
    const { ctx } = makeShellCtx({ stdout: { text: '' }, stderr: { text: 'boom' }, exitCode: 3 })
    const t = localExecTool(ctx)
    const fail = await t.execute({ command: 'exit3cmd', project: dir }, { callId: 'hams-sim-t' })
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.equal(fail.stderr, 'boom')
    assert.equal(fail.error, undefined, 'a nonzero exit is a value, not an infra error')
    const { ctx: ctx2, specs: specs2 } = makeShellCtx({ stdout: { text: '' }, stderr: { text: '' }, exitCode: null, timedOut: true })
    const t2 = localExecTool(ctx2)
    const timed = await t2.execute({ command: 'hang', project: dir }, { callId: 'hams-sim-t' })
    assert.equal(timed.ok, false)
    assert.equal(timed.timedOut, true)
    // a pre-aborted signal never reaches the shell
    const aborted = await t2.execute({ command: 'echo x', project: dir }, { callId: 'hams-sim-t', signal: AbortSignal.abort() })
    assert.equal(aborted.ok, false)
    assert.equal(aborted.aborted, true)
    assert.equal(specs2.length, 1, 'only the real command reached the shell')
  } finally { await rmrf(dir) }
})

test('local_exec: a direct model call, a raw ssh command and a PDK command are refused before the shell', async () => {
  const dir = await makeProject()
  try {
    const { ctx, specs } = makeShellCtx({ stdout: { text: 'x' }, stderr: { text: '' }, exitCode: 0 })
    const t = localExecTool(ctx)
    // a model's direct call carries the pipeline's own callId and an agent
    const direct = await t.execute({ command: 'echo x', project: dir }, { callId: 'toolu-01', agent: { id: 'session-1' } })
    assert.equal(direct.ok, false)
    assert.match(direct.error, /automation-internal/)
    // the red lines (the body re-check mirrors the pre-execute gate)
    const ssh = await t.execute({ command: 'ssh op@node6 hostname', project: dir }, { callId: 'hams-sim-t' })
    assert.equal(ssh.ok, false)
    assert.match(ssh.error, /raw shell ssh is denied/)
    const pdk = await t.execute({ command: 'type D:/pdk/sky130A/lib.lib', project: dir }, { callId: 'hams-sim-t' })
    assert.equal(pdk.ok, false)
    assert.match(pdk.error, /PDK paths are denied/)
    // the automation channel injects the project; a missing one is refused
    const noProject = await t.execute({ command: 'echo x' }, { callId: 'hams-sim-t' })
    assert.match(noProject.error, /project is required/)
    // a degraded embed (no callId, no agent) passes the caller gate
    const embed = await t.execute({ command: 'echo x', project: dir }, {})
    assert.equal(embed.ok, true)
    assert.equal(specs.length, 1, 'only the degraded-embed call reaches the shell')
  } finally { await rmrf(dir) }
})

test('local_exec: stdout and stderr are capped at the output limit', async () => {
  const dir = await makeProject()
  try {
    const { ctx } = makeShellCtx({ stdout: { text: 'x'.repeat(30_000) }, stderr: { text: '' }, exitCode: 0 })
    const t = localExecTool(ctx)
    const r = await t.execute({ command: 'bigout', project: dir }, { callId: 'hams-sim-t' })
    assert.ok(r.stdout.length > 20_000 && r.stdout.length < 30_000, 'capped near the limit')
    assert.match(r.stdout, /truncated /, 'the truncation marker')
  } finally { await rmrf(dir) }
})

test('runner: the run status lives in process memory — running marker, finished payload, delete clears', async () => {
  const dir = await makeProject({ machineId: null })
  try {
    await addAutomation(dir, { sessionId: 's-mem', name: 'mem', mode: 'local', commands: [{ file: 'm.txt', content: 'safe_trash {"action":"empty"}' }] })
    const { automations } = await readAutomations(dir)
    const key = automations[0].key
    assert.equal(readRunMemory(dir, key), null, 'no run yet')
    // mid-run: the handler executes while the run is in flight, so the memory
    // entry is the running marker at that moment
    let seenMidRun = null
    const { ctx } = makeToolCtx({
      safe_trash: () => { seenMidRun = readRunMemory(dir, key); return { value: { ok: true, output: 'ok' } } },
    })
    const r = await runAutomation(ctx, { project: { path: dir }, key })
    assert.equal(seenMidRun?.status, 'running')
    assert.equal(seenMidRun.mode, 'local')
    assert.equal(seenMidRun.started_at, r.started_at)
    // the finished entry carries the whole payload; the light reader is the
    // list route's projection
    const after = readRunMemory(dir, key)
    assert.equal(after.status, 'done')
    assert.equal(after.finished_at, r.finished_at)
    assert.equal(after.result, r)
    assert.deepEqual(readRunStatus(dir, key), { status: 'done', started_at: r.started_at, finished_at: r.finished_at })
    assert.equal(readRunStatus(dir, 'nope'), null)
    // deleting the task clears its memory entry with it
    await deleteAutomation(dir, { key })
    assert.equal(readRunMemory(dir, key), null)
  } finally { await rmrf(dir) }
  // a refused run (remote task without machine_id) writes no memory entry
  const noMachine = await makeProject({ machineId: null })
  try {
    await addAutomation(noMachine, { sessionId: 's', name: 'x', commands: [{ file: 'a.txt', content: 'echo a' }] })
    const { automations } = await readAutomations(noMachine)
    const { ctx } = makeSshCtx(okExec)
    const r = await runAutomation(ctx, { project: { path: noMachine }, key: automations[0].key })
    assert.equal(r.code, 400)
    assert.equal(readRunMemory(noMachine, automations[0].key), null)
  } finally { await rmrf(noMachine) }
})

test('routes: the list carries last_run and /api/automation/result serves the full record', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, { sessionId: 'session-st', name: 'st1', commands: [{ file: 'hi.txt', content: 'echo hi' }] })
    const { automations } = await readAutomations(dir)
    const key = automations[0].key
    const registry = { list: () => [{ id: 'w1', path: dir, title: 'w', sessionIds: ['session-st'] }] }
    const { ctx } = makeSshCtx(okExec)
    ctx.workspaceRegistry = registry
    const handler = await registerRoutes(ctx)
    const before = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation?sessionId=session-st')
    assert.equal(before.body.automations[0].last_run, undefined, 'no run yet -> no last_run field')
    await callPost(handler, 'http://127.0.0.1/harnessams/api/automation/run', { sessionId: 'session-st', key })
    const after = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation?sessionId=session-st')
    const lr = after.body.automations[0].last_run
    assert.equal(lr.status, 'done')
    assert.ok(lr.finished_at)
    assert.equal(lr.results, undefined, 'the light projection carries no result payload')
    const detail = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation/result?sessionId=session-st&key=' + key)
    assert.equal(detail.code, 200)
    assert.equal(detail.body.status, 'done')
    assert.equal(detail.body.result.status, 'done')
    assert.deepEqual(detail.body.result.results.map((x) => x.file), ['hi.txt'])
    const unknown = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation/result?sessionId=session-st&key=nope')
    assert.equal(unknown.code, 404)
    const noKey = await callGet(handler, 'http://127.0.0.1/harnessams/api/automation/result?sessionId=session-st')
    assert.equal(noKey.code, 400)
  } finally { await rmrf(dir) }
})

test('runner: a tool value that says failed (ok:false or success:false) fails its line', async () => {
  const dir = await makeProject()
  try {
    await addAutomation(dir, {
      sessionId: 's-val', name: 'valfail', mode: 'local',
      commands: [{ file: 'v.txt', content: 'safe_trash {"action":"empty"}\nssh_exec {"alias":"node1","command":"x"}' }],
    })
    const { automations } = await readAutomations(dir)
    const { ctx } = makeToolCtx({
      safe_trash: () => ({ value: { ok: false, error: 'boom' } }),
      ssh_exec: () => ({ value: { success: false, exitCode: 1, stderr: 'bad' } }),
    })
    const r = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(r.status, 'failed')
    assert.equal(r.results[0].ok, false, 'an ok:false value fails its line')
    assert.equal(r.results[1].ok, false, 'a success:false value fails its line')
  } finally { await rmrf(dir) }
})

test('runner: local_exec lines ride the local channel with the project injected', async () => {
  const dir = await makeProject({ machineId: null })
  try {
    await addAutomation(dir, {
      sessionId: 's-lex', name: 'host cmd', mode: 'local',
      commands: [{ file: 'lex.txt', content: 'local_exec {"command":"node -e \\"console.log(1)\\""}' }],
    })
    const { automations } = await readAutomations(dir)
    const { ctx, calls } = makeToolCtx({
      local_exec: () => ({ value: { ok: true, exitCode: 0, stdout: '1', text: 'exit 0 · 2 ms\n1' } }),
    })
    const r = await runAutomation(ctx, { project: { path: dir }, key: automations[0].key })
    assert.equal(r.status, 'done')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'local_exec')
    assert.equal(calls[0].args.command, 'node -e "console.log(1)"')
    assert.equal(calls[0].args.project, dir, 'the runner injects the project into local_exec')
    assert.equal(r.results[0].tool, 'local_exec')
    assert.equal(r.results[0].ok, true)
    assert.match(r.results[0].text, /exit 0/, 'the value text becomes the line payload')
  } finally { await rmrf(dir) }
})
