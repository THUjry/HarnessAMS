// Generic remote batch channel: submit a worker through LSF (bsub), or launch
// the same worker on a node over ssh DETACHED (scheduler=ssh — the unified
// submit contract: every scheduler is a quick launch that returns a job file
// for batch_poll; only the internals differ, bsub vs nohup vs a local spawn).
// Out-of-cluster both paths upload one run directory plus the suite's worker
// scripts over dsh-ssh; in-cluster the uploads are local copies on the shared
// filesystem and in-cluster LSF submits locally (the channel matrix lives in
// tools/batch.js, the environment ruling in docs/decisions.md D-001). Both
// paths record the same job file for batch_poll.
//
// This layer knows nothing about a simulator: it uploads a run directory plus
// the suite's worker scripts, submits a worker script through bsub, and polls
// the LSF job plus the batch's progress files (a terminal poll pulls the light
// result files straight down — no archive). A simulator-specific flow is only a choice of worker + worker_args
// (for example spectre/spectre_sweep_worker.py --config sweep_config.json ...).
//
// Worker-script source: the batch tools live here but the simulator workers do
// NOT — they ship with the SmartAnaSim plugin. The upload tree / worker lookup
// root is the project's workspace_config.json workspace.sim_scripts_dir
// (normally the SmartAnaSim scripts/ directory; the project root comes from the
// calling session or an explicit project argument — D-002, no path walk-up), so
// cross-package npm resolution is never required (dev-mount loads plugins by
// absolute path). HARNESSAMS_SIM_SCRIPTS_DIR overrides discovery (tests, custom
// layouts). The tree uploads as a unit with its relative layout so any worker
// and its shared modules resolve remotely.
import fs from 'node:fs'
import path from 'node:path'
import { resolveScriptsSource } from './settings.js'
import { listPyTree, listAssets } from './scriptStage.js'
import { shq } from '../channel/remote.js'
import { normalizeRemoteRoot, sanitizeRel } from '../lib/remotepath.js'
import { atomicWriteSync } from '../lib/io.js'

// Worker scripts root (see the header comment). `projectRoot` is the
// session-resolved project root (D-002: no ancestor walk-up from a run
// directory — the caller anchored the project through resolveProjectTool).
// Resolution core is settings.resolveScriptsSource (the single
// implementation, shared with the lazy healer); this side adds the existence
// check + guidance — a wrong root would upload a partial tree whose remote
// imports break, so failing early beats a confusing remote traceback.
export function simScriptsDir(projectRoot = process.cwd()) {
  const dir = resolveScriptsSource(projectRoot)
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return path.resolve(dir)
  const override = process.env.HARNESSAMS_SIM_SCRIPTS_DIR
  throw new Error(override
    ? `HARNESSAMS_SIM_SCRIPTS_DIR is not a directory: ${override}`
    : `no worker scripts root: ${dir} does not exist — fix the worker scripts root in the `
      + 'project settings table (the Overview settings UI or the harnessams_selfcheck settings argument) '
      + 'or set HARNESSAMS_SIM_SCRIPTS_DIR')
}

// Every Python script under the worker scripts root (relative POSIX paths).
// Uploaded as a unit so any worker and its shared modules resolve remotely.
// The tree walk is scriptStage's listPyTree — the single implementation (the
// lazy healer stages the same tree).
export function pluginScripts(root = simScriptsDir()) {
  return listPyTree(root)
}

// The sibling assets bucket: snp_common.py resolves its pure-stdlib fallback
// at <scripts root>/../assets/numfallback.py (here.parents[1]/assets) — the
// SmartAnaSim package layout where scripts/ and assets/ are siblings. Both
// the dev-sibling scripts root and the staged project copy
// (.harnessams/scripts + .harnessams/assets) resolve through this one probe,
// so the upload carries the fallback the remote host needs when numpy is
// missing (2026-11-24: the live incident had to patch it in by hand).
// The listing is scriptStage's listAssets — the single implementation.
export function pluginAssets(root = simScriptsDir()) {
  return listAssets(root).files
}

