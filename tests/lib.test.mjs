// lib/ leaf-primitive contracts: the BOM-tolerant JSON readers, the atomic
// writers, the package-root/host-home paths, and the remote-path helpers.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileAsync, readJsonTolerant, readJsonBom, atomicWrite, atomicWriteSync } from '../src/lib/io.js'
import { PKG_ROOT, dshHome } from '../src/lib/paths.js'
import { remoteJoin, normalizeRemoteRoot, resolveRemoteDir, defaultRemoteScriptsDir, sanitizeRel } from '../src/lib/remotepath.js'

test('io: BOM-tolerant reads, atomic writes, promisified exec', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-lib-'))
  try {
    // readers: the tolerant face (null on missing/corrupt)…
    const bom = path.join(dir, 'bom.json')
    await writeFile(bom, '\uFEFF{"a":1}', 'utf8')
    assert.deepEqual(readJsonTolerant(bom), { a: 1 }, 'a BOM must not break the tolerant read')
    const corrupt = path.join(dir, 'corrupt.json')
    await writeFile(corrupt, '{nope', 'utf8')
    assert.equal(readJsonTolerant(corrupt), null, 'corrupt JSON degrades to null')
    assert.equal(readJsonTolerant(path.join(dir, 'missing.json')), null, 'missing file degrades to null')
    // …and the strict twin: same BOM tolerance, failures throw
    assert.deepEqual(readJsonBom(bom), { a: 1 })
    assert.throws(() => readJsonBom(corrupt), SyntaxError)
    // writers: tmp+rename in place, the last write wins, no leftovers
    const f = path.join(dir, 'state.json')
    await atomicWrite(f, '{"n":1}\n')
    await atomicWrite(f, '{"n":2}\n')
    atomicWriteSync(f, '{"n":3}\n')
    assert.equal(await readFile(f, 'utf8'), '{"n":3}\n')
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'no .tmp files remain after the atomic writes')
  } finally { await rm(dir, { recursive: true, force: true }) }
  // the promisified execFile: a spawned child's stdout resolves on the promise
  const r = await execFileAsync(process.execPath, ['-e', 'process.stdout.write("ok")'])
  assert.equal(r.stdout, 'ok')
})

test('paths: PKG_ROOT is the package root (src/) and dshHome honors DSH_HOME', () => {
  // src/lib/paths.js -> its parent is src/ (this package's npm root: the only
  // layout where index.js, package.json and the layer folders sit together);
  // this test lives in tests/, one level above src/.
  assert.equal(PKG_ROOT, path.resolve(import.meta.dirname ?? '.', '..', 'src'))
  assert.ok(fs.existsSync(path.join(PKG_ROOT, 'package.json')), 'PKG_ROOT must hold the package.json')
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'D:/proj/dsh-home-x'
    assert.equal(dshHome(), 'D:/proj/dsh-home-x')
    delete process.env.DSH_HOME
    assert.equal(dshHome(), path.join(os.homedir(), '.dsh'))
  } finally {
    if (saved !== undefined) process.env.DSH_HOME = saved
  }
})

test('remotepath: defaults, fencing and the scripts-root convention', () => {
  assert.equal(defaultRemoteScriptsDir('/home/op/sim/'), '/home/op/sim/.harnessams/scripts')
  assert.equal(remoteJoin('/a', 'b', 'c'), '/a/b/c')
  assert.equal(normalizeRemoteRoot('/a///'), '/a')
  assert.throws(() => normalizeRemoteRoot('a/b'), /must be absolute/)
  assert.equal(resolveRemoteDir('/r', 'sub/x'), '/r/sub/x')
  assert.equal(resolveRemoteDir('/r', '/r/abs'), '/r/abs')
  assert.throws(() => resolveRemoteDir('/r', '../escape'), /escapes the remote workspace/)
  assert.equal(sanitizeRel('a/b.py'), 'a/b.py')
  assert.throws(() => sanitizeRel('../x'), /unsafe relative path/)
})
