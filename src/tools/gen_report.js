// gen_sweep_report (D-006, 2026-11-21; underscore name 2026-11-23): the ONLY
// analysis-surface tool — a pure report renderer. Raw-data processing is the
// MODEL's job (remote analysis by default; only compact results are pulled
// back), so this tool consumes a model-written spec JSON (points/curves inline
// or via {"$file"} references), renders the sweep dashboard at the project
// root with data JS in SimResults/, and registers the report into the CALLING
// session's dashboard. Chart PNGs go into Figs/ ONLY when the workspace
// setting report_figs is on (Overview toggle, default off — 2026-11-24;
// headless jsdom+plotly+resvg, fail-open when enabled).
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDir } from '../py.js'
import { readJsonBom, chartSpecs, curveMids, genReportFromSpec, findProjectConfigFrom } from '../report_render.js'
import { exportFigs } from '../figs_export.js'

// --- report auto-registration target: the calling session's HarnessAMS ----
// dashboard. Since the task retirement (2026-11-19, D-005) each DSH session
// carries its own report list in <workspace>/.harnessams/sessions.json; the
// calling session is identified EXACTLY through the tool execution context
// (exec.agent.id IS the SessionId — probe-verified, see probe-taskmerge-20261119).
// server/project.js owns the store and its validation; this side only merges one
// report into one session entry through writeSessionConfig (atomic, defensive).

const SESSIONS_DIR = '.harnessams'
const MAX_REPORTS = 32 // same cap as the sidebar's writer (server/project.js)

// Walk up from startDir (max 8 levels) to the nearest ancestor holding a
// .harnessams/ store directory. Returns { storeDir } or null.
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

// --- spec loading -----------------------------------------------------------
const SAFE_ID_RE = /^[\w][\w.-]*$/

// points / curves may be inline or {"$file": "<path relative to the project
// root, or absolute>"}. Returns the resolved value; throws actionable errors.
function resolveRef(value, what, projectRoot) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$file === 'string') {
    const p = path.isAbsolute(value.$file) ? value.$file : path.join(projectRoot, value.$file)
    if (!fs.existsSync(p)) {
      throw new Error(`${what}: $file not found: ${p} (paths resolve against the project root ${projectRoot})`)
    }
    try {
      return readJsonBom(p)
    } catch (e) {
      throw new Error(`${what}: $file is not valid JSON: ${p} (${e.message})`)
    }
  }
  return value
}

function labelOfPoint(p) {
  if (p && typeof p.label === 'string' && p.label) return p.label
  if (p && p.params && typeof p.params === 'object') {
    return Object.keys(p.params).map((k) => `${k}=${p.params[k] ?? '-'}`).join(', ')
  }
  return String(p ? p.index : '-')
}