// Worker scripts root for one submit call. The tool's `sim_scripts_dir`
// argument is the documented root OVERRIDE: when it names an existing
// directory, that directory IS the root (a custom worker tree, a test
// fixture). Any other value is ignored (D-002: no walk-up — the session
// project's workspace.sim_scripts_dir applies). (2026-11-23: the local
// scheduler handed a custom root silently started the stock worker instead.)
export function submitScriptsRoot(simScriptsDirArg, projectRoot) {
  const given = typeof simScriptsDirArg === 'string' ? simScriptsDirArg.trim() : ''
  if (given) {
    const abs = path.resolve(given)
    try {
      if (fs.statSync(abs).isDirectory()) return abs
    } catch { /* not an existing directory: fall through to the project default */ }
  }
  return simScriptsDir(projectRoot)
}

// Bare interpreter defaults — what a worker runs under while the project has
// no toolchain pin (D-006: settings.remote_python / remote_spectre_cmd hold
// absolute paths; the pins sit between a per-call argument and these
// constants). The retired harnessams.json remote_python / remote_node /
// remote_scripts_dir keys are gone.
export const DEFAULT_REMOTE_PYTHON = 'python3'
export const DEFAULT_REMOTE_NODE = 'node'

export function collectRunFiles(runDir, files) {
  if (Array.isArray(files) && files.length) {
    return files.map((rel) => {
      const safe = sanitizeRel(rel)
      const local = path.resolve(runDir, safe)
      if (!local.startsWith(path.resolve(runDir) + path.sep)) {
        throw new Error(`file escapes run_dir: ${rel}`)
      }
      if (!fs.existsSync(local) || !fs.statSync(local).isFile()) {
        throw new Error(`run file not found: ${rel}`)
      }
      return { local, name: safe }
    })
  }
  return fs.readdirSync(runDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !/^fetch_.*\.tgz$/.test(e.name))
    .map((e) => ({ local: path.join(runDir, e.name), name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// template*.scs family (2026-11-21 relaxation, supersedes the exact-name
// rename): the template uploads under its OWN name and
// sweep_config.netlist_template must match it exactly — the worker reads the
// config name remotely, so any declared-vs-uploaded mismatch is a guaranteed
// remote failure caught here, before anything is submitted.
export const TEMPLATE_NAME_RE = /^template[\w.-]*\.scs$/

export function templateUploadPlan(runDir, files, config) {
  const templates = files.filter((f) => /^template[._]/.test(path.posix.basename(f.name)))
  if (templates.length > 1) {
    throw new Error(`multiple template files in ${runDir}: ${templates.map((f) => f.name).join(', ')}`)
  }
  const declared = config?.netlist_template
  if (templates.length) {
    const base = path.posix.basename(templates[0].name)
    if (!TEMPLATE_NAME_RE.test(base)) {
      throw new Error(`template file ${JSON.stringify(base)} is not a template*.scs family name`)
    }
    if (declared && declared !== base) {
      throw new Error(`sweep_config.netlist_template is ${JSON.stringify(declared)} but the run `
        + `directory holds ${JSON.stringify(base)} — set netlist_template to ${JSON.stringify(base)}`)
    }
    if (!declared && base !== 'template.scs') {
      throw new Error(`${base} requires sweep_config.netlist_template = ${JSON.stringify(base)} `
        + '(the worker defaults to "template.scs")')
    }
  } else if (declared && declared !== 'template.scs') {
    throw new Error(`sweep_config.netlist_template is ${JSON.stringify(declared)} but no template `
      + 'file is being uploaded — add the template to run_dir or reset netlist_template')
  }
  if (!files.some((f) => f.name === 'sweep_config.json')) {
    throw new Error('sweep_config.json is required in run_dir (the worker reads it remotely)')
  }
  return files
}

// The Sim run-directory convention (2026-11-21):
// <base>/Sim<N>_<YYYYMMDD>_batch<M> — the Sim index is the design iteration,
// batches accumulate per iteration per day: the highest existing index
// continues with batch<M>+1 on the same date, any new date starts
// Sim<N>+1 at batch1. Pure function over the sibling directory names.
export function nextSimDir(names, today) {
  const re = /^Sim(\d+)_(\d{8})_batch(\d+)$/
  let best = null // [simIndex, date, batch]
  for (const name of names ?? []) {
    const m = re.exec(String(name))
    if (!m) continue
    const cur = [Number(m[1]), m[2], Number(m[3])]
    if (!best || cur[0] > best[0] || (cur[0] === best[0] && cur[2] > best[2])) best = cur
  }
  if (!best) return `Sim0_${today}_batch1`
  if (best[1] === today) return `Sim${best[0]}_${today}_batch${best[2] + 1}`
  return `Sim${best[0] + 1}_${today}_batch1`
}

// LSF submit, idempotent against dsh-ssh's broken-connection replay (a replayed
// exec must never double-submit): a .hams_submitted marker carries the original
// bsub output and is READ BACK on replay (not skipped — the caller still gets
// its job id); flock serializes concurrent first attempts so two submissions
// can never both miss the marker. The marker is written only when bsub exits 0,
// so a failed submit stays retryable.
//
// overwrite=true replaces a batch that already ran here (2026-11-23): the
// stale replay markers (.hams_submitted / .hams_ssh_done) are cleared under
// the flock so the run actually re-runs, and the fresh marker this attempt
// writes carries a "#hams-overwrite" tag — a REPLAY of the same overwrite call
// sees the tag and still short-circuits instead of double-submitting. An
// untagged marker is by definition stale under overwrite (it predates this
// call). parseJobId/parsePollOutput ignore the extra tag line.
// `node` (LSF only) pins the job to a host or host list: bsub -m "<node>".
export function buildSubmitCommand({ remoteDir, queue, jobName, node, python, workerPath, workerArgs, overwrite }) {
  const args = (workerArgs || []).map(String)
  if (!args.includes('--work-dir')) args.push('--work-dir', remoteDir)
  const replay = 'if [ -f .hams_submitted ]; then cat .hams_submitted; exit 0; fi;'
  const replaceStale = 'grep -q "^#hams-overwrite" .hams_submitted 2>/dev/null '
    + '&& { cat .hams_submitted; exit 0; }; rm -f .hams_submitted .hams_ssh_done;'
  const preLock = overwrite ? ':' : replay
  const inLock = overwrite ? replaceStale : replay
  const mark = overwrite
    ? 'printf \'%s\\n#hams-overwrite\\n\' "$out" | tee .hams_submitted;'
    : 'printf \'%s\\n\' "$out" | tee .hams_submitted;'
  return [
    'cd', shq(remoteDir), '|| exit 9;',
    preLock,
    'exec 9>.hams_submit.lock; flock 9;',
    inLock,
    'out=$(bsub',
    '-q', shq(queue || 'normal'),
    '-J', shq(jobName || 'harnessams'),
    ...(node ? ['-m', shq(node)] : []),
    '-o', 'bsub.out', '-e', 'bsub.err',
    shq(python), shq(workerPath), ...args.map(shq),
    '2>&1); rc=$?;',
    `if [ "$rc" -eq 0 ]; then ${mark}`,
    'else printf \'%s\\n\' "$out" >&2; fi;',
    'exit "$rc"',
  ].join(' ')
}

// scheduler=ssh: launch the SAME worker on the target node DETACHED and
// return at once — the unified submit contract (local spawn / bsub / nohup
// launch all behave identically toward the session; only the internals
// differ). The guard family is unchanged, but the whole guarded block
// (flock + replay check + worker + done marker) runs as one backgrounded
// `sh -c` under nohup with every fd redirected (stdout/stderr ->
// ssh_worker.log, stdin < /dev/null), so it survives the exec channel
// closing; the foreground part only cds, runs the pre-lock replay check,
// launches, and waits a bounded ~20 s for the worker's own .worker_started
// marker (the worker writes it with pid/host/started_at right after its
// imports — a completed-run replay short-circuits the foreground on
// .hams_ssh_done before anything is launched; a still-running first attempt
// holds the flock so a replay's background block queues behind it instead of
// double-running while its foreground sees the existing .worker_started and
// reports running; a dead holder releases the lock, letting the replay
// rerun). overwrite=true uses the same clear-and-tag scheme as the LSF
// submit (see there). The exec budget is launch-scale (tools/batch.js), NOT
// a per-run ssh deadline — the worker's own global budget is the only
// run-level deadline left.
export function buildSshCommand({ remoteDir, python, workerPath, workerArgs, overwrite }) {
  const args = (workerArgs || []).map(String)
  if (!args.includes('--work-dir')) args.push('--work-dir', remoteDir)
  const replay = 'if [ -f .hams_ssh_done ]; then echo \'[hams] already completed (marker present)\'; exit 0; fi;'
  const replaceStale = 'if [ -f .hams_ssh_done ] && grep -q "^#hams-overwrite" .hams_ssh_done 2>/dev/null; '
    + 'then echo \'[hams] already completed (overwrite run)\'; exit 0; fi; '
    + 'rm -f .hams_submitted .hams_ssh_done;'
  const preLock = overwrite ? ':' : replay
  const inLock = overwrite ? replaceStale : replay
  const done = overwrite
    ? 'printf \'#hams-overwrite\\n\' > .hams_ssh_done'
    : 'touch .hams_ssh_done'
  const guarded = [
    'exec 9>.hams_ssh.lock; flock 9;',
    inLock,
    shq(python), shq(workerPath), ...args.map(shq), `&& ${done}`,
  ].join(' ')
  return [
    'cd', shq(remoteDir), '|| exit 9;',
    preLock,
    `nohup sh -c ${shq(guarded)} > ssh_worker.log 2>&1 < /dev/null &`,
    'i=0; while [ $i -lt 20 ] && [ ! -f .worker_started ]; do sleep 1; i=$((i+1)); done;',
    'echo \'[hams] worker detached (stdout/stderr -> ssh_worker.log)\';',
    'if [ -f .worker_started ]; then echo __STARTED__; cat .worker_started; '
      + 'else echo \'[hams] no .worker_started marker yet (slow start or replay queued on the flock) — poll to confirm\'; fi',
  ].join(' ')
}

export function parseJobId(text) {
  const m = String(text ?? '').match(/Job\s*<(\d+)>\s+is\s+submitted/i)
  return m ? m[1] : null
}

export function postSubmitCommand(remoteDir, jobId) {
  return `cd ${shq(remoteDir)} && sleep 1; bjobs -noheader -o 'jobid stat' ${shq(jobId)} 2>&1; `
    + 'test -f errlog.txt && echo __ERRLOG__; test -f .worker_started && echo __STARTED__'
}

// Terminal poll states: once seen, no further polling helps — batch_poll's
// wait_sec loop stops and the progress-card source freezes on the last payload.
// 'partial' (queue DONE but points missing) is terminal for that submission;
// 'unknown' keeps polling (often a queue hiccup).
export const TERMINAL_POLL_STATES = new Set(['completed', 'failed', 'partial'])

export function pollCommand({ remoteDir, jobId, scheduler }) {
  const bjob = scheduler === 'ssh'
    ? 'echo __BJOB__; echo "(scheduler=ssh)"'
    : `echo __BJOB__; bjobs -noheader -o 'jobid stat exec_host' ${shq(jobId)} 2>&1`
  return `cd ${shq(remoteDir)} || exit 9; ${bjob}; `
    + `echo __META__; ls -1 ${shq(normalizeRemoteRoot(remoteDir))}/*/point_meta.json 2>/dev/null | wc -l; `
    + `echo __DIRS__; ls -1d ${shq(normalizeRemoteRoot(remoteDir))}/*/ 2>/dev/null | wc -l; `
    + 'echo __PROG__; cat sweep_progress.json 2>/dev/null; '
    + 'echo __ERR__; [ -f errlog.txt ] && tail -n 5 errlog.txt || true'
}

function section(text, name) {
  // The trailing marker may abut the payload without a newline (a progress
  // file written without a trailing \n makes `cat sweep_progress.json; echo
  // __ERR__` concatenate into `}__ERR__`) — the lookahead takes an optional
  // \n so such sections still split instead of silently parsing to nothing.
  const m = text.match(new RegExp(`__${name}__\\n?([\\s\\S]*?)(?=\\n?__[A-Z]+__|$)`))
  return m ? m[1].trim() : ''
}

// Classify a raw `bjobs` output block into one vocabulary word
// ('queued' | 'running' | 'done' | 'failed' | '' | 'unknown'). Shared by the
// poll parser and the submit-time post-check so PEND means the same thing in
// both places.
export function classifyBjobsState(bjobsOut) {
  if (/(^|\n)\s*\d+\s+(PEND|PSUSP)/.test(bjobsOut)) return 'queued'
  if (/(^|\n)\s*\d+\s+RUN/.test(bjobsOut)) return 'running'
  if (/(^|\n)\s*\d+\s+DONE/.test(bjobsOut)) return 'done'
  if (/(^|\n)\s*\d+\s+(EXIT|ZOMBI)/.test(bjobsOut)) return 'failed'
  return /No (unfinished )?job found/i.test(bjobsOut) || !bjobsOut ? '' : 'unknown'
}

export function parsePollOutput(text, { total } = {}) {
  const bjob = section(text, 'BJOB')
  const meta = Number(section(text, 'META')) || 0
  const dirs = Number(section(text, 'DIRS')) || 0
  const errlog = section(text, 'ERR')
  let progress = null
  const progressText = section(text, 'PROG')
  if (progressText) {
    try { progress = JSON.parse(progressText) } catch { progress = null }
  }
  const jobState = classifyBjobsState(bjob)
  const progressTotal = Number(progress?.total_points) || Number(total) || 0
  const completed = meta
  let state = 'unknown'
  if (progressTotal && completed >= progressTotal) state = 'completed'
  else if (progress?.status === 'completed') state = 'completed'
  else if (progress?.status === 'failed' || jobState === 'failed') state = 'failed'
  else if (jobState === 'queued') state = 'queued'
  else if (jobState === 'running' || (completed > 0 && progressTotal && completed < progressTotal)) state = 'running'
  else if (jobState === 'done' && progressTotal && completed < progressTotal) state = 'partial'
  else if (errlog) state = 'failed'
  return {
    state,
    job_state: jobState || 'unknown',
    completed,
    dirs,
    total: progressTotal || null,
    succeeded: Number(progress?.succeeded) || 0,
    failed: Number(progress?.failed) || 0,
    progress_status: progress?.status ?? null,
    compute_node: progress?.compute_node ?? null,
    errlog_tail: errlog || null,
    points: trimPoints(progress?.points),
  }
}

// Per-point digest carried on every poll frame (2026-11-23: poll is the only
// retrieval face — the model needs each point's params/status without pulling
// the per-point meta files). Bounded to the worker's own 100-point cap.
function trimPoints(points) {
  if (!Array.isArray(points)) return null
  return points.slice(0, 100).map((p) => (p && typeof p === 'object') ? {
    index: p.index ?? null,
    point_name: p.point_name ?? null,
    status: p.status ?? null,
    params: p.params ?? null,
    error: p.error ?? null,
  } : null)
}

export function jobFile(runDir) {
  return path.join(runDir, '.batch_job.json')
}

export function readJob(runDir) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(runDir), 'utf8'))
  } catch {
    return null
  }
}

export function writeJob(runDir, job) {
  atomicWriteSync(jobFile(runDir), JSON.stringify(job, null, 2) + '\n')
}
