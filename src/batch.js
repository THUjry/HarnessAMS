// Generic remote batch channel: submit a worker through LSF (bsub), or run the
// same worker directly on the remote login host (scheduler=direct, node-local
// foreground). Both paths upload one run directory plus the suite's worker
// scripts and record the same job file for poll/fetch.
//
// This layer knows nothing about a simulator: it uploads a run directory plus
// the suite's worker scripts, submits a worker script through bsub, polls the
// LSF job and the batch's progress files, and fetches the produced files back
// with tar. A simulator-specific flow is only a choice of worker + worker_args
// (for example spectre/spectre_sweep_worker.py --config sweep_config.json ...).
//
// Worker-script source: the batch tools live here but the simulator workers do
// NOT — they ship with the SmartAnaSim plugin. The upload tree / worker lookup
// root is the project's workspace_config.json workspace.sim_scripts_dir
// (normally the SmartAnaSim scripts/ directory; the project root is discovered
// by walking up from the run directory for a .harnessams store), so
// cross-package npm resolution is never required (dev-mount loads plugins by
// absolute path). HARNESSAMS_SIM_SCRIPTS_DIR overrides discovery (tests, custom
// layouts). The tree uploads as a unit with its relative layout so any worker
// and its shared modules resolve remotely.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWorkspacePaths } from './server/settings.js'
import { shq } from './remote.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_INCLUDES = ['point_meta.json', 'sweep_progress.json',
  'errlog.txt', 'bsub.out', 'bsub.err']

// Worker scripts root (see the header comment). `anchor` is any path inside
// the project (a run directory); the project root is the nearest ancestor with
// a .harnessams store. Throws with guidance when no usable root exists — a
// wrong root would upload a partial tree whose remote imports break, so
// failing early beats a confusing remote traceback.
export function simScriptsDir(anchor = process.cwd()) {
  const override = process.env.HARNESSAMS_SIM_SCRIPTS_DIR
  if (override) {
    const abs = path.resolve(override)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`HARNESSAMS_SIM_SCRIPTS_DIR is not a directory: ${override}`)
    }
    return abs
  }
  const { sim_scripts_dir: dir } = resolveWorkspacePaths(anchor)
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return path.resolve(dir)
  throw new Error(`no worker scripts root: ${dir} does not exist — set workspace.sim_scripts_dir `
    + 'in the project\'s .harnessams/workspace_config.json (the SmartAnaSim plugin\'s scripts/ '
    + 'directory) or set HARNESSAMS_SIM_SCRIPTS_DIR')
}

// Every Python script under the worker scripts root (relative POSIX paths).
// Uploaded as a unit so any worker and its shared modules resolve remotely.
export function pluginScripts(root = simScriptsDir()) {
  const out = []
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__pycache__') continue
      const rel = prefix ? prefix + '/' + ent.name : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.name.endsWith('.py')) out.push({ rel, local: abs })
    }
  }
  walk(root, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

export function remoteJoin(...parts) {
  return path.posix.join(...parts)
}

export function normalizeRemoteRoot(root) {
  const r = path.posix.normalize(String(root ?? '').replace(/\\/g, '/'))
  if (!r || r === '.' || !r.startsWith('/')) throw new Error(`remotePath must be absolute: ${root}`)
  return r.replace(/\/+$/, '') || '/'
}

export function resolveRemoteDir(remoteRoot, remoteDir) {
  const root = normalizeRemoteRoot(remoteRoot)
  if (!remoteDir || typeof remoteDir !== 'string') throw new Error('remote_dir is required')
  const raw = remoteDir.replace(/\\/g, '/')
  const candidate = raw.startsWith('/') ? path.posix.normalize(raw) : path.posix.join(root, raw)
  if (candidate !== root && !candidate.startsWith(root + '/')) {
    throw new Error(`remote_dir escapes the remote workspace (${root}): ${remoteDir}`)
  }
  return candidate
}

// Remote interpreter defaults (the retired harnessams.json remote_python /
// remote_node / remote_scripts_dir keys are gone — per-call args and these
// constants are the whole surface now).
export const DEFAULT_REMOTE_PYTHON = 'python3'
export const DEFAULT_REMOTE_NODE = 'node'

export function defaultRemoteScriptsDir(remoteRoot) {
  return remoteJoin(remoteRoot, '.harnessams', 'scripts')
}

export function sanitizeRel(rel) {
  const normalized = path.posix.normalize(String(rel ?? '').replace(/\\/g, '/'))
  if (!normalized || normalized === '.' || normalized.startsWith('/')
      || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`unsafe relative path: ${rel}`)
  }
  return normalized
}

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
export function buildSubmitCommand({ remoteDir, queue, jobName, python, workerPath, workerArgs }) {
  const args = (workerArgs || []).map(String)
  if (!args.includes('--work-dir')) args.push('--work-dir', remoteDir)
  return [
    'cd', shq(remoteDir), '|| exit 9;',
    'if [ -f .hams_submitted ]; then cat .hams_submitted; exit 0; fi;',
    'exec 9>.hams_submit.lock; flock 9;',
    'if [ -f .hams_submitted ]; then cat .hams_submitted; exit 0; fi;',
    'out=$(bsub',
    '-q', shq(queue || 'normal'),
    '-J', shq(jobName || 'harnessams'),
    '-o', 'bsub.out', '-e', 'bsub.err',
    shq(python), shq(workerPath), ...args.map(shq),
    '2>&1); rc=$?;',
    'if [ "$rc" -eq 0 ]; then printf \'%s\\n\' "$out" | tee .hams_submitted;',
    'else printf \'%s\\n\' "$out" >&2; fi;',
    'exit "$rc"',
  ].join(' ')
}

