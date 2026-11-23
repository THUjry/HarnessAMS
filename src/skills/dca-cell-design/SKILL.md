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

Unit-cell design flow: dimension calculation (three architectures), cluster
verification sweeps (the batch-sweep workflow; spectre template/config rules
in the **smart-spectre** skill) and the cell design report
(`gen_sweep_report`). Cascade analysis and reporting live in the
**analysis-cascade-dca** skill.

**Design method:** the arm total resistance comes from the ideal network
formulas, then the **switch Ron is a direct input** (suggested **1/3 ~ 1/5 of
the arm total** — a larger Ron wastes arm resistance on the switch, a smaller
one grows the device and its off-capacitance); the resistive part is the
remainder. Temperature-coefficient targeting (ZTC) is retired — residual
drift is measured in the mandatory final temperature sweep and recorded, not
compensated.

**Ideal RC:** the templates realize R and C as IDEAL elements; only the
switches are real sky130 devices. Analytic flatness predictions from the
calculators are therefore advisory — **actual simulation results are
authoritative**.

## Required Parameters (ask the user when missing)

| Parameter | Description | Default |
|-----------|-------------|---------|
| **work_dir** | Cell root directory, e.g. `<project>/AttST1dB/` | — |
| **architecture** | `T-type`, `SimpleT`, or `Pi` | — |
| **target_db** | Target attenuation in dB | — |
| **ron** | Direct input: shunt switch Ron [Ω] (arm total /4 by default; keep within 1/3 ~ 1/5 of the arm total) | derived |
| **ron1** | Direct input: bypass switch Ron [Ω] (T/Pi only; 12 Ω class by default) | derived |
| **freq_start / freq_stop** | Sweep band (GHz) | 1 / 40 |

**Frequency bands.** The S-parameter sweep and reports run to **40 GHz max**.
Design metrics — `delta_db_range`, `delta_db_avg`, `delta_phase_range_deg`,
`worst_match_db`, `ref_state_il_db_range`, `temp_span_0_100C` — are
characterized over the **DC~30 GHz** band (the 1 GHz sweep point represents
DC; the resistive network is near-flat below 1 GHz). Do not truncate the
sweep to 30 GHz just because the metric band is DC~30 GHz.

## sky130_examples (`sky130_examples/`)

Self-contained example set — every netlist runs as-is against the bundled
model file:

- `template_Pi.scs` — Pi template with the verified 8 dB worked values
  (reproduced by `calc_pi.py 8`).
- `template_T.scs` — 4 dB T-type class defaults (`calc_t_type.py 4`).
- `template_ST.scs` — 1 dB SimpleT class defaults (`calc_simplet.py 1`).
- `sky130_fd_pr__nfet_01v8_lvt.scs` — the transcribed sky130 switch model
  (per-geometry flattened `nlowvt_model__w<W>p<N>f<N>` cards; MIT-licensed
  sky130-spectre-models repo). In a real project point the `include` at the
  project's own transcribed-library copy.
- `nfet_switch.json` — switch data for the calculators: Ron·W ≈ 740 Ω·µm
  (l=0.15, Vgs=1.8) with the verified sizing points, Coff·W ≈ 0.92 fF/µm
  (estimate).

Switch instances use the flattened model card names — when the calculator
picks a new w/nf, take the nearest existing card from the transcribed library
(or extend its generator) and update `l/w/nf/nrd/nrs` together.

## Shunt-Arm Calculation (shared; for SimpleT this IS the whole design)

Every architecture realizes its shunt path the same way — a resistive part in
series with a shunt switch — and for SimpleT the whole cell is exactly this
path:

1. **Arm total from the ideal formulas** (per architecture below):
   `R_arm = R0/(2/|S21| − 2)` for SimpleT; `R3` for T-type; `Rsh` per side
   for Pi.
