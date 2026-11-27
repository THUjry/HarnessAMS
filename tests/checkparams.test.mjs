// Check-parameters storage + API contract (per-session since D-003): module
// read/validate semantics survive unchanged (the project file is the FALLBACK
// layer) and /api/session-config carries fallback_params (+ the sessions
// map with per-session confirmed tables).
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerRoutes, callGet } from './helpers.mjs'
import { writeSessionConfig } from '../src/server/project.js'
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
      mult: { nf: [2, 64], m: [0, 10] },
      unit_check: 'yes',
    }), 'utf8')
    r = await readCheckParams(dir)
    assert.deepEqual(r.params.rcl.r, [1, 10])
    assert.deepEqual(r.params.rcl.c, defaultCheckParams().rcl.c)
    assert.deepEqual(r.params.rcl.l, defaultCheckParams().rcl.l) // min>max -> default
    assert.deepEqual(r.params.mult.nf, [2, 64])
    assert.deepEqual(r.params.mult.m, defaultCheckParams().mult.m) // min<=0 -> default
    assert.equal(r.params.unit_check, true) // non-boolean -> default
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('checkparams: validateCheckParams rejects bad shapes, accepts good ones', () => {
  const good = defaultCheckParams()
  assert.ok(validateCheckParams(good).params)
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, r: [2, 4] } }).params)
  assert.ok(validateCheckParams({ ...good, mult: { ...good.mult, nf: [2, 64] } }).params)
  assert.ok(validateCheckParams('nope').error)
  assert.ok(validateCheckParams(null).error)
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, c: [1e-6, 1e-15] } }).error) // min>max
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, r: [0, 10] } }).error) // min>0
  assert.ok(validateCheckParams({ ...good, rcl: { ...good.rcl, l: [1, Infinity] } }).error) // non-finite
  assert.ok(validateCheckParams({ ...good, mult: { ...good.mult, nf: [64, 2] } }).error) // min>max
  assert.ok(validateCheckParams({ ...good, mult: { ...good.mult, nf: [0, 64] } }).error) // min>0
  assert.ok(validateCheckParams({ ...good, mult: { ...good.mult, m: [1, 2.5] } }).error) // non-integer
  assert.ok(validateCheckParams({ ...good, unit_check: 'on' }).error)
  // the session table carries the full new shape — a pre-mult entry is
  // rejected (existing sessions are deliberately not kept compatible)
  assert.ok(validateCheckParams({ rcl: good.rcl, unit_check: true }).error) // no mult table
})

test('per-session table + fallback_params ride /api/session-config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-chkapi-'))
  try {
    const handler = await registerRoutes({ workspaceRegistry: { list: () => [
      { id: 'w1', path: dir, title: 'P1', sessionIds: ['s1', 'session-sess1111-2222-3332-4444-555555555555'] },
    ] } })
    const base = 'http://127.0.0.1/harnessams/api/session-config'
    // unknown session -> 404
    assert.equal((await callGet(handler, base + '?sessionId=nope')).code, 404)
    // no project file -> fallback_params = built-in defaults; the asking
    // session has no entry yet -> a fork verdict is computed (fail-open false
    // for a sid with no DSH log)
    const g1 = await callGet(handler, base + '?sessionId=s1')
    assert.equal(g1.code, 200)
    assert.deepEqual(g1.body.fallback_params, defaultCheckParams())
    assert.equal(g1.body.fork, false)
    // a project-level file shifts the fallback (hand-editable baseline)
    await mkdir(path.join(dir, '.harnessams'), { recursive: true })
    await writeFile(checkParamsPath(dir), JSON.stringify({
      rcl: { r: [1, 100], c: [1e-15, 1e-6], l: [1e-13, 1e-8] },
      mult: { nf: [1, 64], m: [1, 1000] },
    }), 'utf8')
    const g2 = await callGet(handler, base + '?sessionId=s1')
    assert.deepEqual(g2.body.fallback_params.rcl.r, [1, 100])
    assert.deepEqual(g2.body.fallback_params.mult.nf, [1, 64])
    // once the session HAS an entry, no fork verdict is carried (tombstone)
    const sid = 'session-sess1111-2222-3332-4444-555555555555'
    await writeSessionConfig(dir, sid, {
      display: 'session', reports: [], dashboard_selected: null,
      check_params: { ...defaultCheckParams(), unit_check: false },
    })
    const g3 = await callGet(handler, base + '?sessionId=' + sid)
    assert.equal(g3.body.sessions[sid].check_params.unit_check, false)
    assert.equal(g3.body.fork, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
