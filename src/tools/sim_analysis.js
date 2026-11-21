// Simulator-agnostic analysis tools: sim_analysis (collect + optional report
// dashboard) and sim_progress (the LOCAL progress-file window). They read the
// data contract written by either sweep worker (point_meta.json /
// sweep_progress.json) and never spawn a simulator. The collect/report pipeline
// is pure JS: results.json / report HTML shapes and stdout line formats follow
// the contract, report inline-JSON '</' and HTML text are escaped against
// injection, and point directories sort numerically ("11" before "100").
// safe_trash lives with its implementation in trash.js.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJsonIfExists, resolveDir } from '../py.js'

// --- sim_analysis(report=true) auto-registration target: the calling session's
// HarnessAMS dashboard. Since the task retirement (2026-11-19, D-008) each DSH
// session carries its own report list in <workspace>/.harnessams/sessions.json;
// the calling session is identified EXACTLY through the tool execution context
// (exec.agent.id IS the SessionId — probe-verified, see probe-taskmerge-20261119).
// server/project.js owns the store and its validation; this side only merges one
// report into one session entry through writeSessionConfig (atomic, defensive).

const SESSIONS_DIR = '.harnessams'
const MAX_REPORTS = 32 // same cap as the sidebar's writer (server/project.js)

// Walk up from startDir (max 8 levels) to the nearest ancestor holding a
// .harnessams/ store directory. The store dir — not harnessams.json — is
// the anchor because the DSH workspace root (where the sidebar's store lives)
// can sit ABOVE the harnessams.json directory (e.g. repo root vs its
// harnessams-workspace/). Returns { storeDir } or null.
export function findSessionsStore(startDir) {
  let d = path.resolve(startDir)
  for (let i = 0; i < 8; i++) {
    const storeDir = path.join(d, SESSIONS_DIR)
    if (fs.existsSync(storeDir) && fs.statSync(storeDir).isDirectory()) return { storeDir }
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

// Append (or reuse) `reportPath` in session `sessionId`'s entry and select it
// on that session's dashboard. Creates the entry when absent; preserves the
// entry's display/check_params. Returns { session, report } or { error } —
// never throws, never clobbers sibling sessions (single-session merge write).
export async function registerReportIntoSession(storeDir, sessionId, reportPath) {
  const { readSessionConfigs, writeSessionConfig } = await import('../server/project.js')
  const workspacePath = path.dirname(path.resolve(storeDir))
  const abs = path.resolve(reportPath)
  const store = await readSessionConfigs(workspacePath)
  const entry = store.sessions[sessionId] ?? { display: 'overview', reports: [], dashboard_selected: null }
  const reports = Array.isArray(entry.reports) ? entry.reports : []
  let report = reports.find((r) => r && typeof r.path === 'string' && path.resolve(r.path) === abs)
  if (!report) {
    if (reports.length >= MAX_REPORTS) {
      return { error: `this session already has ${MAX_REPORTS} reports (max) — remove one in the sidebar dashboard first` }
    }
    report = { id: 'r-' + randomUUID().slice(0, 8), name: path.basename(abs), path: abs, added_at: new Date().toISOString() }
    reports.push(report)
  }
  const state = { ...entry, reports, dashboard_selected: report.id }
  const w = await writeSessionConfig(workspacePath, sessionId, state)
  if (w.error) return { error: w.error }
  return { session: sessionId, report }
}

// The sweep convention places run directories at <project>/sweep/RoundN/top;
// the Sim convention (2026-11-21) places them at <project>/Sim<N>_<date>_
// batch<M>/ (or <project>/sweep/Sim*/). Derive the project root from a
// run_dir (null when the shape does not match).
const SIM_DIR_RE = /^Sim\d+_\d{8}_batch\d+$/

function deriveProjectDir(runDir) {
  const abs = path.resolve(runDir)
  if (SIM_DIR_RE.test(path.basename(abs))) {
    const parent = path.basename(path.dirname(abs))
    return parent === 'sweep' ? path.dirname(path.dirname(abs)) : path.dirname(abs)
  }
  const round = path.basename(path.dirname(runDir))
  const sweep = path.basename(path.dirname(path.dirname(runDir)))
  if (/^Round/.test(round) && sweep === 'sweep') {
    return path.dirname(path.dirname(path.dirname(runDir)))
  }
  return null
}

// --- Collect pipeline (was common/common_collect_results.py) ---------------
// Aggregates every NN/point_meta.json of a run directory into results.json:
// per-point records (the worker's `signals` become `metrics`) plus min/max/mean
// summary statistics. The simulator label comes from the explicit override,
// else the run's .simulator marker (written by the sweep worker), else the
// netlist template (template.scs -> spectre).

// JSON read tolerating a UTF-8 BOM (the Python side read every meta/config
// file with utf-8-sig; editors on zh-CN Windows add BOMs).
function readJsonBom(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

// Python dict.get semantics: the default only applies when the key is ABSENT
// (an explicit null survives), so results.json keeps py-identical null fields.
const pick = (m, k, dflt) => (k in m ? m[k] : dflt)

// Python '%.6g' equivalent for the summary stdout lines: 6 significant digits,
// trailing zeros stripped, exponent with a sign and at least two digits.
function fmt6g(v) {
  if (!Number.isFinite(v)) return String(v)
  const s = v.toPrecision(6)
  let mant = s
  let exp = ''
  const ei = s.indexOf('e')
  if (ei >= 0) { mant = s.slice(0, ei); exp = s.slice(ei + 1) }
  if (mant.includes('.')) mant = mant.replace(/\.?0+$/, '')
  if (exp) {
    const n = Number(exp)
    mant += 'e' + (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(2, '0')
  }
  return mant
}

function loadPoints(workDir) {
  // Numeric point ordering (review fix): directory names are all-digits, so
  // 00..09, 10..99, 100.. keep their natural order (a plain lexicographic sort
  // places "100" before "11").
  const names = fs.readdirSync(workDir)
    .filter((n) => /^\d{2,}$/.test(n))
    .sort((a, b) => Number(a) - Number(b))
  const points = []
  for (const name of names) {
    const metaPath = path.join(workDir, name, 'point_meta.json')
    let m
    try {
      const st = fs.statSync(metaPath)
      if (!st.isFile()) continue
      m = readJsonBom(metaPath)
    } catch {
      continue // missing / unreadable / broken point metas are skipped silently
    }
    points.push({
      index: pick(m, 'point_index', Number(name)),
      point_name: pick(m, 'point_name', name),
      params: pick(m, 'params', null),
      status: pick(m, 'status', null),
      returncode: pick(m, 'returncode', null),
      elapsed_sec: pick(m, 'elapsed_sec', null),
      metrics: m.signals || {},
      error: pick(m, 'error_message', null),
    })
  }
  return points
}

// OK population = success/partial; only finite numeric values enter the stats.
// Deliberate divergence from Python: isinstance(True, int) counted booleans
// there — the signals contract carries numbers/strings only, so excluding
// booleans outright loses nothing and is clearer.
function summarize(points) {
  const ok = points.filter((p) => p.status === 'success' || p.status === 'partial')
  const metricNames = [...new Set(ok.flatMap((p) => Object.keys(p.metrics || {})))].sort()
  const summary = {}
  for (const k of metricNames) {
    const vals = ok.map((p) => (p.metrics || {})[k])
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (!vals.length) continue
    summary[k] = {
      min: Math.min(...vals),
      max: Math.max(...vals),
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      n: vals.length,
    }
  }
  return summary
}

function detectSimulator(workDir, override) {
  if (override) return override
  const marker = path.join(workDir, '.simulator')
  if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
    try {
      const name = fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, '').trim()
      if (name) return name
    } catch { /* unreadable marker falls through to template sniffing */ }
  }
  try {
    // template*.scs family (2026-11-21): any family member marks a spectre run
    if (fs.readdirSync(workDir).some((n) => /^template[\w.-]*\.scs$/.test(n))) return 'spectre'
  } catch { /* unreadable directory falls through */ }
  return null
}

// Full collect step. Returns { result, stdout, anyOk }; throws only when no
// point_meta.json exists at all. A sweep with zero success/partial points has
// still written results.json but reports anyOk=false — the tool turns that
// into a failure, matching the old script's exit-1 contract.
function collectResults(workDir, opts = {}) {
  const points = loadPoints(workDir)
  if (!points.length) throw new Error(`no point_meta.json found: ${workDir}`)
  const nSuccess = points.filter((p) => p.status === 'success').length
  const nPartial = points.filter((p) => p.status === 'partial').length
  const nFailed = points.filter((p) => p.status !== 'success' && p.status !== 'partial').length
  const result = {
    work_dir: workDir,
    simulator: detectSimulator(workDir, opts.simulator),
    n_points: points.length,
    n_success: nSuccess,
    n_partial: nPartial,
    n_failed: nFailed,
    points,
    summary: summarize(points),
  }
  const out = opts.out ? path.resolve(opts.out) : path.join(workDir, 'results.json')
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8')
  const lines = [`[collect] ${result.simulator || 'unknown'}: ${nSuccess} success / ${nPartial} partial / ${nFailed} failed -> ${out}`]
  for (const [k, v] of Object.entries(result.summary)) {
    lines.push(`  ${k}: min=${fmt6g(v.min)} max=${fmt6g(v.max)} mean=${fmt6g(v.mean)} (n=${v.n})`)
  }
  return { result, stdout: lines.join('\n'), anyOk: nSuccess + nPartial > 0 }
}

// --- Report pipeline (was common/common_gen_sweep_report.py) ---------------
// Renders the sweep-result HTML dashboard: summary metric cards, interactive
// Plotly metric charts and a per-point table, with a round selector driven by
// MANIFEST + data/Round<N>.js loaded via <script> tags (no fetch under file://,
// so script injection is the only reliable channel).

const PLOTLY_CDN = 'https://cdn.plot.ly/plotly-3.0.1.min.js'

// Server-side HTML text escaping (review P1 #11): project/testbench/pdk names
// go into <title>/<h1> text and the inline MANIFEST — escaping HTML specials
// (quotes included) means they can neither inject markup nor break out of the
// inline JS string literal.
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// JSON string for INLINE <script> embedding: a literal '</' would terminate
// the script tag, so break it as '<\/' (identity inside a JS string literal).
function inlineJson(v) {
  return JSON.stringify(v).replaceAll('</', '<\\/')
}

// Visual language follows the verified AttST0p5dB_ch.html dashboard
// (2026-11-21 user request): centered container on #f9f9f7, #fcfcfb cards
// with 12px radius + soft shadow, system-ui, H1 32px, chart titles 20px /
// ticks 16px, curve charts carry NO legend (the table swatches map colors to
// parameter combinations), selection dims the other curves (width 4 vs 1,
// opacity 1 vs 0.08) and lights the table row; blank-click deselects.
const HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__CASCADE__ - sweep report</title>
<script src="__PLOTLY__"></script>
<script>window.Plotly || document.write('<script src="/harnessams/assets/plotly.min.js"><\\/script>');</script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #f9f9f7; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; padding: 36px; display: flex; flex-direction: column; align-items: center; }
.container { max-width: none; width: 100%; }   /* full-width: the selector stays left-anchored on wide screens (user 2026-11-21), the sidebar iframe is unaffected */
h1 { font-size: 32px; font-weight: 600; color: #0b0b0b; margin: 0 0 4px 0; }
.filter-line { font-size: 17px; color: #898781; margin: 0 0 6px 0; }
.hint { font-size: 18px; color: #898781; margin: 0 0 20px 0; }
.cards { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 20px 0; }
.card { background: #fcfcfb; border-radius: 8px; padding: 12px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); min-width: 190px; }
.card .k { font-size: 14px; color: #898781; }
.card .v { font-size: 19px; font-weight: 600; color: #0b0b0b; margin-top: 2px; }
.card .s { font-size: 14px; color: #52514e; margin-top: 2px; }
#info-bar { background: #fcfcfb; border-radius: 8px; padding: 14px 24px; margin-bottom: 20px; font-size: 19px; color: #0b0b0b; box-shadow: 0 1px 4px rgba(0,0,0,0.06); min-height: 32px; cursor: pointer; }
#info-bar:hover { background: #f0f0ee; }
.chart-box { background: #fcfcfb; border-radius: 12px; padding: 20px 16px 12px 16px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
#selector-bar { display: flex; align-items: center; gap: 12px; margin: 18px 0 20px 0; flex-wrap: wrap; }
#selector-bar label { font-size: 16px; font-weight: 600; color: #52514e; }
#round-select { font-size: 16px; padding: 8px 14px; border-radius: 8px; border: 1px solid #ccc; background: #fcfcfb; cursor: pointer; }
#round-select:hover { border-color: #888; }
#round-info { font-size: 15px; color: #898781; }
.table-box { background: #fcfcfb; border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
.table-box h2 { font-size: 20px; font-weight: 600; color: #0b0b0b; margin-bottom: 14px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 15px; }
.tbl th { background: #f3f3f1; color: #52514e; font-weight: 600; padding: 10px 14px; text-align: left; border-bottom: 2px solid #ddd; }
.tbl th.sortable { cursor: pointer; user-select: none; }
.tbl th.sortable:hover { background: #e8e8e4; }
.tbl th .sort-arrow { margin-left: 4px; font-size: 12px; opacity: 0.4; }
.tbl th.sort-active .sort-arrow { opacity: 1; }
.tbl td { padding: 8px 14px; border-bottom: 1px solid #eee; color: #0b0b0b; cursor: pointer; }
.tbl tr:hover td { background: #f0f5ff; }
.tbl tr.selected td { background: #dce8ff; font-weight: 600; }
.tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }
.swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: middle; margin-right: 6px; }
.legend-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 10px; font-size: 13px; margin-bottom: 20px; }
.legend-item { padding: 4px 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; min-width: 0; }
.legend-item:hover { background: #f0f5ff; }
.legend-item.selected { background: #dce8ff; font-weight: 600; }
.legend-item .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl tr.bad td:first-child .swatch { outline: 2px solid #c0392b; }
</style>
</head>
<body>
<div class="container">
<h1>__CASCADE__ — sweep report</h1>
<div class="filter-line">Generated __NOW__ | PDK: __PDK__ | Simulator: __SIMULATOR__</div>
<div id="selector-bar">
  <label for="round-select">Select batch:</label>
  <select id="round-select"></select>
  <span id="round-info"></span>
</div>
<div id="dashboard-area" style="display:none">
  <p class="hint">Click legend entry / table row (or a curve) → cross-highlight | Click blank area or info bar to deselect</p>
  <div id="info-bar">Click a legend entry or table row to cross-highlight a parameter combination</div>
  <div id="legend-grid" class="legend-grid"></div>
  <div class="cards" id="summary-cards"></div>
  <div id="chart-area"></div>
  <div class="table-box"><h2>All Parameter Combinations</h2>
    <div style="overflow-x:auto"><table class="tbl" id="points-table">
      <thead id="points-head"></thead><tbody id="points-body"></tbody>
    </table></div>
  </div>
</div>
<div id="placeholder" style="padding:60px;text-align:center;color:#aaa;font-size:18px">Select a batch to load data</div>
</div>
`

// Raw template (the Python original was an r-string): preserves the regex
// backslashes below verbatim. No ${...} interpolation — everything is string
// concatenation, matching the original generator's style.
const FOOT_JS = String.raw`
<script>
const MANIFEST = { project: "__CASCADE__", rounds: [__ROUNDS__] };
var ROUND_DATA = null;                       // hard rule: var, not const (batch switching re-declares)

var sel = null, clickFired = false, sortCol = null, sortAsc = true;
var PTS = [], N = 0, PARAM_KEYS = [], METRIC_KEYS = [], CURVE = null;
var CURVE_DIVS = [];                         // legend-less curve charts (swatch-mapped)

function num(v, n) {                         // hard rule: robust formatter
  return (typeof v === "number" && isFinite(v)) ? v.toFixed(n === undefined ? 4 : n) : "-";
}
function show(v) { return (v === null || v === undefined || v === "") ? "-" : String(v); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fmtVal(v) {
  if (typeof v !== "number" || !isFinite(v)) return esc(show(v));
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
  return num(v, 4).replace(/\.?0+$/, "");
}
function labelOf(p) {                        // k=v comma label of one parameter combination
  if (p && p.params) {
    return Object.keys(p.params).map(function (k) { return k + "=" + show(p.params[k]); }).join(", ");
  }
  return show(p ? p.index : "-");
}
function hsl(i, n) {                         // HSL blue-to-red gradient (swatch + curve colors)
  n = n || N;
  return "hsl(" + Math.round(240 - 240 * (n <= 1 ? 0.5 : i / (n - 1))) + ",65%,50%)";
}

function populateSelect() {
  const selEl = document.getElementById("round-select");
  selEl.innerHTML = "";
  for (const r of MANIFEST.rounds) {
    const opt = document.createElement("option");
    opt.value = r.file; opt.textContent = r.title + " (" + r.n_points + " pts)";
    selEl.appendChild(opt);
  }
  selEl.onchange = function () { loadRound(selEl.value); };
}

function loadRound(file) {                   // hard rule: script injection + ?v= cache-bust
  const old = document.getElementById("round-data-script");
  if (old) old.remove();
  const el = document.createElement("script");
  el.id = "round-data-script";
  el.src = file + "?v=" + Date.now();
  el.onload = function () { buildReport(ROUND_DATA); };
  el.onerror = function () {
    document.getElementById("round-info").textContent = "data load failed: " + file;
  };
  document.head.appendChild(el);
}

function buildReport(RD) {
  if (!RD) return;
  PTS = RD.points || []; N = PTS.length;
  for (const p of PTS) { p.label = p.label || labelOf(p); }
  PARAM_KEYS = RD.param_names || []; METRIC_KEYS = RD.metric_names || []; CURVE = RD.curves || null;
  document.getElementById("placeholder").style.display = "none";
  document.getElementById("dashboard-area").style.display = "block";
  document.getElementById("round-info").textContent =
    "Status: " + RD.n_success + " success / " + RD.n_failed + " failed";
  sortCol = null; sortAsc = true; sel = null;
  document.getElementById("info-bar").textContent = "Click a legend entry or table row to cross-highlight a parameter combination";
  try { buildLegend(); } catch (e) { console.warn("legend", e); }
  try { buildSummary(RD); } catch (e) { console.warn("summary", e); }   // hard rule: per-section isolation
  try { buildCharts(RD); } catch (e) { console.warn("charts", e); }
  try { buildTable(RD); } catch (e) { console.warn("table", e); }
}

// Per-combination legend grid (cascade-report pattern): pure-DOM click
// highlighting that works regardless of plotly_click support — the primary
// cross-highlight path; curve clicks ride el.on('plotly_click') best-effort.
function buildLegend() {
  const grid = document.getElementById("legend-grid");
  grid.innerHTML = "";
  grid.style.display = N >= 2 ? "" : "none";
  PTS.forEach(function (p, i) {
    const it = document.createElement("div");
    it.className = "legend-item";
    it.dataset.index = String(p.index);
    it.title = p.label;
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = hsl(i);
    const tx = document.createElement("span");
    tx.className = "lbl";
    tx.textContent = p.label;
    it.appendChild(sw);
    it.appendChild(tx);
    grid.appendChild(it);
  });
}

function buildSummary(RD) {
  const cards = document.getElementById("summary-cards");
  cards.innerHTML = "";
  for (const [k, s] of Object.entries(RD.summary || {})) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = '<div class="k">' + esc(show(k)) + '</div>'
      + '<div class="v">min ' + fmtVal(s.min) + ' / max ' + fmtVal(s.max) + '</div>'
      + '<div class="s">mean ' + fmtVal(s.mean) + ' (n=' + s.n + ')</div>';
    cards.appendChild(c);
  }
  cards.style.display = cards.childElementCount ? "" : "none";
}

function chartLayout(ytitle, xtitle, legend) {
  return {
    title: { text: ytitle, font: { size: 20 } },
    xaxis: { title: { text: xtitle, standoff: 14 }, tickfont: { size: 16 }, showgrid: true,
      gridcolor: "#e8e8e8", zeroline: false, linecolor: "#ccc", linewidth: 1, ticks: "outside", ticklen: 5 },
    yaxis: { title: { text: ytitle, standoff: 12 }, tickfont: { size: 16 }, gridcolor: "#e8e8e8",
      zeroline: true, zerolinecolor: "#ddd" },
    margin: { t: 48, b: 60, l: 76, r: 40 }, height: 480,
    showlegend: !!legend, hovermode: "closest", clickmode: "event",
    hoverlabel: { font: { size: 15 }, bgcolor: "#fff", bordercolor: "#ccc" },
    paper_bgcolor: "#fcfcfb", plot_bgcolor: "#fcfcfb",
    font: { family: "system-ui, -apple-system, sans-serif", color: "#0b0b0b" },
  };
}

function newChartBox(id) {
  const box = document.createElement("div");
  box.className = "chart-box";
  const div = document.createElement("div");
  div.id = id;
  box.appendChild(div);
  document.getElementById("chart-area").appendChild(box);
  return div;
}

function buildCharts(RD) {
  const area = document.getElementById("chart-area");
  area.innerHTML = "";
  CURVE_DIVS = [];
  let n = 0;

  // scalar metric charts: metric vs point index, traces = group values (legend:
  // groups are not parameter combinations, so the table swatches cannot map them)
  const byGroup = RD.group_by && RD.group_values && RD.group_values.length > 1;
  for (let mi = 0; mi < METRIC_KEYS.length; mi++) {
    const mk = METRIC_KEYS[mi];
    const div = newChartBox("chart-metric-" + mi);
    const traces = [];
    if (byGroup) {
      RD.group_values.forEach(function (gv, gi) {
        const pts = PTS.filter(function (p) { return String(p.params[RD.group_by]) === String(gv); });
        traces.push({
          x: pts.map(function (p) { return p.index; }),
          y: pts.map(function (p) { return (p.metrics && typeof p.metrics[mk] === "number") ? p.metrics[mk] : null; }),
          mode: "lines+markers", name: RD.group_by + "=" + show(gv),
          line: { width: 2, color: hsl(gi, RD.group_values.length) }, marker: { size: 7, opacity: 0.3, color: hsl(gi, RD.group_values.length) },
          connectgaps: false, cliponaxis: false,
          hovertemplate: "%{fullData.name}<br>point %{x}<br>" + esc(mk) + ": %{y:.4g}<extra></extra>",
        });
      });
    } else {
      traces.push({
        x: PTS.map(function (p) { return p.index; }),
        y: PTS.map(function (p) { return (p.metrics && typeof p.metrics[mk] === "number") ? p.metrics[mk] : null; }),
        mode: "lines+markers", name: mk,
        line: { width: 2, color: "hsl(210,65%,45%)" }, marker: { size: 7, opacity: 0.3, color: "hsl(210,65%,45%)" },
        connectgaps: false, cliponaxis: false,
        hovertemplate: "%{fullData.name}<br>point %{x}: %{y:.4g}<extra></extra>",
      });
    }
    const layout = chartLayout(mk, "sweep point index", byGroup);
    layout.xaxis.dtick = 1;
    Plotly.newPlot(div, traces, layout, { displayModeBar: false });
    const el = div;
    el.on("plotly_click", function (evt) {                       // index-axis charts: x IS the point index
      clickFired = true;
      if (evt.points && evt.points[0]) { toggle(String(evt.points[0].x)); }
    });
    el.on("plotly_deselect", resetAll);
    addBlankDeselect(el);
    n++;
  }

  // sweep curves (spectre_parse psf data): ONE TRACE PER PARAMETER COMBINATION,
  // legend-less — the table swatches carry the color mapping (AttST0p5dB style)
  if (CURVE && CURVE.points && CURVE.points.length) {
    if (CURVE.note) {
      const note = document.createElement("p");
      note.className = "filter-line"; note.textContent = CURVE.note;
      area.appendChild(note);
    }
    CURVE.signals.forEach(function (sk, si) {
      const div = newChartBox("chart-curve-" + si);
      const traces = CURVE.points.map(function (p, pi) {
        return {
          x: p.x, y: (p.y && p.y[sk.name]) ? p.y[sk.name] : [],
          mode: "lines+markers", name: p.label,
          line: { width: 2, color: hsl(pi, CURVE.points.length) },
          marker: { size: 7, opacity: 0.3, color: hsl(pi, CURVE.points.length), line: { width: 0 } },
          legendgroup: String(p.index), cliponaxis: false, connectgaps: false,
          hovertemplate: esc(p.label) + "<br>" + esc(CURVE.x_signal) + ": %{x:.4g}<br>" + esc(sk.name) + (sk.dB ? " (dB)" : "") + ": %{y:.4g}<extra></extra>",
        };
      });
      Plotly.newPlot(div, traces, chartLayout(sk.name + (sk.dB ? " (dB)" : ""), CURVE.x_signal, false), { displayModeBar: false });
      CURVE_DIVS.push(div.id);
      div.on("plotly_click", function (evt) {
        clickFired = true;
        if (evt.points && evt.points[0]) { toggle(String(CURVE.points[evt.points[0].pointNumber].index)); }
      });
      div.on("plotly_deselect", resetAll);
      addBlankDeselect(div);
      n++;
    });
  }
  if (!n) area.innerHTML = '<p class="hint">No metric or curve data in this batch.</p>';
}

// blank-area click deselects (AttST0p5dB pattern): a plotly_click sets the
// flag first; a bare click that follows within the timeout resets
function addBlankDeselect(el) {
  el.addEventListener("click", function () {
    setTimeout(function () { if (!clickFired && sel !== null) resetAll(); clickFired = false; }, 10);
  });
}

function buildTable(RD) {
  const COLS = [{ key: "index", label: "#", kind: "num" }]
    .concat(PARAM_KEYS.map(function (k) { return { key: k, label: k, kind: "param" }; }))
    .concat(METRIC_KEYS.map(function (k) { return { key: k, label: k, kind: "metric" }; }))
    .concat([{ key: "status", label: "status", kind: "txt" }, { key: "elapsed_sec", label: "elapsed s", kind: "num" }]);

  function sortArrow(ci) { return sortCol !== ci ? "" : (sortAsc ? " ▴" : " ▾"); }
  function buildHead() {
    let h = "<tr><th></th>";
    COLS.forEach(function (c, ci) {
      h += '<th class="sortable" data-col="' + ci + '">' + esc(c.label) + '<span class="sort-arrow">' + sortArrow(ci) + '</span></th>';
    });
    document.getElementById("points-head").innerHTML = h + "</tr>";
    document.querySelectorAll("#points-head th.sortable").forEach(function (th) {
      th.addEventListener("click", function () { sortTable(parseInt(this.dataset.col, 10)); });
    });
  }
  function cellVal(p, c) {
    if (c.kind === "metric") return { txt: fmtVal(p.metrics ? p.metrics[c.key] : null), cls: "num" };
    if (c.kind === "num") return { txt: num(p[c.key], 2), cls: "num" };
    if (c.key === "index") return { txt: esc(String(p.index)), cls: "num" };
    return { txt: esc(show(p[c.key])), cls: "" };
  }
  function buildRows(list) {
    let t = "";
    list.forEach(function (p) {
      const gi = PTS.indexOf(p);
      t += '<tr data-index="' + esc(String(p.index)) + '" class="' + ((p.status === "success" || p.status === "partial") ? "ok" : "bad") + '">';
      t += '<td><span class="swatch" style="background:' + hsl(gi) + '"></span></td>';
      COLS.forEach(function (c) { const cv = cellVal(p, c); t += '<td class="' + cv.cls + '">' + cv.txt + "</td>"; });
      t += "</tr>";
    });
    document.getElementById("points-body").innerHTML = t;
    document.querySelectorAll("#points-body tr").forEach(function (tr) {
      tr.addEventListener("click", function () { toggle(this.dataset.index); });
    });
    if (sel !== null) {
      const r = document.querySelector('#points-body tr[data-index="' + sel + '"]');
      if (r) r.classList.add("selected");
    }
  }
  function sortTable(ci) {
    if (sortCol === ci) sortAsc = !sortAsc; else { sortCol = ci; sortAsc = true; }
    document.querySelectorAll("#points-head th.sortable").forEach(function (th, i) {
      th.classList.toggle("sort-active", i === ci);
    });
    buildHead();
    const c = COLS[ci];
    const sorted = PTS.slice().sort(function (a, b) {
      const va = cellVal(a, c).txt, vb = cellVal(b, c).txt;
      const na = parseFloat(va), nb = parseFloat(vb);
      if (isFinite(na) && isFinite(nb) && va !== "" && vb !== "") return sortAsc ? na - nb : nb - na;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    buildRows(sorted);
  }
  buildHead();
  buildRows(PTS);
}

function toggle(idx) { sel !== null && String(sel) === String(idx) ? resetAll() : highlight(idx); }

function highlight(idx) {                    // cross-highlight: table row + curve dimming + info bar
  document.querySelectorAll("#points-body .selected").forEach(function (r) { r.classList.remove("selected"); });
  sel = idx;
  const p = PTS.find(function (q) { return String(q.index) === String(idx); });
  const bar = document.getElementById("info-bar");
  document.querySelectorAll("#legend-grid .legend-item").forEach(function (it) {
    it.classList.toggle("selected", it.dataset.index === String(idx));
  });
  if (p) {
    let txt = "<b>" + esc(p.label) + "</b>";
    const ms = p.metrics ? Object.keys(p.metrics).map(function (k) { return esc(k) + " = " + fmtVal(p.metrics[k]); }) : [];
    if (CURVE && CURVE.points) {
      const cp = CURVE.points.find(function (q) { return String(q.index) === String(idx); });
      if (cp && cp.x && cp.x.length) {
        const m = Math.floor(cp.x.length / 2);
        CURVE.signals.forEach(function (sk) {
          const v = cp.y && cp.y[sk.name] ? cp.y[sk.name][m] : null;
          ms.push(esc(sk.name) + (sk.dB ? " (dB)" : "") + " = " + fmtVal(v));
        });
        ms.push(esc(CURVE.x_signal) + " = " + fmtVal(cp.x[m]));
      }
    }
    if (ms.length) txt += " → " + ms.join(" | ");
    bar.innerHTML = txt;
  }
  CURVE_DIVS.forEach(function (id) {         // selected curve width 4 / others 1 @ opacity 0.08
    const el = document.getElementById(id);
    if (!el || !el.data) return;
    const w = [], o = [];
    el.data.forEach(function (tr) {
      const m = p && tr.name === p.label;
      w.push(m ? 4 : 1); o.push(m ? 1 : 0.08);
    });
    Plotly.restyle(id, { "line.width": w, opacity: o });
  });
  const row = document.querySelector('#points-body tr[data-index="' + idx + '"]');
  if (row) row.classList.add("selected");
}

function resetAll() {
  sel = null;
  document.getElementById("info-bar").textContent = "Click a legend entry or table row to cross-highlight a parameter combination";
  document.querySelectorAll("#legend-grid .selected").forEach(function (it) { it.classList.remove("selected"); });
  CURVE_DIVS.forEach(function (id) {
    if (document.getElementById(id)) Plotly.restyle(id, { "line.width": 2, opacity: 1 });
  });
  document.querySelectorAll("#points-body .selected").forEach(function (r) { r.classList.remove("selected"); });
}

document.getElementById("info-bar").onclick = resetAll;
// native DOM listener ONCE at startup — the container survives batch switches
document.getElementById("legend-grid").addEventListener("click", function (e) {
  const it = e.target.closest(".legend-item");
  if (it) toggle(it.dataset.index);
});

populateSelect();
if (MANIFEST.rounds.length) { loadRound(MANIFEST.rounds[0].file); }
</script>
</body>
</html>
`

// Walk upward from the report's PROJECT directory for the single project
// config (.harnessams/workspace_config.json, 2026-11-19 — the harnessams.json
// walkers are retired), at most 8 levels. Corrupt configs are skipped and the
// walk continues. Only the workspace section matters here (plotly_asset).
function findProjectConfigFrom(startDir, maxLevels = 8) {
  let d = path.resolve(String(startDir ?? '.'))
  for (let i = 0; i < maxLevels; i++) {
    const cand = path.join(d, '.harnessams', 'workspace_config.json')
    if (isFileLoose(cand)) {
      try {
        const raw = readJsonBom(cand)
        const ws = raw?.workspace && typeof raw.workspace === 'object' ? raw.workspace : {}
        return { workspace: ws, root: d }
      } catch { /* corrupt config keeps the walk going */ }
    }
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

function isFileLoose(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// Project-level shared Plotly copy. The single copy lives at
// <project_root>/assets/plotly.min.js (the project root = the directory holding
// .harnessams/, else the report's project dir). Seed source search order:
// 1. an explicit plotly path (seed override);
// 2. the project config's workspace.plotly_asset (default-filled at file
//    creation with the plugin package's shipped copy — the ~/.dsh npm-install
//    location in installed layouts; relative values resolve against the
//    project root);
// 3. this module's ancestor directories, each probed for four candidates:
//    assets/plotly.min.js (package-local assets/), src/assets/plotly.min.js
//    (the shipped copy inside the dsh-harnessams package),
//    node_modules/dsh-harnessams/assets/plotly.min.js (an installed sibling
//    package) and dsh-harnessams/assets/plotly.min.js (an ancestor that is a
//    node_modules directory).
// A missing or size-stale project copy is (re-)seeded from the found source,
// and the report references it with a project-relative src (always same-drive,
// so it opens offline; an out-dir on another drive falls back to a copy beside
// the report). With no local source at all the CDN is the fallback.
function resolvePlotlySrc(forceCdn, outDir, project, plotlyArg) {
  if (forceCdn) return PLOTLY_CDN
  const found = findProjectConfigFrom(project)
  const root = found?.root ?? path.resolve(String(project ?? '.'))
  const wsAsset = path.join(root, 'assets', 'plotly.min.js')
  let seed = plotlyArg || null
  if (!seed) {
    const field = found?.workspace?.plotly_asset
    if (field) seed = path.isAbsolute(field) ? field : path.resolve(root, field)
  }
  if (!seed) {
    let d = path.resolve(import.meta.dirname ?? '.')
    for (let i = 0; i < 5; i++) {
      for (const cand of [path.join(d, 'assets', 'plotly.min.js'),
        path.join(d, 'src', 'assets', 'plotly.min.js'),
        path.join(d, 'node_modules', 'dsh-harnessams', 'assets', 'plotly.min.js'),
        path.join(d, 'dsh-harnessams', 'assets', 'plotly.min.js')]) {
        if (isFileLoose(cand)) { seed = cand; break }
      }
      if (seed) break
      const parent = path.dirname(d)
      if (parent === d) break
      d = parent
    }
  }
  const seedOk = !!seed && isFileLoose(seed)
  if (isFileLoose(wsAsset)) {
    if (seedOk && fs.statSync(wsAsset).size !== fs.statSync(seed).size) {
      fs.copyFileSync(seed, wsAsset) // size mismatch = plotly version bump, refresh
    }
  } else if (seedOk) {
    fs.mkdirSync(path.dirname(wsAsset), { recursive: true })
    fs.copyFileSync(seed, wsAsset)
  } else {
    return PLOTLY_CDN
  }
  const rel = path.relative(outDir, wsAsset)
  if (path.isAbsolute(rel)) {
    // out dir on a different drive than the workspace: no relative route, keep a sibling copy
    fs.copyFileSync(wsAsset, path.join(outDir, 'plotly.min.js'))
    return 'plotly.min.js'
  }
  return rel.replace(/\\/g, '/')
}

// Numeric sort key: legacy RoundN entries order by N; Sim<N>_<date>_batch<M>
// entries (2026-11-21) order by (N, date, M) — a lexicographic sort would
// place Sim10_* before Sim2_*.
function runSortKey(name) {
  const rm = /^Round(\d+)$/.exec(name)
  if (rm) return [0, Number(rm[1]), 0, 0]
  const sm = /^Sim(\d+)_(\d{8})_batch(\d+)$/.exec(name)
  if (sm) return [1, Number(sm[1]), Number(sm[2]), Number(sm[3])]
  return [2, 0, 0, 0]
}

function findRounds(projectDir, only) {
  const rounds = []
  const seen = new Set()
  const push = (name, top) => {
    if (seen.has(name)) return
    const resultsPath = path.join(top, 'results.json')
    if (isFileLoose(resultsPath)) { seen.add(name); rounds.push({ name, top, resultsPath }) }
  }
  // legacy layout: <project>/sweep/RoundN/top
  try {
    const names = fs.readdirSync(path.join(projectDir, 'sweep')).sort()
    for (const name of names) {
      if (!/^Round\d+$/.test(name)) continue
      if (only && name !== only) continue
      push(name, path.join(projectDir, 'sweep', name, 'top'))
    }
    // Sim convention inside sweep/: <project>/sweep/Sim*/
    for (const name of names) {
      if (!SIM_DIR_RE.test(name)) continue
      if (only && name !== only) continue
      push(name, path.join(projectDir, 'sweep', name))
    }
  } catch { /* no sweep/ directory */ }
  // Sim convention at the project root: <project>/Sim*/
  try {
    for (const name of fs.readdirSync(projectDir).sort()) {
      if (!SIM_DIR_RE.test(name)) continue
      if (only && name !== only) continue
      push(name, path.join(projectDir, name))
    }
  } catch { /* unreadable project dir */ }
  return rounds.sort((a, b) => {
    const ka = runSortKey(a.name)
    const kb = runSortKey(b.name)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    return a.name.localeCompare(b.name)
  })
}

// --- 2b sweep curves (2026-11-21): one trace per parameter combination ----
// Curve source: the spectre_parse outputs at <run>/psf/<point>_psf.json
// (per-point signal arrays; complex signals carry [re, im] pairs and plot as
// magnitude in dB). The section renders only when those files exist — a
// scalar-only run keeps the legacy metric-only report (backward compatible).
const CURVE_SIGNAL_LIMIT = 6
const CURVE_VALUE_LIMIT = 2_000_000

function isCurveArray(v) {
  return !!v && typeof v === 'object' && Array.isArray(v.values)
}

function loadPsfCurves(top, resultsPoints, opts = {}) {
  const psfDir = path.join(top, 'psf')
  let files
  try { files = fs.readdirSync(psfDir).filter((n) => n.endsWith('_psf.json')) } catch { return null }
  const byPoint = []
  for (const f of files.sort()) {
    let j
    try { j = readJsonBom(path.join(psfDir, f)) } catch { continue }
    if (!j || typeof j !== 'object' || !j.signals) continue
    byPoint.push({ point: String(j.point ?? f.replace(/_psf\.json$/, '')), signals: j.signals })
  }
  if (!byPoint.length) return null
  // candidate y-signals: array-valued in at least one point, filtered by the
  // requested signal list when given
  const wanted = opts.signals && opts.signals.length ? new Set(opts.signals) : null
  let yNames = [...new Set(byPoint.flatMap((p) => Object.keys(p.signals)
    .filter((k) => isCurveArray(p.signals[k]))))]
    .filter((k) => !wanted || wanted.has(k))
    .sort()
  // x signal: explicit > freq > time > the first array signal (dropped from y)
  const hasArray = (name) => byPoint.some((p) => isCurveArray(p.signals[name]))
  let xSignal = opts.xSignal && hasArray(opts.xSignal) ? opts.xSignal
    : (hasArray('freq') ? 'freq' : (hasArray('time') ? 'time' : null))
  if (!xSignal) {
    if (!yNames.length) return null
    xSignal = yNames.shift()
  } else {
    yNames = yNames.filter((k) => k !== xSignal)
  }
  if (!yNames.length) return null
  if (yNames.length > CURVE_SIGNAL_LIMIT) yNames = yNames.slice(0, CURVE_SIGNAL_LIMIT)
  const dB = {}
  for (const k of yNames) {
    const sample = byPoint.find((p) => isCurveArray(p.signals[k]))
    dB[k] = !!(sample && sample.signals[k].complex)
  }
  // per-point curves; the label comes from the results.json params (k=v) and
  // the index is reused, so cross-highlight matches the metric table rows
  const points = []
  let total = 0
  let truncated = false
  for (const p of byPoint) {
    const xArr = isCurveArray(p.signals[xSignal]) ? p.signals[xSignal].values : null
    if (!xArr || !xArr.length) continue
    if (total + xArr.length * (yNames.length + 1) > CURVE_VALUE_LIMIT) { truncated = true; break }
    total += xArr.length * (yNames.length + 1)
    const rp = resultsPoints.find((q) => String(q.point_name) === p.point || Number(p.point) === q.index)
    const label = rp && rp.params
      ? Object.entries(rp.params).map(([k, v]) => `${k}=${v}`).join(', ')
      : p.point
    const y = {}
    for (const k of yNames) {
      const arr = isCurveArray(p.signals[k]) ? p.signals[k].values : null
      if (!arr) { y[k] = null; continue }
      y[k] = dB[k]
        ? arr.map((v) => {
          const m = Math.hypot(Array.isArray(v) ? (v[0] ?? 0) : (v ?? 0), Array.isArray(v) ? (v[1] ?? 0) : 0)
          return m > 0 ? 20 * Math.log10(m) : -300
        })
        : arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    }
    points.push({ index: rp ? rp.index : (Number(p.point) || p.point), label, x: xArr, y })
  }
  if (!points.length) return null
  return {
    x_signal: xSignal,
    signals: yNames.map((k) => ({ name: k, dB: dB[k] })),
    points,
    ...(truncated ? { note: `curve data capped at ${CURVE_VALUE_LIMIT} values — ${byPoint.length - points.length} point(s) omitted` } : {}),
  }
}

function buildRoundData(name, top, resultsPath, curveOpts = {}) {
  const res = readJsonBom(resultsPath)
  const metaPath = path.join(top, 'cell_meta.json')
  const meta = isFileLoose(metaPath) ? readJsonBom(metaPath) : {}
  const points = res.points ?? []
  let paramNames = []
  let metricNames = []
  if (points.length) {
    paramNames = Object.keys(points[0].params || {})
    metricNames = Object.keys(points[0].metrics || {})
  }
  // group_by: the first param whose distinct values (first-seen order) number
  // more than one; fallback: the first param with its single value.
  let groupBy = null
  let groupValues = []
  for (const k of paramNames) {
    const vals = []
    for (const p of points) {
      const v = (p.params || {})[k]
      if (!vals.includes(v)) vals.push(v)
    }
    if (vals.length > 1 && groupBy === null) { groupBy = k; groupValues = vals }
  }
  if (groupBy === null && paramNames.length) {
    groupBy = paramNames[0]
    groupValues = [(points[0].params || {})[paramNames[0]]]
  }
  const curves = loadPsfCurves(top, points, curveOpts)
  return {
    round: name,
    testbench: meta.testbench || meta.cell_name || '',
    pdk: (meta.pdk || {}).name || '',
    simulator: res.simulator || '',
    group_by: groupBy || '',
    group_values: groupValues,
    param_names: paramNames,
    metric_names: metricNames,
    n_points: res.n_points ?? points.length,
    n_success: res.n_success ?? 0,
    n_partial: res.n_partial ?? 0,
    n_failed: res.n_failed ?? 0,
    summary: res.summary || {},
    points,
    ...(curves ? { curves } : {}),
  }
}

// Full report step (was the script's main()): writes Analysis/data/Round<N>.js
// + Analysis/<project>_report.html, returns { reportPath, stdout }; throws when
// no round with a results.json exists. The script's --out flag is not carried
// over (no caller ever passed it); plotly / plotlyCdn stay plumbed for parity.
function genSweepReport(projectDir, opts = {}) {
  const project = path.resolve(projectDir)
  const rounds = findRounds(project, opts.round)
  if (!rounds.length) {
    throw new Error(`no run directory with a results.json found (${path.join(project, 'sweep', 'Round*', 'top')} `
      + `or ${path.join(project, 'Sim*_********_batch*')})`)
  }
  const outDir = path.join(project, 'Analysis')
  const dataDir = path.join(outDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const entries = []
  let pdkName = ''
  let simulatorName = ''
  for (const r of rounds) {
    const rd = buildRoundData(r.name, r.top, r.resultsPath,
      { signals: opts.signals, xSignal: opts.xSignal })
    pdkName = pdkName || rd.pdk
    simulatorName = simulatorName || rd.simulator
    const jsName = r.name.startsWith('Round')
      ? `Round${r.name.replace('Round', '')}.js`
      : `${r.name}.js`
    // hard rule: data JS is plain utf-8 without BOM, one var line. JSON.stringify
    // vs ensure_ascii=True only differs by CJK literals, which load identically
    // in the utf-8 report page.
    fs.writeFileSync(path.join(dataDir, jsName), 'var ROUND_DATA = ' + JSON.stringify(rd) + ';', 'utf8')
    entries.push({ id: r.name, title: `${r.name} - ${rd.testbench}`, file: `data/${jsName}`, n_points: rd.n_points })
  }

  const projectName = path.basename(project.replace(/[\\/]+$/, ''))
  const roundsJs = entries.map((e) => (
    `{id:${inlineJson(e.id)},title:${inlineJson(e.title)},file:${inlineJson(e.file)},n_points:${e.n_points}}`
  )).join(',')
  const plotlySrc = resolvePlotlySrc(!!opts.plotlyCdn, outDir, project, opts.plotly || null)
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const nowStamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} `
    + `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`
  let html = HEAD
    .replaceAll('__CASCADE__', htmlEscape(projectName))
    .replaceAll('__PLOTLY__', plotlySrc)
    .replaceAll('__NOW__', nowStamp)
    .replaceAll('__PDK__', htmlEscape(pdkName || 'n/a'))
    .replaceAll('__SIMULATOR__', htmlEscape(simulatorName || 'n/a'))
  html += FOOT_JS
    .replaceAll('__CASCADE__', htmlEscape(projectName))
    .replaceAll('__ROUNDS__', roundsJs)
  // hard rule: main HTML is utf-8-sig (BOM prevents single-byte-locale misreads)
  const reportPath = path.join(outDir, `${projectName}_report.html`)
  fs.writeFileSync(reportPath, '\ufeff' + html, 'utf8')
  return { reportPath, stdout: `[report] ${entries.length} round(s) -> ${reportPath}` }
}

export function analysisTools() {
  return [
    {
      name: 'sim_analysis',
      description: 'Analyze a finished sweep and optionally render its dashboard. Always aggregates every '
        + 'NN/point_meta.json of the run directory into results.json (per-point metrics, min/max/mean summary; '
        + 'the simulator label comes from the run\'s .simulator marker or a template*.scs family member). When '
        + 'report=true, also regenerates the sweep-result HTML report (interactive Plotly metric charts, '
        + 'per-parameter-combination sweep curves from the spectre_parse psf outputs, summary cards, per-point '
        + 'table; works from file:// and inside the WebUI) at <project>/Analysis/<project>_report.html — the '
        + 'project root defaults to the run_dir\'s sweep/RoundN/top or Sim<N>_<date>_batch<M> structure — with '
        + 'a batch dropdown switching between every results.json-bearing run directory, and registers the '
        + 'report into the CALLING session\'s HarnessAMS dashboard (the session identity comes from the '
        + 'execution context; nearest .harnessams/sessions.json above the project). A registration failure '
        + 'never fails the analysis.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Run directory (sweep/RoundN/top or Sim<N>_<date>_batch<M>) holding NN/point_meta.json' },
        out: { type: 'string', description: 'Output results.json path (default: <run_dir>/results.json; must stay at the default when report=true)' },
        simulator: { type: 'string', enum: ['spectre'], description: 'Override the detected simulator label' },
        report: { type: 'boolean', description: 'Also generate the HTML dashboard for the project (default false)' },
        round: { type: 'string', description: 'report only: run-directory name to render (e.g. Round1 or Sim0_20260805_batch1; default: all discovered)' },
        project_dir: { type: 'string', description: 'report only: project root containing the run directories '
          + '(default: derived from run_dir\'s sweep/RoundN/top or Sim* structure)' },
        signals: { type: 'string', description: 'report only: comma list of curve signals for the sweep-curves section '
          + '(default: auto-pick common array signals from <run>/psf, bounded; complex signals plot as magnitude dB)' },
        x_signal: { type: 'string', description: 'report only: the sweep x-axis signal (default: freq, else time, '
          + 'else the first array signal)' },
      },
      async execute(args, exec) {
        const runDir = resolveDir(args.run_dir)
        // Collect step: point metas -> results.json. The report generator reads
        // results.json from the canonical <run_dir>/results.json location, so a
        // custom --out is incompatible with report=true (fail early, actionable).
        const defaultResults = path.join(runDir, 'results.json')
        const resultsPath = args.out ? path.resolve(args.out) : defaultResults
        if (args.report && resultsPath !== path.resolve(defaultResults)) {
          throw new Error('report=true requires the default results.json location (<run_dir>/results.json) '
            + '— the report generator reads results.json from the run directory; drop out= or omit report')
        }
        let collect
        try {
          collect = collectResults(runDir, {
            out: args.out ? resultsPath : null,
            simulator: args.simulator ? String(args.simulator) : null,
          })
          // Zero success/partial points is a failed analysis by contract (the
          // Python script exited 1 with results.json already written).
          if (!collect.anyOk) throw new Error(collect.stdout)
        } catch (e) {
          throw new Error(`collect failed: ${e.message}`)
        }
        const results = readJsonIfExists(resultsPath)
        const result = {
          ok: true,
          output: collect.stdout.trim(),
          results_file: resultsPath,
          simulator: results?.simulator ?? null,
          summary: results?.summary ?? null,
        }
        if (!args.report) return result

        // Report step: results.json -> HTML dashboard (+ optional task injection).
        const project = args.project_dir ? resolveDir(args.project_dir)
          : (deriveProjectDir(runDir)
            ?? (() => { throw new Error(`run_dir does not match <project>/sweep/RoundN/top: ${runDir} `
              + '(pass project_dir explicitly or use a conventional run directory)') })())
        let report
        try {
          report = genSweepReport(project, {
            round: args.round ? String(args.round) : null,
            signals: typeof args.signals === 'string'
              ? args.signals.split(',').map((s) => s.trim()).filter(Boolean) : null,
            xSignal: args.x_signal ? String(args.x_signal) : null,
          })
        } catch (e) {
          throw new Error(`report generation failed: ${e.message}`)
        }
        result.output = (collect.stdout.trim() + '\n' + report.stdout.trim()).trim()
        result.report_dir = path.join(project, 'Analysis')
        result.report_path = report.reportPath
        // Auto-registration into the CALLING session's dashboard (identity =
        // exec.agent.id, which IS the SessionId — D-008). The report is already
        // on disk, so a failure here is reported, never thrown.
        const sid = typeof exec?.agent?.id === 'string' && exec.agent.id ? exec.agent.id : null
        if (!sid) {
          result.registered = false
          result.register_error = 'no session identity in the tool execution context — report generated at '
            + result.report_path + ' but not registered (add it in the HarnessAMS sidebar dashboard)'
        } else {
          const found = findSessionsStore(project)
          if (!found) {
            result.registered = false
            result.register_error = `no HarnessAMS session store (.harnessams) found above ${project} — open the HarnessAMS sidebar in this workspace once first`
          } else {
            const r = await registerReportIntoSession(found.storeDir, sid, report.reportPath)
            if (r.error) { result.registered = false; result.register_error = r.error }
            else { result.registered = true; result.session = r.session; result.report = r.report }
          }
        }
        return result
      },
    },
    {
      name: 'sim_progress',
      description: 'Read a sweep batch\'s progress file (sweep_progress.json in the run directory; no simulation '
        + 'is started). This is the LOCAL file window: use it directly for local runs; for a remote batch poll '
        + 'batch_poll while it runs (it also sees the LSF queue state, which this file never knows) and call '
        + 'this tool after batch_fetch brought the progress file back.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Run directory holding sweep_progress.json' },
      },
      async execute(args) {
        const runDir = resolveDir(args.run_dir)
        const file = path.join(runDir, 'sweep_progress.json')
        if (!fs.existsSync(file)) return { ok: false, error: `no progress file yet: ${file}` }
        const prog = readJsonIfExists(file)
        if (!prog) return { ok: false, error: `unreadable progress file: ${file}` }
        return {
          ok: true,
          run_dir: runDir,
          simulator: prog.simulator ?? null,
          status: prog.status,
          total: prog.total_points,
          completed: prog.completed,
          succeeded: prog.succeeded,
          failed: prog.failed,
          updated_at: prog.updated_at,
        }
      },
    },
  ]
}
