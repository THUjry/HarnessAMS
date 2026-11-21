// AGENTS.md project-config block (server/agentsmd.js + the .harnessams
// writers): the .harnessams creation moment lays down an EMPTY flat table with
// the first-fill instruction; the values sync (the harnessams_selfcheck tool's
// save_agentsmd action — the buttons and the self-check finalize both land
// there) rewrites the marked block WITHOUT the instruction (a stale prompt is
// removed with it); the .harnessams pointer paragraph rides BOTH builds; the
// block is created fresh / prepended at the head / replaced in place. Route
// level via the apply()-registered handler; the client half is pinned against
// the source. Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureAgentsMdTemplate, latestSelfcheckRun, syncAgentsMd, agentsMdPath } from '../src/server/agentsmd.js'
import { writeSettings } from '../src/server/settings.js'
import { registerRoutes, callPost, callPut, clientSrc, assertDictKeys } from './helpers.mjs'

const BEGIN = '<!-- hams-config:begin'
const END = '<!-- hams-config:end -->'
const INSTRUCTION = 'Before starting any task in this workspace'
const POINTER = 'Project state lives in `.harnessams/`'

test('agentsmd: a fresh workspace gets the empty flat table + pointer + first-fill instruction, idempotent', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-'))
  try {
    assert.deepEqual(await ensureAgentsMdTemplate(ws), { ok: true, created: true })
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.startsWith(BEGIN), 'the block sits at the head of the file')
    assert.ok(md1.includes(END))
    assert.ok(md1.includes('## Project Config (HarnessAMS)'))
    assert.ok(md1.includes(INSTRUCTION), 'first-fill instruction present')
    assert.ok(md1.includes(POINTER), '.harnessams pointer rides the template too')
    assert.ok(md1.includes('hams_project_config:'))
    // flat single-level fields, nulls for the not-yet-measured facts
    assert.ok(md1.includes('  last_selfcheck_run_id: null'))
    assert.ok(md1.includes('  last_selfcheck_overall: null'))
    assert.ok(md1.includes('  run_mode: null'), 'unmeasured fields are the YAML null literal in the template')
    assert.ok(!md1.includes('machines:'), 'no machines section anymore (registry facts stay out)')
    assert.ok(!md1.includes('Self-check workflow'), 'the first-fill template (no settings yet) renders no workflow section')

    // a later call never rewrites — an agent-filled table survives
    await writeFile(agentsMdPath(ws), md1.replace('  run_mode: null', '  run_mode: "agent-filled"'), 'utf8')
    assert.deepEqual(await ensureAgentsMdTemplate(ws), { ok: true, created: false })
    assert.ok((await readFile(agentsMdPath(ws), 'utf8')).includes('"agent-filled"'))
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: values sync fills measured flat facts, keeps the pointer, REMOVES the stale instruction', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-sync-'))
  try {
    await ensureAgentsMdTemplate(ws)
    // content below the block must survive the in-place replace
    await writeFile(agentsMdPath(ws), (await readFile(agentsMdPath(ws), 'utf8')) + '\n# Project notes\n\nkeep me\n', 'utf8')

    const settings = { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    // no dsh-ssh in ctx at all anymore: the machines section is gone, the sync
    // never touches the tool shell
    const r = await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings })
    assert.equal(r.ok, true)
    assert.equal(r.created, false) // block already existed → in-place replace
    const md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(!md.includes(INSTRUCTION), 'the values rewrite drops the first-fill instruction')
    assert.ok(md.includes(POINTER), 'the pointer survives the values rewrite')
    assert.ok(md.includes('# Project notes'), 'content below the block survives')
    assert.ok(md.indexOf(BEGIN) < md.indexOf('# Project notes'), 'block stays at the head')
    assert.ok(md.includes(`  workspace_root: ${JSON.stringify(ws)}`), 'workspace root, JSON-escaped for yaml')
    assert.ok(md.includes(`  node_version: "${process.version}"`), 'node version as a flat field')
    assert.ok(md.includes(`  node_path: ${JSON.stringify(process.execPath)}`), 'node absolute path as a flat field')
    assert.ok(md.includes('  run_mode: "remote"'))
    assert.ok(md.includes('  machine: "node1"'))
    assert.ok(md.includes('  remote_root: "/home/op/sim"'), 'remote_root mirrors the project config')
    assert.ok(md.includes('  last_selfcheck_run_id: null'), 'no done run yet → null')
    assert.ok(!md.includes('machines:'), 'machines section retired')
    assert.ok(md.includes('### Self-check workflow (remote / LSF / spectre)'), 'the values sync renders the settings-matched workflow branch')
    assert.ok(md.includes('ok-via-fallback'), 'the LSF branch carries the fallback rule')
    assert.equal(md.split(BEGIN).length - 1, 1, 'exactly one block after the sync')
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: re-syncing under different settings switches the workflow branch without residue', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-workflow-'))
  try {
    await ensureAgentsMdTemplate(ws)
    const remoteLsf = { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    const localSpectre = { run_mode: 'local', machine_id: null, remote_root: null, remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: remoteLsf })
    let md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('### Self-check workflow (remote / LSF / spectre)'))
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: localSpectre })
    md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('### Self-check workflow (local / spectre)'), 'branch switched to the saved settings')
    assert.ok(!md.includes('LSF'), 'old branch fully replaced (uppercase LSF only lives in the workflow text)')
    assert.equal(md.split(BEGIN).length - 1, 1, 'exactly one block')
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: latestSelfcheckRun picks the newest DONE run under .harnessams/selfcheck', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-latest-'))
  try {
    assert.equal(await latestSelfcheckRun(ws), null)
    const mk = async (id, status, summary) => {
      await mkdir(path.join(ws, '.harnessams', 'selfcheck', id), { recursive: true })
      await writeFile(path.join(ws, '.harnessams', 'selfcheck', id, 'selfcheck_run.json'),
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

test('agentsmd route+writers: .harnessams creation lays the template; /api/tool save_agentsmd syncs values', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-route-'))
  try {
    const handler = await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w1', path: ws, title: 'harnessams-workspace', sessionIds: ['s1'] }] },
      tools: { register: () => {}, get: () => undefined },
    })
    const base = 'http://127.0.0.1/harnessams/api'

    // writeSettings (behind the tool's settings argument) = one of the two
    // .harnessams creation moments → the AGENTS.md template appears
    await writeSettings(ws, {
      run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.includes(INSTRUCTION), 'template with the first-fill instruction')
    // a second settings write stays idempotent (block present → untouched)
    await writeSettings(ws, {
      run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    assert.ok((await readFile(agentsMdPath(ws), 'utf8')).includes(INSTRUCTION), 'later writes never rewrite the block')

    // the SESSION-CONFIG writer also lays the template when IT creates
    // .harnessams first (the common case now: a session opening its sidebar)
    const ws2 = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-sess-'))
    try {
      const handler2 = await registerRoutes({
        workspaceRegistry: { list: () => [{ id: 'w2', path: ws2, title: 'P2', sessionIds: ['s2'] }] },
        tools: { register: () => {}, get: () => undefined },
      })
      const c = await callPut(handler2, base + '/session-config?sessionId=s2', {
        sessionId: 's2', state: { display: 'overview', reports: [], dashboard_selected: null },
      })
      assert.equal(c.code, 200)
      assert.ok((await readFile(agentsMdPath(ws2), 'utf8')).includes(INSTRUCTION), 'session-config creation lays the template')
    } finally {
      await rm(ws2, { recursive: true, force: true })
    }

    // POST /api/tool {action:save_agentsmd} → values rewrite without the
    // instruction; pending settings ride along (the table's confirm button)
    const r = await callPost(handler, base + '/tool', {
      sessionId: 's1', action: 'save_agentsmd',
      settings: { run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
        scheduler: 'direct', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' },
    })
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    assert.equal(r.body.created, false)
    assert.equal(r.body.path, path.join(ws, 'AGENTS.md'))
    const md2 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(!md2.includes(INSTRUCTION))
    assert.ok(md2.includes('  run_mode: "remote"'), 'settings snapshot comes from workspace_config.json')
    assert.ok(md2.includes('  scheduler: "direct"'), 'the riding settings landed before the sync')
    assert.ok(md2.includes('### Self-check workflow (remote / direct / spectre)'), 'save_agentsmd renders the workflow for the riding settings')

    // a second POST keeps exactly one block
    await callPost(handler, base + '/tool', { sessionId: 's1', action: 'save_agentsmd' })
    assert.equal(((await readFile(agentsMdPath(ws), 'utf8')).split(BEGIN).length - 1), 1)

    assert.equal((await callPost(handler, base + '/tool', { sessionId: 'stranger', action: 'save_agentsmd' })).code, 404)
    assert.equal((await callPost(handler, base + '/tool', {})).code, 400)
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

test('agentsmd client: button row order and wiring, new keys bilingual', () => {
  assert.ok(src.includes("API + '/tool'"), 'the buttons ride the single tool funnel')
  assert.ok(src.includes("API + '/remote-browse?'"), 'the dir browser fetches the remote-browse route')
  const iSave = src.indexOf("tr('agents.saveBtn')")
  const iRun = src.indexOf("tr('selfchk.run')", iSave)
  const iLocal = src.indexOf("tr('chk.btn.local')", iSave)
  const iAll = src.indexOf("tr('agents.checkAll')", iSave)
  assert.ok(iSave >= 0 && iSave < iRun && iRun < iLocal && iLocal < iAll,
    'button order: save to AGENTS.md | one-click self-check | list local environment | check all & save')
  assert.ok(/setCheckAllPending\(true\); void startRun\(\)/.test(src), 'check-all runs the self-check then auto-saves on landing')
  assert.ok(src.includes('function RemoteDirBrowse') && src.includes('function LocalEnvResults'), 'the new components exist')
  // confirm row: the staged table commits through the same funnel
  assert.ok(src.includes("tr('pset.confirmBtn')"), 'confirm button present')
  assert.ok(src.includes("tr('pset.unsaved')"), 'red unsaved marker present')
  assertDictKeys(src, [
    'agents.saveBtn', 'agents.saving', 'agents.saved', 'agents.saveFailed', 'agents.checkAll', 'agents.checkAllRunning',
    'pset.browse', 'pset.browseTitle', 'pset.browsePickDir', 'pset.pickDir', 'pset.pickThisDir', 'pset.pickCurrentDir',
    'pset.colName', 'pset.colValue', 'pset.confirmBtn', 'pset.unsaved', 'pset.stagedHint',
    'chk.btn.local', 'chk.truncated',
  ])
})