2. **Ron direct input** — the shunt switch on-resistance is GIVEN (suggested
   1/3 ~ 1/5 of `R_arm`; default `R_arm/4`). Switch sizing:
   `W_tot = 740 Ω·µm / Ron` (`sky130_fd_pr__nfet_01v8_lvt`, l=0.15, Vgs=1.8),
   per-finger width ≈ 2 µm (`nf = round(W_tot/2)`); Coff ≈ 0.92 fF/µm
   (estimate — see `sky130_examples/nfet_switch.json`).
3. **Resistive remainder**: `Rp = R_arm − Ron`. Report the achieved step
   against the target (with ideal RC the DC step is exact; the flatness is
   simulation's business).

For T-type and Pi the series arm(s) come from the same ideal formulas
(`Rs`), and the bypass switch Ron1 is a direct input (default 12 Ω class;
keep Ron1 ≪ the series path it shorts, or the bypass fails).

## Architecture: Pi

Single series arm R0 bypassed by M1; two symmetric shunt arms, each
`(Rp‖Cp)` in series with M2/M3 to GND. **Cp parallels Rp** (netlist-
accurate), NOT the switch. Reference state: SW=0 (M1 ON, M2/M3 OFF).

```
IN ──[R0]──┐(M1 across)┌── OUT
    │                    │
   (Rp‖Cp)             (Rp‖Cp)
    │                    │
    M2                   M3
    │                    │
   GND                  GND
```

Formulas (Aperture-B iteration for the reference-state IL of M1 shorting the
series arm):

```
K   = 10^(A'/20)              Rs  = R0·(K²−1)/(2K)        # single series arm
IL_ref = 20·log10[1+(Ron1‖Rs)/(2R0)]                      Rsh = R0·(K+1)/(K−1)  # per side
A'  = attn + IL_ref           (iterate to convergence)
```

Worked anchor (verified): 8 dB → A'=8.828, Rs=60.03 Ω, Rsh=106.72 Ω/side =
Rp 89.64 + Ron2 17.07; M1 w=61.7 nf=31 (12 Ω), M2/M3 w=43.3 nf=22 (17.1 Ω);
Cp scan optimum 40 fF/side. (Reproduced by `calc_pi.py 8 --ron 17.07`.)

Tradeoffs: **M1** is the dominant matching limiter — Ron sets the reference-
state DC floor, junction cap drives the HF rolloff; keep Ron ≪ R0 and balance
the size (Ron×Coff ≈ const). **Rp** plus the switch off-cap sets the
reference-state HF matching (hangs directly on the ports). **M2/M3** off-cap
sits behind Rp (shielded) — secondary. Worst matching is the reference state
at every frequency; the attenuation state rolls toward it at the band top.

## Architecture: T-type

Balanced T-pad: Rs1/Rs2 series per arm, M1 bypass across IN-OUT, shunt arm
`(Rp‖Cp)+M2` at the mid node. Reference state: SW=0 (M1 ON, M2 OFF).

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

Tradeoffs: **M1** sets both the DC floor (Ron) and the HF worst point
(junction cap) — balance the size; keep Ron ≪ 2·Rs. **Rs** value sets the
step; its temperature coefficient dominates the residual drift (the series
arm is far more sensitive than the shunt). **Rp** (same poly family as Rs in
a real-RC realization) keeps the series/shunt ratio nearly
temperature-invariant. Worst matching is the reference state; the design-band
worst point falls at the top of the band.

## Architecture: SimpleT

Shunt attenuator: IN-OUT shorted by a 0 Ω bridge; the shunt path (Rp then
M0 to GND) loads the thru only in the attenuation state. Reference state:
SW=0 (M0 OFF, signal passes); attenuation state: SW=1 (M0 ON).

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

Examples: 1 dB → R_shunt ≈ 205 Ω; 0.5 dB → ≈ 435 Ω. Best suited to small
attenuation steps.

## Cp Compensation (shared, final parameter)

A compensation capacitor Cp parallels the shunt resistor Rp in every
architecture (countering the bypass switch's Coff-induced HF droop). Cp is
the **last-determined parameter**: fix everything else, then sweep the
`cpf` config parameter across candidates (one batch) and select the point
that keeps ΔS21 inside the target band while minimizing
**max|Δphase(f)| over the whole band** — the phase optimum is the curve
lying closest to 0°, NOT the high-frequency phase pushed to zero. Beware
over-compensation: past the optimum the phase swings negative at the band
edge and the span re-widens.

**Magnitude-vs-phase trade-off (mandatory to report):** more compensation
flattens ΔdB magnitude but deepens the HF attenuation and re-widens the
phase error — the two cannot both be minimized. If the design target is
ambiguous, report the trade-off to the user explicitly before committing to
a Cp value; pick the phase optimum unless the magnitude spec is hard, and
document any accepted penalty in `bestPoints.json` designNotes.

## Mandatory Process Rules

1. **Sub-circuit verification first.** Simulate each new sub-component
   (switch Ron/Coff, shunt arm) before the top-level cell; read Z11 from the
   parsed curves (Ron = Re(z11), Coff = −1/(2πf·Im(z11)) at the band
   midpoint).
2. **5×5 local sweep for sub-circuit verification.** Sizing quantization is
   unavoidable — verify a 5×5 local sweep around the calculated point
   (e.g. W × nf, ±2 discrete steps each) in the SAME batch.
3. **Always generate the report.** After every batch: parse (remote by
   default — see batch-sweep step 4), then build the spec and call
   `gen_sweep_report {spec}` — one round per `Sim*_<date>_batch*` run of the
   project joins the batch dropdown.
4. **Switch geometry moves as one unit.** The flattened model card name,
   `l/w/nf` and `nrd/nrs` change together (see sky130_examples).
5. **Cp local scan (last parameter).** See the Cp section above.
6. **Reference-state IL is NOT an optimization metric** — but it MUST be
   presented in the report (ΔS21 charts pair the SW=0/SW=1 states).
7. **Design metrics DC~30 GHz; sims/plots to 40 GHz max.**
8. **Device-usage compliance check (mandatory, after every design).** Verify
   every switch instance against the transcribed library rules (l=0.15,
   per-finger w ≈ 2 µm, card name consistent with geometry) and the include
   path against the project's library copy; report the per-instance PASS/FAIL
   table before declaring the cell done.

## Shared Simulation Workflow

1. Run the architecture calculator:
   `python calc_<arch>.py <target_db> [--ron R] [--ron1 R] [--json design.json]`
   (from this skill's `scripts/`; switch data from `sky130_examples/` or
   `--data-dir`).
2. Verify sub-circuits — 5×5 local sweep (Rule 2), one `Sim*` batch per
   verification unit.
3. Create the run directory: copy the architecture template in as
   `template.scs` (fill the calculator values first), write
   `sweep_config.json` (`SW: [0,1]`, `cpf` candidates, ≤100 points).
4. Submit: `batch_submit {run_dir, worker: "spectre/spectre_sweep_worker.py",
   worker_args: ["--config", "sweep_config.json", "--max-parallel", "8"],
   scheduler: "lsf"|"direct", machine_id, remote_root}` — omit `remote_dir`
   for the next auto `Sim<N>_<YYYYMMDD>_batch<M>` under `RawResults/`
   (Spectre on this host: `scheduler: "local"` instead, no machine/root).
5. Poll: `batch_poll {run_dir, wait_sec}` — completion by the point count;
   a terminal poll auto-fetches sweep_progress.json + errlog.txt (the raw
   sp.sp curves stay remote; analyze them there per batch-sweep step 4).
6. Report: analyze (remote-first), write the spec into `SimResults/`, then
   `gen_sweep_report {spec}`.
9. **Cp scan batch** (Rule 5) — pick the phase optimum, re-run 5–6.
10. **Final temperature sweep (mandatory).** All parameters fixed, sweep
    `temperature: [0,20,40,60,80,100]` × `SW: [0,1]` = 12 points; the final
    report view shows the 6 temperature curves.
11. Write `top/bestPoints.json` (schema below).
12. **Final file-structure check (mandatory).** Confirm the layout below;
    report the checklist in the final summary.

## PSS IP1dB Characterization (Reference State)

Optional large-signal characterization of the **reference state** (T-type,
SimpleT and Pi: SW=0 — do NOT infer it from the netlist). Copy the template
as `template_thorough.scs`, replace the `sp` analysis with the `sweeppss`
block and follow the smart-spectre skill's PSS companion page (pin sweep
−20..+30 dBm, `dbm=pin` on PORT0, `pin` kept in the parameters line — both
pitfalls documented there). Extract Pout = |V_OUT|²/(2·Rport) from the
parsed curves, small-signal gain from the first 10 low-power points, IP1dB
at the 1 dB gain-drop crossing (interpolated; nearest-neighbour frequency
lookup).

## Cascade Analysis

Assembling and analysing a cascade is the **analysis-cascade-dca** skill's
job (assembly mechanics in the smart-spectre skill's cascade companion
page). Write
`cascade_cells.json` next to the results (per cell: `name`, `architecture`,
`target_att_db`, `control_bit`, `bestPoints_params`) — that file feeds the
cascade report.

## File Organization

```
<CellName>/
  top/
    template.scs               # from sky130_examples/template_{ST,T,Pi}.scs, values filled
    template_thorough.scs      # PSS variant (optional)
    bestPoints.json
  verify/                      # Sub-circuit verification run dirs
<project>/
  RawResults/Sim<N>_<YYYYMMDD>_batch<M>/   # raw run dirs (remote batches / debug fetches)
  SimResults/                  # compact results + report spec JSONs
  Figs/                        # exported chart PNGs (gen-sweep-report)
  <name>_report.html           # the generated report (project root)
```

`top/` holds the netlists and bestPoints only — sweep configs live inside
each run directory, never in `top/`.

## bestPoints.json

Canonical schema: `generated`, `targetSpec` (incl. freq range), `params`,
`designNotes` (record the direct inputs: `ron`, `ron1`, and the derived arm
split), `targetCoverage`, `ref_state_il_db_range` ([min,max] dB — presented,
NOT optimized), `delta_db_range`, `delta_db_avg`, `delta_phase_range_deg`,
`worst_match_db`, `temp_span_0_100C` (`temperatures` + `delta_db_avg` [6] +
`drift_db`), `source`, `dataRef`, `tempDataRef`, and (when characterized)
`ip1dB_ref` = `freq_GHz_ip1dB_dBm` map + `source` + `dataRef`. All
band-dependent metrics over the DC~30 GHz characterization band.

## Dependencies

- **batch-sweep** — the submit/poll/report workflow (schedulers, Sim naming,
  remote-first analysis, the spec flow).
- **smart-spectre** — spectre template/config rules, the parser CLIs, cascade
  assembly, PSS pitfalls.
- **analysis-cascade-dca** — cascade analysis and the cascade design report.
- Plugin tools: `spectre_assemble` / `snp_guide` -> `snp_read` / `snp_extract`
  (SmartAnaSim), `batch_submit` / `batch_poll` / `gen_sweep_report`
  (HarnessAMS).

## References & Copyright

All formulas in this skill were independently derived by the Agent during
design work; the analysis methods, however, are not first proposals in the
literature. If you need to cite them or want more detailed theoretical
analysis, use:

Switch below the shunt resistor (current topology — switch junction cap
shielded behind Rp):

[1] A. Sun et al., "A 26–32-GHz CMOS Attenuator With Optimized Capacitive
Compensation and High Linearity Enhancement," IEEE Transactions on Microwave
Theory and Techniques, vol. 73, no. 7, pp. 3997–4009, Jul. 2025,
doi: 10.1109/TMTT.2024.3515134.

Switch above the shunt resistor (compensation cap across the switch):

[1] Z. Zhang et al., "A DC–Ka-Band 7-Bit Passive Attenuator With
Capacitive-Compensation-Based Bandwidth Extension Technique in 55-nm CMOS,"
IEEE Transactions on Microwave Theory and Techniques, vol. 69, no. 8,
pp. 3861–3874, Aug. 2021, doi: 10.1109/TMTT.2021.3074635.
