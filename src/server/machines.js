// dsh-remote alignment (2026-10-25 SSH decision): the console's server area shows the
// dsh-remote machine registry next to nodes.yaml and marks which node HOSTs are known
// there. Two read-only channels, tried in order — neither exposes credentials:
//   1. the tool shell: ctx.tools.get('rw_machines') + ctx.tools.execute (the documented
//      programmatic path; see DSHstudy DSHremoteSSH.md §5.6),
//   2. same-origin HTTP GET /dsh-remote/machines (present when the plugin's web routes
//      are mounted; the route surface has no exec, so this stays read-only).
// When both fail the console falls back to the direct-ssh check channel.
async function viaToolShell(tools) {
  const def = tools?.get?.('rw_machines')
  if (!def) return { ok: false, reason: 'rw_machines tool not registered (dsh-remote not installed?)' }
  const r = await tools.execute({ name: 'rw_machines', arguments: {} })
  if (r?.isError) return { ok: false, reason: 'rw_machines returned an error' }
  const machines = parseMachineList(r?.value ?? r?.content)
  if (!machines) return { ok: false, reason: 'rw_machines result not parseable' }
  return { ok: true, machines, source: 'tool shell (rw_machines)' }
}

async function viaHttp(req) {
  const host = req?.headers?.host ?? '127.0.0.1:3080'
  const res = await fetch(`http://${host}/dsh-remote/machines`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  const machines = parseMachineList(await res.json().catch(() => null))
  if (!machines) return { ok: false, reason: 'HTTP body not parseable' }
  return { ok: true, machines, source: 'HTTP /dsh-remote/machines' }
}

// Best-effort shape extraction: accept [{name|host|machine...}] arrays or {machines:[...]}
// objects; keep only display fields and never look at secrets.
function parseMachineList(value) {
  let list = null
  if (Array.isArray(value)) list = value
  else if (value && Array.isArray(value.machines)) list = value.machines
  else if (typeof value === 'string') {
    // tool content may be a text blob; try JSON inside it
    try { return parseMachineList(JSON.parse(value)) } catch { return null }
  }
  if (!list) return null
  return list.map((m) => {
    if (!m || typeof m !== 'object') return null
    const name = m.name ?? m.host ?? m.id ?? m.label
    if (name === undefined) return null
    return { name: String(name), current: m.current === true || m.active === true, host: m.host ? String(m.host) : undefined }
  }).filter(Boolean)
}

// Aggregate: dsh-remote presence, machine list (either channel), and alignment with the
// nodes.yaml HOSTs. Never throws — the console renders a degraded note on failure.
export async function remoteMachinesStatus(tools, req, nodes) {
  let channel = null
  try {
    channel = await viaToolShell(tools)
    if (!channel.ok) channel = await viaHttp(req)
  } catch (e) {
    channel = { ok: false, reason: String(e?.message ?? e) }
  }
  const hosts = (nodes ?? []).map((n) => String(n.HOST))
  if (!channel.ok) {
    return { installed: false, source: null, machines: [],
             reason: channel.reason,
             fallback: 'remote checks use the direct-ssh fallback channel (BatchMode, system OpenSSH)',
             alignment: hosts.map((h) => ({ host: h, known: false })) }
  }
  const known = new Set(channel.machines.map((m) => m.name.toLowerCase()))
  return {
    installed: true,
    source: channel.source,
    machines: channel.machines,
    alignment: hosts.map((h) => ({ host: h, known: known.has(h.toLowerCase()) })),
  }
}
