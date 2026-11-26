// Directory access for the add-report dialog unified on the system's native
// folder chooser (2026-11-26 ruling: system first, the self-made one-level
// listing as the SILENT fallback). The DSH host composes a 'directoryPicker'
// service on every web instance (the auto chooser mounts exactly one backend —
// the same OS dialog the host's own add-workspace flow uses on loopback
// win32/darwin hosts), so this module only *consumes* it: no process is
// spawned here, no dialog is built here.
// The service is read through ctx.get('directoryPicker') — the ONE cordis
// channel that reads a service WITHOUT an inject declaration (undefined when
// not provided). That matters twice over: a static inject would leave this
// plugin PENDING forever in headless compositions (no web server, no picker
// service, fiber never activates), and the real cordis ctx is a proxy that
// throws on reads of undeclared service properties — the guarded probe below
// survives both hand-rolled embeds and proxy quirks (the openLauncher lesson,
// HA 70a36b5). The pick lives on the CAPABILITY object, not the service body:
// capability() returns { kind: 'native', pick(signal) } on the native backend
// (the browse backend returns { kind: 'browse', list, createDirectory }), and
// reading `service.pick` yields undefined — live-caught 2026-11-26, the first
// build's 503 while the capability probe said 'native' was the tell.
// The native dialog can only choose a FOLDER (FOS_PICKFOLDERS); the .html
// pick stays with the dialog's own listing.
const PICK_TIMEOUT_MS = 600_000

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
// usable string). Never throws. The host's own pick route has no timeout; we
// bound a hung dialog at 10 minutes — the timeout aborts, the native worker
// closes the dialog and the rejection lands in { error }.
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