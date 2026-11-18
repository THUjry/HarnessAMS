// Remote working-directory browser (server/remotebrowse.js + GET
// /api/remote-browse): ls -1p parsing, POSIX parent resolution, the ssh_exec
// funnel wiring (batch contract, alias addressing, timeout-KILL wrapper) and
// the route's error-code mapping. Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { remoteBrowse, parseLsDirs, remoteParent } from '../src/server/remotebrowse.js'
import { registerRoutes, callGet, batchOf, setRemoteMachines, assertValidShell } from './helpers.mjs'

test('remotebrowse: parseLsDirs keeps directory entries only', () => {
  assert.deepEqual(parseLsDirs('bin/\nboot/\nfile.txt\nlink/\nnested/deep/\n\n'), ['bin', 'boot', 'link'])
  assert.deepEqual(parseLsDirs(''), [])
  assert.deepEqual(parseLsDirs(null), [])
  assert.deepEqual(parseLsDirs('a\nb\n'), [])
})

test('remotebrowse: remoteParent walks POSIX-style; "/" has none', () => {
  assert.equal(remoteParent('/'), null)
  assert.equal(remoteParent('///'), null)
  assert.equal(remoteParent('/home'), '/')
  assert.equal(remoteParent('/home/op/sim/'), '/home/op')
})

// ssh_list + ssh_exec mock through the batch contract (dsh-tools 0.2.2-rc.x).
function makeCtx(route) {
  return {
    tools: {
      register: () => {},
      get: (n) => (n === 'ssh_list' || n === 'ssh_exec' ? { name: n } : undefined),
      execute: async (input) => {
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        const v = call.name === 'ssh_list'
          ? { hosts: [{ alias: 'node1', host: '192.0.2.11', port: 22, user: 'test_user', auth: 'key', keyReady: true }] }
          : route(args)
        return batchOf({ isError: false, value: v })
      },
    },
  }
}
const execOk = (stdout) => ({ success: true, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 2 })

test('remotebrowse: lists one level through the exec funnel, defaulting to the remote root', async () => {
  const restore = setRemoteMachines({ node1: '/home/op/sim' })
  const inputs = []
  try {
    const ctx = makeCtx((args) => { inputs.push(args); return execOk('AutoAnalog/\n.harnessams/\nreadme.md\n') })
    const r = await remoteBrowse(ctx, 'node1', null)
    assert.deepEqual(r, { dir: '/home/op/sim', parent: '/home/op', dirs: ['.harnessams', 'AutoAnalog'], truncated: false })
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].alias, 'node1') // alias addressing, zero gating
    assert.equal(inputs[0].timeoutMs, 110_000) // 20s deadline + 90s replay margin
    assertValidShell(inputs[0].command)
    const cmd = String(inputs[0].command).replace(/\\"/g, '"')
    assert.equal(cmd, 'timeout -s KILL 20s sh -c "ls -1p "/home/op/sim""')

    // explicit dir, trailing slash normalized, parent of a deep path
    const r2 = await remoteBrowse(ctx, 'node1', '/home/op/sim/AutoAnalog/')
    assert.equal(r2.dir, '/home/op/sim/AutoAnalog')
    assert.equal(r2.parent, '/home/op/sim')
  } finally { restore() }
})

test('remotebrowse: caps the listing at 200 entries with a truncated flag', async () => {
  const restore = setRemoteMachines({ node1: '/r' })
  try {
    const ctx = makeCtx(() => execOk(Array.from({ length: 205 }, (_, i) => `d${String(i).padStart(3, '0')}/\n`).join('')))
    const r = await remoteBrowse(ctx, 'node1', '/r')
    assert.equal(r.dirs.length, 200)
    assert.equal(r.dirs[0], 'd000')
    assert.equal(r.truncated, true)
  } finally { restore() }
})

test('remotebrowse: rejects bad dirs and unknown machines; surfaces exec failure verbatim', async () => {
  const restore = setRemoteMachines({ node1: '/home/op/sim' })
  try {
    const ctx = makeCtx(() => execOk(''))
    await assert.rejects(() => remoteBrowse(ctx, 'node1', 'relative/path'), /must be an absolute remote path/)
    await assert.rejects(() => remoteBrowse(ctx, 'node1', '/a/../b'), /must not contain/)
    await assert.rejects(() => remoteBrowse(ctx, 'ghost', null), /no such dsh-ssh host/)
    const fail = makeCtx(() => ({ success: false, exitCode: 2, timedOut: false, stdout: '', stderr: 'ls: cannot access /nope', durationMs: 2 }))
    await assert.rejects(() => remoteBrowse(fail, 'node1', '/nope'), /remote listing failed for \/nope: ls: cannot access \/nope/)
  } finally { restore() }
})

test('remotebrowse route: session→workspace mapping, machineId required, error codes', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-rb-route-'))
  try {
    const restore = setRemoteMachines({ node1: '/home/op/sim' })
    const handler = await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w', path: ws, title: 'P', sessionIds: ['s1'] }] },
      tools: makeCtx(() => execOk('sub/\n')).tools,
    })
    const base = 'http://127.0.0.1/harnessams/api/remote-browse'
    const ok = await callGet(handler, base + '?sessionId=s1&machineId=node1')
    assert.equal(ok.code, 200)
    assert.equal(ok.body.dir, '/home/op/sim')
    assert.deepEqual(ok.body.dirs, ['sub'])
    assert.equal(ok.body.parent, '/home/op')
    assert.equal((await callGet(handler, base + '?sessionId=s1')).code, 400) // missing machineId
    assert.equal((await callGet(handler, base + '?sessionId=s1&machineId=ghost')).code, 404)
    assert.equal((await callGet(handler, base + '?sessionId=stranger&machineId=node1')).code, 404)
    assert.equal((await callGet(handler, base + '?sessionId=s1&machineId=node1&dir=relative')).code, 400)
    restore()
  } finally { await rm(ws, { recursive: true, force: true }) }
})
