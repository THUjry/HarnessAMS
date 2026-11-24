#!/usr/bin/env python3
"""Generate a round-selectable HTML design report for a cascaded-ATT workspace.

Scans <cascade_dir>/Results/Round*/ for per-control-word S-parameter files
(sp_XXXXX.sp, psfascii), computes metrics relative to the zero state
(control word 0000 for a 4-bit cascade; width auto-detected), and emits:

  - <out>/data/Round<N>.js    (var ROUND_DATA per round; plain UTF-8, ASCII content)
  - <out>/<cascade_name>_report.html   (UTF-8 with BOM)

With --run-dir <dir> the same pipeline reads a sweep run directory instead:
every NN/netlist.scs.raw/sp.sp becomes one control word (NN = point index =
the integer value of the binary control word), no renaming step needed.

Round-independent content (physical-parameter table, consistency check) is
built from cascade_cells.json; round-dependent content (summary table,
accuracy chart, delta charts, legend) is rendered in JS from the loaded
ROUND_DATA so the Round dropdown can switch datasets live.

Conventions:
  - Control word _xxxx: bit(n-1)(leftmost)=MSB cell ... bit0(rightmost)=LSB cell;
    x=0 reference state, x=1 attenuation state; point index = integer of suffix.
  - Zero state (reference) = all bits zero.
  - Performance metrics over the 1-30 GHz band; plots show 1-40 GHz.
  - Expected attenuation of a state = sum of target_att_db of set bits.
  - Worst match = max(S11,S22) at every frequency (symmetric chains only).

Chart styling: Plotly 3.x, title font 20 / tick 16, height 480, margins
t48/b60/l76/r40, lines+markers, cross-highlight via the graph-div events API.

Usage:
  python gen_cascade_report.py <cascade_dir> [--out DIR] [--cells-base DIR]
      [--default-round RoundN] [--point-index N] [--nbits N]
  python gen_cascade_report.py --run-dir <run_dir> [--cells <file>] [--out DIR]
"""
import argparse
import glob
import json
import math
import os
import re

N_BITS = 4           # default; auto-detected from the data (or --nbits)
REF = "0" * N_BITS   # recomputed in main()
BAND_GHZ = 30.0


# --------------------------------------------------------------------------- #
# psfascii S-parameter parser (self-contained)
# --------------------------------------------------------------------------- #
def parse_sp(path):
    txt = open(path, encoding="utf-8", errors="replace").read()
    freq = []
    data = {"s11": {"re": [], "im": []}, "s21": {"re": [], "im": []},
            "s22": {"re": [], "im": []}}
    in_val = False
    for line in txt.split("\n"):
        t = line.strip()
        if t == "VALUE":
            in_val = True
            continue
        if not in_val or t.startswith("END"):
            continue
        if t.startswith('"freq"'):
            freq.append(float(t.split()[1]))
        else:
            for key in ("s11", "s21", "s22"):
                if t.startswith('"' + key + '"'):
                    m = re.search(r"\(([^)]+)\)", t)
                    if m:
                        r, i = m.group(1).split()
                        data[key]["re"].append(float(r))
                        data[key]["im"].append(float(i))
                    break
    return freq, data


def db(re_, im_):
    return 20 * math.log10(math.hypot(re_, im_))


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def rnd_list(xs, n=4):
    return [round(float(x), n) for x in xs]


def phase_delta(d, ref, i):
    """Principal phase arg(S21_ctrl / S21_ref) in degrees."""
    cr, ci = ref["s21c"][i]
    dr, di = d["s21c"][i]
    re = dr * cr + di * ci
    im = di * cr - dr * ci
    return math.degrees(math.atan2(im, re))


def find_rounds(cascade_dir):
    """Sorted list of Results/Round* dirs that contain sp_*.sp files."""
    results = os.path.join(cascade_dir, "Results")
    out = []
    if os.path.isdir(results):
        for d in sorted(os.listdir(results)):
            if re.match(r"^Round\d+$", d) and glob.glob(os.path.join(results, d, "sp_*.sp")):
                out.append(d)
    return out


def find_cascade_cells(cascade_dir):
    """cascade_cells.json lives in the first round dir that has one."""
    for rnd in find_rounds(cascade_dir):
        p = os.path.join(cascade_dir, "Results", rnd, "cascade_cells.json")
        if os.path.exists(p):
            return load_json(p)
    raise FileNotFoundError("cascade_cells.json not found under any Results/Round*/")


# --------------------------------------------------------------------------- #
# Metrics (attenuation / phase / worst match relative to the zero state)
# --------------------------------------------------------------------------- #
def parse_all_sp(round_dir):
    files = sorted(glob.glob(os.path.join(round_dir, "sp_*.sp")))
    data, freqs = {}, None
    for f in files:
        ctrl = os.path.basename(f)[3:-3]  # sp_XXXXX.sp -> XXXXX
        freq, d = parse_sp(f)
        if freqs is None:
            freqs = freq
        s21 = [db(r, i) for r, i in zip(d["s21"]["re"], d["s21"]["im"])]
        s11 = [db(r, i) for r, i in zip(d["s11"]["re"], d["s11"]["im"])]
        s22 = [db(r, i) for r, i in zip(d["s22"]["re"], d["s22"]["im"])]
        data[ctrl] = {
            "s21": s21, "s11": s11, "s22": s22,
            "s21c": list(zip(d["s21"]["re"], d["s21"]["im"])),
        }
    return freqs, data


