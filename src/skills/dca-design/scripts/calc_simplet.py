# -*- coding: utf-8 -*-
"""
calc_simplet.py — SimpleT/shunt ATT design, direct Rpoly/Ron input (sky130)
============================================================================
Shunt path: PORT0 → Rpoly → M0 → GND with IN-OUT shorted (0-ohm bridge).
Design method (2026-11-21): the shunt-arm total comes from the ideal
formula, then the switch Ron is a DIRECT input (--ron, suggested 1/3..1/5
of R_shunt; default R_shunt/4); the resistive part is the remainder
Rpoly = R_shunt - Ron. The legacy ZTC ratio method is retired — residual
temperature drift is accepted and recorded, not compensated.

Geometry comes from the bundled sky130 data pack (data/sky130/): poly
res_high_po (rsh effective incl. heads), switch sky130_fd_pr__nfet_01v8_lvt
(ron_w product, l=0.15, Vgs=1.8), MIM cap (order-of-magnitude fF/um^2).

Run: python calc_simplet.py <attn_db> [--ron <ohm>]
         [--data-dir <dir>] [--json <file>]
"""
import argparse
import cmath
import json
import math
import os

R0 = 50.0
FREQS = [1, 5, 10, 15, 20, 25, 30, 35, 40]  # GHz, flatness estimate band

DEFAULT_DATA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'sky130'))


def load_pack(data_dir):
    with open(os.path.join(data_dir, 'resistors.json'), encoding='utf-8') as f:
        resistors = json.load(f)
    with open(os.path.join(data_dir, 'nfet_switch.json'), encoding='utf-8') as f:
        nfet = json.load(f)
    nfet['device'] = nfet['meta']['device']   # flattened for the sizing helpers
    with open(os.path.join(data_dir, 'mimcap.json'), encoding='utf-8') as f:
        mimcap = json.load(f)
    return resistors, nfet, mimcap


def r_shunt_from_db(attn_db):
    """Shunt resistance achieving attn_db between two 50-ohm ports."""
    s21 = 10.0 ** (-attn_db / 20.0)
    return R0 / (2.0 / s21 - 2.0)


def attn_from_r_shunt(r_shunt):
    """Achieved attenuation for a given shunt resistance (inverse)."""
    r_par = R0 * r_shunt / (R0 + r_shunt)
    s21 = 2.0 * r_par / (R0 + r_par)
    return -20.0 * math.log10(s21)


def ron_to_switch(ron_target, nfet):
    """Switch geometry from the Ron x total-width product (per-finger ~2 um)."""
    ron_w = nfet['ron_w_ohm_um']
    w_tot = ron_w / ron_target
    nf = max(1, min(64, int(round(w_tot / 2.0))))
    wf = w_tot / nf
    coff_w = nfet.get('coff_w_ff_um')
    coff_ff = coff_w * w_tot if coff_w else None
    return {'device': nfet['device'], 'l_um': nfet['l_um'], 'w_um': round(w_tot, 2),
            'nf': nf, 'wf_um': round(wf, 2), 'ron_ohm': ron_target,
            'coff_ff': round(coff_ff, 1) if coff_ff else None}


def r_to_poly(target_r, resistors, device='res_high_po', w_grid=(0.69, 1.0, 1.41, 2.0, 3.0, 5.0, 8.0, 10.0, 20.0)):
    """Poly geometry from the effective sheet resistance. R = rsh_eff*l/w."""
    rsh = resistors[device]['recommended_rsh_effective_ohm_sq']
    best = None
    for w in w_grid:
        l = target_r * w / rsh
        if l < 0.5:            # below the PO-resistor minimum length
            continue
        if best is None or l < best[1]:
            best = (w, l)
    if best is None:
        # fall back to the narrowest width and report the (sub-min) length
        best = (w_grid[0], target_r * w_grid[0] / rsh)
    w, l = best
    return {'device': device, 'w_um': w, 'l_um': round(l, 2),
            'r_ohm': round(rsh * l / w, 2), 'rsh_eff': rsh}


