// dsh-remote machine registry access (the single remote channel since the 2026-10-26
// rework removed nodes.yaml and the BatchMode ssh fallback). Two read-only channels,
// tried independently — neither exposes credentials:
//   1. the tool shell: ctx.tools.get('rw_machines') + ctx.tools.execute (the documented
//      programmatic path). execute() REQUIRES a
//      callId + AbortSignal (verified against @deepseek-ai/dsh-tools 0.2.1-rc.2: without
//      a signal the pipeline crashes reading `signal.aborted`), and rw_machines answers
//      with a TEXT listing, not JSON — see parseRwMachinesText.
//   2. same-origin HTTP GET /dsh-remote/machines (present when the plugin's web routes
//      are mounted). That surface sits behind the DSH web auth gate (401 without the
//      browser session credentials — verified 2026-10-25), so the incoming request's
//      cookie/authorization headers are forwarded; credential-less probes get a 401
//      and fall through.
// Mirror discovery (findMirrorForMachine) feeds the remote-project model (remote.js):
// rw_exec has no machine parameter and binds from the caller's session cwd, so a
// workspace opened inside a machine's local mirror directory IS that machine's
// remote project.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Extract the text payload of a ToolExecutionResult: value may be the raw string or a
// {text} object; content is a ContentBlock[] of {type:'text', text} blocks.
export function resultText(r) {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r.value === 'string') return r.value
  if (r.value && typeof r.value === 'object' && typeof r.value.text === 'string') return r.value.text
  if (Array.isArray(r.content)) return r.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

// Parse the rw_machines text listing (dsh-remote 0.8.54 format; group labels ride on
// an extra line after the auth line and match no entry, unchanged since 0.8.51):
//   - <id>  "<name>"  [native]  <user>@<host>:<port>  [CURRENT]
//       auth: key:... + agent | NONE (...)  workspace=<path>
// The workspace rides on the AUTH line following each header; the listing ends
// with a "connect with rw_connect(...)" hint line that matches no entry.
export function parseRwMachinesText(text) {
  const machines = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('- ')) continue
    const m = line.match(/^-\s+(\S+)\s+"([^"]*)"\s+\[([^\]]*)\]\s*([^@\s]*)@(\S+):(\d+)\s*(.*)$/)
    if (!m) continue
    const [, id, name, , username, host, port, tail] = m
    const ws = (lines[i + 1] ?? '').match(/workspace=(\S+)/) ?? String(tail).match(/workspace=(\S+)/)
    machines.push({
      id, name: name || host, host,
      port: Number(port) || 22,
      username: username || '',
      current: /\[CURRENT\]/.test(tail),
      workspace: ws ? ws[1] : undefined,
    })
  }
  return machines
}

// Normalize an HTTP-channel machine record ({machines:[...], currentId} shape). The
// HTTP body carries the full registry records, so the status extras (lastConnectedAt,
// latencyMs) pass through when present; the tool-shell text listing cannot carry them.
function fromHttpList(data) {
  if (!data || !Array.isArray(data.machines)) return null
  return data.machines.map((m) => ({
    id: String(m.id ?? m.host ?? m.name),
    name: String(m.name ?? m.host ?? m.id),
    host: m.host ? String(m.host) : undefined,
    port: Number(m.port) || 22,
    username: m.username ? String(m.username) : '',
    current: data.currentId != null && m.id === data.currentId,
    workspace: m.workspace ? String(m.workspace) : undefined,
    ...(m.lastConnectedAt ? { lastConnectedAt: String(m.lastConnectedAt) } : {}),
    ...(Number.isFinite(m.latencyMs) ? { latencyMs: Number(m.latencyMs) } : {}),
  }))
}

