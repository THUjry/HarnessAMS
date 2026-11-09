// Generic analysis / ops tools (simulator-agnostic, moved from the SmartAnaSim
// plugin 2026-11-01): they read the data contract written by either sweep worker
// (point_meta.json / sweep_progress.json) and never spawn a simulator.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cliError, readJsonIfExists, resolveDir, runPython } from '../py.js'
import { listTrash, purgeEntry, restoreEntry, trashPaths } from '../trash.js'

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

export function sharedTools() {
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
        const collectArgv = ['--work-dir', runDir]
        if (args.out) collectArgv.push('--out', resultsPath)
        if (args.simulator) collectArgv.push('--simulator', String(args.simulator))
        const collect = await runPython('common/common_collect_results.py', collectArgv, 180_000)
          .catch((e) => { throw new Error(`collect failed: ${cliError(e)}`) })
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
        const reportArgv = ['--project', project]
        if (args.round) reportArgv.push('--round', String(args.round))
        const reportRun = await runPython('common/common_gen_sweep_report.py', reportArgv, 300_000)
          .catch((e) => { throw new Error(`report generation failed: ${cliError(e)}`) })
        // The script's final stdout line is "[report] N round(s) -> <abs path>";
        // parse it, fall back to the default naming rule if the format drifts.
        const m = /\[report\] \d+ round\(s\) -> (.+)\s*$/.exec(reportRun.stdout.trim())
        const reportPath = m?.[1] ?? path.join(project, 'Analysis', path.basename(project) + '_report.html')
        result.output = (collect.stdout.trim() + '\n' + reportRun.stdout.trim()).trim()
        result.report_dir = path.join(project, 'Analysis')
        result.report_path = reportPath
        if (args.task) {
          // Optional injection: the report is already on disk, so a failure here
          // is reported, never thrown — the caller can retry with a fixed target.
          const found = findTasksStore(project)
          if (!found) {
            result.registered = false
            result.register_error = `no HarnessAMS task store (.harnessams/tasks.json) found above ${project} — create a task in the HarnessAMS task sidebar first`
          } else {
            const r = registerReportIntoTask(found.storeDir, args.task, reportPath)
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
    {
      name: 'safe_trash',
      description: 'Workspace trash (safety by default): move paths into <workspace>/.trash instead of deleting, '
        + 'then list, restore, or explicitly purge an entry (restore/purge take an entry name exactly as list '
        + 'reports it; names are fenced inside the trash directory).',
      parameters: {
        action: { type: 'string', required: true, enum: ['trash', 'list', 'restore', 'purge'],
          description: 'trash | list | restore | purge' },
        path: { type: 'string', description: 'trash: path to move; restore/purge: trash entry name (from list)' },
        dest: { type: 'string', description: 'restore destination directory' },
      },
      async execute(args) {
        if (args.action === 'list') {
          const entries = listTrash()
          return { ok: true, entries, output: JSON.stringify(entries, null, 2) }
        }
        if (args.action === 'restore') {
          if (!args.path) return { ok: false, error: 'restore requires path=<trash entry name from list>' }
          return { ok: true, output: restoreEntry(String(args.path), args.dest ? String(args.dest) : '.') }
        }
        if (args.action === 'purge') {
          if (!args.path) return { ok: false, error: 'purge requires path=<trash entry name from list>' }
          return { ok: true, output: purgeEntry(String(args.path)) }
        }
        if (args.action === 'trash') {
          if (!args.path) return { ok: false, error: 'trash requires path=<file or directory>' }
          return { ok: true, output: trashPaths([String(args.path)]).join('\n') }
        }
        return { ok: false, error: `unknown action: ${args.action}` }
      },
    },
  ]
}
