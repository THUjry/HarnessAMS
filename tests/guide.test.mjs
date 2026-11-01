// Console-page first-run guide static contracts: the client half is a combo-loaded
// classic script (no ESM import), so these are asserted against the source text —
// the same discipline as entry.test.mjs / terminal.test.mjs.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

test('guide: console page wiring — seen flag, centered first-run state, persistent entry', () => {
  assert.ok(src.includes("'hams-guide-seen'"), 'first-run flag must persist in localStorage')
  assert.ok(src.includes('hams-guidecenter'), 'the centered first-run state needs its layout class')
  assert.ok(src.includes('function GuideView'), 'the guide view component must exist')
  assert.ok(/function guideSeenMark\(\)/.test(src), 'seen-flag writer must exist')
  // the guide is a console-page surface only: never a task-sidebar sub-view
  assert.ok(!/id: 'guide'/.test(src), 'guide must not be registered as a TASK_VIEWS entry')
})

test('guide: bilingual copy — every key exactly twice, slurm marked not supported', () => {
  const keys = [...src.matchAll(/'(guide\.[a-zA-Z0-9.]+)':/g)].map((m) => m[1])
  assert.ok(keys.length >= 14, 'the guide key set must be present, found ' + keys.length)
  for (const key of new Set(keys)) {
    const hits = src.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `dictionary key ${key} must exist exactly twice (zh + en), found ${hits}`)
  }
  assert.match(src, /'guide\.s2slurm': '[^']*暂不支持/, 'slurm must be marked 暂不支持 in zh')
  assert.match(src, /'guide\.s2slurm': '[^']*not supported/, 'slurm must be marked not supported in en')
  // the start-page guide card description was upgraded together with the feature
  assert.ok(!src.includes("'项目任务'"), 'guide card description must not regress to the placeholder text')
  const desc = src.split(`'tasks.guideDesc':`).length - 1
  assert.equal(desc, 2, 'tasks.guideDesc must exist exactly twice (zh + en)')
})
