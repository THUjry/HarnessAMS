// Trash module (src/trash.js). The sharp edges are pinned here: restore/purge must
// fence the entry name inside the trash root (no ../, no separators, no drive letters),
// trashing a plain file must not break meta writing, and purge is fenced rmtree.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { listTrash, purgeEntry, restoreEntry, trashPaths } from '../src/trash.js'

const sandbox = () => fs.mkdtempSync(path.join(tmpdir(), 'hams-trash-'))

test('trash: file and directory round-trip with meta + list shape', () => {
  const box = sandbox()
  try {
    const trash = path.join(box, '.trash')
    const file = path.join(box, 'a.txt')
    const dir = path.join(box, 'proj')
    fs.writeFileSync(file, 'hello trash')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'nested')

    const lines = trashPaths([file, dir], { trashDir: trash })
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^trashed .* -> /)

    const entries = listTrash({ trashDir: trash })
    assert.equal(entries.length, 2)
    const fileEntry = entries.find((e) => e.name.endsWith('_a.txt'))
    const dirEntry = entries.find((e) => e.name.endsWith('_proj'))
    assert.ok(fileEntry && dirEntry, JSON.stringify(entries.map((e) => e.name)))

    // new layout: entry dir holds the item under its own basename + meta
    const entryDir = path.join(trash, fileEntry.name)
    const meta = JSON.parse(fs.readFileSync(path.join(entryDir, '.trash_meta.json'), 'utf8'))
    assert.equal(meta.original_path, file)
    assert.equal(fs.readFileSync(path.join(entryDir, 'a.txt'), 'utf8'), 'hello trash')
    assert.ok(fileEntry.size_bytes > 0)
    assert.ok(dirEntry.size_bytes > 0)

    // restore the file entry: item comes back under its basename, entry dir gone
    const dest = path.join(box, 'back')
    const line = restoreEntry(fileEntry.name, dest, { trashDir: trash })
    assert.match(line, /^restored -> /)
    assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello trash')
    assert.ok(!fs.existsSync(entryDir))
    assert.equal(listTrash({ trashDir: trash }).length, 1)
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})

test('trash: fences — traversal, separators, drive letters, missing entries', () => {
  const box = sandbox()
  try {
    const trash = path.join(box, '.trash')
    fs.mkdirSync(trash, { recursive: true })
    fs.mkdirSync(path.join(trash, '20260109_000000_x'))
    fs.mkdirSync(path.join(box, 'outside')) // outside the trash root

    for (const bad of ['../outside', 'a/b', 'a\\b', 'C:\\evil', '..', '.', '']) {
      assert.throws(() => restoreEntry(bad, box, { trashDir: trash }), { message: /invalid trash entry name/ },
        `restoreEntry must reject ${JSON.stringify(bad)}`)
      assert.throws(() => purgeEntry(bad, { trashDir: trash }), { message: /invalid trash entry name/ },
        `purgeEntry must reject ${JSON.stringify(bad)}`)
    }
    assert.throws(() => restoreEntry('ghost', box, { trashDir: trash }), { message: /no such trash entry/ })
    assert.ok(fs.existsSync(path.join(box, 'outside')), 'nothing outside the trash was touched')
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})

test('trash: purge removes one entry; trash refuses missing paths and the trash dir itself', () => {
  const box = sandbox()
  try {
    const trash = path.join(box, '.trash')
    fs.mkdirSync(trash, { recursive: true })
    const victim = path.join(box, 'victim')
    fs.mkdirSync(path.join(victim, 'deep'), { recursive: true })
    fs.writeFileSync(path.join(victim, 'deep', 'f.bin'), 'x')
    trashPaths([victim], { trashDir: trash })
    const [entry] = listTrash({ trashDir: trash })
    assert.equal(purgeEntry(entry.name, { trashDir: trash }), `purged ${entry.name}`)
    assert.equal(listTrash({ trashDir: trash }).length, 0)
    assert.ok(!fs.existsSync(path.join(trash, entry.name)))

    assert.throws(() => trashPaths([path.join(box, 'missing')], { trashDir: trash }),
      { message: /path does not exist/ })
    assert.throws(() => trashPaths([trash], { trashDir: trash }), { message: /refusing to trash the trash/ })
    fs.writeFileSync(path.join(trash, 'inner.txt'), 'x')
    assert.throws(() => trashPaths([path.join(trash, 'inner.txt')], { trashDir: trash }),
      { message: /refusing to trash the trash/ })
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})

test('trash: legacy layout (item moved AS the entry, meta inside) restores whole entry', () => {
  const box = sandbox()
  try {
    const trash = path.join(box, '.trash')
    fs.mkdirSync(path.join(trash, '20260101_000000_oldproj'), { recursive: true })
    fs.writeFileSync(path.join(trash, '20260101_000000_oldproj', 'x.txt'), 'legacy')
    fs.writeFileSync(path.join(trash, '20260101_000000_oldproj', '.trash_meta.json'),
      JSON.stringify({ original_path: '/gone/oldproj', trashed_at: '20260101_000000' }))

    const line = restoreEntry('20260101_000000_oldproj', path.join(box, 'out'), { trashDir: trash })
    assert.match(line, /oldproj/)
    assert.equal(fs.readFileSync(path.join(box, 'out', 'oldproj', 'x.txt'), 'utf8'), 'legacy')
    assert.ok(!fs.existsSync(path.join(trash, '20260101_000000_oldproj')))
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }
})
