// AGENTS.md project-config table (server/agentsmd.js + the three .harnessams
// writers): the .harnessams creation moment lays down an EMPTY table with the
// first-fill instruction; the Overview buttons' values sync rewrites the marked
// block WITHOUT the instruction (a stale prompt is removed with it); the block
// is created fresh / prepended at the head / replaced in place. Route level via
// the apply()-registered handler; the client half is pinned against the source.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureAgentsMdTemplate, latestSelfcheckRun, syncAgentsMd, agentsMdPath } from '../src/server/agentsmd.js'
import { registerRoutes, callPost, callPut, batchOf, setRemoteMachines, clientSrc, assertDictKeys } from './helpers.mjs'

const BEGIN = '<!-- hams-config:begin'
const END = '<!-- hams-config:end -->'
const INSTRUCTION = 'Before starting any task in this workspace'

test('agentsmd: a fresh workspace gets the empty table + first-fill instruction, idempotent', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-'))
  try {
    assert.deepEqual(await ensureAgentsMdTemplate(ws), { ok: true, created: true })
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.startsWith(BEGIN), 'the block sits at the head of the file')
    assert.ok(md1.includes(END))
    assert.ok(md1.includes('## Project Config (HarnessAMS)'))
    assert.ok(md1.includes(INSTRUCTION), 'first-fill instruction present')
    assert.ok(md1.includes('hams_project_config:'))
    assert.ok(md1.includes('  machines: []'))
    assert.ok(md1.includes('  last_selfcheck: null'))
    assert.ok(!md1.includes('remote_root'), 'no machine rows in the empty table')

    // a later call never rewrites — an agent-filled table survives
    await writeFile(agentsMdPath(ws), md1.replace('  machines: []', '  machines: [agent-filled]'), 'utf8')
    assert.deepEqual(await ensureAgentsMdTemplate(ws), { ok: true, created: false })
    assert.ok((await readFile(agentsMdPath(ws), 'utf8')).includes('[agent-filled]'))
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: values sync fills measured facts and REMOVES the stale instruction', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-sync-'))
  try {
    await ensureAgentsMdTemplate(ws)
    // content below the block must survive the in-place replace
    await writeFile(agentsMdPath(ws), (await readFile(agentsMdPath(ws), 'utf8')) + '\n# Project notes\n\nkeep me\n', 'utf8')

    const settings = { run_mode: 'remote', machine_id: 'node1', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    const r = await syncAgentsMd({ tools: { get: () => undefined } }, { project: { path: ws, title: 'demo' }, settings })
    assert.equal(r.ok, true)
    assert.equal(r.created, false) // block already existed → in-place replace
    const md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(!md.includes(INSTRUCTION), 'the values rewrite drops the first-fill instruction')
    assert.ok(md.includes('# Project notes'), 'content below the block survives')
    assert.ok(md.indexOf(BEGIN) < md.indexOf('# Project notes'), 'block stays at the head')
    assert.ok(md.includes(`workspace: { root: ${JSON.stringify(ws)} }`), 'workspace root, JSON-escaped for yaml')
    assert.ok(md.includes('  machines: []'), 'no dsh-ssh → empty machine list, not a failed sync')
    assert.ok(md.includes(`    node:    { version: "${process.version}", path: ${JSON.stringify(process.execPath)} }`),
      'node carries version AND absolute path')
    assert.ok(md.includes('    run_mode: "remote"'))
    assert.ok(md.includes('    machine: "node1"'))
    assert.ok(md.includes('  last_selfcheck: null'))

    // a configured machine rides along (ssh_list through the batch contract)
    const restore = setRemoteMachines({ node1: '/home/op/sim' })
    try {
      const ctx = {
        tools: {
          get: (n) => (n === 'ssh_list' ? {} : undefined),
          execute: async (input) => batchOf({ isError: false, value: { hosts: [
            { alias: 'node1', host: '192.0.2.11', port: 22, user: 'test_user', auth: 'key', keyReady: true }] } }),
        },
      }
      await syncAgentsMd(ctx, { project: { path: ws }, settings })
      const md2 = await readFile(agentsMdPath(ws), 'utf8')
      assert.ok(md2.includes('    - { alias: "node1", host: "192.0.2.11", port: 22, user: "test_user", auth: "key", remote_root: "/home/op/sim" }'))
      assert.equal(md2.split(BEGIN).length - 1, 1, 'exactly one block after a second sync')
    } finally { restore() }
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: latestSelfcheckRun picks the newest DONE run of this workspace', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-latest-'))
  try {
    assert.equal(await latestSelfcheckRun(ws), null)
    const mk = async (id, status, summary) => {
      await mkdir(path.join(ws, 'selfcheck', id), { recursive: true })
      await writeFile(path.join(ws, 'selfcheck', id, 'selfcheck_run.json'),
        JSON.stringify({ id, status, startedAt: '2026-11-18T10:00:00.000Z', finishedAt: '2026-11-18T10:01:00.000Z', summary }), 'utf8')
    }
    await mk('rc_20261118100000_aaaa', 'done', { local: true, remote: 'ok', ok: true })
    await mk('rc_20261118120000_bbbb', 'running', {})
    assert.deepEqual(await latestSelfcheckRun(ws), {
      run_id: 'rc_20261118100000_aaaa', finished_at: '2026-11-18T10:01:00.000Z',
      local: 'ok', remote: 'ok', overall: 'ok',
    })
    // a newer DONE run wins even when a still-newer RUNNING one exists
    await mk('rc_20261118113000_cccc', 'done', { local: false, remote: 'ok-via-fallback', ok: false })
    assert.deepEqual(await latestSelfcheckRun(ws), {
      run_id: 'rc_20261118113000_cccc', finished_at: '2026-11-18T10:01:00.000Z',
      local: 'failed', remote: 'ok-via-fallback', overall: 'failed',
    })
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd route+writers: .harnessams creation lays the template; POST /api/agents-md syncs values', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-route-'))
  try {
    const handler = await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w1', path: ws, title: 'harnessams-workspace', sessionIds: ['s1'] }] },
      tools: { register: () => {}, get: () => undefined },
    })
    const base = 'http://127.0.0.1/harnessams/api'

    // PUT tasks = the .harnessams creation moment → AGENTS.md template appears
    const t = await callPut(handler, base + '/tasks?sessionId=s1', { tasks: [{ name: 'demo' }] })
    assert.equal(t.code, 200)
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.includes(INSTRUCTION), 'template with the first-fill instruction')
    assert.ok(md1.includes('  machines: []'))

    // PUT settings / PUT check-params stay idempotent (block present → untouched)
    await callPut(handler, base + '/project-settings?sessionId=s1', {
      run_mode: 'remote', machine_id: 'node1', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    await callPut(handler, base + '/check-params?sessionId=s1', {
      rcl: { r: [0.1, 1e6], c: [1e-15, 1e-6], l: [1e-13, 1e-8] }, unit_check: true, bias_check: true, strict_includes: false,
    })
    assert.ok((await readFile(agentsMdPath(ws), 'utf8')).includes(INSTRUCTION), 'later writes never rewrite the block')

    // POST /api/agents-md → values rewrite without the instruction
    const r = await callPost(handler, base + '/agents-md', { sessionId: 's1' })
    assert.equal(r.code, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.created, false)
    assert.equal(r.body.path, path.join(ws, 'AGENTS.md'))
    const md2 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(!md2.includes(INSTRUCTION))
    assert.ok(md2.includes('    run_mode: "remote"'), 'settings snapshot comes from project_settings.json')

    // a second POST keeps exactly one block
    await callPost(handler, base + '/agents-md', { sessionId: 's1' })
    assert.equal(((await readFile(agentsMdPath(ws), 'utf8')).split(BEGIN).length - 1), 1)

    assert.equal((await callPost(handler, base + '/agents-md', { sessionId: 'stranger' })).code, 404)
    assert.equal((await callPost(handler, base + '/agents-md', {})).code, 400)
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: apply() alone writes nothing — only the .harnessams writers and the save button do', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-apply-'))
  try {
    // an already-initialized workspace (has .harnessams) must NOT gain AGENTS.md
    // just from the plugin starting up
    await mkdir(path.join(ws, '.harnessams'), { recursive: true })
    await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w', path: ws, title: 'P', sessionIds: ['s9'] }] },
      tools: { register: () => {}, get: () => undefined },
    })
    await assert.rejects(() => readFile(agentsMdPath(ws), 'utf8'), /ENOENT/)
  } finally { await rm(ws, { recursive: true, force: true }) }
})

