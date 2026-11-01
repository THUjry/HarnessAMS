// Check-failure diagnosis sessions (2026-11-01, branch check-diagnose-session):
// when an Overview check reports problems, the client can hand them to a freshly
// created DSH session instead of the old copy-to-clipboard flow. The host half
// assembles an English prompt from the failed entries and drives the DSH
// session controller (ctx service `sessionController`, same registry as the
// `sessions` service this plugin already consumes lazily): create() binds the
// new session to a workspace (a machine's remote-project workspace for remote
// checks — its cwd inside the mirror is what binds dsh-remote's rw_* tools to
// that machine), prompt() delivers the diagnosis text as the first user turn
// (the controller auto-resolves/starts the agent), rename() is cosmetic.
// Deliberately PRIVATE: no ctx service key and no model tool is registered for
// this — other plugins cannot route through it (by design, 2026-11-01).
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

// The prompt body is English by convention (server strings and model-facing
// text stay English per the UI spec); only the final line asks the agent to
// answer in the user's current UI language (client sends `lang`).
export function buildDiagnosisPrompt({ check, machine, remotePath, mirrorDir, projectTitle, failed, lang, auto }) {
  const label = { local: 'Local environment', load: 'Load', jobs: 'LSF jobs', batches: 'Batch dirs', scripts: 'Script sync' }[check] ?? check
  const lines = []
  lines.push('You are the diagnostic agent of the HarnessAMS workbench.')
  lines.push('')
  lines.push('A health check reported problems. Diagnose the root cause. Context:')
  lines.push(`- Check: ${label} (id: ${check})`)
  lines.push(`- Trigger: ${auto ? 'automatic — the check run ended with failed entries' : 'user button on the check results'}`)
  if (machine) {
    lines.push(`- Machine: ${machine.name || machine.host} (${machine.username ? machine.username + '@' : ''}${machine.host}:${machine.port ?? 22})`)
    if (remotePath) lines.push(`- Remote workspace path: ${remotePath}`)
    if (mirrorDir) lines.push(`- Local mirror of that workspace (this session's cwd sits inside it): ${mirrorDir}`)
  } else {
    lines.push('- Machine: local (this host)')
  }
  if (projectTitle) lines.push(`- Project: ${projectTitle}`)
  lines.push(`- Time: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('Failed entries (ok = false), verbatim from the check run:')
  const entries = sanitizeFailed(failed)
  entries.forEach((x, i) => {
    lines.push(`${i + 1}. ${x.item}`)
    if (x.cmd) lines.push(`   command: ${x.cmd}`)
    if (x.result) lines.push(`   summary: ${x.result}`)
    if (x.detail) lines.push(`   detail: ${x.detail}`)
    if (x.warn) lines.push(`   warning: ${x.warn}`)
    if (x.truncated) lines.push('   (output was truncated)')
    if (x.rowsRaw?.length) {
      lines.push('   raw output lines:')
      for (const l of x.rowsRaw) lines.push('     ' + l)
    } else if (x.rows?.length) {
      lines.push('   parsed rows: ' + x.rows.map((r) => '| ' + r.join(' | ')).join('  '))
    }
  })
  lines.push('')
  lines.push('Instructions:')
  lines.push('- READ-ONLY diagnosis: do not create, modify, move, or delete anything.')
  if (machine) {
    lines.push('- This session was created inside the machine\'s remote-project workspace, so dsh-remote binds its remote tools to that machine: you may run read-only commands on it (e.g. via the rw_* tools) to verify. If a remote tool errors out, say so and analyze from the evidence above instead.')
  } else {
    lines.push('- You may run read-only local commands to verify (the workspace is this machine\'s HarnessAMS workspace).')
  }
  lines.push('- Give: (1) the most likely root cause, (2) the evidence for it, (3) the next concrete read-only command(s) to confirm, and, when obvious, (4) what a fix would look like — without applying it.')
  lines.push('- Keep the answer compact and structured.')
  lines.push('')
  lines.push(lang === 'zh' ? 'Answer in Chinese.' : 'Answer in English.')
  return lines.join('\n')
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
