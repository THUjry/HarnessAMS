---
name: smart-spectre
description: >
  Parallel Spectre parameter sweep workflow for the HarnessAMS suite: local
  run_sweep, remote batch_submit/batch_poll/batch_fetch over dsh-ssh (LSF or
  direct), psfascii parsing (spectre_parse, including S-parameter sp.sp),
  remote-first analysis (pull back only compact results) and the
  gen-sweep-report spec-driven report. Trigger on any question about batch
  simulation, sweep workers, PSF parsing, template*.scs rules, run directory
  naming, or the sweep workflow.
---

# smart-spectre — Spectre Sweep Workflow (HarnessAMS suite)

The simulation infrastructure is the plugin tool surface itself — no bundled
scripts. SmartAnaSim ships the sweep worker (`spectre/spectre_sweep_worker.py`,
uploaded automatically by `batch_submit` through the project's
`workspace.sim_scripts_dir`) and the parsers; HarnessAMS ships the remote
batch channel (`batch_*`) and the report/progress tools
(`gen-sweep-report` / `sim_progress`). The D-012 file layout: raw
simulation data lives under `RawResults/` (remote `<remote_root>/RawResults/Sim*`
is the batch_submit default; a raw local fetch lands in `<project>/RawResults/`),
processed compact results in `<project>/SimResults/`, report figures in `<project>/Figs/`,
and the HTML report at the project root.

## Template Rules

### Any `template*.scs` name; `@@PARAM@@` in the `parameters` line only

The run directory holds one template netlist and one `sweep_config.json`. The
template name is any `template*.scs` family member (default `template.scs`;
e.g. `template_thorough.scs` for the PSS variant) — **the name must equal
`sweep_config.netlist_template`**, and the batch uploader checks that the
declared name matches the uploaded file.

The worker's regex `@@(\w+)@@` does simple string substitution — no expression
evaluation. Parameters defined in the `parameters` line become Spectre
variables referenced **anywhere** in instance lines with Spectre-native
expression syntax:

```
parameters temperature=@@temperature@@ SW=@@SW@@
...
V2 (SW AVSS) vsource dc=1.2*SW type=dc          // Spectre references SW directly
V3 (SWB AVSS) vsource dc=1.2*(1-SW) type=dc     // Spectre evaluates the expression
```

Only the `parameters` line needs `@@...@@` placeholders. `@@(\w+)@@` matches
`[a-zA-Z0-9_]+` only — `@@1-SW@@` will not resolve; write `1-SW` in the
instance line instead.

### Run directory naming: `Sim<N>_<YYYYMMDD>_batch<M>`

Local and remote run directories follow `<base>/Sim<N>_<YYYYMMDD>_batch<M>/`
(e.g. `Sim0_<YYYYMMDD>_batch1`). `batch_submit` generates the next free name
under `remote_root` automatically when `remote_dir` is omitted — same `Sim`
index continues with `batch<M>+1` on the same day, a new day starts a new
`Sim<N>+1`. Pass `remote_dir` explicitly only to reuse a specific location.

## Workflow Summary

1. **Prepare** — create the run directory with `template*.scs` (with
   `@@PARAM@@`) + `sweep_config.json` (`parameters` dict of lists,
   `sweep_mode` cross_product|zip, ≤100 points per batch). For
   assembly-layer projects, `spectre_assemble` generates all three from
   `design_params.json` — prefer it when the project has a gen script.
2. **Submit** — `batch_submit {run_dir, machine_id, remote_root, worker:
   "spectre/spectre_sweep_worker.py", worker_args: ["--config",
   "sweep_config.json", "--max-parallel", "8"], scheduler: "lsf"|"direct"}`.
   The tool uploads the run directory plus the whole worker scripts tree,
   submits through bsub (or runs directly on the host for `direct`), and
   writes `.batch_job.json` in the local run directory. Submission is
   idempotent against connection replays (LSF marker + flock).
