# Plugin index

> Basis: top-level repo responsibilities — each plugin's spec, version, dependencies, permission boundaries, verified DSH version.
> The status column is updated per milestone; entries marked "TBD at M1" are backfilled when the plugin lands.

| Plugin | npm package / spec | row id | Dependencies (@deepseek-ai/dsh-*, peer range) | Permission boundary | Verified DSH | Status |
|---|---|---|---|---|---|---|
| HarnessAMS top | `dsh-harnessams` | `harnessams-top` | `@deepseek-ai/dsh-host-webserver >=0.0.1-rc.1` | webServer routes; local command execution via Node child_process (Host plugin, outside the agent sandbox) | 0.2.1-rc.2 (M0 verified 2026-10-25) | implemented, pre-release |
| SmartAnaSim | `dsh-harnessams-smart-ana-sim` | `harnessams-smart-ana-sim` | `@deepseek-ai/dsh-tools >=0.0.1-rc.1` | assembly-layer rejection (checks before the simulator); scripts spawn system Python | 0.2.1-rc.2 (M0 verified 2026-10-25) | implemented, pre-release |
| SmartPostLayout | (repo in stage 2) | `harnessams-smart-post-layout` | — | — | — | not started |
| aligner | (repo in stage 3) | `harnessams-aligner` | — | — | — | not started |

Install methods and bundle membership notes: root `README.md`; compatibility matrix: `compatibility.md`.
