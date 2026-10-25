# sky130_fd_pr (fossi-foundation) — minimal model closure

Bundled here: 338 model files, ~4.3 MB — the minimal `.include` closure the bundled
demos need to simulate sky130 with ngspice. License: Apache License 2.0 — see `LICENSE`.

- `combined_models/` — the fossi-foundation **continuous** model set, complete (210
  files); the library entry is `combined_models/sky130.lib.spice` (what the demos'
  `.lib` line points at)
- `cells/` — the 128 per-cell model files pulled in by `corners/*.spice` through
  recursive `../../cells/...` and bare-filename includes; without them the corners do
  not load

## What was trimmed and why

Upstream (https://github.com/fossi-foundation/skywater-pdk-libs-sky130_fd_pr, Apache-2.0)
is a full PDK library tree — ~675 MB / ~4,300 files. A SPICE simulator reads none of the
distribution, layout, or measured-data artifacts, so they are not bundled:

| Upstream content | Size | Used by ngspice? |
|---|---|---|
| `cells/` measured characterization data (`.data`, `.tsv`, `.csv`) | ~527 MB | no |
| `cells/` documentation renders (`.svg`, `.json`) | ~94 MB | no |
| `cells/` SPICE files | ~49 MB | only the ~1.5 MB include closure kept here |
| `cells/` layout / physical design (`.gds`, `.lef`, `.cdl`) | ~18 MB | no |
| `models/` (binned top-level models) | 4 MB | deliberately not used (see below) |
| `vacask/` (Verilog-A), `tech/` | ~3.2 MB | no |

The binned `models/sky130.lib.spice` is excluded on purpose: its bins cap device
geometry (nfet_01v8 at w <= 100 µm) and reject larger devices, while the
`combined_models` continuous set has no bin limit. The google-frozen build is unusable
too: its model cards fail to parse under ngspice-47 (uncommented pm3 lines are read as
current sources; google/skywater-pdk issue #286).

## Regenerating the closure

Walk the include graph from `combined_models/sky130.lib.spice`: follow every `.include`
(resolving relative `../../cells/...` and bare filenames against the including file's
directory), copy each referenced file to the same relative path, and repeat until no
include is missing. An incomplete closure fails loudly — ngspice errors on the missing
include or model — so nothing silently simulates wrong; extend the closure the same way
if a demo starts using a device family not yet bundled.

## ngspice-47 conventions

Use the continuous models (not binned, not the google-frozen build); MOS instances use
the X prefix; w/l values are bare µm numbers (the library sets `scale=1u`); an MC
`.option seed` line must precede `.lib`. Not every device has a continuous model (RF
transistors have fixed layouts — see `combined_models/README`).

Verification: the bundled self-check (`../check_environment.py`) runs a sky130 netlist
end-to-end against this closure with the bundled ngspice (green as of 2026-10-25); the
development runs behind the bundled demos reproduced their reference values with zero
deviation.
