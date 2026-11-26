// Open a local file with the OS default application — the "system browser"
// viewing path for generated reports (2026-11-26 ruling: the report HTML is
// opened as a file:// document so its RELATIVE plotly/SimResults references
// resolve offline; the embedded /dash iframe view could not serve them past
// its per-report directory fence and leaned on the CDN fallback instead).
// This is a VIEW action, never an execution surface: the path must survive
// strict validation (absolute, existing regular file, viewable-extension
// whitelist, no characters that could break out of the quoting) before the
// platform's one-line "open with default handler" runs through the host
// ctx.shell seam (execLocal — the same seam the in-cluster bsub commands
// use; never a hand-composed pipeline).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execLocal } from '../localchannel.js'

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

// POSIX single-quoting (shlex-style): wrap in single quotes, escaping any
// embedded quote as '\'' — safe against every POSIX shell's parsing.
const quotePosix = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

// Launch with the OS default handler. The opener itself returns immediately
// (it spawns the viewer and exits), so a short timeout only guards a hung
// shell. Returns { ok: true } or { error } — never throws.
export async function openWithDefaultApp(ctx, abs) {
  let command
  if (process.platform === 'win32') {
    // `""` is start's window-title argument (without it a quoted path is
    // eaten as the title and nothing opens). The path is safe inside double
    // quotes because '"' and '%' are both rejected upstream.
    command = `cmd /c start "" "${abs}"`
  } else if (process.platform === 'darwin') {
    command = `open ${quotePosix(abs)}`
  } else {
    // Headless Linux hosts (in-cluster) may lack xdg-open: the execLocal
    // failure lands in the returned error and surfaces inline in the UI.
    command = `xdg-open ${quotePosix(abs)}`
  }
  const r = await execLocal(ctx, command, { timeoutMs: 15_000 })
  if (r.ok) return { ok: true }
  return { error: `open failed on ${process.platform}: ${r.stderr || r.text || 'unknown error'}` }
}
