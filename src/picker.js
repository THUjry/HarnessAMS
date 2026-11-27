// The add-report picking surface, unified (2026-11-26): every way the
// dashboard's "add report" flow can point at a report HTML lives here.
//   pickDirectory(ctx) — the host-borrowed FOLDER chooser (D-010 shape,
//     moved from server/pickdir.js): the DSH host composes a
//     'directoryPicker' service on every web instance (the same OS dialog
//     the host's own add-workspace flow uses), consumed read-only through
//     ctx.get — the ONE cordis channel that reads a service WITHOUT an
//     inject declaration (undefined when not provided; a static inject
//     would leave this plugin PENDING forever in headless compositions).
//     No longer chained into the add flow — the file picker below replaced
//     its folder-then-one-html detour — but POST /api/pick-directory stays
//     a public route.
//   pickFile(opts) — OUR OWN native FILE-open dialog, because the host has
//     none (0.2.2-rc.5 ships directory pickers only; its native backend
//     hardcodes FOS_PICKFOLDERS). win32 spawns the STA PowerShell script
//     shipped next to this module (picker.ps1, spike-validated
//     2026-11-26: the keybd_event Alt press inside the script makes the
//     dialog take the foreground even though a background host spawned it;
//     exit 0 = chosen path on stdout, exit 2 = cancel); linux falls to
//     zenity/kdialog (mirroring the host's own arms). Direct
//     node:child_process spawn, never ctx.shell — the open-local D-008
//     lesson: the sandboxed runner refuses launcher shapes on hosts whose
//     workspace ACLs differ.
//   browseDir(target, fallback) — the self-made one-level listing behind
//     the fallback dialog (moved from server/dashboard.js).
// All three resolve { path } / { canceled: true } / { error, code } shapes
// for the routes to translate; none of them ever throws.
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PICK_TIMEOUT_MS = 600_000

// ---------------------------------------------------------------------------
// Host-borrowed folder chooser (D-010 shape, moved from server/pickdir.js)
// ---------------------------------------------------------------------------

// Resolve the optional host directory-picker service, or null. Never throws.
function resolvePicker(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get('directoryPicker') ?? null
  } catch { /* undeclared-read proxies / hand-rolled embeds: no picker here */ }
  return null
}

// Open the native OS folder chooser. Resolves { path } with the chosen
// absolute directory, { canceled: true } when the user dismisses the dialog,
// or { error, code } for the route to translate (503 when no native picker
// exists on this host, 500 when the pick itself fails or the path is not a
// usable string). Never throws. The pick lives on the CAPABILITY object, not
// the service body: capability() returns { kind: 'native', pick(signal) } on
// the native backend (the browse backend returns list/createDirectory), and
// reading `service.pick` yields undefined — live-caught 2026-11-26. The
// host's own pick route has no timeout; we bound a hung dialog at 10 minutes.
export async function pickDirectory(ctx) {
  const picker = resolvePicker(ctx)
  if (!picker || typeof picker.capability !== 'function') {
    return { error: 'directory picker unavailable on this host', code: 503 }
  }
  let cap
  try { cap = picker.capability() } catch { cap = undefined }
  if (!cap || cap.kind !== 'native' || typeof cap.pick !== 'function') {
    // the browse backend has list/createDirectory but no pick — the dialog's
    // own listing is the fallback there, so this is a plain "not available"
    return { error: `directory picker is not native on this host (kind: ${cap?.kind ?? 'unknown'})`, code: 503 }
  }
  try {
    const p = await cap.pick(AbortSignal.timeout(PICK_TIMEOUT_MS))
    if (p === null || p === undefined) return { canceled: true }
    if (typeof p !== 'string' || !p.trim()) return { error: 'directory picker returned an invalid path', code: 500 }
    return { path: p }
  } catch (e) {
    return { error: `directory picker failed: ${String(e?.message ?? e)}`, code: 500 }
  }
}

// ---------------------------------------------------------------------------
// Our own native file dialog
// ---------------------------------------------------------------------------

const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PICKER_PS1 = path.join(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)), 'picker.ps1')
const DEFAULT_FILE_TITLE = 'Pick an HTML report'

// Kill the whole process tree (the modal dialog goes with the process) —
// powershell may hold helper children, so /T matters; the 5 s fallback guard
// in the caller bounds a taskkill that itself never lands.
function killTree(spawnImpl, pid) {
  if (pid) spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'])
}

// One dialog child to completion: UTF-8 stdout/stderr collection, a hard
// timeout that kills via killTree, exit-code mapping. `exitResult(code,
// stdout, stderr)` decides { path } / { canceled } / { error }.
async function runDialogProcess(spawnImpl, cmd, args, { timeoutMs = PICK_TIMEOUT_MS, exitResult, kill = killTree }) {
  let child
  try {
    child = spawnImpl(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return { error: `file picker spawn failed: ${String(e?.message ?? e)}`, code: 500 }
  }
  const out = []
  const err = []
  child.stdout?.on('data', (d) => out.push(d))
  child.stderr?.on('data', (d) => err.push(d))
  return await new Promise((resolve) => {
    let settled = false
    let deadlineFired = false
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => {
      deadlineFired = true
      kill(spawnImpl, child.pid)
      child.once('exit', () => finish({ error: 'file picker timed out', code: 500 }))
      setTimeout(() => finish({ error: 'file picker timed out', code: 500 }), 5_000)
    }, Math.max(1, timeoutMs))
    child.once('error', (e) => finish({ error: `file picker failed to start: ${String(e?.message ?? e)}`, code: 500 }))
    child.once('exit', (code) => {
      // after the deadline the timeout path owns the outcome — the kill
      // lands as a plain exit (often code null), which must not read as a
      // dialog-level "exit null" error
      if (deadlineFired) return
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const stderr = Buffer.concat(err).toString('utf8').trim()
      finish(exitResult(code, stdout, stderr))
    })
  })
}

