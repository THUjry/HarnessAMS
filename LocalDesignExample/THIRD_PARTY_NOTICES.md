# Third-party notices

This directory bundles third-party components so that a fresh clone can run simulations
without external downloads. Each component is used unmodified under its own license.

## ngspice-47-portable/

- ngspice, 3-clause BSD license - see `ngspice-47-portable/COPYING`
- `ngspice_con.exe` plus the three runtime DLLs from the ngspice-47 Windows x64
  distribution (the minimal standalone set verified to run sky130 netlists)
- Upstream: https://ngspice.sourceforge.io/
- Original package: ngspice-47_64.7z -
  https://sourceforge.net/projects/ngspice/files/ng-spice-rework/47/ngspice-47_64.7z/download
- What was kept and dropped, and why: `ngspice-47-portable/README.md`

## sky130/

- sky130_fd_pr - SKY130 primitive models and cells, Apache License 2.0 - see
  `sky130/LICENSE`
- fossi-foundation distribution: the `combined_models` continuous models plus the
  recursively-included `cells` closure (the minimal include closure needed by the demos;
  the upstream repository is the authoritative source)
- Upstream: https://github.com/fossi-foundation/skywater-pdk-libs-sky130_fd_pr
- What was kept and dropped, and why: `sky130/README.md`

## plotly.min.js

Not bundled here. The **master copy** for the whole HarnessAMSproject tree lives at
the repo level inside the `dsh-harnessams` package: `../src/assets/plotly.min.js`
(plotly.js v3.0.1, MIT, Copyright (c) 2012-2025 Plotly, Inc.; notice and license text:
`../src/assets/THIRD_PARTY_NOTICES.md`) — it ships with the `dsh-harnessams` npm tarball.
The report generator (`tools/gen_sweep_report.py`) discovers it automatically and seeds
the workspace-level `assets/plotly.min.js` from it; generated reports reference that
workspace copy with a relative path so they render fully offline.
