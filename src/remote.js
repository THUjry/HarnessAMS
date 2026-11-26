// Thin @linxin666/dsh-ssh shell used by the generic batch tools and the remote
// server surfaces (the single remote channel since the dsh-remote retirement,
// 2026-11-14; selection evidence = the docs/sshStudy selection conclusion (2026-11-13)).
//
// Coupling contract (@linxin666/dsh-ssh 0.4.18, exact-pinned in the web
// profile; tool shapes re-verified against the installed package's src/tools.ts):
//   - only ssh_list / ssh_exec / ssh_upload / ssh_download are consumed;
//   - zero gating: no agent/binding context is needed — every call targets an
//     `alias` configured in $DSH_HOME/dsh-ssh.json (the dsh-ssh host registry);
//   - ctx.tools.execute takes the batch contract (verified against
//     @deepseek-ai/dsh-tools 0.2.2-rc.1 AND 0.2.2-rc.3 by tarball diff): {
//     calls: [{type,id,name,arguments(JSON string)}], signal } in,
//     { results: [{callId,result}] } out — see callTool; a tool's structured
//     JSON value rides on result.value (ToolExecutionSuccess.value);
//   - ssh_list → value { hosts: [{alias,host,port,user,auth,keyReady,…}] };
//   - ssh_exec → value { success, exitCode|null, timedOut, stdout, stderr,
//     durationMs, error? } — connect/execution failures are VALUES, not throws
//     (only tool-pipeline problems throw);
//   - ssh_upload → value { ok, transferredBytes?, files?, error? } (single
//     file per call; parent directories are auto-created remotely);
//   - ssh_download → value { ok, bytes?, error? } (single file only);
//   - the remote root per alias is NOT dsh-ssh data: it is a per-project
//     setting (workspace_config.json settings.remote_root, 2026-11-19 D-004)
//     passed explicitly by every consumer — no family-level map, no merge.
//
// Hardening owned by this funnel (selection-doc §6/§7 mitigations):
//   - every exec is wrapped in `timeout -s KILL <N>s sh -c …` (no `--`:
//     busybox-flavored timeout treats it as the command) so the remote
//     process is guaranteed to die at the deadline (dsh-ssh's own kill on
//     timeout is best-effort: stream KILL + channel close, connection kept);
//   - an outer abort `signal` (the turn's exec.signal) both rides the batch
//     input — dsh-ssh's exec tool forwards it into stream KILL + channel
//     close — and races the batch in callTool, because the host drains an
//     aborted batch until its bodies settle and sftp has no dsh-ssh abort
//     path at all; the orphaned transfer/upload is harmless (idempotent);
//   - dsh-ssh replays a broken-connection exec up to 3 times and each replay
//     resets the command budget — the outer AbortSignal covers
//     3 × (deadline + connect), the only hard stop in town;
//   - transfers never replay (sftp.ts has zero retry), so an interrupted
//     upload/download surfaces as a plain failure the caller may retry;
//   - ssh2 channel-open failures carry no MaxSessions wording, so open-failure
//     error shapes get a "suspected MaxSessions" annotation (visible-and-
//     attributable ruling, 2026-11-13: no waiting, no semaphore).
import crypto from 'node:crypto'

// Extract the text payload of a ToolExecutionResult: value may be the raw
// string or a {text} object; content is a ContentBlock[] of {type:'text'}.
export function resultText(r) {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r.value === 'string') return r.value
  if (r.value && typeof r.value === 'object' && typeof r.value.text === 'string') return r.value.text
  if (Array.isArray(r.content)) return r.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

// Extract the structured JSON value of a successful ToolExecutionResult (the
// ssh_* tools declare output schemas, so their values are objects).
export function resultValue(r) {
  if (r == null || r.isError) return null
  return r.value !== undefined ? r.value : null
}

// Unwrap host pipeline errors: ToolBatchExecutionError carries the real failure
// on .cause ("Tool batch execution failed" alone hides it).
function errDetail(e) {
  const msg = String(e?.message ?? e)
  return e?.cause?.message ? `${msg} (${e.cause.message})` : msg
}

// ssh2 raises channel-open failures as "Open failed: <reason>" strings with no
// MaxSessions wording; the common server-side reason for a burst of those is
// the per-connection session limit. Annotate the shape (never swallow it).
const CHANNEL_OPEN_FAILURE = /open (failure|failed)|administratively prohibited|channel (open|failure)|session open (refused|failed)/i
export function attributeSshError(text) {
  const t = String(text ?? '')
  return CHANNEL_OPEN_FAILURE.test(t)
    ? `${t} [suspected MaxSessions (concurrent channel limit on one SSH connection) — retry serially]`
    : t
}