3. **Monitor** — `batch_poll {run_dir}`: bjobs state plus the batch's own
   progress (point_meta.json count, sweep_progress.json summary, errlog
   tail). **Timing trap:** for fast batches the progress file may lag or be
   mid-write right after completion — judge completion by the per-point
   `point_meta.json` count (the poll's `completed` field counts exactly
   these), not by the progress file alone.
4. **Fetch** — `batch_fetch {run_dir}` (tar archive; defaults bring
   `point_meta.json`, `sweep_progress.json`, errlog, bsub logs). For
   S-parameter runs add `"*/netlist.scs.raw/sp.sp"` to `includes` so the raw
   curves come back too.
5. **Analyze — REMOTE by default** — run the parsing/metrics ON the cluster
   and pull back only compact results (the put/exec/get triple):
   `ssh_upload` the analyzers (the SmartAnaSim scripts `spectre/spectre_psf_parse.py`
   + `snp/snp_common.py` under the project's `sim_scripts_dir`, both pure
   stdlib — upload them side by side; or your own self-contained script),
   `ssh_exec` it over the remote batch dir (full python3 path on clusters),
   then `ssh_download` the compact JSON (per-point params/metrics + the curve
   arrays you actually plot, complex already converted to dB where wanted)
   into `<project>/SimResults/`. Raw psf/sp stays remote. Fetch raw data only
   to debug (`batch_fetch` into `<project>/RawResults/<Sim*>`, deletable
   afterwards); `spectre_parse` runs locally in that case
   (`psf/NN_psf.json` Re/Im pairs + `psf_index.json`; `sp.sp` flattens to
   `freq` + `s11..sNN` complex curves). For S-parameter matrix CSV dumps and
   passive-device parameter extraction call `snp_guide` first, then
   `snp_read` / `snp_extract`.
6. **Report** — `gen-sweep-report {spec: <path>}` is a pure renderer: YOU
   process the data (metrics from step 5, curve dB conversion, multi-batch
   aggregation) and write a small spec JSON into `<project>/SimResults/`
   (`{project_dir?, title?, conclusions?, out?, rounds: [{id, title?, points,
   curves?, note?}]}`; `points`/`curves` inline or `{"$file": …}` refs —
   write big curve arrays to files). Each point is
   `{index?, label?, params, metrics, status?}`; `curves` is
   `{x_signal, signals: [{name, dB?}], points: [{index, label, x, y}]}`.
   The tool renders the interactive report (conclusions card, summary cards,
   metric charts, one curve per parameter combination, sortable per-point
   table, cross-highlight) at `<project>/<name>_report.html`, exports one PNG
   per chart into `<project>/Figs/`, and registers the report into the calling
   session's dashboard. The batch dropdown switches between the spec's rounds.

Local runs (Spectre on this host): `spectre_run_sweep {run_dir}` replaces
steps 2–4; steps 5–6 are identical (analyze locally, then the same spec
flow). Remote files outside the batch channel ride explicit `ssh_upload` /
`ssh_download` calls.

## LSF / cluster gotchas

- The remote write fence is the project's `settings.remote_root`
  (workspace_config.json) — `remote_dir` must stay under it.
- `bjobs` "No unfinished job found" means the job left the queue; completion
  is confirmed by the point_meta count reaching the configured total.
- `scheduler: "direct"` runs the worker on the login host in the foreground
  (bounded by a 600 s tool timeout) — for small batches only.
- One template file per run directory (multiple `template*` files are
  rejected at submit).

# Cascade Netlist Assembly (netlist-level stitching)

How to join multiple single-cell ATT netlists into one cascade directly at
the netlist level (no schematic). All simulations must be explicit about
temperature (`temp=... tnom=...` in `simulatorOptions` and `temperature=...`
in the `parameters` line).

## 1. Wrap each cell as a `subckt` (device values hardcoded)

Take the cell's flat template netlist and:

