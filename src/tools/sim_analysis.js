// Simulator-agnostic analysis tools: sim_analysis (collect + optional report
// dashboard) and sim_progress (the LOCAL progress-file window). They read the
// data contract written by either sweep worker (point_meta.json /
// sweep_progress.json) and never spawn a simulator. The collect/report pipeline
// is pure JS since 2026-11-10, ported from src/scripts/common/common_*.py
// (retired there under _dont_use_* names): the results.json / report HTML
// shapes and the stdout line formats are preserved, with two review fixes
// folded in — report inline-JSON '</' escaping + HTML text escaping (P1 #11)
// and numeric point-dir ordering ("100" used to sort before "11"). safe_trash
// lives with its implementation in trash.js.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJsonIfExists, resolveDir } from '../py.js'

// --- Optional sim_analysis(report=true, task=…) injection target: the
// HarnessAMS task dashboard. This plugin's own sidebar owns the task store at
// <workspace>/.harnessams/tasks.json (the DSH workspace the sidebar session
// runs in; server/project.js is the sidebar's writer). The store shape is still
// mirrored below and the write stays defensive: anything unexpected is refused,
// never rewritten, and every write is atomic (tmp + rename) against the
// sidebar's own PUT channel.

const TASKS_DIR = '.harnessams'
const TASKS_FILE = 'tasks.json'
const MAX_REPORTS = 32 // same cap as the sidebar's writer (server/project.js)

// Walk up from startDir (max 8 levels) to the nearest ancestor holding a
// .harnessams/ task-store directory. The store dir — not harnessams.json — is
// the anchor because the DSH workspace root (where the sidebar's store lives)
// can sit ABOVE the harnessams.json directory (e.g. repo root vs its
// harnessams-workspace/). Returns { storeDir } or null.
export function findTasksStore(startDir) {
  let d = path.resolve(startDir)
  for (let i = 0; i < 8; i++) {
    const storeDir = path.join(d, TASKS_DIR)
    if (fs.existsSync(storeDir) && fs.statSync(storeDir).isDirectory()) return { storeDir }
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

// Append (or reuse) `reportPath` in task `taskRef` (id first, then exact name)
// and select it on that task's dashboard. Refuses on any unexpected store
// shape; returns { task, report } or { error } — never throws, never clobbers.
export function registerReportIntoTask(storeDir, taskRef, reportPath) {
  const storePath = path.join(storeDir, TASKS_FILE)
  let store
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') store = { version: 1, tasks: [] } // empty store = no tasks yet
    else return { error: `task store unreadable (${storePath}): ${e.message}` }
  }
  if ((store?.version ?? 1) !== 1 || !Array.isArray(store?.tasks)) {
    return { error: `unexpected task store shape (version ${store?.version}) — refusing to write` }
  }
  const ref = String(taskRef)
  const task = store.tasks.find((t) => t?.id === ref) ?? store.tasks.find((t) => t?.name === ref)
  if (!task) {
    const names = store.tasks.map((t) => t?.name).filter(Boolean)
    return {
      error: names.length
        ? `task not found: "${ref}" (tasks: ${names.join(', ')})`
        : 'task store has no tasks yet — create one in the HarnessAMS task sidebar first',
    }
  }
  const abs = path.resolve(reportPath)
  const reports = Array.isArray(task.reports) ? task.reports : []
  let entry = reports.find((r) => r && typeof r.path === 'string' && path.resolve(r.path) === abs)
  if (!entry) {
    if (reports.length >= MAX_REPORTS) {
      return { error: `task "${task.name}" already has ${MAX_REPORTS} reports (max)` }
    }
    entry = { id: 'r-' + randomUUID().slice(0, 8), name: path.basename(abs), path: abs, added_at: new Date().toISOString() }
    reports.push(entry)
    task.reports = reports
  }
  task.dashboard_selected = entry.id
  const tmp = storePath + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...store, version: 1 }, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, storePath)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    return { error: `task store write failed: ${e.message}` }
  }
  return { task: { id: task.id, name: task.name }, report: entry }
}