async function viaToolShell(tools) {
  const def = tools?.get?.('rw_machines')
  if (!def) return { ok: false, reason: 'rw_machines tool not registered (dsh-remote not installed?)' }
  let r
  try {
    r = await tools.execute({
      callId: 'harnessams-machines-' + Math.random().toString(36).slice(2, 8),
      name: 'rw_machines',
      arguments: {},
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    return { ok: false, reason: 'rw_machines execute failed: ' + String(e?.message ?? e) }
  }
  if (r?.isError) return { ok: false, reason: 'rw_machines returned an error' }
  const machines = parseRwMachinesText(resultText(r))
  if (!machines.length) return { ok: false, reason: 'rw_machines listing empty or not parseable' }
  return { ok: true, machines, source: 'tool shell (rw_machines)' }
}

async function viaHttp(req, fetchImpl = fetch) {
  const host = req?.headers?.host ?? '127.0.0.1:3080'
  // The /dsh-remote/* surface sits behind the web auth gate: forward the browser's
  // credentials, or the sub-request 401s even though the user is logged in.
  const headers = {}
  if (req?.headers?.cookie) headers.cookie = req.headers.cookie
  if (req?.headers?.authorization) headers.authorization = req.headers.authorization
  const res = await fetchImpl(`http://${host}/dsh-remote/machines`, { headers, signal: AbortSignal.timeout(3000) })
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status} (the /dsh-remote route needs the web session credentials)` }
  const machines = fromHttpList(await res.json().catch(() => null))
  if (!machines) return { ok: false, reason: 'HTTP body not parseable' }
  return { ok: true, machines, source: 'HTTP /dsh-remote/machines' }
}

// Aggregate both channels with independent failures — a thrown tool shell must not hide
// the HTTP channel (the flow bug that made the console show "not available" on 2026-10-25).
export async function fetchMachines(tools, req, fetchImpl = fetch) {
  const shell = await viaToolShell(tools).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }))
  if (shell.ok) return shell
  const http = await viaHttp(req, fetchImpl).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }))
  if (http.ok) return http
  return { ok: false, reason: `${shell.reason}; HTTP fallback: ${http.reason}` }
}

// dsh-remote's mirror registry root: $DSH_HOME/remote-workspaces (default ~/.dsh).
export function remoteWorkspacesRoot() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'remote-workspaces')
}

// Find the local mirror directory of a dsh-remote machine — the cwd that makes rw_exec
// bind to that machine (dsh-remote resolves bindings by scanning the same meta files;
// see lib/binding.js resolveMirror; identical in 0.8.54, unchanged since 0.8.51). Read-only: the meta carries no secrets.
export function findMirrorForMachine(machine, root = remoteWorkspacesRoot()) {
  if (!machine?.host) return null
  const port = Number(machine.port) || 22
  const user = String(machine.username ?? '').toLowerCase()
  let hostDirs = []
  try { hostDirs = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const hd of hostDirs) {
    if (!hd.isDirectory()) continue
    let entries = []
    try { entries = fs.readdirSync(path.join(root, hd.name), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      let meta
      try { meta = JSON.parse(fs.readFileSync(path.join(root, hd.name, e.name, '.dsh-remote-meta.json'), 'utf8')) } catch { continue }
      if (!meta?.host) continue
      if (String(meta.host).toLowerCase() !== String(machine.host).toLowerCase()) continue
      if ((Number(meta.port) || 22) !== port) continue
      const mu = String(meta.username ?? '').toLowerCase()
      if (user && mu && mu !== user) continue
      return { mirrorDir: path.join(root, hd.name, e.name), remotePath: String(meta.remotePath ?? '') }
    }
  }
  return null
}

// Borrow a live session whose cwd sits inside the mirror, for the rw_* agent context.
// This is the borrowing primitive of the remote-project model: the local project's
// Overview checks use it to run rw_exec on a machine through a session of that
// machine's remote project (and the future remote-simulation path will reuse it).
// The host `sessions` service is fetched lazily like dsh-remote itself does
// (ctx.get('sessions')) so compositions without it degrade instead of failing injection.
// Returns {agent: {session}} or null when no live session is open in that workspace.
export function sessionInMirror(ctx, mirrorDir, list) {
  if (!mirrorDir) return null
  const sessions = list ?? (typeof ctx?.get === 'function' ? ctx.get('sessions') : null)
  if (!sessions || typeof sessions.list !== 'function') return null
  let live = []
  try { live = sessions.list() } catch { return null }
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const root = norm(mirrorDir)
  for (const s of live) {
    const cwd = norm(s?.header?.cwd)
    if (cwd && (cwd === root || cwd.startsWith(root + '/'))) return { agent: { session: s } }
  }
  return null
}

// Aggregate for the tier-1 Remote Projects section: machine list (either channel) with
// each machine's mirror state and the DSH workspace registered inside it, if any (that
// workspace IS the machine's remote project). Never throws — the console renders a
// degraded note on failure.
export async function remoteMachinesStatus(tools, req, registry, fetchImpl = fetch) {
  const channel = await fetchMachines(tools, req, fetchImpl)
  if (!channel.ok) {
    return { installed: false, source: null, machines: [], reason: channel.reason }
  }
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let workspaces = []
  try { workspaces = typeof registry?.list === 'function' ? registry.list() : [] } catch { workspaces = [] }
  return {
    installed: true,
    source: channel.source,
    machines: channel.machines.map((m) => {
      const mirror = findMirrorForMachine(m)
      let remoteProject = null
      if (mirror) {
        const md = norm(mirror.mirrorDir)
        const w = workspaces.find((x) => {
          const p = norm(x?.path)
          return p === md || p.startsWith(md + '/')
        })
        if (w) remoteProject = { id: w.id, path: w.path, title: w.title }
      }
      return { ...m, mirror, remoteProject }
    }),
  }
}
