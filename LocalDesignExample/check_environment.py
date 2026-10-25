# -*- coding: utf-8 -*-
"""LocalDesignExample environment self-check.

Verifies that the bundled assets in this directory form a working local simulation
environment:
1. asset audit - ngspice binary + runtime DLLs, sky130 model closure, offline report
   asset, pipeline scripts, workspace config;
2. an end-to-end simulation - a minimal sky130 netlist (diode-connected nfet, tt corner)
   runs under the bundled ngspice and the measured current is sanity-checked;
3. config readout - harnessams.json fields resolved relative to this file.

Usage: python check_environment.py   (from anywhere; paths resolve relative to this file)
Exit code: 0 = all checks passed, 1 = at least one failure (all listed on stdout).
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

NGSPICE_FILES = ["ngspice_con.exe", "libomp140.x86_64.dll", "samplerate.dll",
                 "sndfile.dll", "COPYING"]
TOOLS_FILES = ["sweep_worker_ngspice.py", "checks.py", "collect_results.py",
               "gen_sweep_report.py", "trash.py"]

SMOKE_NETLIST = """* Environment self-check: diode-connected sky130 nfet, tt corner, DC sweep.
.lib "{pdk_lib}" tt
VDD d 0 1.8
VGS g 0 0
XM1 d g 0 0 sky130_fd_pr__nfet_01v8 w=10 l=1
.options reltol=2e-4 abstol=1e-12 vntol=1e-6
.control
dc VGS 0 1.8 0.1
meas DC i_dd FIND i(VDD) AT=1.8
.endc
.end
"""


def load_config():
    """Read harnessams.json and resolve its path fields the same way the plugins do:
    relative values resolve against the config file's directory."""
    path = os.path.join(HERE, "harnessams.json")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)

    def rel(field):
        v = cfg.get(field)
        if isinstance(v, str) and v and not os.path.isabs(v):
            v = os.path.normpath(os.path.join(HERE, v))
        return v

    return cfg, rel


def audit_assets(rel):
    fails = []
    info = {}
    ng = os.path.join(HERE, "ngspice-47-portable")
    missing = [n for n in NGSPICE_FILES if not os.path.isfile(os.path.join(ng, n))]
    if missing:
        fails.append(f"ngspice-47-portable incomplete: missing {', '.join(missing)}")
    info["ngspice_cmd"] = rel("ngspice_cmd")
    if not os.path.isfile(info["ngspice_cmd"]):
        fails.append(f"ngspice_cmd does not exist: {info['ngspice_cmd']}")
    lib = rel("pdk_lib")
    info["pdk_lib"] = lib
    if not os.path.isfile(lib):
        fails.append(f"pdk_lib does not exist: {lib}")
    cells = os.path.join(HERE, "sky130", "cells")
    models = os.path.join(HERE, "sky130", "combined_models")
    n_cells = sum(len(fs) for _, _, fs in os.walk(cells))
    n_models = sum(len(fs) for _, _, fs in os.walk(models))
    info["sky130_files"] = f"combined_models {n_models} + cells {n_cells}"
    if n_cells < 100 or n_models < 200:
        fails.append(f"sky130 closure looks incomplete (combined_models {n_models}, cells {n_cells})")
    # single shared copy for the whole repo tree: <repo>/src/assets/plotly.min.js
    # (inside the dsh-harnessams package root, so it ships with the npm tarball)
    plotly = os.path.normpath(os.path.join(HERE, "..", "src", "assets", "plotly.min.js"))
    size = os.path.getsize(plotly) if os.path.isfile(plotly) else 0
    info["plotly"] = f"{size / 1e6:.2f} MB"
    if size < 4_000_000:
        fails.append(f"shared src/assets/plotly.min.js missing or too small ({size} bytes)")
    tools = os.path.join(HERE, "tools")
    missing_t = [t for t in TOOLS_FILES if not os.path.isfile(os.path.join(tools, t))]
    if missing_t:
        fails.append(f"tools/ incomplete: missing {', '.join(missing_t)}")
    return fails, info


def run_smoke(rel):
    """End-to-end: bundled ngspice + bundled sky130 + meas parsing."""
    fails = []
    info = {}
    pdk_lib = rel("pdk_lib")
    ngspice = rel("ngspice_cmd")
    netlist = SMOKE_NETLIST.format(pdk_lib=pdk_lib.replace("\\", "/"))
    with tempfile.TemporaryDirectory(prefix="lde_check_") as td:
        n_path = os.path.join(td, "check_netlist.spi")
        with open(n_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(netlist)
        try:
            proc = subprocess.run([ngspice, "-b", n_path], capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=90, cwd=td)
        except (OSError, subprocess.TimeoutExpired) as e:
            return [f"ngspice run failed: {e}"], info
        if proc.returncode != 0:
            fails.append(f"ngspice exited with {proc.returncode}")
        m = re.search(r"^\s*i_dd\s*=\s*([-+0-9.eE]+)\s*$", proc.stdout or "", re.M)
        if not m:
            fails.append("meas output not found (i_dd = ... missing from stdout)")
            info["stdout_tail"] = "\n".join((proc.stdout or "").splitlines()[-8:])
        else:
            i_dd = float(m.group(1))
            info["i_dd_a"] = f"{i_dd:.4g}"
            if not (1e-5 < abs(i_dd) < 1e-2):
                fails.append(f"measured i_dd out of the plausible range: {i_dd:.4g} A")
    return fails, info


def main():
    print(f"[env] LocalDesignExample = {HERE}")
    all_fails = []
    cfg, rel = load_config()
    print(f"[env] workspace_root = {rel('workspace_root')}  pdk = {cfg.get('pdk_name')}")
    fails, info = audit_assets(rel)
    for k, v in info.items():
        print(f"[env] {k}: {v}")
    all_fails += fails
    print("[env] running end-to-end ngspice smoke (diode-connected nfet, tt)...")
    fails, info = run_smoke(rel)
    for k, v in info.items():
        print(f"[env] {k}: {v}")
    all_fails += fails
    if all_fails:
        print(f"[env] FAILED ({len(all_fails)}):")
        for f in all_fails:
            print(f"  - {f}")
        return 1
    print("[env] OK - bundled ngspice + sky130 closure + report assets all verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
