// src/subagent.js — the subagent identity / state-inheritance policy shared
// verbatim with the SmartAnaSim repo (THAT copy is the source of truth; this
// one is the mirror). Unit cases use plain objects shaped like DSH Agent
// records ({ id, session: { header } } with ctx.agents.get as the live-agent
// map), plus a resolveProjectTool integration over a fake workspace
// registry — the subagent anchoring fix this module exists for. The last
// test is the soft sync guard: byte-identity with the SAS sibling in the dev
// layout; an installed copy (no sibling) skips.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveSessionId, inheritsSessionState } from '../src/subagent.js'
import { resolveProjectTool } from '../src/core/project.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const user = (id) => ({ id, session: { header: { origin: undefined, isSeeded: false } } })
const sub = (id, parentId, isSeeded) => ({
  id,
  session: { header: { origin: 'subagent', parentSession: parentId, isSeeded } },
})
const ctxOf = (...agents) => {
  const m = new Map(agents.map((a) => [a.id, a]))
  return { agents: { get: (id) => m.get(id) } }
}

// ---- effectiveSessionId ----------------------------------------------------

test('effectiveSessionId: agent-less call -> null', () => {
  assert.equal(effectiveSessionId(ctxOf(), undefined), null)
  assert.equal(effectiveSessionId(ctxOf(), { session: { header: {} } }), null)
})

test('effectiveSessionId: plain session -> its own id (no header, fork, top-level)', () => {
  assert.equal(effectiveSessionId(ctxOf(), { id: 's1' }), 's1')
  const fork = { id: 's2', session: { header: { origin: undefined, parentSession: 's1', isSeeded: true } } }
  assert.equal(effectiveSessionId(ctxOf(fork), fork), 's2')
})

test('effectiveSessionId: subagent -> topmost user-visible ancestor (chain, fork break, dead parent, cycle)', () => {
  const root = user('root')
  const mid = sub('mid', 'root', true)
  const leaf = sub('leaf', 'mid', false)
  assert.equal(effectiveSessionId(ctxOf(root, mid, leaf), leaf), 'root')
  assert.equal(effectiveSessionId(ctxOf(root, mid, leaf), mid), 'root')
  const fork = { id: 'fork', session: { header: { origin: undefined, isSeeded: true } } }
  assert.equal(effectiveSessionId(ctxOf(fork, sub('c', 'fork', true)), sub('c', 'fork', true)), 'fork')
  assert.equal(effectiveSessionId(ctxOf(), sub('child', 'gone', true)), 'child', 'dead ancestor -> raw id')
  const a = sub('a', 'b', true)
  const b = sub('b', 'a', true)
  assert.equal(effectiveSessionId(ctxOf(a, b), a), 'a', 'cycle never hangs')
})

// ---- resolveProjectTool over the effective id (the subagent anchoring fix) --

test('resolveProjectTool anchors a subagent call on the ancestor workspace', () => {
  const registry = {
    list: () => [
      { id: 'w1', path: 'D:/proj/ws1', title: 'ws1', sessionIds: ['root'] },
      { id: 'w2', path: 'D:/proj/ws2', title: 'ws2', sessionIds: ['other'] },
    ],
  }
  const root = user('root')
  const child = sub('child', 'root', true)
  const ctx = ctxOf(root)
  // the raw child id resolves nothing; the effective id resolves ws1
  assert.equal(resolveProjectTool(registry, child.id, null).error.includes('not accounted'), true)
  const p = resolveProjectTool(registry, effectiveSessionId(ctx, child), null)
  assert.equal(p.project.id, 'w1')
  // an explicit project argument still wins over the lineage fallback
  const explicit = resolveProjectTool(registry, effectiveSessionId(ctx, child), 'D:/proj/ws2')
  assert.equal(explicit.project.id, 'w2')
})

// ---- inheritsSessionState (the generic guide-gate inheritance) -------------

test('inheritsSessionState: seeded child inherits an activated parent (Set and predicate probes)', () => {
  const parent = user('parent')
  const child = sub('child', 'parent', true)
  assert.equal(inheritsSessionState(ctxOf(parent, child), child, new Set(['parent'])), true)
  assert.equal(inheritsSessionState(ctxOf(parent, child), child, (id) => id === 'parent'), true)
  assert.equal(inheritsSessionState(ctxOf(parent, child), child, new Set()), false)
})

test('inheritsSessionState: non-seeded child / plain session / agent-less -> false; chain rules', () => {
  const parent = user('parent')
  assert.equal(inheritsSessionState(ctxOf(parent), sub('child', 'parent', false), new Set(['parent'])), false)
  assert.equal(inheritsSessionState(ctxOf(parent), parent, new Set(['parent'])), false)
  assert.equal(inheritsSessionState(ctxOf(), undefined, () => true), false)
  const root = user('root')
  const seededMid = sub('mid', 'root', true)
  const unseededMid = sub('umid', 'root', false)
  assert.equal(inheritsSessionState(ctxOf(root, seededMid, sub('leaf', 'mid', true)), sub('leaf', 'mid', true), new Set(['root'])), true)
  assert.equal(inheritsSessionState(ctxOf(root, unseededMid, sub('leaf2', 'umid', true)), sub('leaf2', 'umid', true), new Set(['root'])), false)
  // membership holds even when the parent Agent is not live; miss + dead
  // parent is false; a mutual-parent cycle never hangs
  assert.equal(inheritsSessionState(ctxOf(), sub('child', 'gone', true), new Set(['gone'])), true)
  assert.equal(inheritsSessionState(ctxOf(), sub('child', 'gone', true), new Set(['other'])), false)
  const a = sub('a', 'b', true)
  const b = sub('b', 'a', true)
  assert.equal(inheritsSessionState(ctxOf(a, b), a, new Set(['x'])), false)
})

// ---- the verbatim-sync guard (dev layout only) ------------------------------

test('shared module stays byte-identical with the SmartAnaSim source of truth (dev layout)', () => {
  const sibling = path.join(REPO, '..', 'HarnessAMS-SmartAnaSim', 'src', 'subagent.js')
  if (!existsSync(sibling)) return // installed copy: no sibling repo, skip
  const here = readFileSync(path.join(REPO, 'src', 'subagent.js'), 'utf8')
  const there = readFileSync(sibling, 'utf8')
  assert.equal(here, there, 'src/subagent.js drifted from the SmartAnaSim source of truth — edit the SAS copy first, then mirror here')
})