// The sweep convention places run directories at <project>/sweep/RoundN/top;
// derive the project root from a run_dir (null when the shape does not match).
function deriveProjectDir(runDir) {
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
  if (fs.existsSync(path.join(workDir, 'template.scs'))) return 'spectre'
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

const HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>__CASCADE__ - sweep report</title>
<script src="__PLOTLY__"></script>
<script>window.Plotly || document.write('<script src="/harnessams/assets/plotly.min.js"><\\/script>');</script>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0 24px 48px; color: #1c2733; }
  h1 { font-size: 22px; margin: 18px 0 4px; }
  h2 { font-size: 18px; margin: 26px 0 8px; border-left: 4px solid #2b6cb0; padding-left: 8px; }
  .meta { color: #5a6b7b; font-size: 13px; margin-bottom: 12px; }
  .selector-bar { display: flex; gap: 16px; align-items: center; margin: 10px 0; }
  select { padding: 4px 8px; font-size: 14px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
  .card { border: 1px solid #d7e0e8; border-radius: 8px; padding: 10px 16px; min-width: 200px; background: #f8fafc; }
  .card .k { font-size: 13px; color: #5a6b7b; }
  .card .v { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .chart { width: 100%; height: 480px; margin: 8px 0 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d7e0e8; padding: 4px 8px; text-align: right; }
  th { background: #eef3f8; position: sticky; top: 0; }
  td.l, th.l { text-align: left; }
  tr.ok td { background: #ffffff; }
  tr.bad td { background: #fde8e8; }
  tr.sel td { background: #fff3c4 !important; }
  #info-bar { position: sticky; bottom: 0; background: #2b6cb0; color: #fff; padding: 6px 12px;
              border-radius: 6px; display: none; font-size: 13px; cursor: pointer; margin-top: 10px; }
  .legend-item { display: inline-block; margin: 0 10px 6px 0; font-size: 13px; cursor: pointer;
                 padding: 2px 8px; border-radius: 4px; border: 1px solid transparent; }
  .legend-item.selected { border-color: #2b6cb0; background: #e8f0fa; }
</style>
</head>
<body>
<h1>__CASCADE__ - sweep report</h1>
<div class="meta">Generated __NOW__ | PDK: __PDK__ | Simulator: __SIMULATOR__</div>
<div class="selector-bar">Round: <select id="round-select"></select><span id="round-info" class="meta"></span></div>
`

const BODY_TOP = `
<h2>1. Summary metrics</h2>
<div class="cards" id="summary-cards"></div>
<h2>2. Metric charts (click a legend item / curve to highlight its detail row)</h2>
<div id="legend-grid"></div>
<div id="chart-metrics"></div>
<h2>3. Per-point details</h2>
<div style="max-height: 420px; overflow: auto;">
<table id="points-table"><thead id="points-head"></thead><tbody id="points-body"></tbody></table>
</div>
<div id="info-bar"></div>
`

// Raw template (the Python original was an r-string): preserves the regex
// backslashes below verbatim.
const FOOT_JS = String.raw`
<script>
const MANIFEST = { project: "__CASCADE__", rounds: [__ROUNDS__] };
var ROUND_DATA = null;                       // hard rule: var, not const (round switching re-declares and overwrites)

const CHART_DIVS = ["chart-metrics"];

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

function ctrlColor(i, n) {                   // HSL blue-to-red gradient
  const h = 240 - 240 * (n <= 1 ? 0 : i / (n - 1));
  return "hsl(" + Math.round(h) + ",70%,45%)";
}

function populateSelect() {
  const sel = document.getElementById("round-select");
  sel.innerHTML = "";
  for (const r of MANIFEST.rounds) {
    const opt = document.createElement("option");
    opt.value = r.file; opt.textContent = r.title + " - " + r.n_points + " points";
    sel.appendChild(opt);
  }
  sel.onchange = function () { loadRound(sel.value); };
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
  document.getElementById("round-info").textContent =
    "Status: " + RD.n_success + " success / " + RD.n_failed + " failed";
  try { buildSummary(RD); } catch (e) { console.warn("summary", e); }   // hard rule: per-section isolation
  try { buildLegend(RD); } catch (e) { console.warn("legend", e); }
  try { buildCharts(RD); } catch (e) { console.warn("charts", e); }
  try { buildTable(RD); } catch (e) { console.warn("table", e); }
  bind(RD);                                  // hard rule: re-bind Plotly events after every buildReport
}

function buildSummary(RD) {
  const cards = document.getElementById("summary-cards");
  cards.innerHTML = "";
  for (const [k, s] of Object.entries(RD.summary || {})) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = '<div class="k">' + esc(show(k)) + '</div>' +
      '<div class="v">min ' + fmtVal(s.min) + ' / max ' + fmtVal(s.max) + '</div>' +
      '<div class="k">mean ' + fmtVal(s.mean) + ' (n=' + s.n + ')</div>';
    cards.appendChild(c);
  }
}

function buildLegend(RD) {
  const lg = document.getElementById("legend-grid");
  lg.innerHTML = "";
  RD.group_values.forEach(function (v, i) {
    const el = document.createElement("span");
    el.className = "legend-item";
    el.dataset.value = String(v);
    el.style.color = ctrlColor(i, RD.group_values.length);
    el.textContent = RD.group_by + " = " + show(v);
    lg.appendChild(el);
  });
}

function buildCharts(RD) {
  const host = document.getElementById("chart-metrics");
  host.innerHTML = "";
  const metrics = RD.metric_names;
  const rows = Math.ceil(metrics.length / 2);
  for (let i = 0; i < metrics.length; i++) {
    const div = document.createElement("div");
    div.className = "chart";
    div.id = "chart-" + i;
    if (metrics.length > 1) { div.style.height = "360px"; }
    host.appendChild(div);
  }
  metrics.forEach(function (mk, mi) {
    const traces = [];
    RD.group_values.forEach(function (gv, gi) {
      const pts = RD.points.filter(function (p) { return String(p.params[RD.group_by]) === String(gv); });
      traces.push({
        x: pts.map(function (p) { return p.index; }),
        y: pts.map(function (p) { return (p.metrics && typeof p.metrics[mk] === "number") ? p.metrics[mk] : null; }),
        mode: "lines+markers", name: RD.group_by + "=" + show(gv),
        line: { width: 2, color: ctrlColor(gi, RD.group_values.length) },
        marker: { size: 7, opacity: 0.4, color: ctrlColor(gi, RD.group_values.length) },
        connectgaps: false,
        hovertemplate: "point %{x}<br>" + mk + " = %{y}<extra>" + RD.group_by + "=" + show(gv) + "</extra>",
      });
    });
    Plotly.newPlot("chart-" + mi, traces, baseLayout(mk), { displayModeBar: false });
  });
}

function baseLayout(ylabel) {
  return {
    title: { text: ylabel, font: { size: 20 } },
    xaxis: { title: { text: "sweep point index", font: { size: 16 } }, tickfont: { size: 16 }, dtick: 1 },
    yaxis: { title: { text: ylabel, font: { size: 16 } }, tickfont: { size: 16 } },
    height: 480, margin: { t: 48, b: 60, l: 76, r: 40 },
    clickmode: "event", hovermode: "closest", showlegend: true,
  };
}

function buildTable(RD) {
  const head = document.getElementById("points-head");
  const body = document.getElementById("points-body");
  const cols = ["index"].concat(RD.param_names, RD.metric_names, ["status", "elapsed_s"]);
  head.innerHTML = "<tr>" + cols.map(function (c) {
    return '<th class="l">' + esc(show(c)) + "</th>";
  }).join("") + "</tr>";
  body.innerHTML = "";
  RD.points.forEach(function (p) {
    const tr = document.createElement("tr");
    tr.className = (p.status === "success" || p.status === "partial") ? "ok" : "bad";
    tr.dataset.index = String(p.index);
    let html = "<td>" + esc(String(p.index)) + "</td>";
    RD.param_names.forEach(function (k) { html += '<td class="l">' + esc(show(p.params ? p.params[k] : "-")) + "</td>"; });
    RD.metric_names.forEach(function (k) { html += "<td>" + fmtVal(p.metrics ? p.metrics[k] : null) + "</td>"; });
    html += "<td>" + esc(show(p.status)) + "</td><td>" + num(p.elapsed_sec, 2) + "</td>";
    tr.innerHTML = html;
    body.appendChild(tr);
  });
}

let bindDone = false;
let selIndex = null;

function highlight(idx) {                    // cross-highlight: charts <-> detail table
  const rows = document.querySelectorAll("#points-body tr");
  rows.forEach(function (r) { r.classList.toggle("sel", r.dataset.index === String(idx)); });
  const bar = document.getElementById("info-bar");
  const p = ROUND_DATA.points.find(function (q) { return String(q.index) === String(idx); });
  if (p) {
    bar.style.display = "block";
    bar.textContent = "point " + p.index + " | " + JSON.stringify(p.params) +
      " | " + JSON.stringify(p.metrics);
  } else { bar.style.display = "none"; }
  selIndex = idx;
}

function resetAll() { highlight(null); }

function bind(RD) {                          // hard rule: rebind after newPlot; el.on only
  RD.metric_names.forEach(function (mk, mi) {
    const el = document.getElementById("chart-" + mi);
    el.on("plotly_click", function (evt) {
      if (evt.points && evt.points[0]) { highlight(evt.points[0].x); }
    });
    el.on("plotly_deselect", resetAll);
  });
  if (!bindDone) {                           // hard rule: native DOM handlers bound exactly once
    document.getElementById("info-bar").onclick = resetAll;
    document.getElementById("legend-grid").addEventListener("click", function (e) {
      const t = e.target.closest(".legend-item");
      if (!t) return;
      const v = t.dataset.value;
      const p = ROUND_DATA.points.find(function (q) { return String(q.params[ROUND_DATA.group_by]) === v; });
      if (p) highlight(selIndex === p.index ? null : p.index);
    });
    bindDone = true;
  }
}

populateSelect();
if (MANIFEST.rounds.length) { loadRound(MANIFEST.rounds[0].file); }
</script>
</body>
</html>
`

// Walk upward for harnessams.json (bare or inside harnessams-workspace/), at
// most 8 levels, starting from the PROJECT directory — the report's plotly
// resolution anchor. Corrupt configs are skipped and the walk continues.
// NOT server/workspace.js's findWorkspaceConfig: that one anchors on
// cwd/package/homedir, walks 6 levels and throws on a broken file (it serves
// the batch channel's global lookup instead).
function findWorkspaceConfigFrom(startDir, maxLevels = 8) {
  let d = path.resolve(startDir)
  for (let i = 0; i < maxLevels; i++) {
    for (const candDir of [d, path.join(d, 'harnessams-workspace')]) {
      const cand = path.join(candDir, 'harnessams.json')
      if (isFileLoose(cand)) {
        try {
          return { config: readJsonBom(cand), configDir: candDir }
        } catch { /* corrupt config keeps the walk going */ }
      }
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

// Workspace-level shared Plotly copy. The single copy lives at
// <workspace_root>/assets/plotly.min.js (workspace root = the directory holding
// harnessams.json). Seed source search order:
// 1. an explicit plotly path (seed override);
// 2. this module's ancestor directories, each probed for four candidates:
//    assets/plotly.min.js (package-local assets/), src/assets/plotly.min.js
//    (the shipped copy inside the dsh-harnessams package),
//    node_modules/dsh-harnessams/assets/plotly.min.js (an installed sibling
//    package) and dsh-harnessams/assets/plotly.min.js (an ancestor that is a
//    node_modules directory) — the Python script walked from its own scripts/
//    directory; both anchors reach the same shipped copy in dev and installed
//    layouts;
// 3. the workspace harnessams.json plotly_asset field (relative values resolve
//    against the config file's directory).
// A missing or size-stale workspace copy is (re-)seeded from the found source,
// and the report references it with a workspace-relative src (always same-drive,
// so it opens offline; an out-dir on another drive falls back to a copy beside
// the report). With no local source at all the CDN is the fallback.
function resolvePlotlySrc(forceCdn, outDir, project, plotlyArg) {
  if (forceCdn) return PLOTLY_CDN
  const found = findWorkspaceConfigFrom(project)
  if (!found) return PLOTLY_CDN
  const { config, configDir } = found
  const wsAsset = path.join(configDir, 'assets', 'plotly.min.js')
  let seed = plotlyArg || null
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
  if (!seed) {
    const field = config?.plotly_asset
    if (field) seed = path.isAbsolute(field) ? field : path.resolve(configDir, field)
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

function findRounds(projectDir, only) {
  const sweepRoot = path.join(projectDir, 'sweep')
  const rounds = []
  let names
  try { names = fs.readdirSync(sweepRoot) } catch { return rounds }
  names.sort()
  for (const name of names) {
    if (!/^Round\d+$/.test(name)) continue
    if (only && name !== only) continue
    const top = path.join(sweepRoot, name, 'top')
    const resultsPath = path.join(top, 'results.json')
    if (isFileLoose(resultsPath)) rounds.push({ name, top, resultsPath })
  }
  return rounds
}

function buildRoundData(name, top, resultsPath) {
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
    throw new Error(`no round with a results.json found (${path.join(project, 'sweep', 'Round*')})`)
  }
  const outDir = path.join(project, 'Analysis')
  const dataDir = path.join(outDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const entries = []
  let pdkName = ''
  let simulatorName = ''
  for (const r of rounds) {
    const rd = buildRoundData(r.name, r.top, r.resultsPath)
    pdkName = pdkName || rd.pdk
    simulatorName = simulatorName || rd.simulator
    const jsName = `Round${r.name.replace('Round', '')}.js`
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
  html += BODY_TOP
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
        + 'the simulator label comes from the run\'s .simulator marker or the template extension). When '
        + 'report=true, also regenerates the sweep-result HTML report (interactive Plotly metric charts, '
        + 'summary cards, per-point table; works from file:// and inside the WebUI) at '
        + '<project>/Analysis/<project>_report.html — the project root defaults to the sweep/RoundN/top '
        + 'structure of run_dir. With task=<id or exact name>, the generated report is also registered into '
        + 'that HarnessAMS task\'s dashboard (nearest .harnessams/tasks.json above the project); a '
        + 'registration failure never fails the analysis.',
      parameters: {
        run_dir: { type: 'string', required: true, description: 'Run directory (sweep/RoundN/top) holding NN/point_meta.json' },
        out: { type: 'string', description: 'Output results.json path (default: <run_dir>/results.json; must stay at the default when report=true)' },
        simulator: { type: 'string', enum: ['spectre'], description: 'Override the detected simulator label' },
        report: { type: 'boolean', description: 'Also generate the HTML dashboard for the project (default false)' },
        round: { type: 'string', description: 'report only: round name to render (e.g. Round1; default: all Round*)' },
        task: { type: 'string', description: 'report only: register the generated report into this task\'s dashboard '
          + '(HarnessAMS sidebar): task id or exact task name. Omit to only generate the report.' },
        project_dir: { type: 'string', description: 'report only: project root containing sweep/Round*/top '
          + '(default: derived from run_dir\'s sweep/RoundN/top structure)' },
      },
      async execute(args) {
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
          report = genSweepReport(project, { round: args.round ? String(args.round) : null })
        } catch (e) {
          throw new Error(`report generation failed: ${e.message}`)
        }
        result.output = (collect.stdout.trim() + '\n' + report.stdout.trim()).trim()
        result.report_dir = path.join(project, 'Analysis')
        result.report_path = report.reportPath
        if (args.task) {
          // Optional injection: the report is already on disk, so a failure here
          // is reported, never thrown — the caller can retry with a fixed target.
          const found = findTasksStore(project)
          if (!found) {
            result.registered = false
            result.register_error = `no HarnessAMS task store (.harnessams/tasks.json) found above ${project} — create a task in the HarnessAMS task sidebar first`
          } else {
            const r = registerReportIntoTask(found.storeDir, args.task, report.reportPath)
            if (r.error) { result.registered = false; result.register_error = r.error }
            else { result.registered = true; result.task = r.task; result.report = r.report }
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
