// Diagnosis-session surface (server/diagnose.js): entry sanitization and the
// session-controller handoff consumed by the self-check orchestrator. The
// Overview health-check handoff (buildDiagnosisPrompt + POST /api/checks/analyze)
// was retired with that panel on 2026-11-18 — the client half is pinned against
// the source text as GONE. Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFailed, createDiagnosisSession } from '../src/server/diagnose.js'
import { clientSrc } from './helpers.mjs'

test('diagnose: sanitizeFailed caps entries and text, drops unknown fields', () => {
  const big = 'x'.repeat(5000)
  const out = sanitizeFailed([
    { item: 'LSF jobs', cmd: 'bjobs', detail: big, result: 'r', rowsRaw: Array.from({ length: 40 }, (_, i) => 'line' + i), rows: [['a', 'b']], secret: 'nope', extraFn: () => {} },
    ...Array.from({ length: 12 }, (_, i) => ({ item: 'e' + i, detail: big })),
    'not-an-object',
  ])
  assert.equal(out.length, 8)
  assert.equal(out[0].detail.length, 1500 + '… (5000 chars total)'.length)
  assert.equal(out[0].rowsRaw.length, 20)
  assert.equal(out[0].rows[0].join(','), 'a,b')
  assert.equal(out[0].secret, undefined)
  assert.equal(out[1].item, 'e0')
  assert.ok(out.every((x) => x.ok === false))
  assert.equal(sanitizeFailed(null).length, 0)
})

test('diagnose: createDiagnosisSession drives create→prompt→rename and degrades soft', async () => {
  const calls = []
  const sc = {
    create: async (req) => { calls.push(['create', req]); return { sessionId: 'sess-new' } },
    prompt: async (req, signal) => { calls.push(['prompt', req, signal]) },
    rename: async (req) => { calls.push(['rename', req]) },
  }
  const ctx = { get: (n) => (n === 'sessionController' ? sc : null) }
  const r = await createDiagnosisSession(ctx, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.deepEqual(r, { sessionId: 'sess-new' })
  assert.deepEqual(calls[0], ['create', { workspaceId: 'ws-1' }])
  assert.equal(calls[1][0], 'prompt')
  assert.equal(calls[1][1].sessionId, 'sess-new')
  assert.match(calls[1][1].requestId, /^hams-diag-/)
  assert.deepEqual(calls[1][1].content, [{ type: 'text', text: 'P' }])
  // the public prompt(request, signal) requires a live cancellation signal
  assert.ok(calls[1][2] instanceof AbortSignal, 'prompt must be called with a signal (throwIfAborted)')
  assert.deepEqual(calls[2], ['rename', { sessionId: 'sess-new', title: 'T' }])

  // create failure → error, no prompt
  const ctxFail = { get: () => ({ create: async () => { throw new Error('workspace not found') }, prompt: async () => {} }) }
  const f = await createDiagnosisSession(ctxFail, { workspaceId: 'ws-x', title: 'T', prompt: 'P' })
  assert.match(f.error, /session create failed/)
  assert.equal(f.sessionId, undefined)

  // prompt failure after create → 502-shaped { error, sessionId }
  const ctxPromptFail = { get: () => ({ create: async () => ({ sessionId: 'sess-9' }), prompt: async () => { throw new Error('busy') } }) }
  const p = await createDiagnosisSession(ctxPromptFail, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.match(p.error, /prompt delivery failed/)
  assert.equal(p.sessionId, 'sess-9')

  // rename throwing must not fail the handoff
  const ctxRenameFail = { get: () => ({ create: async () => ({ sessionId: 'sess-8' }), prompt: async () => {}, rename: async () => { throw new Error('title service') } }) }
  const rr = await createDiagnosisSession(ctxRenameFail, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.deepEqual(rr, { sessionId: 'sess-8' })

  // missing controller → soft error (503 at the route)
  const miss = await createDiagnosisSession({ get: () => null }, { workspaceId: 'ws-1', title: 'T', prompt: 'P' })
  assert.match(miss.error, /sessionController service unavailable/)
})

// ---- client static contract (classic script: asserted against the source text) ----

const src = await clientSrc()

test('diagnose client: the health-check handoff surface is fully retired', () => {
  assert.ok(!src.includes('/checks/analyze'), 'the analyze route call must be gone from the client')
  assert.ok(!src.includes('AUTO_ANALYZE_REMOTE') && !src.includes('analyzeRun'), 'the auto-handoff machinery must be gone')
  assert.ok(!src.includes('buildDiagnosisPrompt'), 'no stale references to the removed prompt builder')
  for (const k of ['chk.analyze', 'chk.analyzing', 'chk.analyzeDone', 'chk.analyzeAuto', 'chk.analyzeFail']) {
    assert.ok(!src.includes(`'${k}':`), `dictionary key ${k} must be gone (both languages)`)
  }
})
