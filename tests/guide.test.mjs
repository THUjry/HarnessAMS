// Console-page first-run guide + digital-assets listing static contracts: the client
// half is a combo-loaded classic script (no ESM import), so these are asserted against
// the source text — the same discipline as entry.test.mjs.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { clientSrc, assertDictKeys } from './helpers.mjs'

const src = await clientSrc()
const assetsSrc = await readFile(new URL('../src/server/assets.js', import.meta.url), 'utf8')
const indexSrc = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')

test('guide: console page wiring — seen flag, centered first-run state, persistent entry', () => {
  assert.ok(src.includes("'hams-guide-seen'"), 'first-run flag must persist in localStorage')
  assert.ok(src.includes('hams-guidecenter'), 'the centered first-run state needs its layout class')
  assert.ok(src.includes('function GuideView'), 'the guide view component must exist')
  assert.ok(/function guideSeenMark\(\)/.test(src), 'seen-flag writer must exist')
})

test('console page: settings-style core config and display sections', () => {
  // The console page is two settings-style sections: Core configuration (the
  // cluster-env switch riding the active session's project, confirm-gated,
  // single-key write) and Display settings. The machines section is removed
  // (dsh-ssh owns the host list) and the assets section is hidden with its
  // open-asset column gone.
  assert.ok(src.includes('function CoreConfigSection'), 'core-config section component')
  assert.ok(src.includes('function SetSwitch'), 'the official-style switch component')
  assert.ok(src.includes("role: 'switch'"), 'the switch carries the switch role')
  assert.ok(src.includes('.hams-switch'), 'the switch style exists in ensureCss')
  assert.ok(src.includes('.hams-setrow'), 'the settings-row style exists in ensureCss')
  const core = src.indexOf('h(Boundary, null, h(CoreConfigSection, null))')
  const disp = src.indexOf('h(Boundary, null, h(DisplaySettingsSection, null))')
  assert.ok(core >= 0 && disp >= 0 && core < disp, 'core config renders before display settings')
  assert.ok(!src.includes('function MachinesSection'), 'the machines section is removed')
  assert.ok(src.includes('// h(Boundary, null, h(AssetsSection, null)),'), 'the assets section is commented out')
  assert.ok(src.includes('settings: { cluster_env: next }'), 'the env write stays single-key')
  assert.ok(src.includes('activeSessionProbe'), 'the console env switch rides the active-session probe')
})

test('guide: bilingual copy — every key exactly twice, slurm marked not supported', () => {
  const keys = [...src.matchAll(/'(guide\.[a-zA-Z0-9.]+)':/g)].map((m) => m[1])
  assert.ok(keys.length >= 14, 'the guide key set must be present, found ' + keys.length)
  assertDictKeys(src, [...new Set(keys)])
  assert.match(src, /'guide\.s2slurm': '[^']*\u6682\u4e0d\u652f\u6301/, 'slurm must be marked \u6682\u4e0d\u652f\u6301 in zh')
  assert.match(src, /'guide\.s2slurm': '[^']*not supported/, 'slurm must be marked not supported in en')
  // the start-page guide card description is a dictionary key like the rest
  assertDictKeys(src, ['tasks.guideDesc'])
})

test('assets: vendored .js packages with license and the served package copy', () => {
  assert.ok(assetsSrc.includes("file: 'plotly.min.js'"), 'assets.js must list plotly.min.js as vendored')
  assert.equal((assetsSrc.match(/license: 'MIT'/g) ?? []).length, 1, 'exactly one vendored package: plotly')
  // the client consumes packages from /api/assets; the route serves the
  // package copies only — no workspace scan
  assert.ok(/assetsStatus\(\)/.test(indexSrc), '/api/assets serves the package copies without a workspace scan')
  assertDictKeys(src, ['assets.colPkg', 'assets.colLicense', 'assets.colPkgCopy',
    'assets.notices'])
})
