// Remote working-directory browser (server/remotebrowse.js + GET
// /api/remote-browse + POST /api/remote-browse/mkdir): find-TSV/ls-fallback
// listing parsing, POSIX parent resolution, the ssh_exec funnel wiring (batch
// contract, alias addressing, timeout-KILL wrapper), the mkdir name fence and
// the routes' error-code mapping. The default listing root is the project's
// settings.remote_root (passed by the route / by callers explicitly — the
// family remote_machines map is retired). Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { remoteBrowse, remoteMkdir, parseListing, remoteParent, validateDirName } from '../src/server/remotebrowse.js'
import { writeSettings } from '../src/core/settings.js'
import { registerRoutes, callGet, callPost, callRoute, batchOf } from './helpers.mjs'

test('remotebrowse: parseListing reads find TSV lines and ls fallback lines', () => {
  // primary find output: name TAB epoch-seconds (fractional seconds round)
  assert.deepEqual(parseListing('AutoAnalog\t1730000000\n.harnessams\t1730000001.6\n'),
    [{ name: 'AutoAnalog', mtime: 1730000000 }, { name: '.harnessams', mtime: 1730000002 }])
  // plain-ls fallback: trailing-slash lines carry no mtime (UI shows a dash)
  assert.deepEqual(parseListing('bin/\nboot/\nfile.txt\nlink/\nnested/deep/\n\n'),
    [{ name: 'bin', mtime: null }, { name: 'boot', mtime: null }, { name: 'link', mtime: null }])
  // unparsable lines drop silently; a tab inside a name stays in the name
  assert.deepEqual(parseListing('a\t100\nb/\nnoise\nx\t12x\na\tb\t300\n'),
    [{ name: 'a', mtime: 100 }, { name: 'b', mtime: null }, { name: 'a\tb', mtime: 300 }])
  assert.deepEqual(parseListing(''), [])
  assert.deepEqual(parseListing(null), [])
  assert.deepEqual(parseListing('a\nb\n'), [])
})

test('remotebrowse: remoteParent walks POSIX-style; "/" has none', () => {
  assert.equal(remoteParent('/'), null)
  assert.equal(remoteParent('///'), null)
  assert.equal(remoteParent('/home'), '/')
  assert.equal(remoteParent('/home/op/sim/'), '/home/op')
})

