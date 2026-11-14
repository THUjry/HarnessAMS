# Compatibility matrix (DSH version × plugin version)

> Maintenance discipline: the top level maintains the matrix; plugins pin their verified range in `engines.dsh` (never `*`); after a DSH upgrade, rerun the minimal regression before updating this table. Minimal regression checklist: M0 spikes (dev-mount + UI injection, sandbox×junction, answerer) + the M1 assemble->check->simulate->collect chain + M2 report generation.

| DSH version | dsh-harnessams | dsh-harnessams-smart-ana-sim | dsh-harnessams-suite | Notes |
|---|---|---|---|---|
| 0.2.2-rc.3 | 0.1.0 (in development) | 0.1.0 (in development) | 0.1.0 (in development) | Current pinned target; verified 2026-11-14 (dev-mount smoke: routes + tool registration + machines API; engines.dsh re-pinned 0.2.2-rc.1→0.2.2-rc.3 in the same migration wave as the dsh-remote retirement — the @linxin666/dsh-ssh channel requires dsh >= 0.2.2-rc.2; tarball diff confirmed the tools.execute batch contract and host-webserver lib unchanged rc.1→rc.3; tests 95/95 + 31/31) |
| 0.2.2-rc.1 | 0.1.0 (in development) | 0.1.0 (in development) | 0.1.0 (in development) | Pinned target 2026-11-10→2026-11-14 (dev-mount + routes + tool registration + local checks API + three-tier UI smoke; engines.dsh re-pinned 0.2.1-rc.2→0.2.2-rc.1 same day) |
| 0.2.1-rc.2 | 0.1.0 (in development) | 0.1.0 (in development) | 0.1.0 (in development) | Pinned target 2026-10-25→2026-11-10 (dev-mount + routes + local checks smoke-tested); NOT compatible with engines.dsh exact pin against 0.2.2 hosts — rows get disabled at startup |
