// Fork detection (D-005): a session counts as forked iff its own log carries
// the inherited cut marker — event {type:'session/end-seed', data:{inherited:true}}
// (dsh-session buildForkSeed). Resumed sessions write end-seed WITHOUT the flag,
// so the predicate is the flag, not the event type. Everything fails open to
// "not a fork". Live probe evidence: harnessams-workspace/probe-taskmerge-20261119.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { isForkSession } from '../src/server/forkdetect.js'

const ev = (type, extra = {}) => JSON.stringify({ type, seq: extra.seq ?? 0, time: 1795092632947, ...extra })

async function seedLog(home, sessionId, lines) {
  const dir = path.join(home, 'sessions', '--D-test-ws--', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

test('forkdetect: inherited marker is the exact predicate; resume markers never match; everything fails open', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hams-fork-'))
  try {
    // fork child: header + a few events + the inherited cut marker
    await seedLog(home, 'session-fork1111-2222-3332-4444-555555555555', [
      ev('session', { seq: 0 }),
      ev('user/message', { seq: 1 }),
      ev('session/end-seed', { seq: 37, data: { inherited: true } }),
      ev('turn/end', { seq: 38, data: { kind: 'forked' } }),
    ])
    // resumed (NOT forked) session: end-seed WITHOUT inherited — historical
    // logs prove this shape exists and must not false-positive
    await seedLog(home, 'session-resu1111-2222-3332-4444-555555555555', [
      ev('session', { seq: 0 }),
      ev('session/end-seed', { seq: 4 }),
      ev('user/message', { seq: 5 }),
    ])
    // brand-new session: no end-seed at all
    await seedLog(home, 'session-new1111-2222-3332-4444-555555555555', [
      ev('session', { seq: 0 }),
      ev('permission/preset', { seq: 1 }),
    ])

    assert.equal(isForkSession('session-fork1111-2222-3332-4444-555555555555', home), true)
    assert.equal(isForkSession('session-resu1111-2222-3332-4444-555555555555', home), false)
    assert.equal(isForkSession('session-new1111-2222-3332-4444-555555555555', home), false)

    // fail-open: missing log, corrupt zstd, garbage json lines, bad sid shapes
    assert.equal(isForkSession('session-none1111-2222-3332-4444-555555555555', home), false)
    assert.equal(isForkSession('', home), false)
    assert.equal(isForkSession('not an id!', home), false)
    assert.equal(isForkSession('../escape-attempt', home), false)
    const corruptDir = path.join(home, 'sessions', '--D-test-ws--', 'session-corr1111-2222-3332-4444-555555555555')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(path.join(corruptDir, 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'))
    assert.equal(isForkSession('session-corr1111-2222-3332-4444-555555555555', home), false)
    // garbage line before a real marker still finds the marker
    await seedLog(home, 'session-garb1111-2222-3332-4444-555555555555', [
      '{not json',
      ev('session/end-seed', { seq: 2, data: { inherited: true } }),
    ])
    assert.equal(isForkSession('session-garb1111-2222-3332-4444-555555555555', home), true)
    // missing home directory -> false, never throw
    assert.equal(isForkSession('session-fork1111-2222-3332-4444-555555555555', path.join(home, 'nope')), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
