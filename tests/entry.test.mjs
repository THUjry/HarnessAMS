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
  assert.deepEqual(inject, ['webServer', 'workspaceRegistry', 'tools'])
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
    'batch_fetch', 'batch_poll', 'batch_submit',
    'safe_trash', 'sim_analysis', 'sim_progress',
  ])
})

test('every tool compiles to an object-rooted JSON Schema with typed properties', () => {
  const defs = toolDefinitions()
  assert.equal(defs.length, 6)
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
  for (const f of ['index.js', 'client.js', 'server/', 'tools/', 'scripts/', 'selfcheck/', 'cordis.patch.yml', 'assets/']) {
    assert.ok(pkg.files.includes(f), `files whitelist must include ${f}`)
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
  // composed form so an '/api/api/…' double-prefix regression cannot come back.
  assert.ok(src.includes("API + '/progress?runDir='"), 'cards must poll the progress endpoint')
  assert.ok(src.includes("API + '/progress-summary"), 'cards must poll the progress-summary endpoint')
  // A key typo never renders (silent generic-card fallback), so the eight names
  // are pinned against the model-facing tool surface verbatim.
  const m = /const SIM_CARD_TOOLS = \[([^\]]+)\]/.exec(src)
  assert.ok(m, 'SIM_CARD_TOOLS list must exist')
  const cardTools = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.deepEqual(cardTools.sort(), ['batch_fetch', 'batch_poll', 'batch_submit', 'sim_analysis',
    'sim_progress', 'spectre_assemble', 'spectre_parse', 'spectre_run_sweep'])
  assert.ok(src.includes('hams-toolview'), 'card display toggle must persist via localStorage')
  assert.ok(src.includes('TOOLVIEW_EVENT'), 'mounted cards must flip without a reload')
  assert.ok(src.includes('DisplaySettingsSection'), 'console page must host the display toggle')
  assert.ok(src.includes("sec('guide.s6t', 'guide.s6')"), 'guide must cover the tool cards')
})

test('client half: single tab with the project overview on the first-level strip', async () => {
  const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  // The overview dropped back from its own top-level tab (2026-11-10, same day
  // it was promoted): ONE tab remains, and the project overview is the default
  // entry of its first-level strip, ahead of the task capsules and "new task".
  assert.ok(!src.includes('OV_TAB_ID') && !src.includes('OV_TAB_KIND'), 'the top-level overview tab must be gone')
  assert.ok(!src.includes('OverviewSidebarBody'), 'the old top-level body name must be gone')
  assert.ok(src.includes('function ProjectOverviewView'), 'project overview view component')
  assert.ok(src.includes("stripSel === 'overview' && h(ProjectOverviewView"), 'overview renders as the strip selection')
  assert.ok(src.includes("'tasks.projectOverview'"), 'project overview strip capsule copy key')
  assert.ok(src.includes("const STRIP_SEL_KEY = 'hams-task-strip-sel'"), 'strip selection must survive remounts')
  assert.ok(src.includes("tr('tasks.newTask')),"),
    'the create button must read "new task" (not a bare +)')
  // The sidebar follows session switches by tracking open state, not a pin
  assert.ok(!src.includes('STICKY_KEY') && !src.includes('PinToggle'), 'the pin mechanism must be gone')
  assert.ok(src.includes('const sidebarOpenState'), 'open-state tracking')
  assert.ok(src.includes('right.openTab(TAB_KIND)'), 'reopen targets the HarnessAMS tab')
  assert.ok(src.includes('overviewMemory'), 'same-project remount cache stays')
  // The check sub-view keeps its contract
  assert.ok(!src.includes("id: 'overview'"), 'overview must not be a TASK_VIEWS entry')
  assert.ok(/id: 'check', labelKey: 'tasks\.viewCheck'/.test(src), 'TASK_VIEWS must carry the check view')
  assert.ok(src.includes("API + '/check-params"), 'check sub-view must call the check-params API')
  assert.ok(src.includes('check.oldValue'), 'unconfirmed edits must show the old value')
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