def shunt_s21(r_poly, ron, cp_ff, coff_ff, f_ghz, on):
    """S21 of the shunt cell at one frequency (1-port shunt across a 50-ohm thru).

    att state (on=True): shunt = (Rpoly || Cp) + Ron
    ref state (on=False): shunt = (Rpoly || Cp) + 1/jwCoff
    """
    w = 2.0 * math.pi * f_ghz * 1e9
    cp = cp_ff * 1e-15 if cp_ff else 0.0
    zp = 1.0 / (1.0 / r_poly + 1j * w * cp) if cp > 0 else complex(r_poly)
    zsh = zp + (ron if on else 1.0 / (1j * w * coff_ff * 1e-15))
    y = 1.0 / zsh
    return 2.0 / (2.0 + R0 * y)          # shunt admittance across the thru


def design(attn_db, ron=None, data_dir=None):
    resistors, nfet, mimcap = load_pack(data_dir or DEFAULT_DATA_DIR)
    r_shunt_target = r_shunt_from_db(attn_db)

    # --- direct input: arm total from the formula, Ron GIVEN ---
    if ron is None:
        ron = r_shunt_target / 4.0       # mid of the 1/3..1/5 guidance band
    rpoly = r_shunt_target - ron         # resistive remainder
    r_shunt = rpoly + ron
    attn_ach = attn_from_r_shunt(r_shunt)

    m0 = ron_to_switch(ron, nfet)
    rpoly_geo = r_to_poly(rpoly, resistors)

    # Cp first estimate: ~ Coff of the shunt switch (the Pi8dB calibration had
    # Cp* ~= Coff of the shunt device). Refined by the mandatory Cp scan.
    cp_ff = m0['coff_ff']

    print("=" * 60)
    print("  SimpleT/Shunt ATT design (arm total + direct Ron, sky130)")
    print("=" * 60)
    print(f"  Target attenuation: {attn_db} dB")
    print(f"  R_shunt required:   {r_shunt_target:.1f} ohm")
    print(f"  R_shunt realized:   {r_shunt:.1f} ohm  (Rpoly {rpoly:.1f} + Ron {ron:.1f};"
          f" keep Ron within 1/3..1/5 of R_shunt)")
    print(f"  Achieved attenuation: {attn_ach:.3f} dB  (residual {attn_ach - attn_db:+.3f} dB)")
    print(f"\n  M0 (shunt switch): {m0['device']} l={m0['l_um']} w={m0['w_um']} nf={m0['nf']}"
          f" (wf={m0['wf_um']} um), Ron={ron:.2f} ohm, Coff~{m0['coff_ff']} fF")
    print(f"  Rpoly: {rpoly_geo['device']} w={rpoly_geo['w_um']} l={rpoly_geo['l_um']} um"
          f" -> R={rpoly_geo['r_ohm']} ohm (rsh_eff={rpoly_geo['rsh_eff']:.0f})")
    print(f"  Cp first estimate: {cp_ff:.0f} fF (scan in simulation — see design.md)")

    if cp_ff and m0['coff_ff']:
        print(f"\n  {'f (GHz)':>8} {'att dB':>8}")
        for f in FREQS:
            s_att = shunt_s21(rpoly, ron, cp_ff, m0['coff_ff'], f, True)
            print(f"{f:8.0f} {-20 * math.log10(abs(s_att)):8.3f}")

    out = {
        'architecture': 'simplet', 'attn_target_db': attn_db,
        'attn_achieved_db': round(attn_ach, 4),
        'Rpoly': rpoly_geo, 'M0': m0,
        'cp_first_estimate_ff': cp_ff,
        'method': 'arm total from the ideal formula + direct Ron input '
                  '(1/3..1/5 guidance, ZTC retired), sky130 data pack',
    }
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('attn_db', type=float, help='target attenuation [dB]')
    ap.add_argument('--ron', type=float, default=None,
                    help='direct input: shunt switch on-resistance [ohm] '
                         '(suggested 1/3..1/5 of R_shunt; default R_shunt/4)')
    ap.add_argument('--data-dir', default=None,
                    help='sky130 data pack dir (default: bundled with the skill)')
    ap.add_argument('--json', default=None, help='also write the design dict here')
    args = ap.parse_args()
    result = design(args.attn_db, args.ron, args.data_dir)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2)
            f.write('\n')
        print(f"\n  [json] wrote {os.path.abspath(args.json)}")
