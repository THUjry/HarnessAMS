# -*- coding: utf-8 -*-
"""
calc_t_type.py — T-type ATT design, direct Rpoly/Ron input (sky130)
===================================================================
Topology: balanced T-pad (Rs1/Rs2 series per arm, M1 bypass across IN-OUT,
shunt arm Rp||Cp in series with M2 to GND).

Design method: the arm total comes from the ideal formulas, then the switch
Ron is a DIRECT input (--ron, suggested 1/3..1/5 of the arm total; default
arm/4); the resistive part is the remainder Rp = R3 - Ron. The bypass
switch Ron1 is a direct input too (default: the verified 8 dB Pi 12-ohm
class). No TC optimization; residual drift is accepted and recorded.

Run: python calc_t_type.py <attn_db> [--ron1 <ohm>] [--ron <ohm>]
         [--data-dir <dir>] [--json <file>]
"""
import argparse
import cmath
import json
import math
import os

R0 = 50.0
FREQS = [5, 10, 15, 20, 25, 30, 35, 40]  # GHz, flatness estimate band

DEFAULT_DATA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                 'sky130_examples', 'sky130proc'))


def load_pack(data_dir):
    with open(os.path.join(data_dir, 'nfet_switch.json'), encoding='utf-8') as f:
        nfet = json.load(f)
    nfet['device'] = nfet['meta']['device']   # flattened for the sizing helpers
    return nfet


def ideal_t(attn_db):
    """T-network: returns (Rs_per_arm, R3_shunt_total)."""
    k = 10.0 ** (attn_db / 20.0)
    rs = R0 * (k - 1.0) / (k + 1.0)
    r3 = 2.0 * k * R0 / (k * k - 1.0)
    return rs, r3


def il_ref_t(ron1, rs):
    """Reference-state DC insertion loss [dB]: M1 shorts the series arms."""
    zser = ron1 * (2.0 * rs) / (ron1 + 2.0 * rs)
    return 20.0 * math.log10(1.0 + zser / (2.0 * R0))


def design_aperture(attn_nominal, ron1):
    """Aperture B iteration: relative step (att-ref) = nominal attenuation."""
    a = attn_nominal
    for _ in range(30):
        rs, _ = ideal_t(a)
        a_new = attn_nominal + il_ref_t(ron1, rs)
        if abs(a_new - a) < 1e-9:
            break
        a = a_new
    rs, r3 = ideal_t(a)
    return a, rs, r3


def ron_to_switch(ron_target, nfet):
    """Switch geometry from the Ron x total-width product (per-finger ~2 um)."""
    w_tot = nfet['ron_w_ohm_um'] / ron_target
    nf = max(1, min(64, int(round(w_tot / 2.0))))
    coff = nfet.get('coff_w_ff_um')
    return {'device': nfet['device'], 'l_um': nfet['l_um'], 'w_um': round(w_tot, 2),
            'nf': nf, 'wf_um': round(w_tot / nf, 2), 'ron_ohm': ron_target,
            'coff_ff': round(coff * w_tot, 1) if coff else None}


