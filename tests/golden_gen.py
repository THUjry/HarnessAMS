#!/usr/bin/env python3
"""Regenerate the bundled self-check golden dataset (test-only helper).

The golden tree at src/selfcheck/golden/ is the simulator=none dataset: it ships
with the package and replays a full parse+compute round without running Spectre.
It is synthesized analytically from the SAME 3x3 grid as
src/selfcheck/script/analysis/gen_selfcheck_rc.py (r_val x c_val) with the exact
psfascii layout of a Spectre `ac` analysis raw file (see the ac.ac fixture in
SmartAnaSim's tests), so the real spectre/spectre_psf_parse.py accepts it.

Deterministic by construction: fixed float format (%.6e), fixed JSON layout, no
timestamps. tests/selfcheck.test.mjs regenerates into a temp dir and compares
byte-for-byte against the committed tree — accidental edits fail the test. A
future real-spectre capture can replace the tree as long as regeneration stays
byte-stable (regenerate then, or retire this helper).
"""
import argparse
import json
import math
import os
import sys

R_VALS = ["1k", "2k", "5k"]
C_VALS = ["1n", "2n", "5n"]
AC_START = 1e3
AC_STOP = 1e8
AC_PER_DEC = 50

SI = {"t": 1e12, "g": 1e9, "meg": 1e6, "k": 1e3, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15}


def si(text):
    low = str(text).lower()
    for suffix, factor in SI.items():
        if low.endswith(suffix) and low[: -len(suffix)]:
            return float(low[: -len(suffix)]) * factor
    return float(low)


def freq_grid():
    decades = math.log10(AC_STOP / AC_START)
    n = int(round(decades * AC_PER_DEC)) + 1
    return [AC_START * 10 ** (i / AC_PER_DEC) for i in range(n)]


def response(topo, freq, r, c):
    """(re, im) of the analytic RC phasor with a unit-magnitude AC source."""
    fc = 1.0 / (2.0 * math.pi * r * c)
    x = freq / fc
    if topo == "lpf":
        return 1.0 / (1.0 + x * x), -x / (1.0 + x * x)
    return x * x / (1.0 + x * x), x / (1.0 + x * x)


def fmt(value):
    return "%.6e" % value


def write_point_ac(freqs, topo, r, c, path):
    lines = ["TYPE", "sweep", "SWEEP", '"freq" "F"']
    lines.extend(fmt(f) for f in freqs)
    lines += ["TRACE", '"vout" "V"', "END", "VALUE"]
    for f in freqs:
        re_v, im_v = response(topo, f, r, c)
        lines.append('"freq" %s' % fmt(f))
        lines.append('"vout" (%s %s)' % (fmt(re_v), fmt(im_v)))
    lines.append("END")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")


def write_point_meta(index, name, r, c, path):
    meta = {
        "point_index": index,
        "point_name": name,
        "simulator": "spectre",
        "params": {"r_val": r, "c_val": c},
        "status": "success",
    }
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")


def generate(out_root):
    freqs = freq_grid()
    count = 0
    for topo in ("lpf", "hpf"):
        index = 0
        for r in R_VALS:
            for c in C_VALS:
                name = "%02d" % index
                base = os.path.join(out_root, topo, name)
                write_point_ac(freqs, topo, si(r), si(c),
                               os.path.join(base, "netlist.scs.raw", "ac.ac"))
                write_point_meta(index, name, r, c, os.path.join(base, "point_meta.json"))
                index += 1
                count += 1
    return count


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="regenerate the self-check golden dataset")
    ap.add_argument("--out", default=os.path.join(here, "..", "src", "selfcheck", "golden"))
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    n = generate(out)
    print("[golden] %d points (%d freqs each) -> %s" % (n, len(freq_grid()), out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