// Normalize + derive everything the renderer needs from one spec round.
// Column names are the UNION across all points (the 2026-11-21 empty-table
// bug took them from points[0] only — a failed first point blanked columns).
function buildRoundData(specRound, projectRoot, at) {
  const id = String(specRound.id ?? '')
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`rounds[${at}].id "${id}" is not filename-safe (use e.g. Sim0_20260805_batch1)`)
  }
  const rawPoints = resolveRef(specRound.points, `rounds[${at}].points`, projectRoot)
  if (!Array.isArray(rawPoints) || !rawPoints.length) {
    throw new Error(`rounds[${at}].points must be a non-empty array (inline or {"$file": ...})`)
  }
  const points = rawPoints.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`rounds[${at}].points[${i}] is not an object`)
    return {
      index: typeof p.index === 'number' ? p.index : i,
      label: labelOfPoint(p),
      params: (p.params && typeof p.params === 'object') ? p.params : {},
      metrics: (p.metrics && typeof p.metrics === 'object') ? p.metrics : {},
      status: typeof p.status === 'string' ? p.status : 'success',
      elapsed_sec: typeof p.elapsed_sec === 'number' ? p.elapsed_sec : null,
    }
  })
  const paramNames = [...new Set(points.flatMap((p) => Object.keys(p.params)))]
  const metricNames = [...new Set(points.flatMap((p) => Object.keys(p.metrics)))]
  const ok = points.filter((p) => p.status === 'success' || p.status === 'partial')
  const summary = {}
  for (const k of metricNames) {
    const vals = ok.map((p) => p.metrics[k])
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (!vals.length) continue
    summary[k] = { min: Math.min(...vals), max: Math.max(...vals), mean: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }
  }
  let curves = specRound.curves === undefined ? null
    : resolveRef(specRound.curves, `rounds[${at}].curves`, projectRoot)
  if (curves) {
    if (!curves.x_signal || !Array.isArray(curves.signals) || !Array.isArray(curves.points)) {
      throw new Error(`rounds[${at}].curves must be {x_signal, signals:[{name, dB?}], points:[{index, label?, x:[], y:{}}]} (inline or {"$file": ...})`)
    }
    curves.points = curves.points.map((p, i) => ({
      index: typeof p.index === 'number' ? p.index : i,
      label: (p && typeof p.label === 'string' && p.label) || `curve ${i}`,
      x: Array.isArray(p.x) ? p.x : [],
      y: (p.y && typeof p.y === 'object') ? p.y : {},
    }))
  }
  const rd = {
    round: id,
    title: typeof specRound.title === 'string' && specRound.title ? specRound.title : id,
    param_names: paramNames,
    metric_names: metricNames,
    n_points: points.length,
    n_success: points.filter((p) => p.status === 'success').length,
    n_partial: points.filter((p) => p.status === 'partial').length,
    n_failed: points.filter((p) => p.status !== 'success' && p.status !== 'partial').length,
    summary,
    points,
    ...(curves ? { curves } : {}),
    ...(typeof specRound.note === 'string' && specRound.note ? { note: specRound.note } : {}),
    ...(curves ? { curve_mids: curveMids({ curves }) || undefined, curve_x_label: curves.x_signal } : {}),
  }
  if (rd.curve_mids === undefined) delete rd.curve_mids
  rd.charts = chartSpecs(rd)
  return rd
}

// Project root: spec.project_dir > the spec file's parent's parent when the
// spec sits directly in <project>/SimResults/ > error.
function deriveProjectRoot(specFile, specObj) {
  if (specObj.project_dir) return path.resolve(String(specObj.project_dir))
  const abs = path.resolve(specFile)
  if (path.basename(path.dirname(abs)) === 'SimResults') return path.dirname(path.dirname(abs))
  return null
}

