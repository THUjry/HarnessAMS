// AGENTS.md project-config block (server/agentsmd.js + the .harnessams
// writers), 2026-11-24 shape: the .harnessams creation moment lays down the
// core-constraints bullets + an EMPTY yaml table (no prose, no instruction
// any more); the values sync (the harnessams_selfcheck tool's save_agentsmd
// action — the buttons and the self-check finalize both land there) rewrites
// the marked block with measured yaml facts PLUS the recommended-workflow
// table (values builds only). Machine aliases never render — the remote side
// is paths only. Route level via the apply()-registered handler; the client
// half is pinned against the source. Run: bare `node --test` from the repo root.
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
const ASK_FIRST = 'When design constraints are unclear, ask the user'
const TOOLS_FIRST = 'Execute through the SAS/HA plugin tools'
const NO_STORE_READ = 'do not read it during normal work'
const WORKFLOW_TABLE = '### Recommended workflow'

test('agentsmd: a fresh workspace gets constraints + the empty yaml table, no workflow table, idempotent', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-'))
  try {
    assert.deepEqual(await ensureAgentsMdTemplate(ws), { ok: true, created: true })
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.startsWith(BEGIN), 'the block sits at the head of the file')
    assert.ok(md1.includes(END))
    assert.ok(md1.includes('## Project Config (HarnessAMS)'))
    assert.ok(md1.includes(ASK_FIRST), 'ask-first constraint present')
    assert.ok(md1.includes(TOOLS_FIRST), 'tools-first constraint present')
    assert.ok(md1.includes(NO_STORE_READ), '.harnessams do-not-read constraint present')
    assert.ok(md1.includes('hams_project_config:'))
    // flat single-level fields, nulls for the not-yet-measured facts
    assert.ok(md1.includes('  last_selfcheck_run_id: null'))
    assert.ok(md1.includes('  last_selfcheck_overall: null'))
    assert.ok(md1.includes('  run_mode: null'), 'unmeasured fields are the YAML null literal in the template')
    assert.ok(!md1.includes(WORKFLOW_TABLE), 'the first-fill template (no settings yet) renders no workflow table')
    assert.ok(!md1.includes('Project state lives in'), 'the old pointer prose is gone')
    assert.ok(!md1.includes('Before starting any task'), 'the old first-fill instruction is gone')

    // a later call never rewrites — an agent-filled table survives
    await writeFile(agentsMdPath(ws), md1.replace('  run_mode: null', '  run_mode: "agent-filled"'), 'utf8')
    assert.deepEqual(await ensureAgentsMdTemplate(ws), { ok: true, created: false })
    assert.ok((await readFile(agentsMdPath(ws), 'utf8')).includes('"agent-filled"'))
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: values sync fills measured yaml facts, adds the workflow table, keeps outside content', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-sync-'))
  try {
    await ensureAgentsMdTemplate(ws)
    // content below the block must survive the in-place replace
    await writeFile(agentsMdPath(ws), (await readFile(agentsMdPath(ws), 'utf8')) + '\n# Project notes\n\nkeep me\n', 'utf8')

    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    // no dsh-ssh in ctx at all anymore: the sync never touches the tool shell
    const r = await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings })
    assert.equal(r.ok, true)
    assert.equal(r.created, false) // block already existed → in-place replace
    const md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('# Project notes'), 'content below the block survives')
    assert.ok(md.indexOf(BEGIN) < md.indexOf('# Project notes'), 'block stays at the head')
    assert.ok(md.includes(`  workspace_root: ${JSON.stringify(ws)}`), 'workspace root, JSON-escaped for yaml')
    assert.ok(md.includes(`  node_version: "${process.version}"`), 'node version as a flat field')
    assert.ok(md.includes(`  node_path: ${JSON.stringify(process.execPath)}`), 'node absolute path as a flat field')
    assert.ok(md.includes('  cluster_env: "out-of-cluster"'), 'the working environment mirrors the config')
    assert.ok(md.includes('  run_mode: "remote"'))
    assert.ok(md.includes('  remote_root: "/home/op/sim"'), 'remote_root mirrors the project config')
    assert.ok(md.includes('  remote_scripts_dir: "/home/op/sim/.harnessams/scripts"'), 'the remote scripts path rides along')
    assert.ok(md.includes('  report_figs: false'), 'the PNG-export gate mirrors the config (untyped default)')
    assert.ok(md.includes('  remote_python: null'), 'no interpreter pin yet → the YAML null literal')
    assert.ok(md.includes('  remote_spectre_cmd: null'), 'no spectre pin yet → the YAML null literal')
    assert.ok(md.includes('  last_selfcheck_run_id: null'), 'no done run yet → null')
    // 2026-11-24: aliases never render — the machine rows are gone entirely
    assert.ok(!md.includes('remote_node:'), 'the alias row is gone')
    assert.ok(!md.includes('other_nodes:'), 'the alias-list row is gone')
    assert.ok(!md.includes('This is an out-of-cluster project'), 'the env prose statement is gone (yaml carries it)')
    // the workflow table rides the values build
    assert.ok(md.includes(WORKFLOW_TABLE), 'the values sync renders the workflow table')
    assert.ok(md.includes('| Submit | batch_submit |'))
    assert.ok(md.includes('"local" is unavailable out-of-cluster'), 'the scheduler cell forks on cluster_env')
    assert.equal(md.split(BEGIN).length - 1, 1, 'exactly one block after the sync')
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: the toolchain pins mirror as yaml rows a session reads for remote parsers (D-016)', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-pins-'))
  try {
    await ensureAgentsMdTemplate(ws)
    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
      remote_python: '/opt/tools/python3/bin/python3', remote_spectre_cmd: '/opt/tools/spectre/bin/spectre' }
    const r = await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings })
    assert.equal(r.ok, true)
    const md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('  remote_python: "/opt/tools/python3/bin/python3"'), 'the interpreter pin as a plain path row')
    assert.ok(md.includes('  remote_spectre_cmd: "/opt/tools/spectre/bin/spectre"'), 'the spectre pin as a plain path row')
    // right after the compute selectors, before the remote paths — the row
    // order is part of the block's contract
    assert.ok(md.indexOf('  compute_remote: "python"') < md.indexOf('  remote_python: ')
      && md.indexOf('  remote_python: ') < md.indexOf('  remote_spectre_cmd: ')
      && md.indexOf('  remote_spectre_cmd: ') < md.indexOf('  remote_root: '), 'row order: compute_remote, pins, remote paths')
    assert.ok(md.includes('the interpreter named by the remote_python row'), 'the workflow table points at the row')
    // an untyped settings object (no pin keys at all) still renders the rows as null
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: { ...settings, remote_python: undefined, remote_spectre_cmd: undefined } })
    const md2 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md2.includes('  remote_python: null') && md2.includes('  remote_spectre_cmd: null'))
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: re-syncing under different settings switches the table wording without residue', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-workflow-'))
  try {
    await ensureAgentsMdTemplate(ws)
    const remoteLsf = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    const localSpectre = { cluster_env: 'in-cluster', run_mode: 'local', machine_id: null, remote_root: null, remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: remoteLsf })
    let md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('"local" is unavailable out-of-cluster'))
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: localSpectre })
    md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(!md.includes('unavailable out-of-cluster'), 'cell switched to the in-cluster wording')
    assert.ok(md.includes('bsub on this host'), 'in-cluster scheduler semantics')
    assert.ok(md.includes('| Analyze | python (direct) |'), 'analyze switched to direct python')
    assert.ok(!md.includes('| Analyze | ssh_exec'), 'old analyze wording fully replaced')
    assert.equal(md.split(BEGIN).length - 1, 1, 'exactly one block')
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: machine aliases never render even with a dsh-ssh registry in ctx', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-nodes-'))
  try {
    await ensureAgentsMdTemplate(ws)
    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    const ctx = {
      tools: {
        get: (name) => (name === 'ssh_list' ? { name } : undefined),
        execute: async (input) => {
          const call = input.calls[0]
          if (call.name !== 'ssh_list') throw new Error('unexpected tool ' + call.name)
          return { results: [{ callId: call.id, result: { isError: false, value: { hosts: [
            { alias: 'node1', host: '192.0.2.11' }, { alias: 'lab9', host: '192.0.2.99' }, { alias: 'node2', host: '192.0.2.12' },
          ] } } }] }
        },
      },
    }
    const r = await syncAgentsMd(ctx, { project: { path: ws, title: 'demo' }, settings })
    assert.equal(r.ok, true)
    const md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(!md.includes('remote_node:'), 'no alias row')
    assert.ok(!md.includes('other_nodes:'), 'no alias-list row')
    assert.ok(!md.includes('lab9') && !md.includes('node2') && !md.includes('192.0.2'), 'no alias names or hosts leak into the block')
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
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.includes(ASK_FIRST), 'template carries the core constraints')
    assert.ok(!md1.includes(WORKFLOW_TABLE), 'template carries no workflow table')
    // a second settings write stays idempotent (block present → untouched)
    await writeSettings(ws, {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    assert.ok(!(await readFile(agentsMdPath(ws), 'utf8')).includes(WORKFLOW_TABLE), 'later writes never rewrite the block')

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
      assert.ok((await readFile(agentsMdPath(ws2), 'utf8')).includes(ASK_FIRST), 'session-config creation lays the template')
    } finally {
      await rm(ws2, { recursive: true, force: true })
    }

    // POST /api/tool {action:save_agentsmd} → values rewrite with the
    // workflow table; pending settings ride along (the table's confirm button)
    const r = await callPost(handler, base + '/tool', {
      sessionId: 's1', action: 'save_agentsmd',
      settings: { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
        scheduler: 'ssh', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' },
    })
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    assert.equal(r.body.created, false)
    assert.equal(r.body.path, path.join(ws, 'AGENTS.md'))
    const md2 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md2.includes(WORKFLOW_TABLE), 'save_agentsmd renders the workflow table')
    assert.ok(md2.includes('  run_mode: "remote"'), 'settings snapshot comes from workspace_config.json')
    assert.ok(md2.includes('  scheduler: "ssh"'), 'the riding settings landed before the sync')

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
    'pset.envTitle', 'pset.envIn', 'pset.envOut', 'pset.envHint',
    'envc.title', 'envc.bodyIn', 'envc.bodyOut', 'envc.ok',
    'chk.btn.local', 'chk.truncated',
  ])
  // the cluster toolchain pins are NOT a settings-table row (by ruling)
  for (const gone of ['pset.colRemotePython', 'pset.colRemoteSpectre', 'pset.pinPlaceholder', 'pset.pinHint', "kind: 'text'"]) {
    assert.ok(!src.includes(gone), `the settings table lost "${gone}"`)
  }
})
