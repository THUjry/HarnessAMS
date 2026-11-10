// Check-parameters storage + API contract: defaults on a missing file, per-key
// fallback on a hand-corrupted file, PUT validation, and the GET/PUT routes
// (sessionId → workspace via the registry, local projects only).
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerRoutes, callGet, callPut } from './helpers.mjs'
import {
  defaultCheckParams, validateCheckParams, readCheckParams, checkParamsPath,
} from '../src/server/checkparams.js'

test('checkparams: defaults on missing file, per-key fallback on a corrupted one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-chk-'))
  try {
    // missing file = the built-in defaults, not an error
    let r = await readCheckParams(dir)
    assert.deepEqual(r.params, defaultCheckParams())
    assert.ok(r.defaults)
    // hand-edited off-spec values fall back per-key; valid ones survive
    await mkdir(path.join(dir, '.harnessams'), { recursive: true })
    await writeFile(checkParamsPath(dir), JSON.stringify({
      rcl: { r: [1, 10], c: 'nope', l: [5, 1] },
      unit_check: 'yes', bias_check: false,
    }), 'utf8')
    r = await readCheckParams(dir)
    assert.deepEqual(r.params.rcl.r, [1, 10])
    assert.deepEqual(r.params.rcl.c, defaultCheckParams().rcl.c)
    assert.deepEqual(r.params.rcl.l, defaultCheckParams().rcl.l) // min>max -> default
    assert.equal(r.params.unit_check, true) // non-boolean -> default
    assert.equal(r.params.bias_check, false)
    assert.equal(r.params.strict_includes, defaultCheckParams().strict_includes)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('checkparams: validateCheckParams rejects bad shapes, accepts good ones', () => {
  const good = defaultCheckParams()
  assert.ok(validateCheckParams(good).params)
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, r: [2, 4] } }).params)
  assert.ok(validateCheckParams('nope').error)
  assert.ok(validateCheckParams(null).error)
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, c: [1e-6, 1e-15] } }).error) // min>max
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, r: [0, 10] } }).error) // min>0
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, l: [1, Infinity] } }).error) // non-finite
  assert.ok(validateCheckParams({ ...good, unit_check: 'on' }).error)
  assert.ok(validateCheckParams({ ...good, strict_includes: 1 }).error)
})

test('checkparams routes: GET defaults, PUT persists, invalid PUT leaves the file untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-chkapi-'))
  try {
    const handler = await registerRoutes({ workspaceRegistry: { list: () => [
      { id: 'w1', path: dir, title: 'P1', sessionIds: ['s1'] },
    ] } })
    const base = 'http://127.0.0.1/harnessams/api/check-params'
    // unknown session -> 404
    assert.equal((await callGet(handler, base + '?sessionId=nope')).code, 404)
    // no file -> defaults
    const g1 = await callGet(handler, base + '?sessionId=s1')
    assert.equal(g1.code, 200)
    assert.deepEqual(g1.body.params, defaultCheckParams())
    // PUT persists atomically with a version stamp
    const next = {
      ...defaultCheckParams(),
      rcl: { r: [1, 100], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
      bias_check: false,
    }
    const p1 = await callPut(handler, base + '?sessionId=s1', next)
    assert.equal(p1.code, 200)
    const saved = JSON.parse(await readFile(path.join(dir, '.harnessams', 'check_params.json'), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.bias_check, false)
    assert.deepEqual(saved.rcl.r, [1, 100])
    // GET reflects the saved values
    const g2 = await callGet(handler, base + '?sessionId=s1')
    assert.deepEqual(g2.body.params.rcl.r, [1, 100])
    assert.equal(g2.body.params.bias_check, false)
    // invalid PUT -> 400 and the file stays as the last good write
    const p2 = await callPut(handler, base + '?sessionId=s1', { ...next, rcl: { ...next.rcl, r: [10, 1] } })
    assert.equal(p2.code, 400)
    const g3 = await callGet(handler, base + '?sessionId=s1')
    assert.deepEqual(g3.body.params.rcl.r, [1, 100])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