// scheduler=direct: run the SAME worker directly on the remote host (the
// node-local foreground mode — no LSF involvement), executed synchronously
// through ssh_exec. Same guard family as the LSF submit: a completed run
// short-circuits on the .hams_direct_done marker (read back, exit 0); a
// still-running first attempt holds the flock so a replay queues behind it
// instead of double-running; a dead first attempt releases the lock (its
// holder was killed), letting the replay rerun. The execRemote `timeout -s
// KILL` wrapper bounds any lock wait.
export function buildDirectCommand({ remoteDir, python, workerPath, workerArgs }) {
  const args = (workerArgs || []).map(String)
  if (!args.includes('--work-dir')) args.push('--work-dir', remoteDir)
  return [
    'cd', shq(remoteDir), '|| exit 9;',
    'if [ -f .hams_direct_done ]; then echo \'[hams] already completed (marker present)\'; exit 0; fi;',
    'exec 9>.hams_direct.lock; flock 9;',
    'if [ -f .hams_direct_done ]; then echo \'[hams] already completed (marker present)\'; exit 0; fi;',
    shq(python), shq(workerPath), ...args.map(shq), '&& touch .hams_direct_done',
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
  const bjob = scheduler === 'direct'
    ? 'echo __BJOB__; echo "(scheduler=direct)"'
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
  const jobState = /(^|\n)\s*\d+\s+(PEND|PSUSP)/.test(bjob) ? 'queued'
    : /(^|\n)\s*\d+\s+RUN/.test(bjob) ? 'running'
      : /(^|\n)\s*\d+\s+(DONE)/.test(bjob) ? 'done'
        : /(^|\n)\s*\d+\s+(EXIT|ZOMBI)/.test(bjob) ? 'failed'
          : /No (unfinished )?job found/i.test(bjob) || !bjob ? '' : 'unknown'
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
  }
}

function findConditions(includes) {
  const conds = []
  for (const raw of includes) {
    const inc = String(raw).replace(/\\/g, '/').replace(/^\.\//, '')
    if (!inc) continue
    if (inc.includes('/')) conds.push(`-path ${shq('./' + inc)}`)
    else conds.push(`-name ${shq(inc)}`)
  }
  return conds
}

export function fetchCommand({ remoteDir, includes }) {
  const conds = findConditions(includes)
  const expr = conds.length === 1 ? conds[0] : `\\( ${conds.join(' -o ')} \\)`
  return `cd ${shq(remoteDir)} && find . -maxdepth 5 ${expr} -print | `
    + 'tar czf .batch_fetch.tgz -T -; wc -c < .batch_fetch.tgz'
}

export function listCommand({ remoteDir, includes }) {
  const conds = findConditions(includes)
  const expr = conds.length === 1 ? conds[0] : `\\( ${conds.join(' -o ')} \\)`
  return `cd ${shq(remoteDir)} && find . -maxdepth 5 ${expr} -print | sort | head -200`
}

export function parseRemoteList(text) {
  return String(text ?? '').split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('./'))
    .map((s) => s.slice(2))
    .filter((s) => s && !s.startsWith('../') && !path.posix.isAbsolute(s))
}

export async function extractArchive(archive, runDir) {
  // Run tar with cwd=runDir and a relative archive operand: an absolute
  // "C:\..." operand is parsed as host:path by GNU tar (Git Bash PATH), while
  // Windows bsdtar accepts the relative form equally.
  await execFileAsync('tar', ['-xzf', path.basename(archive)], {
    cwd: runDir, timeout: 180_000, windowsHide: true, encoding: 'utf8',
  })
}

export function countFetched(runDir) {
  let points = 0
  let spFiles = 0
  for (const ent of fs.readdirSync(runDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !/^\d{2,}$/.test(ent.name)) continue
    const pdir = path.join(runDir, ent.name)
    if (fs.existsSync(path.join(pdir, 'point_meta.json'))) points += 1
    if (fs.existsSync(path.join(pdir, 'netlist.scs.raw', 'sp.sp'))) spFiles += 1
  }
  return { points, sp_files: spFiles }
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
  const finalPath = jobFile(runDir)
  const tmp = finalPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, finalPath)
}
