---
name: dca-cell-design
description: >
  Design digital-controlled attenuator (DCA/ATT) cells in sky130: arm-total
  dimension calculation with direct switch-Ron input (T-type, SimpleT, Pi
  architectures) and Spectre verification sweeps through the batch-sweep
  workflow (spectre netlist rules in smart-spectre). Triggers on "design
  ATT", "attenuator design", "DCA cell", "step attenuator", "ATT cell",
  "attenuator sweep".
---

# dca-cell-design — ATT Cell Design (sky130, ideal RC, direct Ron)

Unit-cell design flow: dimension calculation (three architectures), cluster verification sweeps (the batch-sweep workflow; spectre template/config rules in the **smart-spectre** skill) and the cell design report (`gen_sweep_report`). Cascade analysis and reporting live in the **dca-cascade-analysis** skill.

**Design method:** the arm total resistance comes from the ideal network formulas, then the **switch Ron is a direct input** (suggested **1/3 ~ 1/5 of the arm total** — a larger Ron wastes arm resistance on the switch, a smaller one grows the device and its off-capacitance); the resistive part is the remainder. Temperature-coefficient targeting (ZTC) is retired — temperature is neither compensated nor swept by default (single-point, template default 27 °C); run a temperature sweep only when the user asks for one.

**Ideal RC:** the templates realize R and C as IDEAL elements; only the switches are real sky130 devices. Analytic flatness predictions from the calculators are therefore advisory — **actual simulation results are authoritative**.

## Required Parameters (ask the user when missing)

| Parameter | Description | Default |
|-----------|-------------|---------|
| **work_dir** | Cell root directory, e.g. `<project>/AttST1dB/` | — |
| **architecture** | `T-type`, `SimpleT`, or `Pi` | — |
| **target_db** | Target attenuation in dB | — |
| **ron** | Direct input: shunt switch Ron [Ω] (arm total /4 by default; keep within 1/3 ~ 1/5 of the arm total) | derived |
| **ron1** | Direct input: bypass switch Ron [Ω] (T/Pi only; keep well below the series path it shorts) | derived |
| **freq_start / freq_stop** | Sweep band (GHz) | set per design |

**Frequency bands.** The sweep band and the (usually narrower) characterization band for the design metrics — `delta_db_range`, `delta_db_avg`, `delta_phase_range_deg`, `worst_match_db`, `ref_state_il_db_range` — are set per design; the lowest sweep points represent DC for these resistive networks. Do not truncate the sweep to the characterization band. For a verified reference (bands, values, results) see `sky130_examples/Example.md`.

**Example values are not defaults.** The constraints recorded in `sky130_examples/Example.md` — the frequency band, the Ron/Ron1 inputs, the characterization band, the Cp candidate lists, the gate drive — are illustrative for that worked example. When a required parameter of a NEW design is missing, ask the user for it, or explicitly confirm that the example's value may be carried over; never copy example values silently.

## sky130_examples (`sky130_examples/`)

Two layers: a verified **example** (design values + raw two-state results) and the **sky130proc** process kit that keeps the skill self-contained.

- `Example.md` — the verified example (one cell per architecture: ST1/T4/Pi8): design values, verified frequency band and result summary; the concrete numbers live there, not in this SKILL.md.
- `ST1/`, `T4/`, `Pi8/` — per-design `design.json` (final parameters at full precision) plus the two-state raw S-parameter outputs `sp_ref.sp` (SW=0) / `sp_att.sp` (SW=1).
- `sky130proc/template_{Pi,T,ST}.scs` — the runnable architecture templates with calculator class defaults (the `sp` analysis uses the bare instance name `sp`, so the raw output is `sp.sp` as the parsers expect).
- `sky130proc/sky130_fd_pr__nfet_01v8_lvt.scs` — the transcribed sky130 switch model (per-geometry flattened `nlowvt_model__w<W>p<N>f<N>` cards; MIT-licensed sky130-spectre-models repo): the coarse FOM ladder (w10/20/50/100) plus full 5×5 local grids around the two worked design classes (shunt w=43.3/nf=22, bypass w=61.7/nf=31). Extend it with `scripts/gen_lvt_cards.py` (clone-based: shared bin-8 body, `rsh = 89.1*nf/w + 443.5`). In a real project point the `include` at the project's own transcribed-library copy.
- `sky130proc/nfet_switch.json` — lvt switch FOM data for the calculators (Ron·W, the measured dual-route Coff·W, verified sizing points); the full per-card characterization table is `sky130proc/nfet_lvt_ron_coff.csv`.
- `sky130proc/nfet_ron_coff.csv` — measured plain-nfet switch characterization (Ron/Coff per geometry — the device generation the example cells use).

