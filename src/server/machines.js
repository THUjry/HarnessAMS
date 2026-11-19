// dsh-ssh host registry access (the single remote channel since the dsh-remote
// retirement, 2026-11-14). One read-only channel: the tool shell — ssh_list
// through the batch-contract funnel in ../remote.js. Structured values, no
// credentials. The per-alias remote root is NOT registry data and NOT a family
// map anymore (2026-11-19 D-009): it is the project's settings.remote_root —
// consumers that need a root pass it explicitly; the machine projections here
// are pure registry facts.
import { listMachines } from '../remote.js'

// List the configured hosts (single channel; never throws).
export async function fetchMachines(tools) {
  const r = await listMachines({ tools }).catch((e) => ({ ok: false, machines: [], reason: String(e?.message ?? e) }))
  if (r.ok) return { ...r, source: 'tool shell (ssh_list)' }
  return r
}

// Machines for the settings table's dropdown: the full host registry (picking
// a host is picking its alias; the remote root is a separate per-project
// setting, not a machine fact).
export function checkableMachines(machineList) {
  return (machineList ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    host: m.host,
    port: m.port,
    username: m.username,
    auth: m.auth,
    keyReady: m.keyReady,
  }))
}

// Aggregate for the tier-1 machine card: the full host list — pure registry
// facts. Never throws; the console renders a degraded note on failure.
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
    })),
  }
}
