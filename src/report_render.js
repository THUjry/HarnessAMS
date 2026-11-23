// Shared sweep-report rendering (D-006, 2026-11-21): the report HTML/data-JS
// templates and the Node-side chart-spec builder. The same chartSpecs() output
// feeds BOTH the browser page (the data JS embeds ready-to-plot {data, layout}
// per chart — the client only calls newPlot and binds interactions) and the
// headless PNG exporter (src/figs_export.js), so a figure and its PNG cannot
// drift apart. Visual language follows the verified AttST0p5dB_ch.html
// dashboard: #f9f9f7 page, #fcfcfb cards, legend-less curve charts with the
// table-swatch color mapping, selection dims other curves (width 4 vs 1,
// opacity 1 vs 0.08), DOM legend grid as the reliable cross-highlight path
// (plotly_click does not fire in the host's embedded browser — 2026-11-21).
import fs from 'node:fs'
import path from 'node:path'

const PLOTLY_CDN = 'https://cdn.plot.ly/plotly-3.0.1.min.js'

// JSON read tolerating a UTF-8 BOM (zh-CN Windows editors add them).
export function readJsonBom(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

// Server-side HTML text escaping: names go into <title>/<h1> text and the
// inline MANIFEST — escaping HTML specials (quotes included) means they can
// neither inject markup nor break out of the inline JS string literal.
export function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// JSON string for INLINE <script> embedding: a literal '</' would terminate
// the script tag, so break it as '<\/' (identity inside a JS string literal).
export function inlineJson(v) {
  return JSON.stringify(v).replaceAll('</', '<\\/')
}

// Model-written conclusions text → HTML card content. Deliberately tiny
// inline formatting only (paragraphs, **bold**, `code`, "- " list items);
// no markdown library (JS single implementation, zero new deps).
export function conclusionsHtml(text) {
  if (!text || typeof text !== 'string') return ''
  const inline = (s) => htmlEscape(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  const blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/)
  const parts = []
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '')
    if (!lines.length) continue
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      parts.push('<ul>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>').join('') + '</ul>')
    } else {
      parts.push('<p>' + lines.map(inline).join('<br>') + '</p>')
    }
  }
  return parts.join('')
}

// HSL blue-to-red gradient — the ONE color authority for swatches and curves.
// Duplicated verbatim in the report's FOOT_JS (client-side legend swatches);
// keep the two in sync.
export function hslColor(i, n) {
  n = n || 1
  return `hsl(${Math.round(240 - 240 * (n <= 1 ? 0.5 : i / (n - 1)))},65%,50%)`
}