def solve(y, b):
    """Gaussian elimination for Y*x = b."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(y)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    x = [0j] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][k] * x[k] for k in range(r + 1, n))) / m[r][r]
    return x


def cell_s21_t(rs, rp, ron2, cp_ff, ron1, coff1_ff, coff2_ff, f_ghz, state):
    """3-node (IN, MID, OUT) S21 matching the netlist topology.

    Series branches: Rs1=Rs2=Rs each, M1 across IN-OUT.
    Shunt arm at MID: (Rp || Cp) + zM2.
      ref state: zM1=Ron1, zM2=1/jwCoff2 (M2 off)
      att state: zM1=1/jwCoff1 (M1 off), zM2=Ron2
    """
    w = 2.0 * math.pi * f_ghz * 1e9
    cp = cp_ff * 1e-15 if cp_ff else 0.0
    if state == 'att':
        zm1 = 1.0 / (1j * w * coff1_ff * 1e-15)
        zm2 = complex(ron2)
    else:
        zm1 = complex(ron1)
        zm2 = 1.0 / (1j * w * coff2_ff * 1e-15)
    zp = 1.0 / (1.0 / rp + 1j * w * cp) if cp > 0 else complex(rp)
    zsh = zp + zm2

    y = [[0j] * 3 for _ in range(3)]
    y[0][0] = 1.0 / R0 + 1.0 / rs + 1.0 / zm1
    y[0][1] = -1.0 / rs
    y[0][2] = -1.0 / zm1
    y[1][1] = 1.0 / rs + 1.0 / rs + 1.0 / zsh
    y[1][2] = -1.0 / rs
    y[2][2] = 1.0 / R0 + 1.0 / rs + 1.0 / zm1
    y[1][0] = y[0][1]
    y[2][0] = y[0][2]
    y[2][1] = y[1][2]
    v = solve(y, [1.0 / R0, 0.0, 0.0])
    return 2.0 * v[2]


def sweep(rs, rp, ron2, cp_ff, ron1, coff1_ff, coff2_ff):
    rows = []
    for f in FREQS:
        s_ref = cell_s21_t(rs, rp, ron2, cp_ff, ron1, coff1_ff, coff2_ff, f, 'ref')
        s_att = cell_s21_t(rs, rp, ron2, cp_ff, ron1, coff1_ff, coff2_ff, f, 'att')
        rel = 20.0 * math.log10(abs(s_att) / abs(s_ref))
        dph = (cmath.phase(s_att) - cmath.phase(s_ref)) * 180.0 / math.pi
        while dph > 180.0:
            dph -= 360.0
        while dph < -180.0:
            dph += 360.0
        rows.append((f, -rel, abs(dph)))
    return rows


def design(attn_db, ron1=None, ron2=None, data_dir=None):
    nfet = load_pack(data_dir or DEFAULT_DATA_DIR)

    # --- direct inputs: arm total from the ideal formulas, Ron GIVEN ---
    if ron1 is None:
        ron1 = 12.0                                  # bypass-switch class (verified 8 dB Pi)
    a_prime, rs, r3 = design_aperture(attn_db, ron1)
    if ron2 is None:
        ron2 = r3 / 4.0                             # mid of the 1/3..1/5 guidance band
    rpoly = r3 - ron2                               # resistive remainder
    r3_realized = rpoly + ron2

    m1 = ron_to_switch(ron1, nfet)
    m2 = ron_to_switch(ron2, nfet)
    # Cp first estimate ~ Coff of the shunt switch, MEASURED in the
    # cell-bias shunt config (0.42 fF/um; see sky130proc/nfet_switch.json).
    # Advisory only -- the Cp scan is authoritative.
    cp_ff = m2['coff_ff']

    il_ref_dc = il_ref_t(ron1, rs)

    print("=" * 60)
    print(f"  T-type ATT design (arm total + direct Ron, sky130) — {attn_db} dB")
    print("=" * 60)
    print(f"  Aperture B: A'={a_prime:.3f} dB, IL_ref={il_ref_dc:.4f} dB")
    print(f"  Rs (per arm) = {rs:.2f} ohm;  R3 (shunt total) = {r3:.2f} ohm ideal")
    print(f"  Shunt arm: Rp {rpoly:.2f} + Ron2 {ron2:.2f} = {r3_realized:.2f} ohm"
          f"  (Ron2/R3 = {ron2 / r3:.2f}; keep Ron2 within 1/3..1/5 of the arm total)")
    print(f"\n  M1 (bypass):        {m1['device']} l={m1['l_um']} w={m1['w_um']} nf={m1['nf']}"
          f" -> Ron={ron1:.2f} ohm, Coff~{m1['coff_ff']} fF")
    print(f"  M2 (shunt):         {m2['device']} l={m2['l_um']} w={m2['w_um']} nf={m2['nf']}"
          f" -> Ron={ron2:.2f} ohm, Coff~{m2['coff_ff']} fF")
    print(f"  Rs: IDEAL resistor r={rs:.2f} ohm/arm (x2)")
    print(f"  Rp: IDEAL resistor r={rpoly:.2f} ohm")
    print(f"  Cp first estimate: {cp_ff:.0f} fF (scan in simulation)")

    if cp_ff and m1['coff_ff'] and m2['coff_ff']:
        print(f"\n  {'Freq(GHz)':>10} {'Delta att(dB)':>14} {'Delta phase(deg)':>16}")
        rows = sweep(rs, rpoly, ron2, cp_ff, ron1, m1['coff_ff'], m2['coff_ff'])
        for f, d, p in rows:
            print(f"{f:10.0f} {d:14.3f} {p:16.2f}")
        ea = max(abs(d - attn_db) for _, d, _ in rows)
        ep = max(p for _, _, p in rows)
        print(f"\n  Analytic estimate: max att err {ea:.3f} dB, max phase err {ep:.2f} deg"
              f"  (Coff-based, ADVISORY — actual simulation results are authoritative)")

    return {
        'architecture': 't-type', 'attn_target_db': attn_db,
        'a_prime_db': round(a_prime, 4), 'il_ref_db': round(il_ref_dc, 4),
        'Rs': {'r_ohm': round(rs, 2), 'element': 'ideal resistor'},
        'Rp': {'r_ohm': round(rpoly, 2), 'element': 'ideal resistor'},
        'M1': m1, 'M2': m2,
        'cp_first_estimate_ff': cp_ff,
        'method': 'arm total from ideal formulas + direct Ron input (1/3..1/5 guidance), '
                  'sky130 switch data (sky130_examples/sky130proc/nfet_switch.json)',
    }


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('attn_db', type=float, help='target attenuation [dB]')
    ap.add_argument('--ron1', type=float, default=None,
                    help='direct input: M1 bypass switch Ron [ohm]')
    ap.add_argument('--ron', type=float, default=None,
                    help='direct input: shunt switch Ron2 [ohm] '
                         '(suggested 1/3..1/5 of the shunt arm total; default arm/4)')
    ap.add_argument('--data-dir', default=None,
                    help='dir holding nfet_switch.json '
                         '(default: the bundled sky130_examples/sky130proc)')
    ap.add_argument('--json', default=None, help='also write the design dict here')
    args = ap.parse_args()
    result = design(args.attn_db, args.ron1, args.ron, args.data_dir)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2)
            f.write('\n')
        print(f"\n  [json] wrote {os.path.abspath(args.json)}")
