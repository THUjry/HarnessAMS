# Example — 4-bit ATT cascade (ST1 + T2 + T4 + Pi8), real sky130 simulation

A real-simulation example for the cascade analysis flow: four designed ATT cells (sky130 switches + ideal R/C) chained into a 4-bit step attenuator and simulated for all 16 control words with ngspice against the sky130 fossi cards, then reported with `gen_cascade_report.py`.

## Files

- `cell_st1.scs` / `cell_t2.scs` / `cell_t4.scs` / `cell_pi8.scs` — the four cell subckts (SimpleT 1 dB, T-type 2 dB, T-type 4 dB, Pi-type 8 dB; switch geometry and Cp values are the characterized finals).
- `cascade.scs` — the cascade netlist: `.include`s the four cells, chains IN - ST1 - T2 - T4 - Pi8 - OUT, drives SW1..SW4 (`SW1`=bit0/LSB ... `SW4`=bit3/MSB, `SWB = 1.8 - SW`), two-port S-parameter excitation and the `.sp` sweep (1 MHz..40 GHz). The `.lib` line carries a placeholder — point it at your fossi `sky130.lib.spice` (or the transcribed library for a Spectre run).
- `Analysis/data/Round1.js` — the generated results JSON (`var ROUND_DATA`): per-control-word delta/phase/worst traces vs the zero state, expected-vs-actual accuracy, RMS error curves, summary and the per-cell table data.
- `Analysis/Cascade4bit_report.html` — the corresponding generated report (open in a browser; Plotly loads from the CDN).

## Measured behavior (from the real runs)

Reference-state IL @1 GHz ≈ −1.75 dB (the sum of the four cells' reference states); single-bit steps @1 GHz ≈ −1.15 / −2.04 / −4.07 / −8.06 dB against the 1 / 2 / 4 / 8 dB nominal; the all-ones state ≈ ref IL + Σ bits (interaction < 0.3 dB). The consistency check (Section 5) passes for every cell.

## Recorded cross-check references

These anchors were removed from the SKILL.md method text when it was generalized — they are recorded here instead. Verified sweep grid of this example: `cascade.scs` sweeps 1 MHz..40 GHz; performance metrics use the generator's built-in metrics band. Single-bit increments from an earlier 5-bit reference cascade (cross-check at a low-frequency point): 0.5 dB cell ≈ −0.58, 1 dB ≈ −1.17, 2 dB ≈ −2.09, 4 dB ≈ −4.11, 8 dB ≈ −8.09 dB. RMS attenuation error growth on that reference cascade: ≈ 0.17 dB @ 1 GHz → 0.42 dB @ 30 GHz.

## Regenerating

Re-run the 16 simulations (one per control word — set the four SW levels in `cascade.scs`, run ngspice, convert the wrdata CSV columns `f,s11re,f,s11im,f,s21re,f,s21im,f,s22re,f,s22im` into psfascii `sp_XXXX.sp` files under `Results/Round1/`), write a `cascade_cells.json` (four cells, `control_bit` 0..3 per the wiring above) plus per-cell `cells/<folder>/top/bestPoints.json`, then:

```bash
python ../scripts/gen_cascade_report.py <cascade_dir>
# or, on a sweep run directory with NN/netlist.scs.raw/sp.sp points:
python ../scripts/gen_cascade_report.py --run-dir <run_dir>
```
