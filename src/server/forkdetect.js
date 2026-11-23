// Fork detection (2026-11-19, decisions.md D-005): decides whether a DSH session
// was forked from another one, WITHOUT chasing the branch point. rc.3 ordinary
// forks deliberately carry no parentSession in headers or list rows; the only
// durable signal is the inherited cut marker the fork seed writes into the
// child's own log (dsh-session buildForkSeed): an event
//   { type: 'session/end-seed', data: { inherited: true } }
// followed by synthetic {kind:'forked'} closers. Resumed (non-fork) sessions
// also write session/end-seed events but WITHOUT inherited:true — the flag is
// the exact predicate, not the event type alone (probe-verified live:
// harnessams-workspace/probe-taskmerge-20261119/PROBE-RESULT.md).
//
// Everything here fails open to "not a fork": a missing log, a corrupt zstd
// stream, or an unreadable DSH home must never break the sidebar's first-seen
// flow — a session that cannot be proven forked simply starts empty.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const SID_RE = /^[\w-]{1,128}$/

// <dshHome>/sessions/<workspace-dir>/<sessionId>/session.v4.jsonl.zstd
// (the workspace-dir segment is a mangled path; matching by sessionId
// subdirectory keeps this independent of the mangling rule).
function sessionLogPath(dshHome, sessionId) {
  const sessionsRoot = path.join(dshHome, 'sessions')
  let workspaces
  try { workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return null }
  for (const ent of workspaces) {
    if (!ent.isDirectory()) continue
    const log = path.join(sessionsRoot, ent.name, sessionId, 'session.v4.jsonl.zstd')
    try { if (fs.statSync(log).isFile()) return log } catch { /* keep looking */ }
  }
  return null
}

// True when the session's log carries an inherited fork cut. Sync + bounded:
// called at most once per session (while it has no sessions.json entry yet).
export function isForkSession(sessionId, dshHome) {
  if (typeof sessionId !== 'string' || !SID_RE.test(sessionId)) return false
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const log = sessionLogPath(home, sessionId)
  if (!log) return false
  let text
  try {
    text = zstdDecompressSync(fs.readFileSync(log)).toString('utf8')
  } catch { return false }
  for (const line of text.split('\n')) {
    if (!line.includes('session/end-seed')) continue // fast reject before JSON.parse
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'session/end-seed' && ev?.data && ev.data.inherited === true) return true
    } catch { /* skip malformed line */ }
  }
  return false
}