def parse_run_dir(run_dir):
    """Parse a sweep run directory: every NN/netlist.scs.raw/sp.sp becomes one
    control word (NN = point index = the integer value of the binary control
    word). The word width comes from the largest point index, so a complete
    2^n sweep maps onto exactly n-bit words. Same return shape as parse_all_sp.
    """
    points = []
    for name in sorted(os.listdir(run_dir)):
        if not re.match(r"^\d{2,}$", name) or not os.path.isdir(os.path.join(run_dir, name)):
            continue
        sp = os.path.join(run_dir, name, "netlist.scs.raw", "sp.sp")
        if not os.path.isfile(sp):
            continue
        points.append((int(name), sp))
    if not points:
        raise SystemExit("[error] no NN/netlist.scs.raw/sp.sp point dirs under %s" % run_dir)
    nbits = max(1, max(idx for idx, _ in points).bit_length())
    data, freqs = {}, None
    for idx, sp in points:
        freq, d = parse_sp(sp)
        if freqs is None:
            freqs = freq
        s21 = [db(r, i) for r, i in zip(d["s21"]["re"], d["s21"]["im"])]
        s11 = [db(r, i) for r, i in zip(d["s11"]["re"], d["s11"]["im"])]
        s22 = [db(r, i) for r, i in zip(d["s22"]["re"], d["s22"]["im"])]
        data[format(idx, "0%db" % nbits)] = {
            "s21": s21, "s11": s11, "s22": s22,
            "s21c": list(zip(d["s21"]["re"], d["s21"]["im"])),
        }
    return freqs, data


def compute_metrics(freq, spdata):
    band = [i for i, f in enumerate(freq) if f <= BAND_GHZ * 1e9]
    idx30 = min(range(len(freq)), key=lambda i: abs(freq[i] - 30e9))  # nearest grid point (robust for non-integer-GHz starts)
    ref = spdata[REF]
    ctrls = sorted(c for c in spdata if c != REF)

    traces = []
    for c in ctrls:
        d = spdata[c]
        traces.append({
            "ctrl": c,
            "delta_db": rnd_list([ref["s21"][i] - d["s21"][i] for i in range(len(freq))]),
            "delta_phase": rnd_list([phase_delta(d, ref, i) for i in range(len(freq))], 3),
            "worst_db": rnd_list([max(d["s11"][i], d["s22"][i])
                                  for i in range(len(freq))]),
        })

    def argmax(fn):
        best = None
        for t in traces:
            for i in band:
                v = fn(t, i)
                if best is None or v > best[0]:
                    best = (v, t["ctrl"], freq[i] / 1e9)
        return best

    def worst_over(key):
        best = None
        for c in ctrls:
            d = spdata[c]
            for i in band:
                v = d[key][i]
                if best is None or v > best[0]:
                    best = (v, c, freq[i] / 1e9)
        return best

    v, c, fq = argmax(lambda t, i: t["delta_db"][i])
    max_atten = {"value": v, "ctrl": c, "freq": fq}
    v, c, fq = argmax(lambda t, i: abs(t["delta_phase"][i]))
    max_phase = {"value": v, "ctrl": c, "freq": fq}
    vs11 = worst_over("s11")
    vs22 = worst_over("s22")
    worst_s11 = {"value": vs11[0], "ctrl": vs11[1], "freq": vs11[2]}
    worst_s22 = {"value": vs22[0], "ctrl": vs22[1], "freq": vs22[2]}
    summary = {"max_atten": max_atten, "max_phase": max_phase,
               "worst_s11": worst_s11, "worst_s22": worst_s22}
    return traces, summary, idx30


def expected_db(cascade):
    cells = cascade["cells"]
    exp = {}
    for k in range(2 ** len(cells)):
        c = format(k, "0%db" % len(cells))
        s = 0.0
        for cell in cells:
            if c[len(cells) - 1 - cell["control_bit"]] == "1":
                s += cell["target_att_db"]
        exp[c] = s
    return exp


def accuracy_data(traces, cascade, idx30):
    exp = expected_db(cascade)
    rows = []
    all_ctrls = [REF] + [t["ctrl"] for t in traces]
    for c in all_ctrls:
        if c == REF:
            att30, e = 0.0, 0.0
        else:
            att30 = next(t for t in traces if t["ctrl"] == c)["delta_db"][idx30]
            e = exp[c]
        rows.append({"ctrl": c, "att30": round(att30, 4), "expected": e, "error": round(att30 - e, 4)})
    return rows


def rms_error_curves(traces, cascade, nfreq):
    """Per-frequency RMS error over all control words (zero state included, error 0).

    - att error at (state, freq) = delta_db - expected (sum of nominal values of set bits)
    - phase error at (state, freq) = |delta_phase| vs zero state (nominal phase change = 0)
    Returns (rms_att_db, rms_phase_deg), one value per frequency point.
    """
    exp = expected_db(cascade)
    ctrls = [REF] + [t["ctrl"] for t in traces]
    n = len(ctrls)
    att = [0.0] * nfreq
    ph = [0.0] * nfreq
    for i in range(nfreq):
        sa = sp = 0.0
        for c in ctrls:
            if c == REF:
                continue  # zero state: delta 0, expected 0 -> error 0
            t = next(x for x in traces if x["ctrl"] == c)
            da = t["delta_db"][i] - exp[c]
            dp = t["delta_phase"][i]
            sa += da * da
            sp += dp * dp
        att[i] = math.sqrt(sa / n)
        ph[i] = math.sqrt(sp / n)
    return rnd_list(att, 4), rnd_list(ph, 3)


def build_round_data(freq, spdata, cascade, rnd, cells_base="", point_index=0):
    traces, summary, idx30 = compute_metrics(freq, spdata)
    acc = accuracy_data(traces, cascade, idx30)
    rms_att, rms_ph = rms_error_curves(traces, cascade, len(freq))
    # Per-round cell info for the dynamic physical table
    cells_info = []
    for cell in cascade["cells"]:
        bp = best_points(cells_base, cell["folder"], point_index)
        ip = (cell.get("ref_state_ip1db_dBm") or {}).get("30")
        cells_info.append({
            "name": cell["name"],
            "architecture": cell["architecture"],
            "target_att_db": cell["target_att_db"],
            "control_bit": cell["control_bit"],
            "bestPoints_params": cell.get("bestPoints_params", {}),
            "target": bp.get("target"),
            "delta_avg": bp.get("delta_avg"),
            "delta_range": bp.get("delta_range"),
            "worst_match": bp.get("worst_match"),
            "ip1db_30g": ip,
        })
    return {
        "meta": {"round": rnd, "title": "%s - %d states" % (rnd, len(spdata)),
                 "n_states": len(spdata)},
        "ref_ctrl": REF,
        "freq_ghz": [round(f / 1e9, 4) for f in freq],
        "idx30": idx30,
        "traces": traces,
        "ref_s21_db": rnd_list(spdata[REF]["s21"]),
        "acc": acc,
        "rms_att_db": rms_att,
        "rms_phase_deg": rms_ph,
        "summary": summary,
        "cells": cells_info,
    }


