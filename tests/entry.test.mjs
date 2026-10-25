// Starter unit tests for the console plugin entry (run: bare `node --test` from the repo
// root — a directory argument fails on Node 24).
// Covers the metadata surface, the webServer prefix-route registration with a mock ctx,
// and the packaging contract (assets + files whitelist).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { name, inject, apply } from '../src/index.js'

test('plugin metadata', () => {
  assert.equal(name, 'dsh-harnessams')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof apply, 'function')
})

test('apply registers the /harnessams prefix route', async () => {
  const routes = []
  const ctx = {
    effect: (fn) => { fn() },
    webServer: { register: (r, label) => routes.push({ ...r, label }) },
  }
  await apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/harnessams')
  assert.equal(typeof routes[0].handler, 'function')
})

test('packaging contract: assets ship and the whitelist stays correct', async () => {
  const pkg = JSON.parse(await readFile(new URL('../src/package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('assets/'), 'files whitelist must include assets/')
  assert.ok(pkg.files.includes('scripts/'), 'files whitelist must include scripts/')
  const st = await stat(new URL('../src/assets/plotly.min.js', import.meta.url))
  assert.ok(st.size > 4_000_000, `src/assets/plotly.min.js too small: ${st.size} bytes`)
})
