# Verified example: ST1 / T4 / Pi8 (sky130, plain-nfet switches)

Three unit cells — one per architecture (SimpleT, T-type, Pi) — designed with this skill's method and verified in Spectre: ideal R/C, real sky130 switches, tt corner, 27 °C, ports Z0=50 Ω. This file records the example's design values and the verified frequency band; the SKILL.md method text stays number-free on purpose — the concrete numbers live here. They are illustrative for THIS example: a new design asks the user for its own constraints or explicitly confirms carrying any of these over — never copies them silently.

**Device generation.** The example cells use the plain `sky130_fd_pr__nfet_01v8` switch (flattened `nshort_model__*` model cards, l=0.15 µm, Vgs=1.8 V; Ron·W ≈ 789.6 Ω·µm, Coff·W ≈ 0.494 fF/µm — the measured table is `sky130proc/nfet_ron_coff.csv`). The runnable templates and the bundled model file in `sky130proc/` use the lvt flavor (`nlowvt_model__*`) — the two flavors coexist on purpose: the templates are the self-contained runnable kit, the examples document the plain-nfet generation. The lvt kit carries the coarse FOM ladder (w10/20/50/100) plus full 5×5 local grids around the two worked design classes; extend it with `scripts/gen_lvt_cards.py` (clone-based, rsh = 89.1·nf/w + 443.5).

**Verified band.** Every cell was swept 1 MHz – 15 GHz (spectre `sp` analysis, psfascii, 210 points per state). Reported metrics: ΔS21 mean over the band, ΔS21 peak-to-peak within 15 GHz (Pi8 also within 14.45 GHz), Δphase peak-to-peak, reference-state IL DC→15 GHz, and S11 at 15 GHz in both states.

| design | arch | target | Cp (fF) | series R (Ω) | shunt R (Ω) | switches w/nf (Ron Ω) | ΔS21 mean (dB) | ΔS21 pk-pk (dB) | Δφ pk-pk (deg) | IL_ref DC→15G (dB) | S11@15G ref/att (dB) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ST1 | SimpleT | 1 dB | 28 | — | 172.11 | M0 24.09/12 (32.78) | -1.0014 | 0.0047 | 1.17 | 0 → -0.0309 | -33.1 / -18.5 |
| T4 | T-type | 4 dB | 88 | 12.70 ×2 | 77.31 | M1 98.70/49 (8.0), M2 53.62/27 (14.73) | -4.0019 | 0.0231 | 2.92 | -0.5074 → -1.0371 | -13.7 / -14.7 |
| Pi8 | Pi | 8 dB | 60 | 60.03 | 89.64 ×2/side | M1 65.80/33 (12.0), M2/M3 46.24/23 (17.07) | -8.0120 | 0.0301 (0.0204 ≤14.45G) | 4.42 | -0.8184 → -1.2397 | -14.4 / -15.2 |

**Per-design folders.** Each of `ST1/`, `T4/`, `Pi8/` holds `design.json` (final parameters at full precision, per-state switch settings, result summary) plus the two-state raw results `sp_ref.sp` (SW=0) and `sp_att.sp` (SW=1) — verbatim spectre psfascii `sp` outputs, renamed only (the recorded runs carry their original internal analysis name in the psf header). Parse them with the SmartAnaSim `spectre_psf_parse.py` CLI.