// ---- client static contract (classic script: asserted against the source text) ----

const src = await clientSrc()

test('agentsmd client: button row order and wiring, retired keys gone, new keys bilingual', () => {
  assert.ok(src.includes("API + '/agents-md'"), 'the save buttons post to the agents-md route')
  assert.ok(src.includes("API + '/remote-browse?'"), 'the dir browser fetches the remote-browse route')
  const iSave = src.indexOf("tr('agents.saveBtn')")
  const iRun = src.indexOf("tr('selfchk.run')", iSave)
  const iLocal = src.indexOf("tr('chk.btn.local')", iSave)
  const iAll = src.indexOf("tr('agents.checkAll')", iSave)
  assert.ok(iSave >= 0 && iSave < iRun && iRun < iLocal && iLocal < iAll,
    'button order: save to AGENTS.md | one-click self-check | list local environment | check all & save')
  assert.ok(/setCheckAllPending\(true\); void startRun\(\)/.test(src), 'check-all runs the self-check then auto-saves on landing')
  assertDictKeys(src, [
    'agents.saveBtn', 'agents.saving', 'agents.saved', 'agents.saveFailed', 'agents.checkAll', 'agents.checkAllRunning',
    'pset.browse', 'pset.browseTitle', 'pset.browsePickDir', 'pset.pickDir', 'pset.pickThisDir', 'pset.pickCurrentDir',
    'chk.btn.local', 'chk.truncated',
  ])
  for (const k of ['chk.title', 'chk.remoteArea', 'chk.needRemoteRoot', 'chk.unconfiguredList', 'chk.noneYet', 'chk.rootLegend',
    'chk.btn.load', 'chk.btn.jobs', 'chk.btn.batches', 'chk.btn.scripts',
    'chk.lc.load1', 'chk.jc.jobid', 'chk.bc.dir', 'chk.sc.file', 'chk.sync.in-sync']) {
    assert.ok(!src.includes(`'${k}':`), `dictionary key ${k} must be gone (both languages)`)
  }
  assert.ok(!src.includes('function CheckPanel') && !src.includes('MachineCheckBlock'), 'the health-check panel components must be gone')
  assert.ok(!src.includes('value: dirValue'), 'the free-typed remote-dir input must be gone')
  assert.ok(src.includes('function RemoteDirBrowse') && src.includes('function LocalEnvResults'), 'replacement components present')
})