export function shq(s) {
  return '"' + String(s ?? '').replace(/([$"\\`])/g, '\\$1') + '"'
}

// The one programmatic tool-call funnel (batch contract, see header). Returns
// { isError, text, value } — never throws; pipeline errors land in .text with
// their cause unwrapped and channel-open shapes annotated. An optional external
// `signal` (the turn abort signal from a tool's exec.signal, or the self-check
// stop) combines with the timeout AND races the batch: the host never abandons
// a started tool body (an aborted batch drains until its bodies settle, and
// dsh-ssh uploads/downloads have no abort support at all), so without the race
// an aborted turn would still wait out the transfer. Losing the race returns
// here at once; the orphaned batch keeps running underneath — harmless
// (re-staging uploads are idempotent, and exec-shaped calls additionally
// receive the fused signal, which dsh-ssh turns into KILL + channel close).
const RACE_ABORTED = Symbol('race-aborted')
const ABORT_TEXT = 'aborted: the session stop cancelled this call locally — the remote operation state is uncertain (it may still be in flight); re-verify the remote state before acting'
export async function callTool(ctx, name, args, { timeoutMs = 40_000, signal } = {}) {
  const def = ctx?.tools?.get?.(name)
  if (!def) return { isError: true, text: `${name} is not registered (install/enable @linxin666/dsh-ssh)`, value: null }
  if (signal?.aborted) return { isError: true, text: ABORT_TEXT, value: null }
  try {
    const batchPromise = ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: 'hams-sim-' + crypto.randomUUID(),
        name,
        arguments: JSON.stringify(args ?? {}),
      }],
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    })
    let batch
    if (signal) {
      let onAbort = null
      const abortPromise = new Promise((resolve) => {
        onAbort = () => resolve(RACE_ABORTED)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const winner = await Promise.race([batchPromise, abortPromise])
        if (winner === RACE_ABORTED) return { isError: true, text: ABORT_TEXT, value: null }
        batch = winner
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    } else {
      batch = await batchPromise
    }
    const r = batch?.results?.[0]?.result
    if (!r) return { isError: true, text: `${name}: ToolBatchResult carried no result entry`, value: null }
    return { isError: !!r.isError, text: resultText(r), value: resultValue(r) }
  } catch (e) {
    return { isError: true, text: attributeSshError(errDetail(e)), value: null }
  }
}

// ssh_list → machine records (pure dsh-ssh registry projection). Identity is
// the alias (id === name === alias); the remote root is NOT part of the record
// anymore — each consumer passes the project's settings.remote_root explicitly.
export async function listMachines(ctx, timeoutMs = 10_000) {
  const def = ctx?.tools?.get?.('ssh_list')
  if (!def) return { ok: false, machines: [], reason: 'ssh_list is not registered (@linxin666/dsh-ssh not installed?)' }
  const r = await callTool(ctx, 'ssh_list', {}, { timeoutMs })
  if (r.isError) return { ok: false, machines: [], reason: attributeSshError(r.text || 'ssh_list failed') }
  const hosts = Array.isArray(r.value?.hosts) ? r.value.hosts : []
  if (!hosts.length) {
    return { ok: false, machines: [], reason: 'no hosts configured in dsh-ssh (add aliases in its panel or ~/.dsh/dsh-ssh.json)' }
  }
  const machines = hosts.map((h) => {
    const alias = String(h?.alias ?? '')
    return {
      id: alias,
      name: alias,
      alias,
      host: String(h?.host ?? alias),
      port: Number(h?.port) || 22,
      username: String(h?.user ?? ''),
      auth: String(h?.auth ?? ''),
      keyReady: !!h?.keyReady,
    }
  })
  return { ok: true, machines }
}

// ssh_exec funnel: guaranteed-kill wrapper + structured result normalization.
// `machine` is the alias string or a listMachines record. The command always
// runs as `timeout -s KILL <N>s sh -c <command>` remotely (no `--`, see
// header), so exit 137
// (128+SIGKILL) is the remote deadline firing, not a command failure.
export async function execRemote(ctx, machine, command, { timeoutMs = 40_000, signal } = {}) {
  const alias = typeof machine === 'string' ? machine : (machine?.alias ?? machine?.id)
  if (!alias) return { ok: false, isError: true, text: 'no machine alias', stdout: '', stderr: 'no machine alias', exitCode: -1, timedOut: false }
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  // no `--` separator: busybox-flavored `timeout` (node1) treats it as the
  // command itself ("failed to run command '--'", live-sampled 2026-11-14);
  // GNU coreutils accepts the plain form equally.
  const wrapped = `timeout -s KILL ${seconds}s sh -c ${shq(command)}`
  const r = await callTool(ctx, 'ssh_exec',
    // Tool-level budget sits above the remote deadline so the wrapper's exit
    // code comes back as a value; the outer signal covers 3 broken-connection
    // replays (each replay re-runs the wrapped command, so each costs at most
    // deadline + connect). `signal` is the caller's abort signal (the turn's
    // exec.signal): it both races the call (see callTool) and rides the batch
    // input, where dsh-ssh's exec tool forwards it into KILL + channel close.
    { alias, command: wrapped, timeoutMs: timeoutMs + 90_000 },
    { timeoutMs: 3 * (timeoutMs + 90_000) + 60_000, signal })
  if (r.isError) {
    const text = attributeSshError(r.text)
    return { ok: false, isError: true, text, stdout: '', stderr: text, exitCode: -1, timedOut: false }
  }
  const v = (r.value && typeof r.value === 'object') ? r.value : {}
  const stdout = String(v.stdout ?? '')
  const stderrRaw = String(v.stderr ?? '')
  // Connection/channel errors ride on value.error with success:false (the tool
  // layer catches them into the value) — the MaxSessions shape lives here too
  // (live-sampled on node1: "(SSH) Channel open failure: open failed").
  const errorText = v.error != null ? attributeSshError(String(v.error)) : ''
  const killed = Number(v.exitCode) === 137
  const timedOut = !!v.timedOut || killed
  const ok = v.success === true && !timedOut
  return {
    ok,
    isError: false,
    text: errorText || stdout,
    stdout,
    stderr: stderrRaw || errorText,
    exitCode: v.exitCode ?? null,
    timedOut,
  }
}

// Single-file upload (dsh-ssh auto-creates parent directories remotely).
// dsh-ssh sftp has no abort support, so `signal` only races the wait here —
// an aborted turn returns at once while the orphaned transfer finishes
// underneath (uploads are idempotent re-staging; no log side effects).
export async function uploadFile(ctx, machine, localPath, remotePath, { signal } = {}) {
  const alias = typeof machine === 'string' ? machine : (machine?.alias ?? machine?.id)
  const r = await callTool(ctx, 'ssh_upload', { alias, localPath, remotePath }, { timeoutMs: 300_000, signal })
  const v = (r.value && typeof r.value === 'object' && !r.isError) ? r.value : {}
  const ok = !r.isError && v.ok === true
  return {
    ok,
    text: ok
      ? `uploaded ${v.files ?? 1} file(s), ${v.transferredBytes ?? 0} bytes`
      : attributeSshError(String(v.error ?? r.text ?? 'upload failed')),
  }
}

// Single-file download (directories are not supported by dsh-ssh; the batch
// channel tars remotely and downloads the one archive). Same signal semantics
// as uploadFile: race-only (sftp has no abort path), orphaned transfer is
// harmless.
export async function downloadFile(ctx, machine, remotePath, localPath, { signal } = {}) {
  const alias = typeof machine === 'string' ? machine : (machine?.alias ?? machine?.id)
  const r = await callTool(ctx, 'ssh_download', { alias, remotePath, localPath }, { timeoutMs: 300_000, signal })
  const v = (r.value && typeof r.value === 'object' && !r.isError) ? r.value : {}
  const ok = !r.isError && v.ok === true
  return {
    ok,
    text: ok
      ? `downloaded ${v.bytes ?? 0} bytes`
      : attributeSshError(String(v.error ?? r.text ?? 'download failed')),
  }
}

// Resolve an alias (machine_id) + the project's remote root to
// { machine, alias, remoteRoot }: the machine must exist in the dsh-ssh host
// registry and the root must be an absolute remote path — it fences every
// remote_dir (resolveRemoteDir in batch.js). Callers pass the project's
// settings.remote_root (or a per-call remote_root argument).
export async function resolveMachine(ctx, machineId, remoteRoot) {
  if (!machineId) {
    throw new Error('no machine configured for this project (machine_id) — set one in the Overview '
      + 'settings table or the AGENTS.md config block, or see the machine card / ssh_list')
  }
  const root = typeof remoteRoot === 'string' ? remoteRoot.trim().replace(/\\/g, '/') : ''
  if (!root || !root.startsWith('/')) {
    throw new Error(`remote_root is required for host ${machineId} (an absolute remote path — the `
      + 'project\'s configured remote_root, shown in the AGENTS.md config block)')
  }
  const list = await listMachines(ctx)
  if (!list.ok) throw new Error(`dsh-ssh hosts unavailable: ${list.reason}`)
  const machine = list.machines.find((m) => m.id === machineId || m.name === machineId)
  if (!machine) {
    throw new Error(`no such dsh-ssh host: ${machineId} (known: ${list.machines.map((m) => m.id).join(', ')})`)
  }
  return { machine, alias: machine.id, remoteRoot: root }
}
