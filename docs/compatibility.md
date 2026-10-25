# Compatibility matrix (DSH version × plugin version)

> Maintenance discipline: the top level maintains the matrix; plugins pin their verified range in `engines.dsh` (never `*`); after a DSH upgrade, rerun the minimal regression before updating this table.
> Minimal regression checklist: M0 spikes (dev-mount + UI injection, sandbox×junction, answerer) + the M1 assemble->check->simulate->collect chain + M2 report generation.

| DSH version | dsh-harnessams | dsh-harnessams-smart-ana-sim | dsh-harnessams-suite | Notes |
|---|---|---|---|---|
| 0.2.1-rc.2 | 0.1.0 (in development) | 0.1.0 (in development) | 0.1.0 (in development) | Pinned target; verified 2026-10-25 (dev-mount + routes + local checks smoke-tested) |