# --------------------------------------------------------------------------- #
# Physical-parameter consistency check (cascade netlist vs bestPoints)
# Ideal-RC vocabulary: ideal resistor/capacitor elements plus the transcribed
# library's flattened switch cards (nlowvt_model__w<W>p<N>f<N>).
# --------------------------------------------------------------------------- #
def consistency_check(cell):
    p = cell.get("bestPoints_params", {})
    arch = cell.get("architecture", "")
    devs = cell.get("devices", [])
    checks = []

    def count_matching(devtype, params):
        n = 0
        for d in devs:
            if d["device"] != devtype:
                continue
            dp = d["params"]
            if all(dp.get(k) == v for k, v in params.items()):
                n += 1
        return n

    def add(label, needed, devtype, params):
        if any(v is None for v in params.values()):
            checks.append({"label": label, "ok": False,
                           "detail": "bestPoints params incomplete for this check"})
            return
        found = count_matching(devtype, params)
        ok = found >= needed
        dims = " ".join("%s=%s" % (k, v) for k, v in params.items())
        detail = "%s %s - need %d, found %d" % (devtype, dims, needed, found)
        checks.append({"label": label, "ok": ok, "detail": detail})

    sw_dev = p.get("switch_device", "sky130_fd_pr__nfet_01v8_lvt")
    sw_l = p.get("l", "0.15")

    def add_switch(label, needed, wkey, nfkey):
        add(label, needed, sw_dev, {"l": sw_l, "w": p.get(wkey), "nf": p.get(nfkey)})

    if "SimpleT" in arch or "simplet" in arch:
        add("Rp shunt resistor", 1, "resistor", {"r": p.get("Rp")})
        add("Cp comp cap", 1, "capacitor", {"c": p.get("cpf")})
        add_switch("M0 shunt switch", 1, "w", "nf")
        add("Rg gate resistor", 1, "resistor", {"r": "10k"})
        add("Rshort bridge 0R", 1, "resistor", {"r": "0"})
    elif "T-type" in arch or "t-type" in arch:
        add("Rs series arm x2", 2, "resistor", {"r": p.get("Rs")})
        add("Rp shunt resistor", 1, "resistor", {"r": p.get("Rp")})
        add_switch("M1 bypass switch", 1, "w1", "nf1")
        add_switch("M2 shunt switch", 1, "w2", "nf2")
        add("Cp comp cap", 1, "capacitor", {"c": p.get("cpf")})
        add("Rg gate resistor x2", 2, "resistor", {"r": "10k"})
    elif "Pi" in arch or "pi" in arch:
        add("R0 series resistor", 1, "resistor", {"r": p.get("Rs")})
        add("Rp shunt resistor x2", 2, "resistor", {"r": p.get("Rp")})
        add_switch("M1 bypass switch", 1, "w1", "nf1")
        add_switch("M2/M3 shunt switch x2", 2, "w2", "nf2")
        add("Cp comp cap x2", 2, "capacitor", {"c": p.get("cpf")})
        add("Rg gate resistor x2", 2, "resistor", {"r": "10k"})

    # Switch rule: every switch instance must carry its geometry (l/w/nf) —
    # in the spectre templates the flattened card name IS the geometry, in the
    # ngspice example netlists the fossi wrapper takes them as instance params.
    bad_sw = [d["instance"] for d in devs
              if "nfet" in d["device"]
              and not all(k in d["params"] for k in ("l", "w", "nf"))]
    sw_ok = len(bad_sw) == 0
    checks.append({"label": "Switch rule (instances carry l/w/nf)", "ok": sw_ok,
                   "detail": "OK" if sw_ok else "missing geometry: %s" % bad_sw})
    return {"cell": cell["name"], "ok": all(c["ok"] for c in checks), "checks": checks}


# --------------------------------------------------------------------------- #
# HTML fragments (round-independent parts)
# --------------------------------------------------------------------------- #
def param_str(p):
    return ", ".join("%s=%s" % (k, v) for k, v in p.items() if k not in ("temperature", "pin"))


def best_points(cells_base, folder, point_index=0):
    """Single-cell final results from bestPoints.json; None-safe."""
    p = os.path.join(cells_base, folder, "top", "bestPoints.json")
    if not os.path.exists(p):
        return {}
    pts = load_json(p)["points"]
    idx = point_index if point_index < len(pts) else 0
    d = pts[idx]
    drift = (d.get("temp_span_0_100C") or {}).get("drift_db")
    return {
        "delta_avg": d.get("delta_db_avg"),
        "delta_range": d.get("delta_db_range"),
        "worst_match": d.get("worst_match_db"),
        "drift": drift,
        "target": (d.get("targetSpec") or {}).get("delta_db"),
    }


def badge(ok):
    return '<span class="badge %s">%s</span>' % ("ok" if ok else "fail",
                                                "PASS" if ok else "FAIL")


def build_consist_table(consist):
    """Section 5 physical-parameter consistency check."""
    rows = ""
    for c in consist:
        for ch in c["checks"]:
            rows += ("<tr><td><b>%s</b></td><td>%s</td><td>%s</td><td class='small'>%s</td></tr>"
                     % (c["cell"], ch["label"], badge(ch["ok"]), ch["detail"]))
        rows += ("<tr class='cell-total'><td><b>%s total</b></td><td colspan='3'>%s "
                 "(%d/%d items match)</td></tr>"
                 % (c["cell"], badge(c["ok"]),
                    sum(1 for x in c["checks"] if x["ok"]), len(c["checks"])))
    return ("<table class='tbl consist'><thead><tr><th>Cell</th><th>Check</th>"
            "<th>Result</th><th>Detail (cascade netlist vs bestPoints.json)</th>"
            "</tr></thead><tbody>%s</tbody></table>" % rows)


def nominal_hint(cascade):
    return ", ".join("%s %s dB" % (cell["name"], cell["target_att_db"])
                     for cell in cascade["cells"])


