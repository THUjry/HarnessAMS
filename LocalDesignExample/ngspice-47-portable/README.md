# ngspice-47 portable (Windows x64)

Minimal standalone ngspice-47 console setup:

- `ngspice_con.exe` — batch/console binary (invoke as `ngspice_con -b <netlist>`)
- `libomp140.x86_64.dll`, `samplerate.dll`, `sndfile.dll` — runtime DLLs from the same
  distribution; all three must sit next to the exe (a bare exe does not start)

This is the minimal standalone set, verified to run sky130 netlists on Windows x64
(2026-10-25). License: BSD 3-clause — see `COPYING` (from the ngspice-47 distribution).

## Source and trimming

Original package: **`ngspice-47_64.7z`** (13.8 MB), the official Windows x64 portable
build — https://sourceforge.net/projects/ngspice/files/ng-spice-rework/47/ngspice-47_64.7z/download
(upstream project: https://ngspice.sourceforge.io/).

Extraction notes: Windows' built-in `tar.exe` (bsdtar) reads 7z; the GNU tar shipped
with Git Bash does not. bsdtar may skip the XSPICE codemodel files — nothing here needs
them.

From the full extracted install (~56 MB), everything not needed for batch netlist
simulation is dropped:

| Dropped | Size | Why |
|---|---|---|
| `ngspice.exe` | 8.6 MB | interactive/GUI front end; the pipeline drives `ngspice_con.exe -b` only |
| `examples/` | 26 MB | bundled example circuits |
| `lib/ngspice/` | 7.3 MB | XSPICE codemodels, unused by these netlists |
| `docs/`, `share/` | ~3 MB | manual and init templates (only `COPYING` is kept, for the license) |

Kept: the four files in this directory (~12 MB). The interactive `ngspice.exe` front end
is not included; take it from a full distribution if you need it.

Non-Windows hosts: install ngspice yourself (47 verified; >= 43 recommended) and point
the `ngspice_cmd` field of the parent `../harnessams.json` at your binary.