test('remotebrowse: validateDirName accepts one printable-ASCII segment only', () => {
  assert.equal(validateDirName(' new_folder '), 'new_folder') // trimmed
  assert.equal(validateDirName('a b'), 'a b') // spaces inside are legal
  assert.throws(() => validateDirName(''), /name must not be empty/)
  assert.throws(() => validateDirName('   '), /name must not be empty/)
  assert.throws(() => validateDirName('a/b'), /single path segment/)
  assert.throws(() => validateDirName('.hidden'), /hidden directories are not listed/)
  assert.throws(() => validateDirName('x'.repeat(65)), /name too long/)
  assert.throws(() => validateDirName('\u65b0\u6587\u4ef6\u5939'), /printable ASCII/)
  assert.throws(() => validateDirName('a\tb'), /printable ASCII/)
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

test('remotebrowse: lists one level through the exec funnel, defaulting to the given root', async () => {
  const inputs = []
  const ctx = makeCtx((args) => { inputs.push(args); return execOk('AutoAnalog\t1730000000\n.harnessams\t1730000001\n') })
  const r = await remoteBrowse(ctx, 'node1', null, '/home/op/sim')
  assert.deepEqual(r, {
    dir: '/home/op/sim', parent: '/home/op', truncated: false,
    entries: [{ name: '.harnessams', mtime: 1730000001 }, { name: 'AutoAnalog', mtime: 1730000000 }],
  })
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].alias, 'node1') // alias addressing, zero gating
  assert.equal(inputs[0].timeoutMs, 110_000) // 20s deadline + 90s replay margin
  const cmd = String(inputs[0].command).replace(/\\"/g, '"')
  assert.equal(cmd, 'timeout -s KILL 20s sh -c "find -L "/home/op/sim" -maxdepth 1 -mindepth 1 -type d ! -name \'.*\' -printf \'%P\\\\t%T@\\\\n\' 2>/dev/null || ls -1p "/home/op/sim""')

  // explicit dir, trailing slash normalized, parent of a deep path
  const r2 = await remoteBrowse(ctx, 'node1', '/home/op/sim/AutoAnalog/', '/home/op/sim')
  assert.equal(r2.dir, '/home/op/sim/AutoAnalog')
  assert.equal(r2.parent, '/home/op/sim')

  // no root saved -> the listing bootstraps at the machine's $HOME (the root
  // picker must work before any root exists — the free-typed input retired);
  // an ls-style (fallback) stdout yields entries without mtime
  const homeInputs = []
  const homeCtx = makeCtx((args) => {
    homeInputs.push(args)
    return /echo -n/.test(args.command) ? execOk('/home/op') : execOk('proj/\n')
  })
  const r3 = await remoteBrowse(homeCtx, 'node1', null, null)
  assert.equal(r3.dir, '/home/op')
  assert.deepEqual(r3.entries, [{ name: 'proj', mtime: null }])
  assert.equal(r3.parent, '/home')
  const homeCmd = String(homeInputs[0].command).replace(/\\"/g, '"')
  assert.equal(homeCmd, 'timeout -s KILL 20s sh -c "echo -n "\\$HOME""')
  const lsCmd = String(homeInputs[1].command).replace(/\\"/g, '"')
  assert.equal(lsCmd, 'timeout -s KILL 20s sh -c "find -L "/home/op" -maxdepth 1 -mindepth 1 -type d ! -name \'.*\' -printf \'%P\\\\t%T@\\\\n\' 2>/dev/null || ls -1p "/home/op""')

  // $HOME not resolvable (non-absolute answer) -> attributable error
  const badHome = makeCtx(() => execOk('not-a-path'))
  await assert.rejects(() => remoteBrowse(badHome, 'node1', null, null), /cannot determine the home directory/)
})

test('remotebrowse: caps the listing at 200 entries with a truncated flag', async () => {
  const ctx = makeCtx(() => execOk(Array.from({ length: 205 }, (_, i) => `d${String(i).padStart(3, '0')}\t1730000000\n`).join('')))
  const r = await remoteBrowse(ctx, 'node1', '/r', '/r')
  assert.equal(r.entries.length, 200)
  assert.equal(r.entries[0].name, 'd000')
  assert.equal(r.truncated, true)
})

test('remotebrowse: rejects bad dirs and unknown machines; surfaces exec failure verbatim', async () => {
  const ctx = makeCtx(() => execOk(''))
  await assert.rejects(() => remoteBrowse(ctx, 'node1', 'relative/path', '/home/op/sim'), /must be an absolute remote path/)
  await assert.rejects(() => remoteBrowse(ctx, 'ghost', null, '/home/op/sim'), /no such dsh-ssh host/)
  const fail = makeCtx(() => ({ success: false, exitCode: 2, timedOut: false, stdout: '', stderr: 'ls: cannot access /nope', durationMs: 2 }))
  await assert.rejects(() => remoteBrowse(fail, 'node1', '/nope', '/home/op/sim'), /remote listing failed for \/nope: ls: cannot access \/nope/)
})

test('remotebrowse: remoteMkdir runs a fenced plain mkdir through the exec funnel', async () => {
  const inputs = []
  const ctx = makeCtx((args) => { inputs.push(args); return execOk('') })
  const r = await remoteMkdir(ctx, 'node1', '/home/op/sim/', ' new_folder ')
  assert.deepEqual(r, { path: '/home/op/sim/new_folder' }) // trailing slash + name trimmed
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].alias, 'node1')
  assert.equal(inputs[0].timeoutMs, 110_000)
  const cmd = String(inputs[0].command).replace(/\\"/g, '"')
  assert.equal(cmd, 'timeout -s KILL 20s sh -c "mkdir "/home/op/sim/new_folder""')

  // the root dir needs no double slash
  const r2 = await remoteMkdir(ctx, 'node1', '/', 'tmpdir')
  assert.equal(r2.path, '/tmpdir')

  // name/dir validation and unknown machines never reach the wire
  await assert.rejects(() => remoteMkdir(ctx, 'node1', '/home/op/sim', 'a/b'), /single path segment/)
  await assert.rejects(() => remoteMkdir(ctx, 'node1', '/home/op/sim', '\u65b0\u6587\u4ef6\u5939'), /printable ASCII/)
  await assert.rejects(() => remoteMkdir(ctx, 'ghost', '/home/op/sim', 'ok'), /no such dsh-ssh host/)
  await assert.rejects(() => remoteMkdir(ctx, 'node1', 'relative', 'ok'), /must be an absolute remote path/)

  // exec failure surfaces the stderr verbatim (e.g. an existing name)
  const fail = makeCtx(() => ({ success: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'mkdir: cannot create directory /home/op/sim/new_folder: File exists', durationMs: 2 }))
  await assert.rejects(() => remoteMkdir(fail, 'node1', '/home/op/sim', 'new_folder'), /remote mkdir failed for \/home\/op\/sim\/new_folder: mkdir: cannot create/)
})

test('remotebrowse route: session->workspace mapping, root from settings, error codes', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-rb-route-'))
  try {
    // the default root comes from the project's workspace_config.json settings
    await writeSettings(ws, {
      run_mode: 'remote', machine_id: 'node1', remote_root: '/home/op/sim', remote_dir: '.harnessams/selfcheck',
      scheduler: 'lsf', simulator: 'spectre', compute_script_local: 'python', compute_script_remote: 'python',
    })
    const handler = await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w', path: ws, title: 'P', sessionIds: ['s1'] }] },
      tools: makeCtx(() => execOk('sub/\n')).tools,
    })
    const base = 'http://127.0.0.1/harnessams/api/remote-browse'
    const ok = await callGet(handler, base + '?sessionId=s1&machineId=node1')
    assert.equal(ok.code, 200)
    assert.equal(ok.body.dir, '/home/op/sim')
    assert.deepEqual(ok.body.entries, [{ name: 'sub', mtime: null }]) // fallback-format stdout
    assert.equal(ok.body.parent, '/home/op')
    assert.equal((await callGet(handler, base + '?sessionId=s1')).code, 400) // missing machineId
    assert.equal((await callGet(handler, base + '?sessionId=stranger&machineId=node1')).code, 404)

    // a project without remote_root in its settings -> the listing bootstraps
    // at the machine's $HOME (browse-only root; no 409 anymore)
    const bare = await mkdtemp(path.join(tmpdir(), 'hams-rb-bare-'))
    try {
      const handler2 = await registerRoutes({
        workspaceRegistry: { list: () => [{ id: 'w2', path: bare, title: 'P2', sessionIds: ['s2'] }] },
        tools: makeCtx((args) => (/echo -n/.test(args.command) ? execOk('/home/u') : execOk('sub/\n'))).tools,
      })
      const noRoot = await callGet(handler2, base + '?sessionId=s2&machineId=node1')
      assert.equal(noRoot.code, 200)
      assert.equal(noRoot.body.dir, '/home/u')
      assert.deepEqual(noRoot.body.entries, [{ name: 'sub', mtime: null }])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  } finally { await rm(ws, { recursive: true, force: true }) }
})