export function genReportTools() {
  return [
    {
      name: 'gen_sweep_report',
      description: 'Render the sweep-result HTML report from a model-written spec JSON and register it into the '
        + 'CALLING session\'s HarnessAMS dashboard. This tool ONLY draws: raw-data processing (psf parsing, metric '
        + 'extraction, dB conversion, batch aggregation) is yours — run it remotely by default and pull back only '
        + 'compact results. Spec: {project_dir?, title?, conclusions?, out?, meta?, rounds:[{id, title?, points, '
        + 'curves?, note?}]}; points/curves are inline arrays or {"$file": path} references resolved against the '
        + 'project root (write big curve arrays to files, keep the spec small); each point is {index?, label?, '
        + 'params:{}, metrics:{}, status?}; curves is {x_signal, signals:[{name, dB?}], points:[{index, label?, '
        + 'x:[], y:{}}]}. project_dir defaults to the spec location\'s parent when the spec sits in '
        + '<project>/SimResults/. Outputs: report at <project>/<name>_report.html (data JS in SimResults/); '
        + 'chart PNGs into Figs/ ONLY when the workspace setting report_figs is on (Overview toggle, default '
        + 'off — disk; headless render, skipped with a visible reason when unavailable); conclusions rendered '
        + 'as a text card (paragraphs, **bold**, `code`, "- " lists). Curve charts only (one trace per '
        + 'parameter combination — scalar metrics render in the table, not as charts) and the in-report batch '
        + 'dropdown lists rounds newest-first; charts and table cross-highlight.',
      parameters: {
        spec: { type: 'string', required: true, description: 'Path to the report spec JSON (see description for the schema)' },
      },
      async execute(args, exec) {
        const specFile = resolveDir(args.spec)
        if (!fs.existsSync(specFile)) throw new Error(`spec file not found: ${specFile}`)
        let spec
        try {
          spec = readJsonBom(specFile)
        } catch (e) {
          throw new Error(`spec is not valid JSON: ${specFile} (${e.message})`)
        }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
          throw new Error(`spec must be a JSON object: ${specFile}`)
        }
        const project = deriveProjectRoot(specFile, spec)
        if (!project) {
          throw new Error('cannot determine the project root — set project_dir in the spec, or place the spec '
            + 'directly inside <project>/SimResults/')
        }
        if (!Array.isArray(spec.rounds) || !spec.rounds.length) {
          throw new Error('spec.rounds must be a non-empty array of {id, points, curves?}')
        }
        let outName = null
        if (spec.out !== undefined) {
          outName = String(spec.out).replace(/[\\/]+$/, '')
          if (outName !== path.basename(outName) || !/\.html$/i.test(outName)) {
            throw new Error(`spec.out must be a bare .html filename (no directories): ${spec.out}`)
          }
        }
        const roundData = spec.rounds.map((r, i) => {
          if (!r || typeof r !== 'object') throw new Error(`rounds[${i}] is not an object`)
          return buildRoundData(r, project, i)
        })
        const prepared = {
          title: typeof spec.title === 'string' && spec.title ? spec.title : null,
          metaLine: typeof spec.meta === 'string' && spec.meta ? spec.meta : null,
          conclusions: typeof spec.conclusions === 'string' ? spec.conclusions : null,
          outName,
          rounds: roundData,
        }
        const gen = genReportFromSpec(project, prepared)

        // PNG export is OPT-IN via the workspace setting report_figs (the
        // Overview toggle; default off since 2026-11-24 — continuously saved
        // chart images consume significant disk). When enabled it stays
        // fail-open: a missing renderer never fails the report.
        const figsOn = findProjectConfigFrom(project)?.settings?.report_figs === true
        const figs = figsOn
          ? await exportFigs({
              rounds: roundData,
              plotlyFile: gen.plotlyLocal,
              figsDir: path.join(project, 'Figs'),
            })
          : { figs: [], error: 'disabled: enable "Report figures" in the Overview settings to export PNGs (they consume disk)' }
        const lines = [`[report] ${roundData.length} round(s) -> ${gen.reportPath}`]
        lines.push(figs.figs.length
          ? `[figs] ${figs.figs.length} png -> ${path.join(project, 'Figs')}`
            + (figs.error ? ` (${figs.error})` : '')
          : `[figs] skipped${figs.error ? `: ${figs.error}` : ' (no charts)'}`)

        const result = {
          ok: true,
          output: lines.join('\n'),
          report_path: gen.reportPath,
          report_dir: project,
          rounds: gen.entries.map((e) => ({ id: e.id, n_points: e.n_points })),
          ...(figs.figs.length ? { figs: figs.figs } : {}),
          ...(figs.error ? { figs_note: figs.error } : {}),
        }

        // Auto-registration into the CALLING session's dashboard (identity =
        // exec.agent.id, which IS the SessionId — D-005). The report is already
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
            const r = await registerReportIntoSession(found.storeDir, sid, gen.reportPath)
            if (r.error) { result.registered = false; result.register_error = r.error }
            else { result.registered = true; result.session = r.session; result.report = r.report }
          }
        }
        return result
      },
    },
  ]
}
