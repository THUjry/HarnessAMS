#!/usr/bin/env python3
"""HarnessAMS project self-check verification (compute step, python channel).

Pointwise comparison (NOT a -3dB/cutoff extraction): for every sweep point of an
RC low-pass/high-pass run, read the parsed AC response from
<run-dir>/psf/<point>_psf.csv (emitted by spectre/spectre_psf_parse.py with
--format csv) and compare the magnitude of every frequency sample against the
analytic RC transfer function:

    LPF  |H| = 1 / sqrt(1 + (f/fc)^2)
    HPF  |H| = (f/fc) / sqrt(1 + (f/fc)^2)
    fc   = 1 / (2*pi*R*C)   (R, C read from each point's point_meta.json params,
                             SI-suffixed strings like "1k" / "1n")

A point passes when every frequency sample satisfies |mag - theory| / theory <=
tolerance (default 1%). Output contract (mirrored byte-for-byte in semantics by
selfcheck_verify.mjs): the LAST stdout line is

    [selfcheck] {json}

with {ok, topo, tolerance, points[], max_rel_err, failed_points}. Exit code is 0
whenever the computation COMPLETED (the ok flag inside the JSON carries the
verdict); 2 means usage/IO trouble (missing dirs/files, bad topo). Runs both
locally (spawned by the self-check orchestrator) and remotely (uploaded next to
the run directory and executed with the remote python).
"""
import argparse
import json
import math
import os
import re
import sys

SI_SUFFIX = [
    ("t", 1e12), ("g", 1e9), ("meg", 1e6), ("k", 1e3),
    ("m", 1e-3), ("u", 1e-6), ("n", 1e-9), ("p", 1e-12), ("f", 1e-15),
]


def si_value(text):
    """Parse a Spectre-style number: bare float or f/p/n/u/m/k/meg/g/t suffix
    (case-insensitive; 'meg' must win over 'm')."""
    s = str(text).strip()
    try:
        return float(s)
    except ValueError:
        pass
    low = s.lower()
    for suffix, factor in SI_SUFFIX:
        if low.endswith(suffix):
            try:
                return float(low[: -len(suffix)]) * factor
            except ValueError:
                continue
    raise ValueError("not an SI number: %r" % text)


def theory_mag(topo, freq, r, c):
    fc = 1.0 / (2.0 * math.pi * r * c)
    x = freq / fc
    if topo == "lpf":
        return 1.0 / math.sqrt(1.0 + x * x)
    return x / math.sqrt(1.0 + x * x)


def load_curve(csv_path):
    """Read one <point>_psf.csv into {signal: {index: (re, im|None)}}."""
    curves = {}
    with open(csv_path, encoding="utf-8-sig") as f:
        header = f.readline().strip()
        if header != "point,signal,index,sweep_value,re,im":
            raise ValueError("unexpected CSV header in %s: %r" % (csv_path, header))
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split(",")
            if len(parts) < 6:
                continue
            _, signal, idx, _, re_text, im_text = parts[:6]
            series = curves.setdefault(signal, {})
            series[int(idx)] = (float(re_text), float(im_text) if im_text.strip() else None)
    return curves


def point_names(run_dir):
    return sorted(
        n for n in os.listdir(run_dir)
        if re.fullmatch(r"\d{2,}", n) and os.path.isdir(os.path.join(run_dir, n))
    )


def verify(run_dir, topo, tolerance):
    points = []
    max_rel = 0.0
    failed = 0
    for name in point_names(run_dir):
        meta_path = os.path.join(run_dir, name, "point_meta.json")
        csv_path = os.path.join(run_dir, "psf", "%s_psf.csv" % name)
        with open(meta_path, encoding="utf-8-sig") as f:
            meta = json.load(f)
        params = meta.get("params") or {}
        r = si_value(params["r_val"])
        c = si_value(params["c_val"])
        curves = load_curve(csv_path)
        freq_series = curves.get("ac_freq")
        vout_series = curves.get("ac_vout")
        if not freq_series or not vout_series:
            raise ValueError("missing ac_freq/ac_vout curves in %s" % csv_path)
        point_max = 0.0
        worst_freq = None
        n = 0
        for idx in sorted(freq_series):
            if idx not in vout_series:
                continue
            freq = freq_series[idx][0]
            re_v, im_v = vout_series[idx]
            mag = math.hypot(re_v, im_v if im_v is not None else 0.0)
            theory = theory_mag(topo, freq, r, c)
            rel = abs(mag - theory) / theory
            n += 1
            if rel > point_max:
                point_max = rel
                worst_freq = freq
        ok = point_max <= tolerance
        if not ok:
            failed += 1
        max_rel = max(max_rel, point_max)
        points.append({
            "point": name,
            "r": str(params["r_val"]),
            "c": str(params["c_val"]),
            "n_freq": n,
            "fc_hz": 1.0 / (2.0 * math.pi * r * c),
            "max_rel_err": point_max,
            "worst_freq_hz": worst_freq,
            "pass": ok,
        })
    return {
        "ok": failed == 0 and bool(points),
        "topo": topo,
        "tolerance": tolerance,
        "points": points,
        "max_rel_err": max_rel,
        "failed_points": failed,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="HarnessAMS self-check pointwise RC verification")
    ap.add_argument("--run-dir", required=True, help="run directory (NN point dirs + psf/ CSVs)")
    ap.add_argument("--topo", required=True, choices=["lpf", "hpf"])
    ap.add_argument("--tolerance", type=float, default=0.01)
    args = ap.parse_args(argv)
    run_dir = os.path.abspath(args.run_dir)
    try:
        if not os.path.isdir(run_dir):
            raise ValueError("run dir does not exist: %s" % run_dir)
        result = verify(run_dir, args.topo, args.tolerance)
    except (OSError, ValueError, KeyError) as e:
        print("selfcheck_verify: %s" % e, file=sys.stderr)
        return 2
    print("points=%d failed=%d max_rel_err=%.3e"
          % (len(result["points"]), result["failed_points"], result["max_rel_err"]))
    print("[selfcheck] " + json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
