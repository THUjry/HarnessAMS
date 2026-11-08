#!/usr/bin/env python3
"""HarnessAMS project self-check assembly (simulator=spectre path).

Emits the RC low-pass / high-pass testbench as template.scs + sweep_config.json
pairs under --out: <out>/lpf/ and <out>/hpf/. Ideal components only (resistor /
capacitor / vsource primitives) — no PDK, no includes, so the netlist runs
wherever a Spectre executable exists.

The sweep is a 3x3 grid (r_val x c_val, 9 points per topology). The verification
step compares every frequency point of the AC response against the analytic RC
transfer function with a 1% tolerance (selfcheck_verify.py / .mjs), so this grid
is part of the contract: the same values regenerate the bundled golden dataset
(tests/golden_gen.py) and appear in the golden point_meta.json params.

Invoked through the SmartAnaSim spectre_assemble tool, which runs this script
with cwd=<project_dir> and forwards --out (HARNESSAMS_SIMULATOR=spectre rides in
the environment). Self-contained on purpose: no imports from the plugin scripts
tree.
"""
import argparse
import json
import os
import sys

R_VALS = ["1k", "2k", "5k"]
C_VALS = ["1n", "2n", "5n"]
# AC grid: 1 kHz .. 100 MHz, 50 points/decade. The extreme fc of the grid
# (1/(2*pi*1k*1n) ~ 159 kHz, 1/(2*pi*5k*5n) ~ 6.4 kHz) sits well inside.
AC_START = 1e3
AC_STOP = 1e8
AC_DECADES = 50

TEMPLATE_LPF = """\
// HarnessAMS project self-check - RC low-pass (ideal components, no PDK)
simulator lang=spectre
parameters r_val=1k c_val=1n
V1 (vin 0) vsource dc=0 mag=1
R1 (vin vout) resistor r=@@r_val@@
C1 (vout 0) capacitor c=@@c_val@@
save vout
ac ac start=%s stop=%s dec=%d
""" % ("%.0e" % AC_START, "%.0e" % AC_STOP, AC_DECADES)

TEMPLATE_HPF = """\
// HarnessAMS project self-check - RC high-pass (ideal components, no PDK)
simulator lang=spectre
parameters r_val=1k c_val=1n
V1 (vin 0) vsource dc=0 mag=1
C1 (vin vout) capacitor c=@@c_val@@
R1 (vout 0) resistor r=@@r_val@@
save vout
ac ac start=%s stop=%s dec=%d
""" % ("%.0e" % AC_START, "%.0e" % AC_STOP, AC_DECADES)


def sweep_config():
    return {
        "parameters": {"r_val": list(R_VALS), "c_val": list(C_VALS)},
        "sweep_mode": "cross_product",
        "output_format": "psfascii",
        "netlist_template": "template.scs",
        "timeout_per_point": 120,
        "max_parallel": 4,
    }


def write_pair(out_dir, topo, template):
    topo_dir = os.path.join(out_dir, topo)
    os.makedirs(topo_dir, exist_ok=True)
    with open(os.path.join(topo_dir, "template.scs"), "w", encoding="utf-8", newline="\n") as f:
        f.write(template)
    with open(os.path.join(topo_dir, "sweep_config.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(sweep_config(), f, indent=2)
        f.write("\n")
    return topo_dir


def main(argv=None):
    ap = argparse.ArgumentParser(description="emit the HarnessAMS RC self-check testbench")
    ap.add_argument("--out", default=os.path.join("sweep", "Round1"),
                    help="output root (default: sweep/Round1 under the project dir)")
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    lpf = write_pair(out, "lpf", TEMPLATE_LPF)
    hpf = write_pair(out, "hpf", TEMPLATE_HPF)
    print("[selfcheck-gen] lpf -> %s" % lpf)
    print("[selfcheck-gen] hpf -> %s" % hpf)
    print("[selfcheck-gen] sweep: %d x %d (%s x %s), %d points per topology"
          % (len(R_VALS), len(C_VALS), "/".join(R_VALS), "/".join(C_VALS),
             len(R_VALS) * len(C_VALS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
