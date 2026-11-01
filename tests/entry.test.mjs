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
    'bsub_fetch', 'bsub_poll', 'bsub_submit',
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
  for (const f of ['index.js', 'client.js', 'server/', 'tools/', 'scripts/', 'cordis.patch.yml', 'assets/']) {
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
  for (const slot of ["'main'", "'sidebar.panellist'", "'sidebar.right.pane.tab'", "'conversation.session.header.actions'"]) {
    assert.ok(src.includes(slot), `client must inject the ${slot} slot`)
  }
  assert.ok(src.includes("sidebarRightTabs"), 'client must register the right-sidebar tab')
  assert.ok(src.includes("sessionId"), 'task body must consume sessionId props')
})
