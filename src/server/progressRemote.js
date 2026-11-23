// Remote live progress for the batch_poll session card (client.js useSimProgress,
// D-008): reads the batch's own progress files on the executing side — over the
// dsh-ssh exec funnel, or locally through the ctx.shell seam for an in-cluster
// LSF job (no machine in the job file; bjobs and the progress files live on
// this host's shared filesystem) — the same pollCommand one-shot the
// batch_poll tool runs, minus the queue-id ceremony. Everything the poll needs
// (machine alias, remote dir, job id, total_points fallback) comes from the
// run dir's .batch_job.json that batch_submit wrote — the caller supplies
// nothing beyond the fenced runDir.
// Like remotebrowse.js this server module bridges to remote.js/batch.js helpers
// (pure modules, no ctx coupling); progress.js itself stays a pure local-fs read.
//
// A short single-flight cache bounds the ssh pressure: however many cards poll
// (and however often scroll remounts refetch), each run dir costs at most one
// exec channel per TTL window — comfortably under the ~10-channel MaxSessions
// budget of one shared connection. Failures resolve to { unreachable: true }
// (HTTP 200) so the card keeps its last frame plus a dim note instead of going
// blank — the D-008 rule: a visible card at every moment, placeholder never.
import path from 'node:path'
import { readRunProgress } from './progress.js'
import { readJob, pollCommand, parsePollOutput, resolveRemoteDir } from '../batch.js'
import { resolveMachine, execRemote } from '../remote.js'
import { execLocal } from '../localchannel.js'

const CACHE_TTL_MS = 4_000
const CACHE_MAX = 64
const POLL_TIMEOUT_MS = 10_000
const remoteCache = new Map() // resolved runDir -> { ts, promise }

// One remote poll, uncached. Never rejects — every failure becomes the
// unreachable shape the client renders as "keep last frame + note".
async function pollRemoteJob(ctx, runDir, job) {
  try {
    const scheduler = job.scheduler === 'ssh' ? 'ssh' : 'lsf'
    const jobId = String(job.job_id ?? '')
    if (!/^[\w.-]+$/.test(jobId)) throw new Error(`job file has no usable job_id (${jobId || 'none'})`)
    // In-cluster LSF (no machine recorded): poll through the local shell seam.
    let exec
    let remoteRoot = job.remote_root
    if (scheduler === 'lsf' && job.cluster_env === 'in-cluster' && !job.machine_id) {
      exec = (cmd, opts) => execLocal(ctx, cmd, opts)
    } else {
      const target = await resolveMachine(ctx, job.machine_id, job.remote_root)
      remoteRoot = target.remoteRoot
      exec = (cmd, opts) => execRemote(ctx, target.alias, cmd, opts)
    }
    const remoteDir = resolveRemoteDir(remoteRoot, job.remote_dir)
    const r = await exec(pollCommand({ remoteDir, jobId, scheduler }), { timeoutMs: POLL_TIMEOUT_MS })
    if (!r.ok) {
      return { remote: true, unreachable: true, run_dir: runDir,
        error: String(r.stderr || r.stdout || r.text || 'remote poll failed').slice(0, 400) }
    }
    return { remote: true, run_dir: runDir, ...parsePollOutput(r.stdout, { total: job.total_points }) }
  } catch (e) {
    return { remote: true, unreachable: true, run_dir: runDir, error: String(e?.message ?? e).slice(0, 400) }
  }
}

export async function progressRemotePayload(ctx, runDir) {
  const dir = String(runDir ?? '').trim()
  const job = dir ? readJob(dir) : null
  if (!job || job.scheduler === 'local') {
    // Not a submitted batch (local sweep / plain directory), or a scheduler=local
    // one — the run directory IS the truth on this host: local semantics,
    // identical to /api/progress (the client normalizes both shapes alike).
    // Without the local branch the endpoint tried to resolve a remote machine
    // off a job file that has none, answered `unreachable`, and the card froze
    // on its first frame (2026-11-23 instance check).
    return { remote: false, ...readRunProgress(dir) }
  }
  const key = path.resolve(dir)
  const hit = remoteCache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.promise
  const promise = pollRemoteJob(ctx, dir, job)
  remoteCache.set(key, { ts: Date.now(), promise })
  if (remoteCache.size > CACHE_MAX) {
    // Insertion-order prune: drop the oldest entry (first Map key).
    remoteCache.delete(remoteCache.keys().next().value)
  }
  return promise
}

// Test seam: the single-flight cache is module state; tests reset it between cases.
export function resetRemoteCacheForTest() {
  remoteCache.clear()
}
