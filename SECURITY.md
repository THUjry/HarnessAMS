# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (pre-release) | yes |

## Boundaries you should know about

- Custom web routes registered by DSH plugins are **not token-gated** by the DSH web
  server. The console plugin serves only a management UI and static workspace reports on
  `/harnessams`; treat both as safe for a loopback / personal deployment only. Do not
  expose them to an untrusted network without adding an auth layer.
- Remote connectivity is delegated entirely to the dsh-remote plugin: remote checks run
  a fixed, read-only command set through dsh-remote's `rw_exec` tool shell, bound to a
  machine by the remote project session's mirror cwd. Credentials, authentication, and
  connection handling stay inside dsh-remote (its stored credentials apply); the plugin
  never reads, stores, or transmits credentials, and it never switches dsh-remote's
  global active machine. The one write-ish call is remote-project creation: a same-origin
  POST to dsh-remote's `/dsh-remote/mirror` with the browser's session credentials
  forwarded, then a local workspaceRegistry registration.
- The `/reports/*` route is read-only static file serving with a whitelist root (the
  configured workspace root) plus traversal checks.
- `LocalDesignExample/` vendors third-party binaries (ngspice) and model files (sky130);
  they are used unmodified and their licenses apply (see `LocalDesignExample/THIRD_PARTY_NOTICES.md`).
  Only run binaries from a clone you trust.

## Reporting a vulnerability

Until the public repository goes live, report privately to the maintainer. Once published,
use the GitHub security advisory flow of the repository (link to be added at publication).
