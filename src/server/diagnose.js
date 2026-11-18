// Self-check diagnosis sessions: when a self-check run ends with failed steps,
// the orchestrator (selfcheck.js) hands them to a freshly created DSH session.
// This module drives the DSH session controller (ctx service
// `sessionController`): create() binds the new session to the current project's
// workspace, prompt() delivers the diagnosis text as the first user turn (the
// controller auto-resolves/starts the agent), rename() is cosmetic. The old
// Overview health-check handoff (buildDiagnosisPrompt + POST /api/checks/analyze)
// was retired with that panel on 2026-11-18 — selfcheck.js builds its own prompt
// and consumes sanitizeFailed/createDiagnosisSession directly.
// Deliberately PRIVATE: no ctx service key and no model tool is registered for
// this — other plugins cannot route through it (by design).
import { randomUUID } from 'node:crypto'

// Prompt-size guards: a check run can carry wide tables, but the diagnosis
// agent only needs the failure signals — cap entries and text so the prompt
// stays a few KB even for a 30-row bjobs listing.
const MAX_FAILED_ENTRIES = 8
const MAX_TEXT_CHARS = 1500
const MAX_RAW_LINES = 20
const MAX_RAW_LINE_CHARS = 300

const cap = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + `… (${t.length} chars total)` : t
}

// Keep only the fields that carry diagnostic signal, size-capped. Unknown
// fields are dropped so a client cannot bloat or shape the prompt freely.
export function sanitizeFailed(failed) {
  const list = Array.isArray(failed) ? failed.filter((x) => x && typeof x === 'object') : []
  return list.slice(0, MAX_FAILED_ENTRIES).map((x) => {
    const out = { item: cap(x.item, 120), ok: false, ms: Number(x.ms) || 0 }
    if (x.cmd) out.cmd = cap(x.cmd, 500)
    if (x.result) out.result = cap(x.result, MAX_TEXT_CHARS)
    if (x.detail) out.detail = cap(x.detail, MAX_TEXT_CHARS)
    if (x.warn) out.warn = cap(x.warn, 300)
    if (x.truncated) out.truncated = true
    if (Array.isArray(x.rowsRaw) && x.rowsRaw.length) {
      out.rowsRaw = x.rowsRaw.slice(0, MAX_RAW_LINES).map((l) => cap(l, MAX_RAW_LINE_CHARS))
    }
    if (Array.isArray(x.rows) && x.rows.length) {
      out.rows = x.rows.slice(0, MAX_RAW_LINES).map((r) => (Array.isArray(r) ? r.map((c) => cap(c, 200)) : []))
    }
    return out
  })
}

// Create the diagnosis session and deliver the prompt. Lazy-degrading access
// to `sessionController` (same pattern as ctx.get('sessions') in machines.js):
// a composition without it fails soft with { error }, never throws. rename()
// is best-effort — a missing/failed title service must not fail the handoff.
export async function createDiagnosisSession(ctx, { workspaceId, title, prompt }) {
  const sc = typeof ctx?.get === 'function' ? ctx.get('sessionController') : null
  if (!sc || typeof sc.create !== 'function' || typeof sc.prompt !== 'function') {
    return { error: 'sessionController service unavailable — cannot create a diagnosis session (dsh version without the session API?)' }
  }
  let sessionId
  try {
    const r = await sc.create({ workspaceId })
    sessionId = r?.sessionId
  } catch (e) {
    return { error: 'session create failed: ' + String(e?.message ?? e) }
  }
  if (!sessionId) return { error: 'session create returned no sessionId' }
  try {
    // The controller's public prompt(request, signal) REQUIRES the cancellation
    // signal as the second argument (it calls signal.throwIfAborted() before
    // admission — verified 0.2.1-rc.2); admission itself is quick, so a bounded
    // timeout signal is enough.
    await sc.prompt({
      sessionId,
      requestId: 'hams-diag-' + randomUUID(),
      content: [{ type: 'text', text: prompt }],
    }, AbortSignal.timeout(15000))
  } catch (e) {
    // The session exists but stayed empty — report both so the client can point
    // the user at it anyway (the prompt can be re-sent manually).
    return { error: 'session created but prompt delivery failed: ' + String(e?.message ?? e), sessionId }
  }
  try {
    if (typeof sc.rename === 'function') await sc.rename({ sessionId, title })
  } catch { /* the title is cosmetic */ }
  return { sessionId }
}
