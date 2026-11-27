// AGENTS.md project-config block (core/agentsmd.js + the .harnessams
// writers): the .harnessams creation moment lays down the
// core-constraints bullets + an EMPTY yaml table (no prose, no instruction);
// the values sync (the harnessams_selfcheck tool's save_agentsmd
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
import { ensureAgentsMdTemplate, latestSelfcheckRun, parseFacts, syncAgentsMd, agentsMdPath } from '../src/core/agentsmd.js'
import { writeSettings } from '../src/core/settings.js'
import { registerRoutes, callPost, callPut, clientSrc, assertDictKeys } from './helpers.mjs'

// isolate the plugin-global store — the save_agentsmd action heals pins
// from it, so tests must never read the real ~/.dsh/harnessams.json
process.env.HARNESSAMS_GLOBAL_STORE = path.join(tmpdir(), 'hams-globalstore-agentsmd-' + process.pid + '.json')

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

    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    // the sync never touches the tool shell (no dsh-ssh consumption)
    const r = await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings })
    assert.equal(r.ok, true)
    assert.equal(r.created, false) // block already existed → in-place replace
    const md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('# Project notes'), 'content below the block survives')
    assert.ok(md.indexOf(BEGIN) < md.indexOf('# Project notes'), 'block stays at the head')
    assert.ok(md.includes(`  workspace_root: ${JSON.stringify(ws)}`), 'workspace root, JSON-escaped for yaml')
    assert.ok(md.includes(`  local_node_version: "${process.version}"`), 'node version as a flat local_ field')
    assert.ok(md.includes(`  local_node_path: ${JSON.stringify(process.execPath)}`), 'node absolute path as a flat local_ field')
    assert.ok(md.includes('  local_python_version: ') && md.includes('  local_python_path: '),
      'the local python facts carry the local_ prefix too')
    assert.ok(md.includes('  selfcheck_remote_dir: ".harnessams/selfcheck"'), 'the self-check dir row')
    assert.ok(md.indexOf('  local_python_path: ') < md.indexOf('  selfcheck_remote_dir: ')
      && md.indexOf('  selfcheck_remote_dir: ') < md.indexOf('  last_selfcheck_run_id: '),
      'row order: local env facts, then the selfcheck group at the tail')
    assert.ok(md.includes('  cluster_env: "out-of-cluster"'), 'the working environment mirrors the config')
    assert.ok(md.includes('  run_mode: "remote"'))
    // the CONFIGURED machine renders as one row — the model
    // sees which ssh alias the project's batches and remote-first analysis use
    assert.ok(md.includes('  machine_id: "node1"'), 'the configured machine_id renders as a settings row')
    assert.ok(md.indexOf('  compute_remote: "python"') < md.indexOf('  machine_id: ')
      && md.indexOf('  machine_id: ') < md.indexOf('  remote_python: '), 'row order: machine_id opens the remote group')
    assert.ok(md.includes('  remote_root: "/home/op/sim"'), 'remote_root mirrors the project config')
    assert.ok(md.includes('  remote_scripts_dir: "/home/op/sim/.harnessams/scripts"'), 'the remote scripts path rides along')
    assert.ok(md.includes('  remote_python: null'), 'no interpreter pin yet → the YAML null literal')
    assert.ok(md.includes('  remote_spectre_cmd: null'), 'no spectre pin yet → the YAML null literal')
    assert.ok(md.includes('  last_selfcheck_run_id: null'), 'no done run yet → null')
    // the workflow table rides the values build: purpose rows —
    // parameter semantics live in the tool descriptions
    assert.ok(md.includes(WORKFLOW_TABLE), 'the values sync renders the workflow table')
    assert.ok(md.includes('| Submit | batch_submit |'))
    assert.ok(md.includes('omit machine_id / remote_root / remote_python'),
      'the submit row states what resolves from the config, not parameter semantics')
    // the two numpy tri-state rows: null until a green run measures
    assert.ok(md.includes('  remote_python_numpy: null'), 'the remote numpy tri-state row renders null (unmeasured)')
    assert.ok(md.includes('  local_python_numpy: null'), 'the local numpy tri-state row renders null (unmeasured)')
    assert.equal(md.split(BEGIN).length - 1, 1, 'exactly one block after the sync')
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: the toolchain pins mirror as yaml rows a session reads for remote parsers', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-pins-'))
  try {
    await ensureAgentsMdTemplate(ws)
    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
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
    // no pointer clauses in the workflow table (the tool
    // descriptions are already in the model context) — the analyze row states
    // the action only, with no recipe pointer
    assert.ok(md.includes('write compact JSON into <design>/SimResults/'), 'the analyze row states the action')
    assert.ok(!md.includes('the interpreter per the remote_python row'), 'the recipe pointer is dropped')
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
    const remoteLsf = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    const localSpectre = { cluster_env: 'in-cluster', run_mode: 'local', machine_id: null, remote_root: null, selfcheck_remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python' }
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: remoteLsf })
    let md = await readFile(agentsMdPath(ws), 'utf8')
    // the scheduler matrix lives in the batch_submit description —
    // the only cluster_env fork in the block is the Analyze tool cell
    assert.ok(md.includes('| Analyze | ssh_exec + ssh_download |'), 'out-of-cluster analyze over ssh')
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings: localSpectre })
    md = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md.includes('| Analyze | python (direct) |'), 'analyze switched to direct python')
    assert.ok(!md.includes('| Analyze | ssh_exec'), 'old analyze wording fully replaced')
    // local mode: the non-applicable remote rows are OMITTED, not null — a
    // values build never leaves an unfilled row behind
    assert.ok(!md.includes('  machine_id:'), 'machine_id omitted in local mode (render only when set)')
    assert.ok(!md.includes('  remote_root:'), 'remote_root omitted in local mode')
    assert.ok(!md.includes('  remote_scripts_dir:'), 'remote_scripts_dir omitted in local mode')
    assert.equal(md.split(BEGIN).length - 1, 1, 'exactly one block')
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('agentsmd: the registry inventory never renders — only the configured machine_id row', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-nodes-'))
  try {
    await ensureAgentsMdTemplate(ws)
    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
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
    // the one configured machine renders; the registry (other aliases, hosts)
    // never does — the machine card / ssh_list stays the inventory
    assert.ok(md.includes('  machine_id: "node1"'), 'the configured machine renders (settings, not the registry)')
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

test('agentsmd: parseFacts reads the managed block back as flat facts', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-agentsmd-facts-'))
  try {
    assert.equal(await parseFacts(ws), null, 'no AGENTS.md yet')
    await ensureAgentsMdTemplate(ws)
    const template = await parseFacts(ws)
    assert.ok(template, 'the template block parses')
    assert.equal(template.run_mode, null, 'null literal -> null')
    assert.equal(template.synced_by, 'dsh-harnessams')
    // a values build round-trips: JSON-quoted strings, nulls, the local_ rows
    const settings = { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim',
      selfcheck_remote_dir: '.harnessams/selfcheck', scheduler: 'lsf', simulator: 'spectre',
      compute_script_local: 'python', compute_script_remote: 'python',
      remote_python: '/opt/tools/python3/bin/python3', remote_spectre_cmd: null }
    await syncAgentsMd({}, { project: { path: ws, title: 'demo' }, settings })
    const facts = await parseFacts(ws)
    assert.equal(facts.run_mode, 'remote')
    assert.equal(facts.remote_python, '/opt/tools/python3/bin/python3')
    assert.equal(facts.remote_spectre_cmd, null)
    assert.equal(facts.remote_root, '/home/op/sim')
    assert.equal(facts.workspace_root, ws, 'a JSON-quoted Windows path round-trips unescaped')
    assert.equal(typeof facts.local_node_version, 'string')
    // content outside the block never leaks into the facts
    await writeFile(agentsMdPath(ws), (await readFile(agentsMdPath(ws), 'utf8')) + '\n# notes\n  not_a_row: "x"\n', 'utf8')
    assert.equal((await parseFacts(ws)).not_a_row, undefined, 'outside-block lines are ignored')
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
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    const md1 = await readFile(agentsMdPath(ws), 'utf8')
    assert.ok(md1.includes(ASK_FIRST), 'template carries the core constraints')
    assert.ok(!md1.includes(WORKFLOW_TABLE), 'template carries no workflow table')
    // a second settings write stays idempotent (block present → untouched)
    await writeSettings(ws, {
      cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    assert.ok(!(await readFile(agentsMdPath(ws), 'utf8')).includes(WORKFLOW_TABLE), 'later writes never rewrite the block')

    // the SESSION-CONFIG writer also lays the template when IT creates
    // .harnessams first (the common case: a session opening its sidebar)
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
      settings: { cluster_env: 'out-of-cluster', run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', selfcheck_remote_dir: '.harnessams/selfcheck',
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
    // the report-figures option: a session option above the dashboard
    'pset.colFigs', 'pset.figsWarn',
    'envc.title', 'envc.bodyIn', 'envc.bodyOut', 'envc.ok',
    'chk.btn.local', 'chk.truncated',
  ])
  assert.ok(src.includes("h(SessionOptionFigs, { config, updateConfig }),")
    && src.indexOf('h(SessionOptionFigs, { config, updateConfig }),') < src.indexOf('h(SessionDashboard, { sessionId, config, updateConfig }),'),
    'the report-figures option renders above the dashboard')
  assert.ok(src.includes("onChange: captureValue((on) => void updateConfig((c) => ({ ...c, report_figs: on === '1' })))"),
    'the option writes the session entry')
  assert.ok(src.includes("...(src.report_figs === true ? { report_figs: true } : {})"), 'the session clone carries the option')
  // a controlled select snaps back before the rebased persist runs its
  // mutator: the dashboard dropdown must capture the picked value
  // synchronously — never read e.target.value inside the mutator
  assert.ok(src.includes("onChange: captureValue((id) => updateConfig((c) => ({ ...c, dashboard_selected: id })))"),
    'the report dropdown captures its value synchronously')
  assert.ok(!/updateConfig\(\(c\) => \(\{ \.\.\.c, dashboard_selected: e\.target\.value \}\)\)/.test(src),
    'no deferred read of e.target.value in the report dropdown')
})

test('agentsmd client: remote browse gains the age column, refresh, new-folder form', () => {
  // the remote browse listing entries carry mtime (age via fmtAge, absolute
  // time on hover), the refresh button is a square icon-only button (nonce ->
  // refetch), and the new-folder form POSTs the mkdir route with a validated
  // printable-ASCII name
  assert.ok(src.includes("API + '/remote-browse/mkdir'"), 'the picker posts the mkdir route')
  assert.ok(src.includes('function IconRefresh') && src.includes('h(IconRefresh)'), 'the square icon button renders the refresh glyph')
  assert.ok(src.includes('hams-iconbtn'), 'the square single-icon button class exists')
  assert.ok(/setNonce\(nonce \+ 1\)/.test(src), 'refresh bumps the nonce into the listing effect')
  assert.ok(src.includes('(listing.entries ?? []).map'), 'rows render the entries shape (name + mtime)')
  assert.ok(src.includes('function fmtAge'), 'the age formatter exists')
  assert.ok(src.includes("tr('pset.ageFmt', { d:"), 'the age column formats through the bilingual key')
  assert.ok(src.includes("setMkName('new_folder')"), 'the new-folder form prefills a default name')
  assert.ok(src.includes('autoFocus: true'), 'the form opens focused')
  assertDictKeys(src, [
    'pset.refresh', 'pset.newFolder', 'pset.newFolderName', 'pset.newFolderOk', 'pset.nameRule', 'pset.ageFmt',
  ])
})
