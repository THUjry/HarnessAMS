// Entry + packaging tests for the three-tier plugin (run: bare `node --test` from the
// repo root — a directory argument fails on Node 24).
// The client half is a combo-loaded classic script (no ESM import), so it is covered by
// a syntax check plus static contract assertions rather than a module import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { name, inject, apply, toolDefinitions } from '../src/index.js'
import { makeTool } from '../src/tool.js'

test('plugin metadata', () => {
  assert.equal(name, 'dsh-harnessams')
  assert.deepEqual(inject, ['webServer', 'workspaceRegistry', 'tools', 'systemPrompt', 'skills'])
  assert.equal(typeof apply, 'function')
})

test('apply registers the /harnessams prefix route and the model tools', async () => {
  const routes = []
  const registered = []
  const ctx = {
    effect: (fn) => { fn() },
    webServer: { register: (r, label) => routes.push({ ...r, label }) },
    tools: { register: (t) => registered.push(t.name) },
  }
  await apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/harnessams')
  assert.equal(typeof routes[0].handler, 'function')
  assert.deepEqual(registered.sort(), [
    'batch_poll', 'batch_submit',
    'gen_sweep_report', 'harnessams_selfcheck',
    'safe_trash',
  ])
})

test('apply injects the remote waiting policy as a system prompt section (fail-open)', async () => {
  // with the systemPrompt service: exactly one section, namespaced, placed in
  // the free 5000–9000 order band; the text pins the policy's four hard rules
  const sections = []
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: () => {} },
    tools: { register: () => {} },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
  }
  await apply(ctx)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'harnessams:remote-wait-policy')
  assert.equal(sections[0].order, 5500)
  assert.match(sections[0].text, /Sleep <=30 s per command/)
  assert.match(sections[0].text, /at least once every 5 s/)
  assert.match(sections[0].text, /stop and ask the user first/)
  assert.match(sections[0].text, /dsh-ssh tools \(ssh_exec\/ssh_upload\/ssh_download\)/)
  assert.match(sections[0].text, /never raw ssh commands from the shell/)
  // fail-open: without the service, apply still mounts routes/tools quietly
  const bare = {
    effect: (fn) => fn(),
    webServer: { register: () => {} },
    tools: { register: () => {} },
  }
  await apply(bare) // must not throw
})

