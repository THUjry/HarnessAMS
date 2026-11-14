# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (pre-release) | yes |

## Boundaries you should know about

- Custom web routes registered by DSH plugins are **not token-gated** by the DSH web server. The console plugin serves only a management UI and static workspace reports on `/harnessams`; treat both as safe for a loopback / personal deployment only. Do not expose them to an untrusted network without adding an auth layer.
- Remote connectivity is delegated entirely to the @linxin666/dsh-ssh plugin: remote checks run a fixed, read-only command set through dsh-ssh's `ssh_exec` tool shell, addressed by host alias (zero gating — no binding, no borrowed session). Credentials, authentication, and connection handling stay inside dsh-ssh (`~/.dsh/dsh-ssh.json`, plaintext 0600 — prefer key auth with no stored passphrase, a restricted account and network-level access control; dsh-ssh performs no host-key verification); the plugin never reads, stores, or transmits credentials. The exec funnel wraps every command in a remote `timeout -s KILL` and annotates channel-open failures with a suspected-MaxSessions hint; a lost connection may replay a non-idempotent command up to 3 times — the batch layer guards submissions with marker+flock idempotency (`.hams_submitted` / `.hams_direct_done`). dsh-ssh telemetry is ON by default (daily anonymous POST) — deployments can opt out via localStorage `dsh-web-ui-telemetry-opt-out=1` or DNT.
- The `/reports/*` route is read-only static file serving with a whitelist root (the configured workspace root) plus traversal checks.

## Reporting a vulnerability

Until the public repository goes live, report privately to the maintainer. Once published, use the GitHub security advisory flow of the repository (link to be added at publication).
