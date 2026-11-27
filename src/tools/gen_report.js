// gen_sweep_report (D-008, 2026-11-21; underscore name 2026-11-23) and
// register_report (D-003, 2026-11-26). The renderer is a pure report drawer:
// raw-data processing is the MODEL's job (remote analysis by default; only
// compact results are pulled back), so it consumes a model-written spec JSON
// (points/curves inline or via {"$file"} references) and renders the sweep
// dashboard in the DESIGN FOLDER (D-008, 2026-11-25: <project>/<design>/ holds
// the report HTML, its data JS in SimResults/<report name>/ — one directory
// per report — and Figs/). Registration is its own concern since D-003:
// gen_sweep_report auto-registers into the CALLING session's dashboard unless
// register: false, and register_report attaches ANY existing local HTML (not
// only this renderer's output) into the calling session's dashboard — both
// share the identity anchor (callerAnchor) and registerReportIntoSession
// below. Chart PNGs go into <design>/Figs/ ONLY when that session's "Report
// figures" option is on (HarnessAMS session panel, default off — headless
// jsdom+plotly+resvg, fail-open). Project anchoring (D-008): the OUTPUT root
// comes from the spec (spec.project_dir, or the spec sitting in a SimResults/
// directory — its parent is the design folder); the CONFIG root (sessions
// store, plotly source) comes from the calling session's project — no
// walk-up from paths.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDir } from '../py.js'
import { readJsonBom, chartSpecs, curveMids, genReportFromSpec } from '../report_render.js'
import { exportFigs } from '../figs_export.js'
import { resolveProjectTool } from '../server/project.js'
import { effectiveSessionId } from '../subagent.js'

// --- report registration target: the calling session's HarnessAMS dashboard.
// Since the task retirement (2026-11-19, D-003) each DSH session carries its
// own report list in <workspace>/.harnessams/sessions.json; the calling session
// is identified EXACTLY through the tool execution context (exec.agent.id IS
// the SessionId — probe-verified, see probe-taskmerge-20261119; a delegated
// subagent resolves to its topmost user-visible ancestor via src/subagent.js,
// so the store never gains child-id entries). Two consumers share this anchor:
// gen_sweep_report's auto-registration (default on, register: false opts out)
// and the register_report tool (any existing local HTML). server/project.js
// owns the store and its validation; this side only merges one report into one
// session entry through writeSessionConfig (atomic, defensive).

const SESSIONS_DIR = '.harnessams'
const MAX_REPORTS = 32 // same cap as the sidebar's writer (server/project.js)
const MAX_NAME = 80 // same cap as the store's writer (server/project.js)

// The shared caller anchor: resolves the calling session's identity and the
// CONFIG root (D-002 — the session's project, or an explicit project argument;
// never a path walk-up). A delegated subagent resolves to its topmost
// user-visible ancestor; a subagent whose lineage did not resolve degrades to
// NO identity (sid null, subagentUnresolved true) so the store never gains a
// child-id entry. Returns { sid, configRoot, subagentUnresolved } or
// { anchorError } (the caller decides whether to throw or to report).
function callerAnchor(ctx, exec, projectArg) {
  const rawAgentId = typeof exec?.agent?.id === 'string' && exec.agent.id ? exec.agent.id : null
  const effective = effectiveSessionId(ctx, exec?.agent)
  const subagentUnresolved = effective !== null && effective === rawAgentId
    && exec?.agent?.session?.header?.origin === 'subagent'
  const sid = subagentUnresolved ? null : effective
  const p = sid || projectArg
    ? resolveProjectTool(ctx.workspaceRegistry, sid, projectArg)
    : null
  if (p?.error) return { anchorError: p.error }
  return { sid, configRoot: p?.project?.path ?? null, subagentUnresolved }
}

