// Open a local file with the OS default application — the "system browser"
// viewing path for generated reports (2026-11-26 ruling: the report HTML is
// opened as a file:// document so its RELATIVE plotly/SimResults references
// resolve offline; the sidebar's embedded iframe covers in-panel viewing
// through the same-origin plotly route).
// This is a VIEW action, never an execution surface: the path must survive
// strict validation (absolute, existing regular file, viewable-extension
// whitelist, no characters that could break out of the quoting) before the
// platform's one-line "open with default handler" runs.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Viewable documents only — no executables, no script types: opening a file
// must never become running a file. Reports are .html; the rest covers the
// sibling artifacts a viewing session legitimately wants (Figs images, CSV
// tables, logs).
const VIEWABLE_EXT = new Set([
  '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.csv', '.txt', '.md', '.json', '.log',
])

// Characters the launch commands cannot quote safely: '"' is illegal in
// Windows filenames anyway (and breaks the double-quoted cmd form), '%' is
// cmd's environment-variable expansion (a crafted %VAR% path could expand
// inside the quotes), and control characters poison every shell.
const UNSAFE_CHARS = /["%\u0000-\u001f\u007f]/

// Validate a client-supplied path into an openable absolute file path.
// Returns { abs } on success or { error, code } for the route to translate.
export async function resolveOpenableFile(p) {
  if (typeof p !== 'string' || !p.trim()) return { error: 'missing path', code: 400 }
  if (UNSAFE_CHARS.test(p)) {
    return { error: 'path contains characters the open command cannot quote safely (" % or control characters)', code: 400 }
  }
  if (!path.isAbsolute(p)) return { error: 'path must be absolute: ' + p, code: 400 }
  const abs = path.resolve(p)
  const ext = path.extname(abs).toLowerCase()
  if (!VIEWABLE_EXT.has(ext)) {
    return { error: `not a viewable file type: ${ext || '(no extension)'} — viewable: ${[...VIEWABLE_EXT].sort().join(' ')}`, code: 400 }
  }
  let st
  try { st = await fsp.stat(abs) } catch { return { error: 'file does not exist: ' + abs, code: 404 } }
  if (!st.isFile()) return { error: 'not a regular file: ' + abs, code: 400 }
  return { abs }
}

// Real launcher: spawn the opener directly as an argument vector — the same
// local-launch pattern as py.js and the batch submitLocal worker — because
// ctx.shell's workspace-write sandbox is unusable on hosts whose workspace
// contains %TEMP% (the Windows ACL runner refuses to start, so every
// execLocal call fails; observed on a web instance whose workspace was
// C:\Users\<user>). ctx.shell stays reserved for in-cluster shell command
// strings (bsub). The opener itself returns immediately (it hands the file
// to the viewer and exits), so the timeout only guards a hung opener; the
// 'error' event and a non-zero exit both surface as { error }.
const defaultLauncher = (file, args) => new Promise((resolve) => {
  let child
  try {
    child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
  } catch (e) {
    resolve({ error: `open failed on ${process.platform}: ${String(e?.message ?? e)}` })
    return
  }
  const timer = setTimeout(() => {
    child.kill()
    resolve({ error: `open failed on ${process.platform}: timed out after 15 s` })
  }, 15_000)
  child.once('error', (e) => {
    clearTimeout(timer)
    resolve({ error: `open failed on ${process.platform}: ${String(e?.message ?? e)}` })
  })
  child.once('close', (code) => {
    clearTimeout(timer)
    if (code === 0) resolve({ ok: true })
    else resolve({ error: `open failed on ${process.platform}: exit code ${code}` })
  })
})

// Launch with the OS default handler. Tests inject a launcher through
// ctx.openLauncher (production never sets it and always runs the real
// spawn). Returns { ok: true } or { error } — never throws.
export async function openWithDefaultApp(ctx, abs) {
  let file, args
  if (process.platform === 'win32') {
    // '' is start's window-title argument (without it a quoted path is
    // eaten as the title and nothing opens); Node quotes the path argument
    // itself. '%' is still rejected upstream — cmd expands %VAR% inside
    // whatever command line it receives.
    file = 'cmd'
    args = ['/c', 'start', '', abs]
  } else if (process.platform === 'darwin') {
    file = 'open'
    args = [abs]
  } else {
    // Headless Linux hosts (in-cluster) may lack xdg-open: the spawn error
    // lands in the returned error and surfaces inline in the UI.
    file = 'xdg-open'
    args = [abs]
  }
  const launcher = typeof ctx?.openLauncher === 'function' ? ctx.openLauncher : defaultLauncher
  try {
    const r = await launcher(file, args)
    if (r && r.error) return { error: r.error }
    return { ok: true }
  } catch (e) {
    return { error: `open failed on ${process.platform}: ${String(e?.message ?? e)}` }
  }
}