test('every tool compiles to an object-rooted JSON Schema with typed properties', () => {
  const defs = toolDefinitions()
  assert.equal(defs.length, 5)
  for (const def of defs) {
    const tool = makeTool(def)
    assert.equal(tool.parameters.type, 'object', `${def.name} parameters root`)
    for (const [, prop] of Object.entries(tool.parameters.properties)) {
      assert.equal(typeof prop.type, 'string', `${def.name} property type`)
      assert.notEqual(prop.required, false, `${def.name} must not carry required:false`)
    }
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, true)
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('packaging contract: client half declared and whitelisted', async () => {
  const pkg = JSON.parse(await readFile(new URL('../src/package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./client'], './client.js', 'client export must point at client.js')
  assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform must be web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
    'dsh.client.inject must list the client module dependencies')
  for (const dep of pkg.dsh.client.inject) {
    assert.ok(pkg.peerDependencies?.[dep], `peer dependency missing for client inject: ${dep}`)
    assert.ok(pkg.devDependencies?.[dep], `dev dependency missing for client inject: ${dep}`)
  }
  for (const f of ['index.js', 'client.js', 'server/', 'tools/', 'scripts/', 'selfcheck/', 'cordis.patch.yml', 'assets/',
    'report_render.js', 'figs_export.js']) {
    assert.ok(pkg.files.includes(f), `files whitelist must include ${f}`)
  }
  // the headless PNG pipeline's runtime deps (all prebuilt, zero install scripts)
  for (const dep of ['jsdom', '@napi-rs/canvas', '@resvg/resvg-js']) {
    assert.ok(pkg.dependencies?.[dep], `runtime dependency missing: ${dep}`)
  }
  const st = await stat(new URL('../src/assets/plotly.min.js', import.meta.url))
  assert.ok(st.size > 4_000_000, `src/assets/plotly.min.js too small: ${st.size} bytes`)
})

test('client half: syntax valid and registers the three tiers', async () => {
  execFileSync(process.execPath, ['--check', new URL('../src/client.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')])
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("window.__ModuleLoader__.load"), 'must register as a classic script')
  assert.ok(src.includes("exports.apply = apply"), 'must export apply for the loader')
  for (const slot of ["'main'", "'sidebar.panellist'", "'sidebar.right.pane.tab'",
    "'conversation.session.header.actions'", "'tool.call.toolview'"]) {
    assert.ok(src.includes(slot), `client must inject the ${slot} slot`)
  }
  assert.ok(src.includes("sidebarRightTabs"), 'client must register the right-sidebar tab')
  assert.ok(src.includes("sessionId"), 'task body must consume sessionId props')
  // Dashboard auto-refresh: store poll + report-stat poll
  assert.ok(src.includes('/report-stat'), 'TaskDashboard must poll /api/report-stat')
  assert.ok(src.includes('setInterval'), 'auto-refresh must poll on an interval')
  assert.ok(src.includes('visibilitychange'), 'polling must pause/resume on tab visibility')
  // Sub-view persistence: the DSH host remounts the sidebar slot
  // body around agent tool cards, so the selection must live outside React state
  assert.ok(src.includes('hams-task-view'), 'sub-view choice must persist via localStorage')
  assert.ok(src.includes('rememberTaskView'), 'view switch must write the persisted choice')
  assert.ok(src.includes('useState(readTaskView)'), 'TaskSidebarBody must restore the persisted view on mount')
})

test('client half: simulation tool cards keyed by exact wire tool names', async () => {
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("slots.inject('tool.call.toolview'"), 'must inject the tool card slot')
  // The endpoints hang off the /harnessams/api prefix (API constant) — pin the
  // composed forms so an '/api/api/…' double-prefix regression cannot come back.
  // D-008: the batch_poll card swaps the single-run source for the remote poll.
  assert.ok(src.includes("API + (remote ? '/progress-remote' : '/progress')"), 'cards must pick the local/remote progress endpoint')
  assert.ok(src.includes("API + '/progress-summary"), 'cards must poll the progress-summary endpoint')
  assert.ok(src.includes('normRemoteProg'), 'remote payloads must normalize to the prog shape')
  assert.ok(src.includes('remoteErr'), 'unreachable remotes must surface a note, not a blank card')
  // A failed frame must not show its losses twice (failed:N AND pending:total):
  // the result view takes the payload's own pending when it carries one.
  assert.ok(src.includes('v: d.pending ?? ('), 'result card prefers the payload pending')
  // A key typo never renders (silent generic-card fallback), so the three heavy
  // tool names are pinned against the model-facing tool surface verbatim (the
  // D-008 scope ruling shrank the list from eight).
  const m = /const SIM_CARD_TOOLS = \[([^\]]+)\]/.exec(src)
  assert.ok(m, 'SIM_CARD_TOOLS list must exist')
  const cardTools = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.deepEqual(cardTools.sort(), ['batch_poll'])
  assert.ok(src.includes('hams-toolview'), 'card display toggle must persist via localStorage')
  assert.ok(src.includes('TOOLVIEW_EVENT'), 'mounted cards must flip without a reload')
  assert.ok(src.includes('DisplaySettingsSection'), 'console page must host the display toggle')
  assert.ok(src.includes("sec('guide.s6t', 'guide.s6')"), 'guide must cover the tool cards')
})

test('client half: single tab — two-entry strip (project overview + this session)', async () => {
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  // ONE tab remains, and its first-level strip is exactly TWO entries since the
  // task retirement (D-005, 2026-11-19) — the project overview (default) and
  // the current session's own capsule.
  assert.ok(src.includes('function ProjectOverviewView'), 'project overview view component')
  assert.ok(src.includes("config.display === 'overview' && h(ProjectOverviewView"), 'overview renders as the strip selection')
  assert.ok(src.includes("'tasks.projectOverview'"), 'project overview strip capsule copy key')
  assert.ok(src.includes("'tasks.sessionTab'"), 'session strip capsule copy key')
  assert.ok(src.includes("'/session-config?sessionId='") && src.includes('putSessionConfig'), 'per-session config persists via sessions.json')
  // The sidebar follows session switches by tracking open state
  assert.ok(src.includes('const sidebarOpenState'), 'open-state tracking')
  assert.ok(src.includes('right.openTab(TAB_KIND)'), 'reopen targets the HarnessAMS tab')
  assert.ok(src.includes('overviewMemory'), 'same-project remount cache stays')
  // The check sub-view keeps its contract (per-session since D-005)
  assert.ok(/id: 'check', labelKey: 'tasks\.viewCheck'/.test(src), 'TASK_VIEWS must carry the check view')
  assert.ok(src.includes("API + '/session-config"), 'check sub-view reads through the session-config API')
  assert.ok(src.includes('fallback_params'), 'unconfirmed table shows the fallback source')
  assert.ok(src.includes('check.oldValue'), 'unconfirmed edits must show the old value')
})

