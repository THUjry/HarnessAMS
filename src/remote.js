// Thin @linxin666/dsh-ssh shell used by the generic batch tools and the remote
// server surfaces (the single remote channel since the dsh-remote retirement,
// 2026-11-14; selection evidence = docs/sshStudy/dsh-remote替代选型结论20261113.md).
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
//   - the remote root per alias is NOT dsh-ssh data: it comes from the
//     workspace harnessams.json `remote_machines` map (alias → absolute remote
//     path), merged into the machine records by listMachines.
//
// Hardening owned by this funnel (selection-doc §6/§7 mitigations):
//   - every exec is wrapped in `timeout -s KILL <N>s sh -c …` (no `--`:
//     busybox-flavored timeout treats it as the command) so the remote
//     process is guaranteed to die at the deadline (dsh-ssh's own kill on
//     timeout is best-effort: stream KILL + channel close, connection kept);
//   - dsh-ssh replays a broken-connection exec up to 3 times and each replay
//     resets the command budget — the outer AbortSignal covers
//     3 × (deadline + connect), the only hard stop in town;
//   - transfers never replay (sftp.ts has zero retry), so an interrupted
//     upload/download surfaces as a plain failure the caller may retry;
//   - ssh2 channel-open failures carry no MaxSessions wording, so open-failure
//     error shapes get a "suspected MaxSessions" annotation (visible-and-
//     attributable ruling, 2026-11-13: no waiting, no semaphore).
import crypto from 'node:crypto'
import { findWorkspaceConfig } from './server/workspace.js'

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
// their cause unwrapped and channel-open shapes annotated.
export async function callTool(ctx, name, args, { timeoutMs = 40_000 } = {}) {
  const def = ctx?.tools?.get?.(name)
  if (!def) return { isError: true, text: `${name} is not registered (install/enable @linxin666/dsh-ssh)`, value: null }
  try {
    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: 'hams-sim-' + crypto.randomUUID(),
        name,
        arguments: JSON.stringify(args ?? {}),
      }],
      signal: AbortSignal.timeout(timeoutMs),
    })
    const r = batch?.results?.[0]?.result
    if (!r) return { isError: true, text: `${name}: ToolBatchResult carried no result entry`, value: null }
    return { isError: !!r.isError, text: resultText(r), value: resultValue(r) }
  } catch (e) {
    return { isError: true, text: attributeSshError(errDetail(e)), value: null }
  }
}

// The remote root per alias: harnessams.json `remote_machines` (alias →
// absolute remote path). Hand-edited like the rest of that file; read-only
// here. Returns a Map (empty when unconfigured — machines then surface as
// "no remote root" instead of failing the whole listing). The
// HARNESSAMS_REMOTE_MACHINES env override (inline JSON map, same shape) exists
// for tests/hermetic layouts, mirroring HARNESSAMS_SIM_SCRIPTS_DIR.
export function readRemoteMachines() {
  let map = null
  if (process.env.HARNESSAMS_REMOTE_MACHINES) {
    try { map = JSON.parse(process.env.HARNESSAMS_REMOTE_MACHINES) } catch { map = null }
  } else {
    map = findWorkspaceConfig()?.config?.remote_machines
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return new Map()
  const out = new Map()
  for (const [alias, root] of Object.entries(map)) {
    if (typeof root === 'string' && root.trim()) out.set(alias, root.trim().replace(/\\/g, '/'))
  }
  return out
}

// ssh_list → machine records. Identity is the alias (id === name === alias);
// `workspace` carries the configured remote root (undefined = not configured
// in harnessams.json, `configured` flags it for the UI).
export async function listMachines(ctx, timeoutMs = 10_000) {
  const def = ctx?.tools?.get?.('ssh_list')
  if (!def) return { ok: false, machines: [], reason: 'ssh_list is not registered (@linxin666/dsh-ssh not installed?)' }
  const r = await callTool(ctx, 'ssh_list', {}, { timeoutMs })
  if (r.isError) return { ok: false, machines: [], reason: attributeSshError(r.text || 'ssh_list failed') }
  const hosts = Array.isArray(r.value?.hosts) ? r.value.hosts : []
  if (!hosts.length) {
    return { ok: false, machines: [], reason: 'no hosts configured in dsh-ssh (add aliases in its panel or ~/.dsh/dsh-ssh.json)' }
  }
  const roots = readRemoteMachines()
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
      workspace: roots.get(alias),
      configured: roots.has(alias),
    }
  })
  return { ok: true, machines }
}

// ssh_exec funnel: guaranteed-kill wrapper + structured result normalization.
// `machine` is the alias string or a listMachines record. The command always
// runs as `timeout -s KILL <N>s sh -c <command>` remotely (no `--`, see
// header), so exit 137
// (128+SIGKILL) is the remote deadline firing, not a command failure.
export async function execRemote(ctx, machine, command, { timeoutMs = 40_000 } = {}) {
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
    // deadline + connect).
    { alias, command: wrapped, timeoutMs: timeoutMs + 90_000 },
    { timeoutMs: 3 * (timeoutMs + 90_000) + 60_000 })
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
export async function uploadFile(ctx, machine, localPath, remotePath) {
  const alias = typeof machine === 'string' ? machine : (machine?.alias ?? machine?.id)
  const r = await callTool(ctx, 'ssh_upload', { alias, localPath, remotePath }, { timeoutMs: 300_000 })
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
// channel tars remotely and downloads the one archive).
export async function downloadFile(ctx, machine, remotePath, localPath) {
  const alias = typeof machine === 'string' ? machine : (machine?.alias ?? machine?.id)
  const r = await callTool(ctx, 'ssh_download', { alias, remotePath, localPath }, { timeoutMs: 300_000 })
  const v = (r.value && typeof r.value === 'object' && !r.isError) ? r.value : {}
  const ok = !r.isError && v.ok === true
  return {
    ok,
    text: ok
      ? `downloaded ${v.bytes ?? 0} bytes`
      : attributeSshError(String(v.error ?? r.text ?? 'download failed')),
  }
}

// Resolve an alias (machine_id) to { machine, alias, remoteRoot }: the machine
// must exist in the dsh-ssh host registry AND carry a configured remote root
// (harnessams.json remote_machines) — that root fences every remote_dir.
export async function resolveMachine(ctx, machineId) {
  if (!machineId) {
    throw new Error('machine_id (a dsh-ssh alias) is required — see the machine card or ssh_list')
  }
  const list = await listMachines(ctx)
  if (!list.ok) throw new Error(`dsh-ssh hosts unavailable: ${list.reason}`)
  const machine = list.machines.find((m) => m.id === machineId || m.name === machineId)
  if (!machine) {
    throw new Error(`no such dsh-ssh host: ${machineId} (known: ${list.machines.map((m) => m.id).join(', ')})`)
  }
  if (!machine.workspace) {
    throw new Error(`no remote root configured for host ${machine.id} — `
      + `set remote_machines["${machine.id}"] in the workspace harnessams.json`)
  }
  return { machine, alias: machine.id, remoteRoot: machine.workspace }
}
