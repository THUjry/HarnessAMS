---
name: analysis-cascade-dca
description: >
  Analyse cascaded RF-attenuator (digital ATT / DCA) S-parameter results and
  generate an interactive, round-selectable HTML design report. Use whenever
  the user asks to analyse a cascade/chain of ATT cells, produce a cascade
  design report or performance summary, or compare control-word states.
  Works on Results/RoundN/ workspaces or directly on a sweep run directory
  (--run-dir). Complements, never replaces, dca-cell-design.
---

# analysis-cascade-dca — Cascaded ATT Analysis & HTML Design Report

Generate an interactive HTML design report that characterises a digital-attenuator cascade (e.g. a 4-bit ST1·T2·T4·Pi8 chain) from per-control-word S-parameter simulations, with a Round dropdown to switch between experiment rounds live.

## When to use
- The user has S-parameter results for a cascade of ATT cells and wants a design/analysis report.
- Phrases like "analyse the cascade", "cascade ATT report", "generate the ATT cascade HTML report", "analysis-cascade-dca".
- Any round of a cascade experiment (Round1/Round2/...) with `sp_XXXX.sp` files, or a finished sweep run directory (`NN/netlist.scs.raw/sp.sp`).

## Inputs expected
A cascade workspace, e.g. `<project>/Cascade4bit`, containing:
- `Results/Round<N>/sp_XXXX.sp` — psfascii S-params, one file per control word (`0000`..`1111`, e.g. 16 files for a 4-bit cascade). 1–40 GHz, 0.1 GHz step.
- `Results/Round<N>/cascade_cells.json` — per-cell metadata: `name`, `folder`, `architecture`, `target_att_db`, `control_bit`, `bestPoints_params`, `devices`. **One per round**; `control_bit` reflects that round's stage ordering (see Conventions).
- Cell design folders (siblings of the cascade dir, e.g. `<cells_base>/AttST1dB/top/bestPoints.json`) — used for single-cell final results (Δavg, worst match). Missing folders degrade to "—".

**Or a sweep run directory** — `--run-dir <dir>` reads every `NN/netlist.scs.raw/sp.sp` directly (NN = point index = the integer value of the binary control word; the word width is auto-detected from the largest index). `cascade_cells.json` is looked up next to the run dir (inside it or in its parent; `--cells` overrides), so a finished batch needs no renaming step.

## Conventions (from cascade_cells.json)
- Control word `_xxxx`: bit(n-1)(leftmost)=MSB cell … bit0(rightmost)=LSB cell; `x=0` reference state, `x=1` attenuation state; point index = integer value of the binary suffix.
- **`control_bit` must match the NETLIST wiring, not the cell type (critical).** The generator reads `control_bit` from each round's `cascade_cells.json` — it never derives it itself. Each cascade netlist wires stages to sweep params in its own order, so the stage→bit mapping is project-specific:
    - **Stage-order wiring:** `I1..In` use `SW1..SWn` in stage order and the sweep enumerates SW1 as the fastest-varying LSB → Stage 1 (`SW1`) = LSB (`bit` 0), Stage N (`SWn`) = MSB (`bit` = nbits−1).
    - **Reversed wiring:** `I1..In` use `SWn..SW1` → Stage 1 (`SWn`) = MSB (`bit` = nbits−1), Stage N (`SW1`) = LSB (`bit` 0). Generator-side that is `bit = (len(cells)-1) - stage_index`. **Never** hardcode a bit by the cell's nominal value (e.g. "the 8 dB cell is always bit2") — that is only true when that cell happens to sit on that bit, and it silently corrupts expected/error for swapped orderings (a real failure mode: rounds with a swapped stage order showed errors up to ±6 dB until the mapping was fixed).
- **Each round has its own `cascade_cells.json`** and its own `control_bit` mapping. The generator MUST load the per-round file for `expected_db()`, not the first round's — reusing the first round's mapping corrupts every other round's expected values.
- **Worst match = max(S11,S22) at every frequency** (symmetric chains; the chart title is fixed accordingly).
- **Zero state (reference) = all bits 0** (all cells in reference/bypass). All deltas are measured relative to it.
- Performance metrics use the **1–30 GHz** band only; plots show **1–40 GHz** (x-axis range 0–40). Data starts at 1 GHz (no DC point).
- Expected attenuation of a state = Σ `target_att_db` of cells whose bit is set.

## Workflow
1. Locate the cascade workspace (or run directory); confirm the sp files + `cascade_cells.json` exist.
2. Run the bundled generator (below). Output goes to `<cascade_dir>/Analysis/` by default (run-dir mode: `<run_dir>/../Analysis`) — keep it there so every cascade's report lives next to its data.
3. Verify the output (see Cross-checks) and open the HTML.