test('client half: 2026-11-18 UI wave — single scroll, no horizontal overflow, 8-line clamp, per-session selection', async () => {
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  // ONE scroll container: the task tab's outer .hams-body; the overview is
  // plain flowing content (the old nested .hams-body + height:100% chain is
  // what starved the overview of its vertical scrollbar)
  assert.equal((src.match(/className: 'hams-body'/g) ?? []).length, 1, 'exactly one scroll container element')
  assert.ok(src.includes('.hams-body { padding: 8px 10px; overflow-y: auto; overflow-x: hidden;'), 'scroll container bans horizontal scroll')
  assert.ok(src.includes("flex: 'none', fontSize: 'var(--dsh-content-font-size, 14px)'"), 'overview flows, no height chain')
  assert.ok(src.includes("flex: '1 0 auto'"), 'task branch grows instead of clipping')
  // no horizontal overflow anywhere: wrap-anywhere at the roots + table cells + pre
  assert.ok((src.match(/overflow-wrap: anywhere/g) ?? []).length >= 6, 'overflow-wrap: anywhere across roots/tables/pre')
  assert.ok(src.includes('word-break: break-all'), 'pre blocks break long tokens')
  // 8-line clamp with a measured toggle
  assert.ok(src.includes('function ClampText'), 'clamp component exists')
  assert.ok(src.includes('.hams-clamp { overflow: hidden; max-height: 12em; }'), '8 lines x 1.5 line-height clamp')
  assert.ok(src.includes("tr(open ? 'common.collapse' : 'common.expand')"), 'clamp toggle copy')
  // dropdown options follow the theme (hover-only-readable bug)
  assert.ok(src.includes('.hams-select { color-scheme: light dark; }'), 'select color-scheme')
  assert.ok(src.includes('.hams-select option { background: canvas; color: canvasText; }'), 'option colors')
  // per-session CONFIG with fork-split first-seen (D-005): a forked session
  // deep-copies the previously active session's CURRENT config (deliberately
  // branch-point-independent); a brand-new session starts empty; every change
  // merge-PUTs through sessions.json (v2)
  assert.ok(src.includes('const sessionConfigState = new Map()'), 'per-session config map')
  assert.ok(src.includes('function sessionConfigOf(sessionId, fork, fallbackSource)'), 'first-seen fork split via sessionConfigOf')
  assert.ok(src.includes('function forkCopySource('), 'copy source: last-active, else the store recency tail')
  assert.ok(src.includes('function cloneSessionConfig'), 'deep copy (fork inherits the whole config)')
  assert.ok(src.includes('adoptWith(!!d?.fork, sessions)'), 'the server fork verdict drives the split')
  assert.ok(src.includes('const lastActiveSessionId = { id: null }'), 'last-active session memory')
  assert.ok(src.includes('function putSessionConfig(sessionId, { retries = 4 } = {})'), 'merge-PUT persistence (bounded-retry form, D-006)')
  assert.ok(src.includes("API + '/session-config?sessionId='"), 'session-config API wired')
  // default-open: initialized project + untouched host layout tabs
  assert.ok(src.includes('sessionSidebarUntouched(sessionId)'), 'untouched-layout gate')
  assert.ok(src.includes('r.project?.initialized'), 'default-open keys off initialized')
  assert.ok(src.includes('autoOpenedFor'), 'once per page lifetime')
})

test('client half: fork adopt awaits session persistence before mounting an inherited report (D-006 fix)', async () => {
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  // The 2026-11-21 fork bug: adoptWith setConfig'd a config whose dashboard_
  // selected mounts the /dash iframe while the fork's sessions.json entry was
  // still in flight (fire-and-forget PUT, swallowed errors) — the iframe 404'd
  // until a manual refresh. The fix pins BOTH halves: the await-before-setConfig
  // ordering and a bounded retry on the PUT itself (a fork session not yet in
  // the workspace registry 404s transiently).
  assert.ok(src.includes('const adoptWith = async (fork, sessionsMap)'), 'adoptWith must be async')
  assert.ok(src.includes('await putSessionConfig(sessionId)'), 'first-seen adopt must await persistence before setConfig')
  assert.ok(src.includes('if (!alive) return'), 'stale adopt after unmount must not setConfig')
  assert.ok(src.includes('function putSessionConfig(sessionId, { retries = 4 } = {})'), 'bounded retry contract')
  assert.ok(src.includes('const attempt = (left) => fetchJson(API + \'/session-config?sessionId=\''), 'retry ladder present')
})

test('client half: zh/en dictionaries keep identical key sets', async () => {
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const blockKeys = (name) => {
    const start = src.indexOf(name + ': {')
    assert.ok(start >= 0, `dict block ${name} must exist`)
    const open = src.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    const keys = []
    const re = /^\s+'([A-Za-z0-9_.-]+)':/gm
    let mm
    const body = src.slice(open, end)
    while ((mm = re.exec(body))) keys.push(mm[1])
    return keys
  }
  const zh = blockKeys('zh')
  const en = blockKeys('en')
  assert.equal(zh.length, en.length, 'same key count')
  assert.deepEqual([...zh].sort(), [...en].sort(), 'same key sets')
  for (const probe of ['card.agg.line', 'set.toolview', 'guide.s6']) {
    assert.ok(zh.includes(probe), `zh dictionary must carry ${probe}`)
  }
})