// The win32 arm (spike contract): exit 0 = chosen absolute path on stdout,
// exit 2 = user cancelled, anything else = script error with stderr.
function pickFileWin32({ title, filter, initialDir, timeoutMs }, spawnImpl) {
  const args = [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', PICKER_PS1,
    '-Title', title ?? DEFAULT_FILE_TITLE,
    ...(filter ? ['-Filter', filter] : []),
    ...(initialDir ? ['-InitialDir', String(initialDir)] : []),
  ]
  return runDialogProcess(spawnImpl, PS_EXE, args, {
    timeoutMs,
    exitResult: (code, stdout, stderr) => {
      if (code === 0) {
        if (stdout) return { path: stdout }
        return { error: 'file picker returned no path', code: 500 }
      }
      if (code === 2) return { canceled: true }
      return { error: `file picker failed: ${stderr || `exit ${code}`}`, code: 500 }
    },
  })
}

// The linux arm: zenity first, kdialog where zenity is absent (the same
// pair the dsh host's own picker arms use). Both dialogs ARE the process,
// so a hung dialog dies with the child (plain kill, no tree). zenity exit 1
// = cancel; kdialog returns non-zero on cancel without a stable code, so a
// non-zero exit with empty stdout reads as cancel there. Only a missing
// binary (ENOENT-shaped spawn error) falls through to the next candidate.
async function pickFileLinux({ title, timeoutMs }, spawnImpl) {
  for (const candidate of [
    {
      cmd: 'zenity', args: ['--file-selection', `--title=${title ?? DEFAULT_FILE_TITLE}`],
      cancel: (code, stdout) => code === 1,
    },
    {
      cmd: 'kdialog', args: ['--getopenfilename', '.', '*.html *.htm'],
      cancel: (code, stdout) => code !== 0 && !stdout,
    },
  ]) {
    let r
    try {
      r = await runDialogProcess(spawnImpl, candidate.cmd, candidate.args, {
        timeoutMs,
        kill: (_spawnImpl, pid) => { try { if (pid) process.kill(pid, 'SIGKILL') } catch { /* already gone */ } },
        exitResult: (code, stdout, stderr) => {
          if (code === 0 && stdout) return { path: stdout }
          if (candidate.cancel(code, stdout)) return { canceled: true }
          return { error: `file picker failed: ${stderr || `exit ${code}`}`, code: 500 }
        },
      })
    } catch (e) {
      return { error: `file picker failed: ${String(e?.message ?? e)}`, code: 500 }
    }
    // a missing binary surfaces as the child 'error' event mapped into the
    // result — try the next candidate only for that shape
    if (r.error && /failed to start|spawn failed/.test(r.error)) continue
    return r
  }
  return { error: 'no supported native file picker found (install zenity or kdialog)', code: 503 }
}

// Open the native OS file chooser. Same result contract as pickDirectory:
// { path } / { canceled: true } / { error, code } — never throws. win32 and
// linux have arms; every other platform reports unsupported so the route's
// client falls back to the self-made listing. `internals` (platform,
// spawnImpl) exists for the test face — production always uses the real ones.
export async function pickFile(opts = {}, internals = {}) {
  const platform = internals.platform ?? process.platform
  const spawnImpl = internals.spawnImpl ?? spawn
  if (platform === 'win32') return pickFileWin32(opts, spawnImpl)
  if (platform === 'linux') return pickFileLinux(opts, spawnImpl)
  return { error: `native file picker is unsupported on ${platform}`, code: 503 }
}

// ---------------------------------------------------------------------------
// Self-made one-level listing (moved from server/dashboard.js)
// ---------------------------------------------------------------------------

// One-level listing for the add-report dialog: subdirectories plus *.html
// files with sizes. Any readable local path is acceptable — this dialog is
// how a user points the dashboard at a report anywhere on disk.
// Dot-directories (.git, .harnessams, …) are hidden as picker noise.
export async function browseDir(target, fallback) {
  const raw = typeof target === 'string' && target.trim() ? target.trim() : (fallback ?? '.')
  const p = path.resolve(raw)
  let entries
  try {
    entries = await fsp.readdir(p, { withFileTypes: true })
  } catch (e) {
    return { error: `cannot list ${p}: ${e.code ?? e.message}` }
  }
  const dirs = []
  const htmls = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      dirs.push(e.name)
    } else if (e.isFile() && /\.html?$/i.test(e.name)) {
      const st = await fsp.stat(path.join(p, e.name)).catch(() => null)
      htmls.push({ name: e.name, bytes: st?.size ?? 0 })
    }
  }
  dirs.sort((a, b) => a.localeCompare(b))
  htmls.sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(p)
  return { path: p, parent: parent !== p ? parent : null, dirs, htmls }
}