### Run the generator
```bash
python gen_cascade_report.py <cascade_dir> \
    [--out <output_dir>] [--cells-base <cells_base_dir>] [--default-round <RoundN>]
    [--point-index N] [--nbits N]
python gen_cascade_report.py --run-dir <run_dir> [--cells <cascade_cells.json>] [--out DIR]
```
- `<cascade_dir>` — path to the cascade workspace (contains `Results/`).
- `--run-dir` — sweep run directory alternative (see Inputs); no renaming step.
- `--out` — output dir (default `<cascade_dir>/Analysis`).
- `--cells-base` — parent dir of the per-cell design folders (default: the parent of `<cascade_dir>`).
- `--default-round` — which round to load first in the dropdown (default: the first round found, usually Round1).
- `--point-index` — index into each cell's `bestPoints.json` `points` array read for the physical table (default 0; use 1 for an appended variant point).
- `--nbits` — control-word width override (default: auto-detected from the data; set 3 for a 3-bit cascade so words are 3-digit `000..111`).
- Writes `<out>/data/Round<N>.js` (per round, `var ROUND_DATA`) and `<out>/<cascade_name>_report.html`.

The script is self-contained (bundles the psfascii parser, pure stdlib); run it from anywhere with absolute paths. Plotly loads from the CDN in the generated HTML (the plugin's `gen_sweep_report` uses a local plotly asset instead — this generator trades that for zero dependencies).

## Report structure (generated HTML)
1. **Section 1 — Physical parameter table**: one row per cell (architecture, nominal att, ctrl bit, bestPoints params, target, single-cell Δavg/range, worst match, ref IP1dB@30G). **Dynamic (critical):** it is an empty `<tbody id="phys-body">` populated by the JS `buildPhysTable(RD.cells)` on every round load — the cells, their sizes and their `ctrl bit` column must change when the Round dropdown changes. It is NOT static HTML baked at generation time (the static table was the old, wrong approach).
2. **Section 2 — Performance summary**: (2a) Max attenuation | Max |phase change| (vs zero state) | Input worst match | Output worst match, each as `value @ control word` (metrics over 1–30 GHz); (2b) **RMS error vs frequency** — one dual-axis chart (x = frequency) with two curves: RMS attenuation error (dB, left axis) + RMS phase error (°, right axis), each the RMS over all control words per frequency point. Attenuation error per point = ΔS21 − expected (Σ nominal of set bits); phase error = |Δ phase| vs zero state (nominal 0°).
3. **Section 3 — Attenuation vs expected (30 GHz)**: x = binary control word with a vertical grid at every state; y = actual att@30 GHz − expected (Σ nominal).
4. **Section 4 — Control-word legend + 4 delta charts**: ΔS21 magnitude, ΔS21 phase, worst match max(S11,S22), S21 ref-state IL. Zero state is the reference; charts 1–3 have one curve per non-zero control word; clicking a curve/legend entry cross-highlights that control word across all charts.
5. **Section 5 — Physical-parameter consistency check**: per-device comparison of cascade netlist devices vs each cell's bestPoints params (PASS/FAIL + the switch rule — every switch instance carries its geometry l/w/nf).
- **Round selector dropdown**: `MANIFEST` + per-round `data/RoundN.js` loaded via `<script>` tags (`var ROUND_DATA`, not `const`) so switching rounds works under `file://`. Adding a new round = re-run the generator; it auto-registers in the dropdown.
- **Make the dropdown meaningful with `order_label` (recommended).** The per-round dropdown title is built from that round's `cascade_cells.json`:
  - If it has an `order_label` field (e.g. `"ST1->T2->T4->Pi8"`), the option reads **`RoundN - <order_label>`** — this is what makes each round distinguishable.
  - Otherwise it falls back to `Rref=<rref> Zs=<PORT0>/<PORT1>`, which is identical for every round of the same cascade and leaves the dropdown uninformative. Set `order_label` to the **chain cell order that round actually used**. The generator picks it up automatically — no code change, just regenerate.
- **Each `data/RoundN.js` embeds a `cells` array** (one entry per cell in that round's order): `name`, `architecture`, `target_att_db`, `control_bit`, `bestPoints_params`, plus single-cell metrics `target`, `delta_avg`, `delta_range`, `worst_match`, `ip1db_30g` (read from each cell's `bestPoints.json`). This is what makes Section 1 round-switchable.

## Chart & HTML conventions
- Plotly styling: chart title 20 px, **axis titles match their own axis's tick size** (16 px on the frequency/phase/worst axes and the RMS chart; 12 px on the §3 rotated control-word x-axis, whose ticks are also 12 px) — set `xaxis.title.font`/`yaxis.title.font`/`yaxis2.title.font` accordingly, height 480, margins t48/b60/l76/r40, mode `lines+markers` (marker 7 / opacity 0.3), line width 2 (highlight 4), HSL blue→red gradient, `clickmode:'event'` + `hovermode:'closest'`, cross-highlight via `el.on('plotly_click')` (see the Plotly 3.x events API note below) with the setTimeout/flag background-deselect.
- **Cross-highlight survives round switches (critical):** `Plotly.newPlot` wipes the graph div's event handlers whenever a previously-plotted div is replotted, so a one-time `bindOnce`-style setup silently breaks curve/legend selection after the first round switch. Re-bind the Plotly handlers on **every** `buildReport`, and attach the native DOM handlers (legend click, info-bar, chart click-deselect) exactly **once** at startup so they don't stack duplicates.
- **Plotly 3.x events API (critical):** `Plotly.on` / `Plotly.removeAllListeners` are **undefined in Plotly 3.0.1** — the events API moved onto the graph div as `el.on('plotly_click', cb)`, `el.once`, `el.removeListener`, etc. Calling `Plotly.on(el, ...)` throws a `TypeError` inside `bind()`, so the `plotly_click` handler never attaches and **curves become unselectable while the DOM legend still works**. Use `el.on(...)` exclusively. Do **not** call `el.removeAllListeners()` either — it also removes Plotly's internal click machinery and breaks `plotly_click` permanently.
- **Encoding (critical):** write the HTML as **UTF-8 with BOM** (`utf-8-sig`) so Chinese-Windows tools/browsers don't misread it as GBK (this caused a full-page mojibake report). Write the data JS as **plain UTF-8 (no BOM)** — its content is pure ASCII (`json.dumps` escapes CJK to `\uXXXX`), so a BOM only risks the `<script>` loader.
- **Cache-bust the data scripts (critical):** the data JS is regenerated *in place* (same `data/RoundN.js` URL), so browsers keep serving the stale cached copy — the Round dropdown then appears "broken" (charts switch but Section 1 doesn't, or nothing switches). Load each round with `script.src = filePath + '?v=' + Date.now()` so every switch refetches. After a regeneration the user must also hard-refresh once.
- **Per-round data shapes are heterogeneous (critical):** in `cells`, `target` may be a **string** (`"4.0 dB @ DC-30 GHz"`), a number, or `null`; `delta_range` may be an **array** `[min,max]` **or a scalar** `0.0225`; `delta_avg` / `worst_match` / `ip1db_30g` may be numbers or `null`. The JS formatters must be robust: `num(v,n)` only calls `toFixed` on finite numbers (else `'-'`), `show(v)` prints strings as-is and `'-'` for null/empty, `rng(r)` formats arrays as `[min, max]` and scalars as a single value. A naive `c.target.toFixed(3)` or `r[0].toFixed(3)` throws on the string/scalar shapes and — if not caught — freezes the whole report after the first switch.
- **Isolate table rendering from chart rendering (critical):** wrap the `buildPhysTable` call in `buildReport` as `try { if (RD.cells) buildPhysTable(RD.cells); } catch (e) { console.warn(...) }` so a table-data anomaly never blocks `buildSummary` / `buildCharts` / `bind()`. Without this, one bad round silently leaves every later round un-rendered.
- **Well-formed attributes (critical):** always close HTML attribute quotes. An unterminated `class="` swallows following markup as an attribute value — if it happens right before the `<script>` block, the parser eats the script tag and the page's JS (dropdown + charts) silently never runs. The generator's `badge()` helper is the past source of this bug — keep quotes balanced.

## Cross-checks for verification
- Single-bit increments @1 GHz should match the individual cell deltas (an earlier 5-bit reference: 0.5 dB cell ≈ −0.58, 1 dB ≈ −1.17, 2 dB ≈ −2.09, 4 dB ≈ −4.11, 8 dB ≈ −8.09 dB).
- The all-ones state S21 ≈ ref-state IL + Σ single-bit increments (interaction ~0.4 dB at 5 bits).
- Consistency check passes for every cell.
- Open the HTML: all 5 sections render, dropdown populates, one curve per non-zero control word, a vertical grid at every state in §3, cross-highlight works (click a curve in charts 1–3 **and** a legend entry — both must cross-highlight, also after switching rounds).
- **Section 1 changes with the Round dropdown**: switching rounds must reorder the cells, update each cell's `Ctrl bit`, and show that round's sizes — NOT stay frozen on Round1. If it freezes while charts 2+ update, a `buildPhysTable` exception is being swallowed (check the console / the data shapes above).
- **Per-round expected/error sanity:** the `acc` `expected` values must match the round's own stage ordering (e.g. a round ordered Pi8->T2->T4 has bit1=2 dB, bit0=4 dB → ctrl `001` expects 4 dB, ctrl `010` expects 2 dB). A round that mis-orders expected vs actual attenuation (errors ≈ ±4–6 dB on single bits) means the per-round `control_bit` mapping is wrong.
- Section 2b RMS chart shows 2 curves on dual axes; RMS attenuation error typically grows with frequency (reference cascade: ≈ 0.17 dB @ 1 GHz → 0.42 dB @ 30 GHz).

## Netlist Wiring & Analysis Mapping

The cascade netlist defines the control-bit-to-stage ordering that the analysis must respect. A schematic-extracted netlist (e.g. the ADE XL style at `/prj/.../ATT_cell_tb/adexl/.../Cascade/netlist/input.scs`) uses a **3-level hierarchy** (testbench → cascade subcircuit → cell subcircuits), which is the reference for understanding how the cascade netlist maps to the analysis. The hand-written `template.scs` (the smart-spectre skill's cascade companion page) flattens this into 2 levels, but the control-bit mapping follows the same rules.

### 3-level hierarchy (schematic-extraction reference)

The extracted netlist separates the design into three distinct layers:

```
┌─────────────────────────────────────────────────────────┐
│  Level 1: Testbench (top)                                │
│  - global parameters, model includes                     │
│  - PORT0/PORT1, SW control vsources (V2-V6)              │
│  - I5 (...) ATT_cascade_50ohm_v0        ← cascade inst   │
│  - sp analysis, simulatorOptions, saveOptions             │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Level 2: Cascade subcircuit                             │
│  subckt ATT_cascade_50ohm_v0                             │
│    ports: AVDD AVSS IN OUT SW1 SW2 SW3 SW4 SW5           │
│           SWB3 SWB4 SWB5                                 │
│    ┌─────────────────────────────────────────────────┐   │
│    │  Internal wiring (chain order via net names):   │   │
│    │  I8 (AVSS IN INTER1 SW1)        ATT_cell_ST0p5  │   │
│    │  I7 (AVSS INTER1 INTER2 SW2)    ATT_cell_ST1    │   │
│    │  I6 (AVSS INTER2 INTER3 SW3 SWB3) ATT_cell_T2   │   │
│    │  I3 (AVSS INTER3 INTER4 SW4 SWB4) ATT_cell_T4   │   │
│    │  I5 (AVSS INTER4 OUT SW5 SWB5)  ATT_cell_Pi8    │   │
│    └─────────────────────────────────────────────────┘   │
│  ends ATT_cascade_50ohm_v0                               │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Level 3: Cell subcircuits                               │
│  subckt ATT_cell_Pi8   AVSS IN OUT SW SWB ... ends      │
│  subckt ATT_cell_ST1   AVSS IN OUT SW     ... ends      │
│  subckt ATT_cell_T2    AVSS IN OUT SW SWB ... ends      │
└─────────────────────────────────────────────────────────┘
```

**Key structural points:**

1. **The cascade subcircuit** `ATT_cascade_50ohm_v0` encapsulates the entire ATT chain as a reusable block with its own port list. Its ports include AVDD, AVSS, IN, OUT, plus all SW control signals (SW1-SW5) and the complementary SWB signals for T-type/Pi-type cells (SWB3-SWB5).

2. **SW signals are generated in the testbench**, not inside the cascade subcircuit. The testbench creates the control voltages:
   ```spectre
   V2 (SW1 AVSS) vsource dc=1.2*SW1 type=dc
   V3 (SWB1 AVSS) vsource dc=1.2*(1-SW1) type=dc
   ```
   This means the cascade subcircuit **receives** SW voltages as inputs — it does not generate them internally.

3. **SWB signals are selectively passed through the cascade port list.** The cascade subcircuit only exposes SWB3-SWB5 as ports (for T2, T4, Pi8), while SWB1 and SWB2 are generated in the testbench but not connected to the cascade (the SimpleT cells don't use them). This is visible in the port list: `SW1 SW2 SW3 SW4 SW5 SWB3 SWB4 SWB5`.

4. **Internal nets** (INTER1-INTER4) are local to the cascade subcircuit — they are not visible at the testbench level. This encapsulation means the testbench does not need to know the inter-cell connections.

5. **Cell instance ordering** inside the cascade subcircuit does not have to follow the signal chain. The signal chain is determined by the net connections, not the instance order:
   ```
   IN → ST0p5 → INTER1 → ST1 → INTER2 → T2 → INTER3 → T4 → INTER4 → Pi8 → OUT
   ```

### Flat-subcircuit vs 3-level: implications for analysis

| Aspect | Flat-subcircuit (template.scs) | 3-level (extracted) |
|--------|-------------------------------|-------------------|
| Hierarchy | 2 levels: top + cells | 3 levels: testbench + cascade + cells |
| SW vsources | Alongside cell instances at top level | In testbench, outside cascade subckt |
| SWB pass-through | Only generated for T/Pi cells | Selectively passed through cascade port list |
| Cell encapsulation | Direct connection via internal nets | INTER nets hidden inside cascade subckt |
| When used | Hand-written for the sweep worker | Schematic extraction |

### SW→bit mapping convention

The sweep config uses `cross_product` over the binary SW parameters, yielding 2^n control words. The sweep enumerator assigns bit positions by parameter variance rate:

- **SW1** = fastest-varying → **bit 0 (LSB)**
- **SWn** = slowest-varying → **bit n−1 (MSB)**

Therefore, `control_bit` in `cascade_cells.json` must match the SW parameter each cell instance uses:

| Instance | Cell | SW param | control_bit |
|----------|------|----------|-------------|
| I1 | ST0p5 | SW1 | 0 (LSB) |
| I2 | ST1 | SW2 | 1 |
| I3 | T2 | SW3 | 2 |
| I4 | T4 | SW4 | 3 |
| I5 | Pi8 | SW5 | 4 (MSB) |

This mapping is the **same** regardless of whether the netlist uses the flat or 3-level hierarchy — the SW parameter name (SW1..SWn) determines the bit position, not the hierarchy depth.

### Cascade subcircuit port list conventions

The cascade subckt port list encodes information needed for analysis:

```
subckt ATT_cascade_50ohm_v0 AVDD AVSS IN OUT SW1 SW2 SW3 SW4 SW5 SWB3 SWB4 SWB5
```

- **AVDD, AVSS** — power/ground
- **IN, OUT** — RF signal ports
- **SW1..SWn** — control bits, in sweep order (SW1=LSB, SWn=MSB)
- **SWB…** — complementary signals for T/Pi cells only (SimpleT stages have none)

The presence/absence of SWB ports tells you which cells are T-type/Pi-type vs SimpleT without needing to inspect the cell subcircuits.

### Cell architecture → port count

Each cell's subcircuit port count determines how it is wired in the cascade:

| Architecture | Subcircuit ports | SWB in cascade? | Cascade signal routing |
|--------------|------------------|-----------------|------------------------|
| SimpleT (shunt) | `AVSS IN OUT SW` | No | `(AVSS, net_in, net_out, SWx)` |
| T-type | `AVSS IN OUT SW SWB` | Yes | `(AVSS, net_in, net_out, SWx, SWBx)` |
| Pi-type | `AVSS IN OUT SW SWB` | Yes | `(AVSS, net_in, net_out, SWx, SWBx)` |

### Analysis-side verification checklist

When inspecting a cascade netlist to verify the analysis mapping:

1. **SW parameter order** — Read the `parameters` line: SW1 is the LSB (fastest-varying), SWn is the MSB (slowest-varying). The `control_bit` in `cascade_cells.json` must match this order.
2. **SWB port presence** — If a cell's SWB is not in the cascade port list, that cell is SimpleT architecture. Verify this matches `cascade_cells.json`.
3. **Signal chain order** — Follow the net connections from IN to OUT through the INTER nets to confirm the cell order in the Section 1 table.
4. **Instance naming** — Instance names (I1..In) are local to their subcircuit level. In the 3-level hierarchy, the cascade subcircuit's instances are independent of the testbench's instance names.
5. **Per-round consistency** — If a round reorders cells or changes the SW assignment, the cascade subcircuit port list must change accordingly (or in the flat pattern, the cell instance wiring must change).

## Example (`example/`)

A real-simulation 4-bit cascade example (ST1 + T2 + T4 + Pi8, 16 control words) lives in `example/`: the four cell netlists + the cascade netlist (sky130 switches, ideal R/C, simulated with ngspice against the fossi sky130 cards), the generated results JSON (`Analysis/data/Round1.js`) and the corresponding HTML report. See `example/README.md` for provenance and how to regenerate.

## Constraints
- **Do NOT modify the dca-cell-design skill** — single-cell ATT design is out of scope; this skill only *analyses* cascade results. Single-cell design workflows belong to **dca-cell-design**; sweep mechanics live in **batch-sweep**, template rules in **smart-spectre**.
