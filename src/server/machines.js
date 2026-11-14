// dsh-ssh host registry access (the single remote channel since the dsh-remote
// retirement, 2026-11-14). One read-only channel: the tool shell — ssh_list
// through the batch-contract funnel in ../remote.js. Structured values, no
// credentials; the HTTP /dsh-remote/machines fallback is gone with dsh-remote
// (dsh-ssh has no equivalent route and the tool shell needs no session
// binding, so there is nothing to fall back from).
// The per-alias remote root is NOT dsh-ssh data: listMachines (../remote.js)
// merges the workspace harnessams.json `remote_machines` map into each machine
// record (`workspace` / `configured`), so every consumer sees one shape.
import { listMachines } from '../remote.js'

// List the configured hosts (single channel; never throws).
export async function fetchMachines(tools) {
  const r = await listMachines({ tools }).catch((e) => ({ ok: false, machines: [], reason: String(e?.message ?? e) }))
  if (r.ok) return { ...r, source: 'tool shell (ssh_list)' }
  return r
}

// Machines a LOCAL project can run remote checks / batches on: hosts that
// carry a configured remote root (harnessams.json remote_machines). The
// projection strips the registry plumbing and keeps the check-facing fields.
export function checkableMachines(machineList) {
  return (machineList ?? [])
    .filter((m) => m.configured)
    .map((m) => ({
      id: m.id,
      name: m.name,
      host: m.host,
      port: m.port,
      username: m.username,
      auth: m.auth,
      keyReady: m.keyReady,
      remotePath: m.workspace,
    }))
}

// Aggregate for the tier-1 machine card: the full host list (configured or
// not) with each machine's configured remote root — an unconfigured host is a
// display-level state ("add remote_machines[alias] in harnessams.json"), not
// an error. Never throws; the console renders a degraded note on failure.
export async function remoteMachinesStatus(tools) {
  const channel = await fetchMachines(tools)
  if (!channel.ok) {
    return { installed: false, source: null, machines: [], reason: channel.reason }
  }
  return {
    installed: true,
    source: channel.source,
    machines: channel.machines.map((m) => ({
      id: m.id,
      name: m.name,
      host: m.host,
      port: m.port,
      username: m.username,
      auth: m.auth,
      keyReady: m.keyReady,
      remoteRoot: m.workspace ?? null,
      configured: m.configured,
    })),
  }
}
