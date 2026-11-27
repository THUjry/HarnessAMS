// Automation store + runner contracts: the shared .txt command library under
// .harnessams/automation/, the automation.json task list (lenient read /
// strict write), the key format, and the stateless sequential runner over the
// dsh-ssh exec funnel — plus the config_automation / run_automation tool
// faces and their two routes. The ssh tool shell is a mock speaking the
// dsh-tools batch contract; the route driver is the shared helpers one.
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
  writeCommandFile, runAutomation, makeAutomationKey, automationPath, commandDirPath,
} from '../src/core/automation.js'

const rmrf = (dir) => fsp.rm(dir, { recursive: true, force: true })

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

test('tools: run_automation takes only the key; config_automation is the action runner', async () => {
  const [configDef, runDef] = automationTools({})
  const configTool = makeTool(configDef)
  const runTool = makeTool(runDef)
  assert.deepEqual(Object.keys(runTool.parameters.properties), ['key'], 'the index key is the only field')
  assert.deepEqual(runTool.parameters.required, ['key'])
  assert.deepEqual(configTool.parameters.properties.action.enum, ['add', 'update', 'delete'])
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
