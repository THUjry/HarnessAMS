// Headless per-chart PNG export (D-012, 2026-11-21). Renders the SAME chart
// specs the report page embeds (report_render.chartSpecs) inside a jsdom
// window with the bundled plotly.min.js, exports each as SVG via
// Plotly.toImage, then rasterizes with @resvg/resvg-js. Spike-verified
// (harnessams-workspace/spike-png-20261121, 2026-11-21) hard facts:
//   - jsdom's window.eval is the HOST eval — page code must run through
//     getInternalVMContext() + vm.runInContext (needs runScripts:'outside-only');
//   - plotly's UMD probes `self` (jsdom gap) and URL.createObjectURL at load;
//   - toImage(format:'png') NEVER SETTLES in jsdom (SVG->Image decode is
//     unsupported) — only the SVG path works, and its data URL is
//     URL-ENCODED, not base64;
//   - @napi-rs/canvas provides the 2d context (NAPI prebuilt, no node-gyp).
// Fail-open by design: a missing dependency or a render error skips the PNGs
// and returns a visible reason — the report itself is never at stake.
import fs from 'node:fs'
import path from 'node:path'

const EXPORT_WIDTH = 1280
const CHART_TIMEOUT_MS = 20_000

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

// Decode a plotly toImage data URL (SVG output is URL-encoded; PNG would be
// base64 — kept for symmetry) into the raw SVG string.
function decodeDataUrl(url) {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('unexpected toImage output (not a data URL)')
  if (url.slice(0, comma).includes(';base64')) {
    return Buffer.from(url.slice(comma + 1), 'base64').toString('utf8')
  }
  return decodeURIComponent(url.slice(comma + 1))
}

// One shared page for all charts. Returns { Plotly, document }.
async function makePlotlyPage(plotlyFile) {
  const { JSDOM } = await import('jsdom')
  const vm = await import('node:vm')
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'http://localhost/',
  })
  dom.window.devicePixelRatio = 2
  const pageCtx = dom.getInternalVMContext()
  vm.runInContext('globalThis.self = globalThis;', pageCtx)
  vm.runInContext(
    'if (!URL.createObjectURL) { URL.createObjectURL = function () { return "blob:harnessams" };'
    + ' URL.revokeObjectURL = function () {} }', pageCtx)
  vm.runInContext(fs.readFileSync(plotlyFile, 'utf8'), pageCtx)
  if (!dom.window.Plotly) throw new Error('plotly failed to attach window.Plotly')
  return { Plotly: dom.window.Plotly, document: dom.window.document }
}

// rounds: [{ id, charts: [{ id, title, slug, data, layout }] }]. Writes
// <figsDir>/<round id>_<slug>.png per chart. Never throws: returns
// { figs: [{round, chart, file}], error? }.
export async function exportFigs({ rounds, plotlyFile, figsDir }) {
  const charts = rounds.flatMap((r) => (r.charts || []).map((c) => ({ round: r, chart: c })))
    .filter((x) => x.chart && Array.isArray(x.chart.data))
  if (!charts.length) return { figs: [], error: 'no chart specs to export' }
  if (!plotlyFile || !fs.existsSync(plotlyFile)) {
    return { figs: [], error: `no local plotly.min.js for headless rendering (${plotlyFile || 'none'} — CDN fallback reports skip PNGs)` }
  }
  let deps
  try {
    deps = { page: await makePlotlyPage(plotlyFile), Resvg: (await import('@resvg/resvg-js')).Resvg }
  } catch (e) {
    return { figs: [], error: `headless render unavailable: ${e.message}` }
  }
  const { page, Resvg } = deps
  fs.mkdirSync(figsDir, { recursive: true })
  const figs = []
  const failures = []
  const host = page.document.createElement('div')
  page.document.body.appendChild(host)
  try {
    for (const { round, chart } of charts) {
      const file = path.join(figsDir, `${round.round}_${chart.slug || 'chart'}.png`)
      try {
        // jsdom has no layout: give every chart an explicit pixel width or
        // plotly renders into a 0-wide container.
        const layout = { ...chart.layout, width: EXPORT_WIDTH, height: chart.layout?.height || 480 }
        await withTimeout(page.Plotly.newPlot(host, chart.data, layout, { displayModeBar: false }),
          CHART_TIMEOUT_MS, `newPlot ${chart.id}`)
        const svgUrl = await withTimeout(page.Plotly.toImage(host, { format: 'svg', width: EXPORT_WIDTH, height: layout.height }),
          CHART_TIMEOUT_MS, `toImage ${chart.id}`)
        const svg = decodeDataUrl(svgUrl)
        const resvg = new Resvg(svg, {
          fitTo: { mode: 'width', value: EXPORT_WIDTH },
          font: { loadSystemFonts: true, family: 'Arial' },
          background: chart.layout?.paper_bgcolor || '#fcfcfb',
        })
        fs.writeFileSync(file, resvg.render().asPng())
        figs.push({ round: round.round, chart: chart.title || chart.id, file })
      } catch (e) {
        failures.push(`${chart.id}: ${e.message}`)
      } finally {
        try { page.Plotly.purge(host) } catch { /* purge is best-effort */ }
      }
    }
  } finally {
    host.remove()
  }
  return {
    figs,
    ...(figs.length === 0 && failures.length
      ? { error: `every chart failed headless export — ${failures[0]}` }
      : (failures.length ? { error: `${failures.length} chart(s) skipped (first: ${failures[0]})` } : {})),
  }
}