// --- chart specs (single source of truth for browser + PNG exporter) --------
// rd comes from buildRoundData(): {points, metric_names, group_by, group_values,
// curves?, note?}. Returns [{id, kind, title, slug, data, layout, indices?}].
// kind 'metric': x = sweep point index; kind 'curve': one trace per parameter
// combination, indices maps trace order -> point index (click mapping).
export function chartSpecs(rd) {
  const specs = []
  const points = rd.points || []
  const byGroup = rd.group_by && rd.group_values && rd.group_values.length > 1
  for (let mi = 0; mi < (rd.metric_names || []).length; mi++) {
    const mk = rd.metric_names[mi]
    const traces = []
    if (byGroup) {
      rd.group_values.forEach((gv, gi) => {
        const pts = points.filter((p) => String((p.params || {})[rd.group_by]) === String(gv))
        traces.push({
          x: pts.map((p) => p.index),
          y: pts.map((p) => (p.metrics && typeof p.metrics[mk] === 'number') ? p.metrics[mk] : null),
          mode: 'lines+markers', name: `${rd.group_by}=${gv === null || gv === undefined || gv === '' ? '-' : String(gv)}`,
          line: { width: 2, color: hslColor(gi, rd.group_values.length) },
          marker: { size: 7, opacity: 0.3, color: hslColor(gi, rd.group_values.length) },
          connectgaps: false, cliponaxis: false,
          hovertemplate: '%{fullData.name}<br>point %{x}<br>' + mk + ': %{y:.4g}<extra></extra>',
        })
      })
    } else {
      traces.push({
        x: points.map((p) => p.index),
        y: points.map((p) => (p.metrics && typeof p.metrics[mk] === 'number') ? p.metrics[mk] : null),
        mode: 'lines+markers', name: mk,
        line: { width: 2, color: 'hsl(210,65%,45%)' }, marker: { size: 7, opacity: 0.3, color: 'hsl(210,65%,45%)' },
        connectgaps: false, cliponaxis: false,
        hovertemplate: '%{fullData.name}<br>point %{x}: %{y:.4g}<extra></extra>',
      })
    }
    const layout = chartLayout(mk, 'sweep point index', byGroup)
    layout.xaxis.dtick = 1
    specs.push({ id: `chart-metric-${mi}`, kind: 'metric', title: mk, slug: slugify(mk), data: traces, layout })
  }
  const curves = rd.curves
  if (curves && Array.isArray(curves.points) && curves.points.length) {
    for (let si = 0; si < (curves.signals || []).length; si++) {
      const sk = curves.signals[si]
      const disp = sk.name + (sk.dB ? ' (dB)' : '')
      const traces = curves.points.map((p, pi) => ({
        x: p.x, y: (p.y && p.y[sk.name]) ? p.y[sk.name] : [],
        mode: 'lines+markers', name: p.label,
        line: { width: 2, color: hslColor(pi, curves.points.length) },
        marker: { size: 7, opacity: 0.3, color: hslColor(pi, curves.points.length), line: { width: 0 } },
        legendgroup: String(p.index), cliponaxis: false, connectgaps: false,
        hovertemplate: `${p.label}<br>${curves.x_signal}: %{x:.4g}<br>${disp}: %{y:.4g}<extra></extra>`,
      }))
      specs.push({
        id: `chart-curve-${si}`, kind: 'curve', title: disp, slug: slugify(sk.name),
        data: traces, layout: chartLayout(disp, curves.x_signal, false),
        indices: curves.points.map((p) => p.index),
      })
    }
  }
  return specs
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chart'
}

function chartLayout(ytitle, xtitle, legend) {
  return {
    title: { text: ytitle, font: { size: 20 } },
    xaxis: { title: { text: xtitle, standoff: 14 }, tickfont: { size: 16 }, showgrid: true,
      gridcolor: '#e8e8e8', zeroline: false, linecolor: '#ccc', linewidth: 1, ticks: 'outside', ticklen: 5 },
    yaxis: { title: { text: ytitle, standoff: 12 }, tickfont: { size: 16 }, gridcolor: '#e8e8e8',
      zeroline: true, zerolinecolor: '#ddd' },
    margin: { t: 48, b: 60, l: 76, r: 40 }, height: 480,
    showlegend: !!legend, hovermode: 'closest', clickmode: 'event',
    hoverlabel: { font: { size: 15 }, bgcolor: '#fff', bordercolor: '#ccc' },
    paper_bgcolor: '#fcfcfb', plot_bgcolor: '#fcfcfb',
    font: { family: 'system-ui, -apple-system, sans-serif', color: '#0b0b0b' },
  }
}

// Mid-curve samples for the info bar: { "<point index>": { x: midX, y:
// {"s21 (dB)": midVal} } } — one scalar per signal per point, so the data JS
// does not need to carry the raw curves twice (traces already embed them).
export function curveMids(rd) {
  const curves = rd.curves
  if (!curves || !Array.isArray(curves.points) || !curves.points.length) return null
  const mids = {}
  for (const p of curves.points) {
    if (!Array.isArray(p.x) || !p.x.length) continue
    const m = Math.floor(p.x.length / 2)
    const y = {}
    for (const sk of curves.signals || []) {
      const arr = p.y && p.y[sk.name]
      y[sk.name + (sk.dB ? ' (dB)' : '')] = Array.isArray(arr) && typeof arr[m] === 'number' ? arr[m] : null
    }
    mids[String(p.index)] = { x: p.x[m], y }
  }
  return mids
}

// --- HTML templates ---------------------------------------------------------
// Placeholders: __TITLE__, __PLOTLY__, __NOW__, __META__, __CONCLUSIONS__,
// __ROUNDS__. Everything is placeholder replacement — no interpolation —
// matching the original generator's style. Raw template preserves regex
// backslashes in FOOT_JS verbatim.

const HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ - sweep report</title>
<script src="__PLOTLY__"></script>
<script>window.Plotly || document.write('<script src="/harnessams/assets/plotly.min.js"><\\/script>');</script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #f9f9f7; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; padding: 36px; display: flex; flex-direction: column; align-items: center; }
.container { max-width: none; width: 100%; }   /* full-width: the selector stays left-anchored on wide screens (user 2026-11-21), the sidebar iframe is unaffected */
h1 { font-size: 32px; font-weight: 600; color: #0b0b0b; margin: 0 0 4px 0; }
.filter-line { font-size: 17px; color: #898781; margin: 0 0 6px 0; }
.hint { font-size: 18px; color: #898781; margin: 0 0 20px 0; }
.conclusions-box { background: #fcfcfb; border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
.conclusions-box h2 { font-size: 20px; font-weight: 600; color: #0b0b0b; margin-bottom: 10px; }
.conclusions-box p { font-size: 17px; color: #0b0b0b; line-height: 1.6; margin: 6px 0; }
.conclusions-box ul { margin: 6px 0 6px 22px; }
.conclusions-box li { font-size: 17px; color: #0b0b0b; line-height: 1.6; }
.conclusions-box code { background: #f0f0ee; border-radius: 4px; padding: 1px 6px; font-family: ui-monospace, Consolas, monospace; font-size: 15px; }
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
<h1>__TITLE__ — sweep report</h1>
<div class="filter-line">Generated __NOW____META__</div>
__CONCLUSIONS__
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

const FOOT_JS = String.raw`
<script>
const MANIFEST = { project: "__TITLE__", rounds: [__ROUNDS__] };
var ROUND_DATA = null;                       // hard rule: var, not const (batch switching re-declares)

var sel = null, clickFired = false, sortCol = null, sortAsc = true;
var PTS = [], N = 0, PARAM_KEYS = [], METRIC_KEYS = [];
var CURVE_DIVS = [];                         // legend-less curve charts (swatch-mapped)
var MIDS = null, X_LABEL = "";               // mid-curve samples for the info bar

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
  PARAM_KEYS = RD.param_names || []; METRIC_KEYS = RD.metric_names || [];
  MIDS = RD.curve_mids || null; X_LABEL = RD.curve_x_label || "";
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

function newChartBox(id) {
  const box = document.createElement("div");
  box.className = "chart-box";
  const div = document.createElement("div");
  div.id = id;
  box.appendChild(div);
  document.getElementById("chart-area").appendChild(box);
  return div;
}

// Charts render from the Node-built specs embedded in ROUND_DATA.charts
// (single source of truth — the PNG exporter plots the very same specs).
function buildCharts(RD) {
  const area = document.getElementById("chart-area");
  area.innerHTML = "";
  CURVE_DIVS = [];
  if (RD.note) {
    const note = document.createElement("p");
    note.className = "filter-line"; note.textContent = RD.note;
    area.appendChild(note);
  }
  const specs = RD.charts || [];
  if (!specs.length) { area.innerHTML += '<p class="hint">No metric or curve data in this batch.</p>'; return; }
  specs.forEach(function (sp) {
    const div = newChartBox(sp.id);
    Plotly.newPlot(div, sp.data, sp.layout, { displayModeBar: false });
    if (sp.kind === "curve") {
      CURVE_DIVS.push(div.id);
      div.on("plotly_click", function (evt) {               // trace order maps to point indices
        clickFired = true;
        if (evt.points && evt.points[0] && sp.indices) { toggle(String(sp.indices[evt.points[0].curveNumber])); }
      });
    } else {
      div.on("plotly_click", function (evt) {               // index-axis charts: x IS the point index
        clickFired = true;
        if (evt.points && evt.points[0]) { toggle(String(evt.points[0].x)); }
      });
    }
    div.on("plotly_deselect", resetAll);
    addBlankDeselect(div);
  });
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
    if (c.kind === "param") return { txt: esc(show(p.params ? p.params[c.key] : null)), cls: "" };  // D-006 fix: params live at p.params, not the point root
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
    if (MIDS) {                              // mid-curve samples (precomputed server-side)
      const cm = MIDS[String(idx)];
      if (cm) {
        for (const k of Object.keys(cm.y || {})) { ms.push(esc(k) + " = " + fmtVal(cm.y[k])); }
        if (cm.x !== undefined && cm.x !== null) { ms.push(esc(X_LABEL || "x mid") + " = " + fmtVal(cm.x)); }
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

// --- plotly asset resolution (unchanged mechanism from the retired -------
// sim_analysis.js) ---------------------------------------------------------
function isFileLoose(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// Walk upward from the report's PROJECT directory for the single project
// config (.harnessams/workspace_config.json), at most 8 levels. Corrupt
// configs are skipped and the walk continues. Only the workspace section
// matters here (plotly_asset).
export function findProjectConfigFrom(startDir, maxLevels = 8) {
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

// Project-level shared Plotly copy at <project_root>/assets/plotly.min.js.
// Seed search: explicit path > project config workspace.plotly_asset > this
// module's ancestors (assets/, src/assets/, installed-sibling layouts). A
// missing or size-stale project copy is (re-)seeded; the report references it
// with a project-relative src. With no local source at all the CDN is the
// fallback. Returns the src AND the absolute project copy path (or null when
// CDN) — the PNG exporter needs the local file.
export function resolvePlotlySrc(forceCdn, outDir, project, plotlyArg) {
  if (forceCdn) return { src: PLOTLY_CDN, localFile: null }
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
    return { src: PLOTLY_CDN, localFile: null }
  }
  const rel = path.relative(outDir, wsAsset)
  if (path.isAbsolute(rel)) {
    // out dir on a different drive than the workspace: no relative route, keep a sibling copy
    fs.copyFileSync(wsAsset, path.join(outDir, 'plotly.min.js'))
    return { src: 'plotly.min.js', localFile: path.join(outDir, 'plotly.min.js') }
  }
  return { src: rel.replace(/\\/g, '/'), localFile: wsAsset }
}

// --- report assembly --------------------------------------------------------
// D-006 layout: data JS at <project>/SimResults/<round id>.js, report HTML at
// the PROJECT ROOT (outName defaults to <project>_report.html). prepared = {
// title, metaLine?, conclusions?, outName?, rounds: [roundData] } where each
// roundData already carries .charts specs. Returns { reportPath, dataDir,
// entries, plotlyLocal }.
export function genReportFromSpec(projectDir, prepared) {
  const project = path.resolve(projectDir)
  const dataDir = path.join(project, 'SimResults')
  fs.mkdirSync(dataDir, { recursive: true })

  const entries = []
  for (const rd of prepared.rounds) {
    // hard rule: data JS is plain utf-8 without BOM, one var line.
    fs.writeFileSync(path.join(dataDir, `${rd.round}.js`), 'var ROUND_DATA = ' + JSON.stringify(rd) + ';', 'utf8')
    entries.push({ id: rd.round, title: rd.title || rd.round, file: `SimResults/${rd.round}.js`, n_points: rd.n_points })
  }

  const projectName = path.basename(project.replace(/[\\/]+$/, ''))
  const title = prepared.title || projectName
  const roundsJs = entries.map((e) => (
    `{id:${inlineJson(e.id)},title:${inlineJson(e.title)},file:${inlineJson(e.file)},n_points:${e.n_points}}`
  )).join(',')
  const plotly = resolvePlotlySrc(false, project, project, null)
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const nowStamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} `
    + `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`
  const concl = conclusionsHtml(prepared.conclusions)
  let html = HEAD
    .replaceAll('__TITLE__', htmlEscape(title))
    .replaceAll('__PLOTLY__', plotly.src)
    .replaceAll('__NOW__', nowStamp)
    .replaceAll('__META__', prepared.metaLine ? ' | ' + htmlEscape(prepared.metaLine) : '')
    .replaceAll('__CONCLUSIONS__', concl
      ? `<div class="conclusions-box"><h2>Conclusions</h2>${concl}</div>`
      : '')
  html += FOOT_JS
    .replaceAll('__TITLE__', htmlEscape(title))
    .replaceAll('__ROUNDS__', roundsJs)
  // hard rule: main HTML is utf-8-sig (BOM prevents single-byte-locale misreads)
  const reportPath = path.join(project, prepared.outName || `${projectName}_report.html`)
  fs.writeFileSync(reportPath, '\ufeff' + html, 'utf8')
  return { reportPath, dataDir, entries, plotlyLocal: plotly.localFile }
}