test('remotebrowse mkdir route: same-origin fence, validation codes, exec passthrough', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'hams-rb-mk-'))
  try {
    const execs = []
    const handler = await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w', path: ws, title: 'P', sessionIds: ['s1'] }] },
      tools: makeCtx((args) => { execs.push(args); return execOk('') }).tools,
    })
    const base = 'http://127.0.0.1/harnessams/api/remote-browse/mkdir'

    // the same-origin fence rejects Fetch-Metadata that says cross-site
    // (curl/tests send no sec-fetch-site and pass — see the POST below)
    const cross = { method: 'POST', url: base, headers: { 'sec-fetch-site': 'cross-site' } }
    assert.equal((await callRoute(handler, cross)).code, 403)

    const ok = await callPost(handler, base, { sessionId: 's1', machineId: 'node1', dir: '/home/op/sim', name: 'new_folder' })
    assert.equal(ok.code, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.path, '/home/op/sim/new_folder')
    assert.equal(execs.length, 1)
    assert.match(String(execs[0].command), /mkdir/)

    // name / dir validation -> 400; unknown session/machine -> 404; missing
    // ids -> 400
    assert.equal((await callPost(handler, base, { sessionId: 's1', machineId: 'node1', dir: '/r', name: 'a/b' })).code, 400)
    assert.equal((await callPost(handler, base, { sessionId: 's1', machineId: 'node1', dir: 'rel', name: 'ok' })).code, 400)
    assert.equal((await callPost(handler, base, { sessionId: 'stranger', machineId: 'node1', dir: '/r', name: 'x' })).code, 404)
    assert.equal((await callPost(handler, base, { sessionId: 's1', machineId: 'ghost', dir: '/r', name: 'x' })).code, 404)
    assert.equal((await callPost(handler, base, { machineId: 'node1', dir: '/r', name: 'x' })).code, 400)
    assert.equal((await callPost(handler, base, { sessionId: 's1', dir: '/r', name: 'x' })).code, 400)

    // exec failure -> 502 with the stderr text (an existing name)
    const failHandler = await registerRoutes({
      workspaceRegistry: { list: () => [{ id: 'w2', path: ws, title: 'P2', sessionIds: ['s2'] }] },
      tools: makeCtx(() => ({ success: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'mkdir: cannot create directory /r/x: File exists', durationMs: 2 })).tools,
    })
    const fail = await callPost(failHandler, 'http://127.0.0.1/harnessams/api/remote-browse/mkdir',
      { sessionId: 's2', machineId: 'node1', dir: '/r', name: 'x' })
    assert.equal(fail.code, 502)
    assert.match(fail.body.error, /File exists/)
  } finally { await rm(ws, { recursive: true, force: true }) }
})
