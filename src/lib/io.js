// Shared IO primitives — the single implementation of each (D-001): the
// promisified execFile shared by every local process channel, the BOM-tolerant
// JSON readers, and the atomic tmp+rename writers. Zero dependencies beyond
// node builtins: lib/ holds leaf primitives only, and no project or session
// context ever enters this layer.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

export const execFileAsync = promisify(execFile)

// BOM-tolerant parse of already-read text (the parse half alone, for
// consumers that read with their own async fs).
export function parseJsonBom(text) {
  const s = String(text)
  return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
}

// Tolerant JSON read: strip a UTF-8 BOM before parsing, null on ANY failure
// (missing, unreadable, corrupt). The plugin's own writes are atomic and
// BOM-free; hand-copied fixtures and zh-CN Windows editors are not.
export function readJsonTolerant(file) {
  try {
    return parseJsonBom(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Strict variant for fail-loud consumers: the same BOM tolerance, but a read
// or parse failure throws (the caller decides what a missing file means).
export function readJsonBom(file) {
  return parseJsonBom(fs.readFileSync(file, 'utf8'))
}

// Atomic write (tmp + rename): a reader never sees a half-written file, and a
// crashed writer leaves at most a stray .tmp beside the target. The async and
// sync twins both exist because live call sites use both styles.
export async function atomicWrite(file, text) {
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, file)
}

export function atomicWriteSync(file, text) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