// Sessions store at a KNOWN project root (D-008: the config root comes from
// the calling session — no ancestor walk-up). Returns { storeDir } always
// (readSessionConfigs fails open on a missing store).
export function sessionsStoreAt(projectRoot) {
  return { storeDir: path.join(path.resolve(String(projectRoot ?? '.')), SESSIONS_DIR) }
}

// Append (or reuse) `reportPath` in session `sessionId`'s entry and select it
// on that session's dashboard. Creates the entry when absent; preserves the
// entry's display/check_params; a `name` option overrides the entry's display
// name (missing entry fields — id, added_at — are filled here from the caller
// side). Returns { session, report, warnings? } or { error } — never throws,
// never clobbers sibling sessions (single-session merge write). `warnings`
// carries the store's read-side skip notices (D-003) so tool results can
// surface them.
export async function registerReportIntoSession(storeDir, sessionId, reportPath, { name } = {}) {
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
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : path.basename(abs)
    report = { id: 'r-' + randomUUID().slice(0, 8), name: label, path: abs, added_at: new Date().toISOString() }
    reports.push(report)
  }
  const state = { ...entry, reports, dashboard_selected: report.id }
  const w = await writeSessionConfig(workspacePath, sessionId, state)
  if (w.error) return { error: w.error }
  return {
    session: sessionId,
    report,
    ...(store.warnings && store.warnings.length ? { warnings: store.warnings } : {}),
  }
}