- **Keep** every device instance (resistors, transistors, MOM caps — including
  structural elements such as a SimpleT cell's `Rshort (IN OUT) resistor r=0`
  bridge). These become the subckt body.
- **Drop** the testbench: `PORT0`, `PORT1`, `V1`/`V2`/`V3` (sources),
  `simulatorOptions`, `sp`/`sweeppss`, `modelParameter`/`element`/`save*` lines.
- **Replace each `@@param@@` placeholder with its literal `bestPoints.params`
  value** — no `parameters` line inside the subckt, no device-value variables.
- Ports are `AVSS IN OUT SW`, plus `SWB` iff the cell drives a complementary
  gate (SimpleT cells have no `SWB`).

```
subckt <Name> AVSS IN OUT SW [SWB]
    <device instances with literal values>
ends <Name>
```

## 2. Chain the subckts in series with INTER nodes

The node between stage *n* and stage *n+1* is `INTERn`; the first stage's
`IN` is the cascade input, the last stage's `OUT` is the cascade output.

```
I1 (AVSS IN  INTER1  SW1 [SWB1]) <Cell1>
I2 (AVSS INTER1 INTER2 SW2 [SWB2]) <Cell2>
...
In (AVSS INTER(n-1) OUT SWn [SWBn]) <Celln>
```

`PORT0 (IN AVSS) port r=50 type=sine` / `PORT1 (OUT AVSS) port r=50 type=dc`;
shared `V1 (AVSS 0) vsource dc=0`; per-cell control sources
`VSWn (SWn AVSS) vsource dc=VDD*SWn` and (where the cell has `SWB`)
`VSWBn (SWBn AVSS) vsource dc=VDD*(1-SWn)`. Copy the model `include` block
unchanged from the cell templates; `sp sp ports=[PORT0 PORT1] start=1G
stop=40G step=0.1G paramtype=yz`; `save OUT AVSS`.

## 3. Control-word convention: point index = binary value

For an *n*-cell cascade, run all `2^n` states as one cross-product sweep with
`2^n ≤ 100`:

- `parameters temperature=... SWn=@@SWn@@ … SW1=@@SW1@@` — **order the
  `parameters` dict from the last cell to the first**
  (`{"SW5":[…],"SW4":[…],…,"SW1":[…]}`). The worker's cross-product then
  enumerates points in binary order: **point index = integer value of the
  control word**.
- The control word has **bit(n-1) (leftmost) = last cell, bit0 (rightmost) =
  first cell**. Point `16` ↔ `10000` (only the last cell in attenuation),
  point `0` ↔ `00000` (all reference), point `31` ↔ `11111` (all
  attenuation).
- No post-rename needed: the parsed curves and the report spec key every
  curve by point index and params — the control word is recovered from the
  point index binary representation.

## 4. PSS / IP1dB variant (`template_thorough.scs`)

Same subckts and chaining, but: `parameters … SW1=0 … SWn=0 pin=@@pin@@
fin=@@fin@@`; `PORT0 … type=sine freq=fin dbm=pin`; replace the `sp` analysis
with:

```
sweeppss sweep param=pin start=-20 stop=30 step=1 {
 pss pss flexbalance=yes oversamplefactor=1 fund=fin harms=10 errpreset=moderate tstab=0 annotate=status
}
```

The pin sweep covers **−20..+30 dBm** so high-linearity cells (IP1dB > 20 dBm)
are fully characterized, not just reported as a lower bound. `fin` takes one
point per target frequency (e.g. `["5G","10G","20G","30G"]`).

**Pitfalls (both required together):**
- **Never write `dbm=@@pin@@` on the PORT0 line.** The placeholder substitutes
  a literal, freezing the port power so the sweep has no effect. PORT0 must
  reference the swept parameter as `dbm=pin`.
- **Never remove `pin` from the `parameters` line.** `sweeppss sweep
  param=pin` needs `pin` as a defined parameter, or Spectre errors out
  (SFE-1997). Keep `pin=@@pin@@` in the parameters line (config `pin:[0]`).