Switch instances use the flattened model card names — when the calculator picks a new w/nf, take the nearest existing card from the transcribed library (extend it with `scripts/gen_lvt_cards.py` when a local grid is needed) and update `l/w/nf/nrd/nrs` together.

## Shunt-Arm Calculation (shared; for SimpleT this IS the whole design)

Every architecture realizes its shunt path the same way — a resistive part in series with a shunt switch — and for SimpleT the whole cell is exactly this path:

1. **Arm total from the ideal formulas** (per architecture below): `R_arm = R0/(2/|S21| − 2)` for SimpleT; `R3` for T-type; `Rsh` per side for Pi.
2. **Ron direct input** — the shunt switch on-resistance is GIVEN (suggested 1/3 ~ 1/5 of `R_arm`; default `R_arm/4`). Switch sizing from the device FOM data — `W_tot = (Ron·W)/Ron`, per-finger width per the data file (lvt FOM: `sky130_examples/sky130proc/nfet_switch.json`, per-card table `sky130proc/nfet_lvt_ron_coff.csv`; plain nfet: `sky130_examples/sky130proc/nfet_ron_coff.csv`).
3. **Resistive remainder**: `Rp = R_arm − Ron`. Report the achieved step against the target (with ideal RC the DC step is exact; the flatness is simulation's business).

For T-type and Pi the series arm(s) come from the same ideal formulas (`Rs`), and the bypass switch Ron1 is a direct input (keep Ron1 well below the series path it shorts, or the bypass fails).

## Architecture: Pi

Single series arm R0 bypassed by M1; two symmetric shunt arms, each `(Rp‖Cp)` in series with M2/M3 to GND. **Cp parallels Rp** (netlist-accurate), NOT the switch. Reference state: SW=0 (M1 ON, M2/M3 OFF).

```
IN ──[R0]──┐(M1 across)┌── OUT
    │                    │
   (Rp‖Cp)             (Rp‖Cp)
    │                    │
    M2                   M3
    │                    │
   GND                  GND
```

Formulas (Aperture-B iteration for the reference-state IL of M1 shorting the series arm):

```
K   = 10^(A'/20)              Rs  = R0·(K²−1)/(2K)        # single series arm
IL_ref = 20·log10[1+(Ron1‖Rs)/(2R0)]                      Rsh = R0·(K+1)/(K−1)  # per side
A'  = attn + IL_ref           (iterate to convergence)
```

Worked anchor: the verified Pi design and its values (arm split, switch sizing, Cp optimum) are recorded in `sky130_examples/Example.md` (`Pi8/`); reproduce them with the calculator using the recorded Ron inputs.

Tradeoffs: **M1** is the dominant matching limiter — Ron sets the reference-state DC floor, junction cap drives the HF rolloff; keep Ron ≪ R0 and balance the size (Ron×Coff ≈ const). **Rp** plus the switch off-cap sets the reference-state HF matching (hangs directly on the ports). **M2/M3** off-cap sits behind Rp (shielded) — secondary. Worst matching is the reference state at every frequency; the attenuation state rolls toward it at the band top.

## Architecture: T-type

Balanced T-pad: Rs1/Rs2 series per arm, M1 bypass across IN-OUT, shunt arm `(Rp‖Cp)+M2` at the mid node. Reference state: SW=0 (M1 ON, M2 OFF).

```
IN ──Rs1── MID ──Rs2── OUT
│            │                │
└──── M1 ────┘               │
            (Rp ‖ Cp)
            │
            M2
            │
           GND
```

Formulas:

```
K  = 10^(A'/20)             Rs = R0·(K−1)/(K+1)          # per arm
R3 = 2KR0/(K²−1)            # shunt arm total (Rp + Ron)
IL_ref = 20·log10[1+(Ron1‖2Rs)/(2R0)]   A' = attn + IL_ref  (iterate)
```

Tradeoffs: **M1** sets both the DC floor (Ron) and the HF worst point (junction cap) — balance the size; keep Ron ≪ 2·Rs. **Rs** value sets the step; its temperature coefficient dominates the residual drift (the series arm is far more sensitive than the shunt). **Rp** (same poly family as Rs in a real-RC realization) keeps the series/shunt ratio nearly temperature-invariant. Worst matching is the reference state; the design-band worst point falls at the top of the band.

## Architecture: SimpleT

Shunt attenuator: IN-OUT shorted by a 0 Ω bridge; the shunt path (Rp then M0 to GND) loads the thru only in the attenuation state. Reference state: SW=0 (M0 OFF, signal passes); attenuation state: SW=1 (M0 ON).

```
IN ══ Rshort=0 ══ OUT
│
Rp
│
M0
│
GND
```

Formulas (this IS the shared shunt-arm section for SimpleT):

```
|S21| = 2·R_par/(R0+R_par)      R_par = R0 ‖ R_shunt      R_shunt = Rp + Ron
R_shunt(ideal) = R0/(2/|S21|−2)  with |S21| = 10^(−attn/20)
```

The shunt resistance grows rapidly as the target attenuation shrinks — best suited to small attenuation steps (worked values in `sky130_examples/Example.md`).

## Cp Compensation (shared, final parameter)

A compensation capacitor Cp parallels the shunt resistor Rp in every architecture (countering the bypass switch's Coff-induced HF droop). Cp is the **last-determined parameter**: fix everything else, then sweep the `cpf` config parameter across candidates (one batch) and select the point that keeps ΔS21 inside the target band while minimizing **max|Δphase(f)| over the whole band** — the phase optimum is the curve lying closest to 0°, NOT the high-frequency phase pushed to zero. Beware over-compensation: past the optimum the phase swings negative at the band edge and the span re-widens.

**Magnitude-vs-phase trade-off (mandatory to report):** more compensation flattens ΔdB magnitude but deepens the HF attenuation and re-widens the phase error — the two cannot both be minimized. If the design target is ambiguous, report the trade-off to the user explicitly before committing to a Cp value; pick the phase optimum unless the magnitude spec is hard, and document any accepted penalty in `bestPoints.json` designNotes.

## Mandatory Process Rules

1. **Sub-circuit verification first.** Simulate each new sub-component (switch Ron/Coff, shunt arm) before the top-level cell; read Z11 from the parsed curves (Ron = Re(z11), Coff = −1/(2πf·Im(z11)) at the band midpoint).
2. **5×5 local sweep for sub-circuit verification.** Sizing quantization is unavoidable — verify a 5×5 local sweep around the calculated point (W × nf, ±2 card steps each) in the SAME batch. The bundled lvt library carries those grids around the two worked design classes; for a different design point extend it first with `scripts/gen_lvt_cards.py` (or fall back to the nearest available cards and say so in the report).
3. **Always generate the report.** Parse after every batch (remote by default — see batch-sweep step 4); the spec and the `gen_sweep_report {spec}` call may be ONE consolidated report at the end of the design instead of one per batch — every `Sim*_<date>_batch*` run that produced points still joins the report as its own round in the batch dropdown.
4. **Switch geometry moves as one unit.** The flattened model card name, `l/w/nf` and `nrd/nrs` change together (see sky130_examples).
5. **Cp local scan (last parameter).** See the Cp section above.
6. **Reference-state IL is NOT an optimization metric** — but it MUST be presented in the report (ΔS21 charts pair the SW=0/SW=1 states).
7. **Design metrics over the design's characterization band; sims/plots over the full sweep band** (both set per design — verified reference in `sky130_examples/Example.md`).
8. **Device-usage compliance check (mandatory, after every design).** Verify every switch instance against the transcribed-library geometry rules (see `sky130_examples/sky130proc/nfet_switch.json` and the model-file card list) and the include path against the project's library copy; report the per-instance PASS/FAIL table before declaring the cell done.

## Shared Simulation Workflow

1. Run the architecture calculator: `python calc_<arch>.py <target_db> [--ron R] [--ron1 R] [--json design.json]` (from this skill's `scripts/`; the switch data is bundled at `sky130_examples/sky130proc/` — the calculators' default; override with `--data-dir`).
2. Verify sub-circuits — 5×5 local sweep (Rule 2), one `Sim*` batch per verification unit.
3. Create the run directory: copy the architecture template in as `template.scs` (fill the calculator values first), write `sweep_config.json` (`SW: [0,1]`, `cpf` candidates; total points within the session's Max-points-per-scan field — default 100, `batch_submit` rejects scans above it).
4. Submit: `batch_submit {run_dir, worker: "spectre/spectre_sweep_worker.py", worker_args: ["--config", "sweep_config.json", "--max-parallel", "8"], scheduler: "lsf"|"ssh", machine_id, remote_root}` — omit `remote_dir` for the next auto `Sim<N>_<YYYYMMDD>_batch<M>` under `RawResults/` (Spectre on this host: `scheduler: "local"` instead, no machine/root).
5. Poll: `batch_poll {run_dir, wait_sec}` — completion by the point count; a terminal poll auto-fetches sweep_progress.json + errlog.txt (the raw sp.sp curves stay remote; analyze them there per batch-sweep step 4).
6. Report: analyze (remote-first), write the spec into `SimResults/`, then `gen_sweep_report {spec}`.
7. **Cp scan batch** (Rule 5) — pick the phase optimum, re-run 5–6.
8. Write `top/bestPoints.json` (schema below).
9. **Final file-structure check (mandatory).** Confirm the layout below; report the checklist in the final summary.

## PSS IP1dB Characterization (Reference State)

Optional large-signal characterization of the **reference state** (T-type, SimpleT and Pi: SW=0 — do NOT infer it from the netlist). Copy the template as `template_thorough.scs`, replace the `sp` analysis with the `sweeppss` block and follow the smart-spectre skill's swept-PSS section (`spectre-grammar.md`: pin swept over the design's linear-to-compression range, `dbm=pin` on PORT0, `pin` kept in the parameters line — the pitfalls are documented there). Extract Pout = |V_OUT|²/(2·Rport) from the parsed curves, small-signal gain from the first 10 low-power points, IP1dB at the 1 dB gain-drop crossing (interpolated; nearest-neighbour frequency lookup).

## Cascade Analysis

Assembling and analysing a cascade is the **dca-cascade-analysis** skill's job (assembly mechanics in the smart-spectre skill's cascade section, `spectre-cli.md`). Write `cascade_cells.json` next to the results (per cell: `name`, `architecture`, `target_att_db`, `control_bit`, `bestPoints_params`) — that file feeds the cascade report.

## File Organization

```
<CellName>/
  top/
    template.scs               # from sky130_examples/sky130proc/template_{ST,T,Pi}.scs, values filled
    template_thorough.scs      # PSS variant (optional)
    bestPoints.json
  verify/                      # Sub-circuit verification run dirs
<project>/
  RawResults/Sim<N>_<YYYYMMDD>_batch<M>/   # raw run dirs (remote batches / debug fetches)
  SimResults/                  # compact results + report spec JSONs
  Figs/                        # exported chart PNGs (gen-sweep-report)
  <name>_report.html           # the generated report (project root)
```

`top/` holds the netlists and bestPoints only — sweep configs live inside each run directory, never in `top/`.

## bestPoints.json

Canonical schema: `generated`, `targetSpec` (incl. freq range), `params`, `designNotes` (record the direct inputs: `ron`, `ron1`, and the derived arm split), `targetCoverage`, `ref_state_il_db_range` ([min,max] dB — presented, NOT optimized), `delta_db_range`, `delta_db_avg`, `delta_phase_range_deg`, `worst_match_db`, `source`, `dataRef`, and (when characterized) `ip1dB_ref` = `freq_GHz_ip1dB_dBm` map + `source` + `dataRef`. All band-dependent metrics over the design's characterization band.

## Dependencies

- **batch-sweep** — the submit/poll/report workflow (schedulers, Sim naming, remote-first analysis, the spec flow).
- **smart-spectre** — spectre template/config rules, the parser CLIs, cascade assembly, PSS pitfalls.
- **dca-cascade-analysis** — cascade analysis and the cascade design report.
- Plugin tools: `spectre_assemble` / `snp_guide` -> `snp_read` / `snp_extract` (SmartAnaSim), `batch_submit` / `batch_poll` / `gen_sweep_report` (HarnessAMS).

## References & Copyright

All formulas in this skill were independently derived by the Agent during design work; the analysis methods, however, are not first proposals in the literature. If you need to cite them or want more detailed theoretical analysis, use:

Switch below the shunt resistor (current topology — switch junction cap shielded behind Rp):

[1] A. Sun et al., "A 26–32-GHz CMOS Attenuator With Optimized Capacitive Compensation and High Linearity Enhancement," IEEE Transactions on Microwave Theory and Techniques, vol. 73, no. 7, pp. 3997–4009, Jul. 2025, doi: 10.1109/TMTT.2024.3515134.

Switch above the shunt resistor (compensation cap across the switch):

[1] Z. Zhang et al., "A DC–Ka-Band 7-Bit Passive Attenuator With Capacitive-Compensation-Based Bandwidth Extension Technique in 55-nm CMOS," IEEE Transactions on Microwave Theory and Techniques, vol. 69, no. 8, pp. 3861–3874, Aug. 2021, doi: 10.1109/TMTT.2021.3074635.