// The calling session's "Report figures" option — the PNG export gate. It
// lives on the SESSION (the option sits in the HarnessAMS session panel, above
// the dashboard), not in the project settings. No session entry, no store or
// a flag that is not exactly true all mean off.
export async function sessionReportFigs(storeDir, sessionId) {
  const { readSessionConfigs } = await import('../server/project.js')
  const store = await readSessionConfigs(path.dirname(path.resolve(storeDir)))
  return store.sessions[sessionId]?.report_figs === true
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

// OUTPUT root (the design folder, D-008): spec.project_dir > the spec file's
// parent's parent when the spec sits directly in <design>/SimResults/ > error.
// Purely local — no project-root verification, no walk-up.
function deriveProjectRoot(specFile, specObj) {
  if (specObj.project_dir) return path.resolve(String(specObj.project_dir))
  const abs = path.resolve(specFile)
  if (path.basename(path.dirname(abs)) === 'SimResults') return path.dirname(path.dirname(abs))
  return null
}

export function genReportTools(ctx) {
  return [
    {
      name: 'gen_sweep_report',
      description: 'Render the sweep-result HTML report from a model-written spec JSON and register it into the '
        + 'CALLING session\'s HarnessAMS dashboard. This tool ONLY draws: raw-data processing (psf parsing, metric '
        + 'extraction, dB conversion, batch aggregation) is yours — run it remotely by default and pull back only '
        + 'compact results. Spec: {project_dir?, title?, conclusions?, out?, meta?, rounds:[{id, title?, points, '
        + 'curves?, note?}]}; points/curves are inline arrays or {"$file": path} references resolved against the '
        + 'output root (write big curve arrays to files, keep the spec small); each point is {index?, label?, '
        + 'params:{}, metrics:{}, status?}; curves is {x_signal, signals:[{name, dB?}], points:[{index, label?, '
        + 'x:[], y:{}}]}. Pitfalls: "out" is the LITERAL report filename — bare, ends with .html, no directories '
        + '(write "MyReport.html", not "MyReport"; the report lands at <design>/<out>, its data JS in '
        + 'SimResults/<out minus .html>/); "meta" must be a plain string (any other type is silently dropped). '
        + 'project_dir defaults to the spec location\'s parent when the spec sits in '
        + '<project>/SimResults/. Outputs: report at <project>/<out>, its data JS in SimResults/<report name>/ '
        + '(reports are isolated — give every distinct report its own "out" name; the same name overwrites); '
        + 'chart PNGs into Figs/ ONLY when the calling session\'s "Report figures" option is on (HarnessAMS session '
        + 'panel, default off — disk; headless render, skipped with a visible reason when unavailable); conclusions rendered '
        + 'as a text card (paragraphs, **bold**, `code`, "- " lists). Curve charts only (one trace per '
        + 'parameter combination — scalar metrics render in the table, not as charts) and the in-report batch '
        + 'dropdown lists rounds newest-first; charts and table cross-highlight. Registration into the calling '
        + 'session\'s dashboard is on by default — pass register: false to render without registering and '
        + 'attach the file later with register_report (which also takes HTML this tool did not generate).',
      parameters: {
        spec: { type: 'string', required: true, description: 'Path to the report spec JSON (see description for the schema)' },
        project: { type: 'string', description: 'Optional explicit workspace path (default: the calling session\'s workspace)' },
        register: { type: 'boolean', description: 'Set false to render WITHOUT registering into the calling session\'s dashboard (attach it later with register_report, e.g. from a different session context)' },
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
        // OUTPUT root = the design folder (spec-anchored, local rule); CONFIG
        // root = the calling session's project (D-008: the sessions store, the
        // plotly source, and the registration all resolve there — no walk-up).
        // A delegated subagent anchors on its topmost user-visible ancestor
        // (src/subagent.js): its reports land in the user session's entry. A
        // subagent whose lineage did not resolve degrades to NO session
        // identity (the report still renders, registration is skipped with a
        // reason) instead of throwing at the anchor — the store never gains a
        // child-id entry. The shared callerAnchor also serves register_report.
        const project = deriveProjectRoot(specFile, spec)
        if (!project) {
          throw new Error('cannot determine the output root (the design folder) — set project_dir in the spec, or place the spec '
            + 'directly inside <design>/SimResults/')
        }
        const anchor = callerAnchor(ctx, exec, args.project)
        if (anchor.anchorError) throw new Error(anchor.anchorError)
        const { sid, configRoot, subagentUnresolved } = anchor
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
        const gen = genReportFromSpec(project, prepared, { configRoot })

        // The calling session (identity = the topmost user-visible session —
        // exec.agent.id itself, or a subagent's resolved ancestor) and its
        // store: the PNG gate and the registration both key off them. No
        // session-resolved project → no store lookup (the report still
        // renders; the plotly chain falls to the CDN after the route step and
        // the never-seeded project copy).
        const found = configRoot ? sessionsStoreAt(configRoot) : null

        // PNG export is OPT-IN per session: the "Report figures" option of the
        // calling session in the HarnessAMS session panel (default off —
        // continuously saved chart images consume significant disk). When
        // enabled it stays fail-open: a missing renderer never fails the report.
        const figsOn = found ? await sessionReportFigs(found.storeDir, sid) : false
        const figs = figsOn
          ? await exportFigs({
              rounds: roundData,
              plotlyFile: gen.plotlyLocal,
              figsDir: path.join(project, 'Figs'),
            })
          : { figs: [], error: 'disabled: turn on "Report figures" in the HarnessAMS session panel (above the dashboard) to export PNGs (they consume disk)' }
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
        // the topmost user-visible session; D-003), with an opt-out: register:
        // false leaves the file unattached — the model then calls register_report
        // itself (any session context, external HTML included). The report is
        // already on disk, so a failure here is reported, never thrown. The
        // store stays keyed by USER-VISIBLE sessions only.
        if (args.register === false) {
          result.registered = false
          result.register_note = 'skipped: register=false — attach it with register_report {report_path} '
            + 'when (and from whichever session context) you want it on a dashboard'
        } else if (subagentUnresolved) {
          result.registered = false
          result.register_error = 'delegated subagent identity did not resolve to a user-visible session — report generated at '
            + result.report_path + ' but not registered (the parent session re-runs gen_sweep_report, or add it in the sidebar dashboard)'
        } else if (!sid) {
          result.registered = false
          result.register_error = 'no session identity in the tool execution context — report generated at '
            + result.report_path + ' but not registered (add it in the HarnessAMS sidebar dashboard)'
        } else if (!found) {
          result.registered = false
          result.register_error = 'no project resolved for the calling session — report generated at '
            + result.report_path + ' but not registered (open the HarnessAMS sidebar in this workspace once first)'
        } else {
          const r = await registerReportIntoSession(found.storeDir, sid, gen.reportPath)
          if (r.error) { result.registered = false; result.register_error = r.error }
          else {
            result.registered = true
            result.session = r.session
            result.report = r.report
            if (r.warnings?.length) result.store_warnings = r.warnings
          }
        }
        return result
      },
    },
    {
      name: 'register_report',
      description: 'Register an EXISTING local HTML report file into the CALLING session\'s HarnessAMS '
        + 'dashboard. Use it for reports gen_sweep_report did NOT generate (hand-written or third-party '
        + 'HTML), or to attach a report later after generating it with register: false. Everything else '
        + 'is filled from the caller: the session entry key (a delegated subagent resolves to its '
        + 'topmost user-visible ancestor, src/subagent.js D-003), the store location (the calling '
        + 'session\'s project, or an explicit project argument), and any missing entry fields (id, '
        + 'added_at, and the display name defaulting to the file\'s basename — pass name to override). '
        + 'Pitfalls: report_path must name an existing regular file ending in .html/.htm (absolute, or '
        + 'relative to the current working directory); registering the same path twice reuses the '
        + 'entry (idempotent); a session holds at most 32 reports; files not produced by '
        + 'gen_sweep_report get no plotly routing — their <script src> tags load exactly what they '
        + 'name (offline viewing needs a self-contained file or its own local script copy).',
      parameters: {
        report_path: { type: 'string', required: true, description: 'Path to the report HTML file (absolute, or relative to the current working directory)' },
        name: { type: 'string', description: 'Optional display name in the dashboard list (default: the file\'s basename)' },
        project: { type: 'string', description: 'Optional explicit workspace path (default: the calling session\'s workspace)' },
      },
      async execute(args, exec) {
        if (typeof args.report_path !== 'string' || !args.report_path.trim()) {
          throw new Error('report_path is required (absolute, or relative to the current working directory)')
        }
        const abs = path.resolve(args.report_path)
        let st = null
        try { st = fs.statSync(abs) } catch { throw new Error(`report file not found: ${abs}`) }
        if (!st.isFile()) throw new Error(`report path is not a regular file: ${abs}`)
        if (!/\.html?$/i.test(abs)) throw new Error(`report path must end in .html (or .htm): ${abs}`)
        // Identity strictly from the caller (D-003: a delegated subagent anchors
        // on its topmost user-visible ancestor; there is deliberately NO
        // session_id override — the store stays keyed by user-visible sessions).
        // Unlike gen_sweep_report there is no on-disk artifact to salvage, so
        // every failure below THROWS.
        const anchor = callerAnchor(ctx, exec, args.project)
        if (anchor.anchorError) throw new Error(anchor.anchorError)
        const { sid, configRoot, subagentUnresolved } = anchor
        if (subagentUnresolved) {
          throw new Error('delegated subagent identity did not resolve to a user-visible session — '
            + 'call register_report from the parent session, or add the report in the HarnessAMS sidebar dashboard')
        }
        if (!sid) {
          throw new Error('no session identity in the tool execution context — cannot key the registration '
            + '(add the report in the HarnessAMS sidebar dashboard)')
        }
        if (!configRoot) {
          throw new Error('no project resolved for the calling session — open the HarnessAMS sidebar in '
            + 'this workspace once first, or pass an explicit project')
        }
        const r = await registerReportIntoSession(sessionsStoreAt(configRoot).storeDir, sid, abs, { name: args.name })
        if (r.error) throw new Error(r.error)
        return {
          ok: true,
          output: `[register] ${abs} -> session ${sid}`,
          registered: true,
          session: r.session,
          report: r.report,
          ...(r.warnings?.length ? { store_warnings: r.warnings } : {}),
        }
      },
    },
  ]
}