# --------------------------------------------------------------------------- #
# HTML assembly
# --------------------------------------------------------------------------- #
HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__CASCADE__ - Cascade Att Design Report</title>
<script src="https://cdn.plot.ly/plotly-3.0.1.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #f9f9f7; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; padding: 36px; display: flex; flex-direction: column; align-items: center; }
.container { max-width: 1200px; width: 100%; }
h1 { font-size: 32px; font-weight: 600; color: #0b0b0b; margin: 0 0 4px 0; }
.subtitle { font-size: 20px; color: #52514e; margin: 0 0 20px 0; }
.hint { font-size: 18px; color: #898781; margin: 0 0 12px 0; }
#selector-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
#selector-bar label { font-size: 16px; font-weight: 600; color: #52514e; }
#round-select { font-size: 16px; padding: 8px 14px; border-radius: 8px; border: 1px solid #ccc; background: #fcfcfb; cursor: pointer; }
#round-select:hover { border-color: #888; }
.chart-box, .table-box { background: #fcfcfb; border-radius: 12px; padding: 20px 16px 16px 16px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
.table-box { padding: 20px; }
.table-box h2, .chart-box h2 { font-size: 20px; font-weight: 600; color: #0b0b0b; margin-bottom: 12px; }
#info-bar { background: #fcfcfb; border-radius: 8px; padding: 16px 24px; margin-bottom: 16px; font-size: 19px; color: #0b0b0b; box-shadow: 0 1px 4px rgba(0,0,0,0.06); min-height: 32px; cursor: pointer; }
#info-bar:hover { background: #f0f0ee; }
.tbl { width: 100%; border-collapse: collapse; font-size: 15px; }
.tbl th { background: #f3f3f1; color: #52514e; font-weight: 600; padding: 9px 12px; text-align: left; border-bottom: 2px solid #ddd; }
.tbl td { padding: 8px 12px; border-bottom: 1px solid #eee; color: #0b0b0b; }
.tbl tr:hover td { background: #f0f5ff; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.badge.ok { background: #e5f4e6; color: #1a7f2b; }
.badge.fail { background: #fbe6e6; color: #c0392b; }
.small { font-size: 12px; color: #898781; }
.mono, .ctrlcode { font-family: 'Consolas', 'Courier New', monospace; }
table.summary th { text-align: center; font-size: 15px; }
table.summary td { text-align: center; font-size: 18px; font-weight: 600; padding: 16px 10px; }
table.summary td .ctrlcode { font-size: 15px; color: #52514e; }
table.consist tr.cell-total td { background: #f7f7f4; font-weight: 600; }
table.phys .mono { font-size: 12px; }
.legend-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 4px 10px; font-size: 13px; }
.legend-item { padding: 4px 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.legend-item:hover { background: #f0f5ff; }
.legend-item.selected { background: #dce8ff; font-weight: 600; }
.swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; }
</style>
</head>
<body>
<div class="container">
<h1>__CASCADE__ - Cascade Attenuator Design Report</h1>
<p class="subtitle">Round-selectable S-parameters @__TEMP__&deg;C - data __FSPAN__ GHz (axis 0-__FMAXG__) - performance metrics over 1-30 GHz - zero state = <span class="ctrlcode">__REF__</span> (all reference/bypass)</p>
<div id="selector-bar">
  <label for="round-select">Select Round:</label>
  <select id="round-select"></select>
</div>
"""

BODY_TOP = """
<div class="table-box">
  <h2>Section 1 - Physical Parameter Table (one row per cell)</h2>
  <p class="hint">Per-cell design parameters (bestPoints.json) cross-referenced with single-cell final results; cascade netlist hardcodes match these (see Section 5 consistency check). Cell ordering, sizes and control bits update per round.</p>
  <div style="overflow-x:auto"><table class='tbl phys'><thead><tr><th>Cell</th><th>Architecture</th><th>Nominal att.</th><th>Ctrl bit</th><th>bestPoints params</th><th>Target (delta)</th><th>Single-cell avg / range</th><th>Single-cell worst match</th><th>Ref IP1dB @30G</th></tr></thead><tbody id="phys-body"></tbody></table></div>
</div>

<div class="table-box">
  <h2>Section 2a - Performance Summary (relative to zero state __REF__, 1-30 GHz)</h2>
  <p class="hint">value @ control word (bit(n-1)=MSB ... bit0=LSB); "Max attenuation" is positive attenuation (S21_ref - S21_state).</p>
  <table class="tbl summary"><thead><tr>
    <th>Max Attenuation</th>
    <th>Max |Phase Change| (vs zero)</th>
    <th>Input Worst Match S11</th>
    <th>Output Worst Match S22</th>
  </tr></thead><tbody id="summary-body"></tbody></table>
</div>

<div class="chart-box">
  <h2>Section 2b - RMS Error vs Frequency (all states, dual axis)</h2>
  <p class="hint">RMS over all control words per frequency point; attenuation error = actual attenuation - expected (sum of nominal values of set bits: __NOMINAL__); phase error = |delta phase| vs zero state (nominal 0&deg;). Blue / left axis: RMS &Delta;att error (dB); red / right axis: RMS &Delta;phase error (&deg;).</p>
  <div id="chart-rms"></div>
</div>

<div class="chart-box">
  <h2>Section 3 - Attenuation vs Expected per Control Word (30 GHz)</h2>
  <p class="hint">x = binary control word (vertical grid at every state); y = actual attenuation @30 GHz - expected (expected = sum of nominal values of set bits: __NOMINAL__).</p>
  <div id="chart-acc"></div>
</div>

<div class="table-box" id="legend-box">
  <h2>Section 4 - Control-word Legend &amp; Delta Charts</h2>
  <p class="hint">Zero state <span class="ctrlcode">__REF__</span> (all reference/bypass) is the reference and is not among the curves; click a legend entry to cross-highlight.</p>
  <div id="legend-grid" class="legend-grid"></div>
</div>
<div id="info-bar">Click a curve or legend control word to cross-highlight the same state</div>
<div class="chart-box"><h2>&Delta;S21 - Magnitude (dB)</h2><div id="chart0"></div></div>
<div class="chart-box"><h2>&Delta;S21 - Phase Difference (&deg;)</h2><div id="chart1"></div></div>
<div class="chart-box"><h2>Worst Match - max(S11,S22) (dB)</h2><div id="chart2"></div></div>
<div class="chart-box"><h2>S21 Ref-State - IL (dB)</h2><div id="chart3"></div></div>

<div class="table-box">
  <h2>Section 5 - Physical-Parameter Consistency Check (cascade netlist vs each cell bestPoints.json)</h2>
  <p class="hint">Per-device comparison of each cell subckt in the cascade netlist against bestPoints.json params; also checks the switch rule (every switch instance carries its geometry l/w/nf).</p>
  <div style="overflow-x:auto">__CONSIST__</div>
</div>
"""

FOOT_JS = """
<script>
const MANIFEST = {
  cell: '__CASCADE__',
  rounds: [__ROUNDS__],
};
const METRIC_CH = ['chart0', 'chart1', 'chart2'];
const METRIC_KEY = ['delta_db', 'delta_phase', 'worst_db'];
const TITLES = ['ΔS21 - Magnitude (dB)', 'ΔS21 - Phase Difference (°)',
                'Worst Match - max(S11,S22) (dB)', 'S21 Ref-State - IL (dB)'];
const Y_LABELS = ['ΔS21 (dB)', '∠ΔS21 (°)', 'Worst (dB)', 'S21 (dB)'];

let RD = null, F = [], N = 0, I30 = 0, CTRLS = [], ctrlColor = {};
let sel = null, clickFired = false;
const infoBar = document.getElementById('info-bar');
const legendGrid = document.getElementById('legend-grid');
const METRIC_EL = {}; METRIC_CH.forEach(id => METRIC_EL[id] = document.getElementById(id));

function hsl(i) { return `hsl(${240 - (N > 1 ? i/(N-1) : 0.5)*240}, 65%, 50%)`; }

function baseLayout(title, ylabel, height) {
  return {
    title: { text: title, font: { size: 20 } },
    xaxis: { title: { text: 'Frequency (GHz)', standoff: 14, font: { size: 16 } }, range: [0, __FMAXG__],
      tickfont: { size: 16 }, showgrid: true, gridcolor: '#e8e8e8',
      zeroline: false, linecolor: '#ccc', linewidth: 1, ticks: 'outside', ticklen: 5 },
    yaxis: { title: { text: ylabel, standoff: 12, font: { size: 16 } }, tickfont: { size: 16 },
      gridcolor: '#e8e8e8', zeroline: true, zerolinecolor: '#ddd' },
    margin: { t: 48, b: 60, l: 76, r: 40 }, height: height || 480,
    showlegend: false, hovermode: 'closest', clickmode: 'event',
    hoverlabel: { font: { size: 15 }, bgcolor: '#fff', bordercolor: '#ccc' },
    paper_bgcolor: '#fcfcfb', plot_bgcolor: '#fcfcfb',
    font: { family: 'system-ui, -apple-system, sans-serif', color: '#0b0b0b' },
  };
}

function buildSummary(s) {
  const cell = (m, u) => `<td><b>${m.value.toFixed(3)} ${u}</b>` +
    `<br><span class="ctrlcode">@ ${m.ctrl}</span>` +
    `<br><span class="small">at ${m.freq.toFixed(1)} GHz</span></td>`;
  document.getElementById('summary-body').innerHTML =
    `<tr>${cell(s.max_atten,'dB')}${cell(s.max_phase,'°')}${cell(s.worst_s11,'dB')}${cell(s.worst_s22,'dB')}</tr>`;
}

function buildPhysTable(cells) {
  const paramStr = p => Object.entries(p).filter(([k]) => k!=='temperature' && k!=='pin').map(([k,v]) => `${k}=${v}`).join(', ');
  // Robust formatters: target may be a string (e.g. "4.0 dB @ DC-30 GHz"),
  // delta_range may be an array [min,max] OR a scalar; missing = '-'.
  const num = (v, n) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(n) : '-';
  const show = v => (v === null || v === undefined || v === '') ? '-' : String(v);
  const rng = r => {
    if (r == null) return '-';
    if (Array.isArray(r)) return `[${num(r[0],3)}, ${num(r[1],3)}]`;
    return num(r, 3);
  };
  document.getElementById('phys-body').innerHTML = cells.map(c => {
    const ip = num(c.ip1db_30g, 1);
    const da = num(c.delta_avg, 3);
    const wm = num(c.worst_match, 2);
    const tg = show(c.target);
    return `<tr><td><b>${c.name}</b></td><td>${c.architecture}</td><td>${c.target_att_db} dB</td>` +
      `<td class='ctrlcode'>bit${c.control_bit}</td><td class='mono small'>${paramStr(c.bestPoints_params)}</td>` +
      `<td class='small'>${tg}</td><td>${da} dB<br><span class='small'>${rng(c.delta_range)}</span></td>` +
      `<td>${wm}</td><td>${ip} dBm</td></tr>`;
  }).join('');
}

function buildLegend() {
  legendGrid.innerHTML = CTRLS.map((c, i) =>
    `<div class="legend-item" data-ctrl="${c}"><span class="swatch" style="background:${hsl(i)}"></span>` +
    `<span class="ctrlcode">${c}</span></div>`).join('');
}

function buildCharts() {
  for (let ci = 0; ci < 3; ci++) {
    const traces = RD.traces.map(t => ({
      x: F, y: t[METRIC_KEY[ci]], type: 'scatter', mode: 'lines+markers', name: t.ctrl,
      line: { color: ctrlColor[t.ctrl], width: 2 },
      marker: { size: 7, color: ctrlColor[t.ctrl], opacity: 0.3, line: { width: 0 } },
      cliponaxis: false,
      hovertemplate: `${t.ctrl}<br>%{x:.1f} GHz<br>${Y_LABELS[ci]}: %{y:.4f}<extra></extra>`,
    }));
    Plotly.newPlot(METRIC_CH[ci], traces, baseLayout(TITLES[ci], Y_LABELS[ci], 480));
  }
  Plotly.newPlot('chart3', [{
    x: F, y: RD.ref_s21_db, type: 'scatter', mode: 'lines+markers', name: '__REF__ (ref)',
    line: { color: '#333', width: 3 }, marker: { size: 7, color: '#333', opacity: 0.3, line: { width: 0 } },
    hovertemplate: '__REF__<br>%{x:.1f} GHz<br>S21: %{y:.4f} dB<extra></extra>',
  }], baseLayout(TITLES[3], Y_LABELS[3], 480));

  const acc = RD.acc, xi = acc.map((a, i) => i);
  Plotly.newPlot('chart-acc', [
    { x: xi, y: acc.map(a => a.error), type: 'scatter', mode: 'markers+lines',
      customdata: acc.map(a => [a.ctrl, a.att30.toFixed(3), a.expected.toFixed(2), a.error.toFixed(3)]),
      marker: { size: 9, color: acc.map(a => a.ctrl === RD.ref_ctrl ? '#333' : ctrlColor[a.ctrl]), opacity: 0.95 },
      line: { color: '#cfcfcf', width: 1, dash: 'dot' },
      cliponaxis: false,
      hovertemplate: '%{customdata[0]}<br>att@30G: %{customdata[1]} dB<br>expected: %{customdata[2]} dB<br>error: %{customdata[3]} dB<extra></extra>',
    },
    { x: [0, acc.length - 1], y: [0, 0], type: 'scatter', mode: 'lines',
      line: { color: '#999', width: 1, dash: 'dash' }, hoverinfo: 'skip', showlegend: false },
  ], {
    title: { text: 'Att 30 GHz - Expected (sum of cell nominal values)', font: { size: 20 } },
    xaxis: { title: { text: 'Control word (binary)', standoff: 14, font: { size: 12 } }, tickvals: xi,
      ticktext: acc.map(a => a.ctrl), tickfont: { size: 12 }, tickangle: -45,
      dtick: 1, showgrid: true, gridcolor: '#e8e8e8', zeroline: false,
      range: [-0.5, acc.length - 0.5] },
    yaxis: { title: { text: 'Actual - Expected (dB)', standoff: 12, font: { size: 16 } }, tickfont: { size: 16 },
      gridcolor: '#e8e8e8', zeroline: true, zerolinecolor: '#999' },
    margin: { t: 48, b: 70, l: 70, r: 30 }, height: 300,
    hovermode: 'closest', hoverlabel: { font: { size: 15 }, bgcolor: '#fff', bordercolor: '#ccc' },
    paper_bgcolor: '#fcfcfb', plot_bgcolor: '#fcfcfb',
    font: { family: 'system-ui, -apple-system, sans-serif', color: '#0b0b0b' },
  });

  // Section 2b: RMS error vs frequency, dual axis (att error left, phase error right)
  Plotly.newPlot('chart-rms', [
    { x: F, y: RD.rms_att_db, type: 'scatter', mode: 'lines+markers', name: 'RMS Δatt error',
      line: { color: '#1f77b4', width: 2 }, marker: { size: 6, color: '#1f77b4', opacity: 0.5 },
      cliponaxis: false,
      hovertemplate: 'RMS att err<br>%{x:.1f} GHz<br>%{y:.4f} dB<extra></extra>' },
    { x: F, y: RD.rms_phase_deg, type: 'scatter', mode: 'lines+markers', name: 'RMS Δphase error',
      line: { color: '#d62728', width: 2, dash: 'dash' }, marker: { size: 6, color: '#d62728', opacity: 0.5 },
      cliponaxis: false, yaxis: 'y2',
      hovertemplate: 'RMS phase err<br>%{x:.1f} GHz<br>%{y:.3f} °<extra></extra>' },
  ], {
    title: { text: 'RMS Error vs Frequency (all states)', font: { size: 20 } },
    xaxis: { title: { text: 'Frequency (GHz)', standoff: 14, font: { size: 16 } }, range: [0, __FMAXG__],
      tickfont: { size: 16 }, showgrid: true, gridcolor: '#e8e8e8',
      zeroline: false, linecolor: '#ccc', linewidth: 1, ticks: 'outside', ticklen: 5 },
    yaxis: { title: { text: 'RMS Δatt error (dB)', standoff: 12, font: { size: 16 } }, tickfont: { size: 16 },
      gridcolor: '#e8e8e8', zeroline: true, zerolinecolor: '#ddd' },
    yaxis2: { title: { text: 'RMS Δphase error (°)', standoff: 12, font: { size: 16 } }, tickfont: { size: 16 },
      overlaying: 'y', side: 'right', showgrid: false, zeroline: false },
    margin: { t: 48, b: 60, l: 76, r: 74 }, height: 400,
    showlegend: true, legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 14 } },
    hovermode: 'closest', clickmode: 'event',
    hoverlabel: { font: { size: 15 }, bgcolor: '#fff', bordercolor: '#ccc' },
    paper_bgcolor: '#fcfcfb', plot_bgcolor: '#fcfcfb',
    font: { family: 'system-ui, -apple-system, sans-serif', color: '#0b0b0b' },
  });
}

function buildReport(d) {
  RD = d; F = RD.freq_ghz; N = RD.traces.length; I30 = RD.idx30;
  CTRLS = RD.traces.map(t => t.ctrl);
  ctrlColor = {}; CTRLS.forEach((c, i) => ctrlColor[c] = hsl(i));
  try { if (RD.cells) buildPhysTable(RD.cells); } catch (e) { console.warn('phys table:', e); }
  buildSummary(RD.summary);
  buildLegend();
  buildCharts();
  bind();     // re-bind every build: Plotly.newPlot wipes el.on handlers
  resetAll();
}

function highlight(ctrl) {
  sel = ctrl;
  METRIC_CH.forEach(id => {
    const el = METRIC_EL[id]; const w = [], o = [];
    el.data.forEach(tr => { const m = tr.name === ctrl; w.push(m ? 4 : 1); o.push(m ? 1 : 0.08); });
    Plotly.restyle(id, { 'line.width': w, opacity: o });
  });
  legendGrid.querySelectorAll('.legend-item').forEach(it =>
    it.classList.toggle('selected', it.dataset.ctrl === ctrl));
  const t = RD.traces.find(x => x.ctrl === ctrl);
  infoBar.innerHTML = `<b>${ctrl}</b> @30 GHz - S21: ${t.delta_db[I30].toFixed(3)} dB | `
    + `phase: ${t.delta_phase[I30].toFixed(2)} deg | worst: ${t.worst_db[I30].toFixed(2)} dB`;
}
function resetAll() {
  sel = null;
  METRIC_CH.forEach(id => Plotly.restyle(id, { 'line.width': 2, opacity: 1 }));
  legendGrid.querySelectorAll('.legend-item').forEach(it => it.classList.remove('selected'));
  infoBar.textContent = 'Click a curve or legend control word to cross-highlight the same state';
}

function bind() {
  // Plotly 3.x moved the events API onto the graph div: use el.on(...), NOT
  // Plotly.on(...) — Plotly.on is undefined in 3.0.1, so binding there threw a
  // TypeError and no plotly_click handler ever attached (curves unselectable
  // while the DOM legend still worked). Plotly.newPlot wipes these handlers on
  // every replot, so re-bind on every buildReport. Do NOT call
  // el.removeAllListeners() — it also removes Plotly's internal click machinery
  // and breaks plotly_click permanently.
  METRIC_CH.forEach(id => {
    const el = METRIC_EL[id];
    el.on('plotly_click', function(evt) {
      clickFired = true;
      if (evt && evt.points && evt.points.length) {
        const c = CTRLS[evt.points[0].curveNumber];
        if (c === sel) resetAll(); else highlight(c);
      }
    });
    el.on('plotly_deselect', resetAll);
  });
  document.getElementById('chart3').on('plotly_click', resetAll);
  document.getElementById('chart-rms').on('plotly_click', resetAll);
  const accEl = document.getElementById('chart-acc');
  accEl.on('plotly_click', function(evt) {
    clickFired = true;
    if (evt && evt.points && evt.points.length && evt.points[0].customdata) {
      const c = evt.points[0].customdata[0];
      if (c === RD.ref_ctrl) resetAll(); else if (c === sel) resetAll(); else highlight(c);
    }
  });
}

// Native DOM handlers survive newPlot, so attach them once at startup — re-attaching
// on every buildReport would stack duplicates.
function initStatic() {
  METRIC_CH.forEach(id => {
    METRIC_EL[id].addEventListener('click', function() {
      setTimeout(function() { if (!clickFired && sel !== null) resetAll(); clickFired = false; }, 10);
    });
  });
  ['chart-acc', 'chart-rms'].forEach(id => {
    document.getElementById(id).addEventListener('click', function() {
      setTimeout(function() { if (!clickFired && sel !== null) resetAll(); clickFired = false; }, 10);
    });
  });
  legendGrid.addEventListener('click', function(e) {
    const it = e.target.closest('.legend-item');
    if (it) { const c = it.dataset.ctrl; if (c === sel) resetAll(); else highlight(c); }
  });
  infoBar.onclick = resetAll;
}

const selEl = document.getElementById('round-select');
MANIFEST.rounds.forEach(r => {
  const o = document.createElement('option');
  o.value = r.file; o.textContent = `${r.title} - ${r.n_points} states`;
  selEl.appendChild(o);
});
selEl.onchange = function() { loadRound(this.value); };
function loadRound(filePath) {
  const existing = document.getElementById('round-data-script');
  if (existing) existing.remove();
  const script = document.createElement('script');
  script.id = 'round-data-script';
  // ?v= busts the browser cache: the data JS is regenerated in place, and a
  // stale cached copy would otherwise keep the previous round on screen.
  script.src = filePath + '?v=' + Date.now();
  script.onload = function() { buildReport(ROUND_DATA); };
  document.body.appendChild(script);
}
initStatic();
loadRound(selEl.value);
</script>
"""


def main():
    ap = argparse.ArgumentParser(
        description="Generate a round-selectable HTML design report for a cascaded-ATT workspace.")
    ap.add_argument("cascade_dir", nargs="?", default=None,
                    help="Cascade workspace dir that contains Results/Round*/.")
    ap.add_argument("--run-dir", default=None,
                    help="Sweep run directory instead of a Results/ workspace: every "
                         "NN/netlist.scs.raw/sp.sp becomes one control word (NN = point "
                         "index = the binary control word value).")
    ap.add_argument("--cells", default=None,
                    help="Explicit cascade_cells.json path (default: searched next to the "
                         "round data — the run dir and its parent for --run-dir, every "
                         "Results/Round*/ otherwise).")
    ap.add_argument("--out", default=None,
                    help="Output directory (default: <cascade_dir>/Analysis).")
    ap.add_argument("--cells-base", default=None,
                    help="Base dir holding the per-cell design folders "
                         "(default: parent of cascade_dir).")
    ap.add_argument("--default-round", default=None,
                    help="Round to load by default in the dropdown (e.g. Round2).")
    ap.add_argument("--point-index", type=int, default=0,
                    help="Index into each cell's bestPoints.json 'points' array to read for the "
                         "physical table (default 0 = primary/current point). Use 1 for an appended "
                         "variant point.")
    ap.add_argument("--nbits", type=int, default=None,
                    help="Number of control bits (default: auto-detected from the data "
                         "width). Set to 3 for a 3-bit cascade so control words are "
                         "3-digit (000..111).")
    args = ap.parse_args()
    global N_BITS, REF
    if not args.cascade_dir and not args.run_dir:
        ap.error("pass a cascade_dir or --run-dir")

    if args.run_dir:
        run_dir = os.path.abspath(args.run_dir)
        cells_path = args.cells
        if not cells_path:
            for cand in (os.path.join(run_dir, "cascade_cells.json"),
                         os.path.join(os.path.dirname(run_dir), "cascade_cells.json")):
                if os.path.exists(cand):
                    cells_path = cand
                    break
        if not cells_path or not os.path.exists(cells_path):
            raise SystemExit("[error] cascade_cells.json not found next to the run dir "
                             "(pass --cells explicitly)")
        cascade = load_json(cells_path)
        cells_base = os.path.abspath(args.cells_base) if args.cells_base \
            else os.path.dirname(run_dir)
        out_dir = os.path.abspath(args.out) if args.out \
            else os.path.join(os.path.dirname(run_dir), "Analysis")
        round_names = [os.path.basename(run_dir.rstrip("/\\")) or "RunDir"]
        round_sources = [(run_dir, None, cascade)]
    else:
        cascade_dir = os.path.abspath(args.cascade_dir)
        cells_base = os.path.abspath(args.cells_base) if args.cells_base \
            else os.path.dirname(cascade_dir)
        out_dir = os.path.abspath(args.out) if args.out \
            else os.path.join(cascade_dir, "Analysis")
        rounds = find_rounds(cascade_dir)
        if not rounds:
            raise SystemExit("[error] no Results/Round* dirs with sp_*.sp under %s" % cascade_dir)
        cascade = find_cascade_cells(cascade_dir)
        round_names = rounds
        round_sources = []
        for rnd in rounds:
            cc_path = os.path.join(cascade_dir, "Results", rnd, "cascade_cells.json")
            round_sources.append((os.path.join(cascade_dir, "Results", rnd),
                                  cc_path if os.path.exists(cc_path) else None, cascade))

    if args.nbits is not None:
        N_BITS = args.nbits
        REF = "0" * N_BITS

    cname = cascade.get("cascade_name") or (
        os.path.basename(args.run_dir.rstrip("/\\")) if args.run_dir
        else os.path.basename(cascade_dir))
    temp = cascade.get("temperature", "?")

    # ---- per-round data JS files -------------------------------------------
    manifest_entries = []
    freq = None
    for rnd, src in zip(round_names, round_sources):
        if args.run_dir:
            round_dir, round_cascade = src[0], src[2]
            rtitle = rnd
        else:
            round_dir, cc_path, fallback_cascade = src
            # Build a descriptive round title from cascade_cells.json metadata
            rtitle = rnd
            if cc_path:
                cc = load_json(cc_path)
                ol = cc.get("order_label", "")
                if ol:
                    rtitle = "%s - %s" % (rnd, ol)
                else:
                    rref = cc.get("rref", "")
                    p = cc.get("port_impedance", {})
                    ports = "%s/%s" % (p.get("PORT0", "?"), p.get("PORT1", "?"))
                    rtitle = "Rref=%s Zs=%s" % (rref, ports) if rref and ports else rnd
            # Use per-round cascade_cells.json for correct control_bit mapping
            round_cascade = load_json(cc_path) if cc_path else fallback_cascade

        if args.run_dir:
            freq, spdata = parse_run_dir(round_dir)
        else:
            freq, spdata = parse_all_sp(round_dir)
        N_BITS = len(next(iter(spdata)))
        REF = "0" * N_BITS
        rdata = build_round_data(freq, spdata, round_cascade, rnd,
                                 cells_base, args.point_index)
        os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
        js_path = os.path.join(out_dir, "data", "%s.js" % rnd)
        with open(js_path, "w", encoding="utf-8") as f:  # plain UTF-8, ASCII content
            f.write("var ROUND_DATA = " + json.dumps(rdata, separators=(",", ":")) + ";\n")
        manifest_entries.append((rnd, rtitle, len(spdata)))
        print("[round] %s: %s — %d states -> %s (%.0f KB)"
              % (rnd, rtitle, len(spdata), os.path.relpath(js_path, out_dir),
                 os.path.getsize(js_path) / 1024.0))

        idx1g = min(range(len(freq)), key=lambda i: abs(freq[i] - 1e9))  # nearest grid point
        inc = {c["control_bit"]:
               spdata[format(1 << c["control_bit"], "0%db" % N_BITS)]["s21"][idx1g]
               - spdata["0" * N_BITS]["s21"][idx1g]
               for c in cascade["cells"]}
        print("  [verify] %s ref IL@1G=%.3f dB | single-bit: %s | %s=%.3f dB"
              % (rnd, spdata["0" * N_BITS]["s21"][idx1g],
                 {c["name"]: round(inc[c["control_bit"]], 3)
                  for c in cascade["cells"]},
                 "1" * N_BITS, spdata["1" * N_BITS]["s21"][idx1g]))
        print("  [verify] %s summary: %s" % (rnd, json.dumps(rdata["summary"])))

    # --default-round: put the requested round first so loadRound() selects it
    if args.default_round:
        idx = next((i for i, (r, _, _) in enumerate(manifest_entries)
                    if r == args.default_round), None)
        if idx is not None:
            manifest_entries.insert(0, manifest_entries.pop(idx))
        else:
            print("[warn] --default-round %s not found; keeping round order"
                  % args.default_round)

    rounds_js = ", ".join(
        '{ id:"%s", title:"%s", file:"data/%s.js", n_points:%d }'
        % (r, t, r, n) for r, t, n in manifest_entries)

    consist = [consistency_check(c) for c in cascade["cells"]]
    print("[verify] consistency:", {c["cell"]: c["ok"] for c in consist})
    if not all(c["ok"] for c in consist):
        print("[warn] some consistency checks FAILED")

    # ---- assemble HTML -------------------------------------------------------
    fmaxg = int(math.ceil(freq[-1] / 1e9))
    fspan = "%g-%d" % (freq[0] / 1e9, fmaxg)
    html = HEAD.replace("__CASCADE__", cname).replace("__TEMP__", str(temp)) \
               .replace("__REF__", REF) \
               .replace("__FMAXG__", str(fmaxg)).replace("__FSPAN__", fspan)
    html += BODY_TOP.replace("__CONSIST__", build_consist_table(consist)) \
                   .replace("__NOMINAL__", nominal_hint(cascade))
    html += FOOT_JS.replace("__CASCADE__", cname).replace("__ROUNDS__", rounds_js) \
                  .replace("__REF__", REF)
    html += "</div></body></html>"

    out_html = os.path.join(out_dir, "%s_report.html" % cname)
    with open(out_html, "w", encoding="utf-8-sig") as f:  # BOM: Windows-safe UTF-8
        f.write(html)
    print("[done] wrote %s (%.0f KB, rounds=%s)"
          % (out_html, os.path.getsize(out_html) / 1024.0, manifest_entries))


if __name__ == "__main__":
    main()
