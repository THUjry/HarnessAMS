// Directory access for the add-report dialog unified on the system's native
// folder chooser (2026-11-26 ruling: system open first, the self-made
// one-level listing stays as the fallback). The DSH host composes a
// 'directoryPicker' service on every web instance (the auto chooser mounts
// exactly one backend — the same OS dialog the host's own add-workspace flow
// uses on loopback win32/darwin hosts), so this module only *consumes* it:
// no process is spawned here, no dialog is built here.
// The service is read through ctx.get('directoryPicker') — the ONE cordis
// channel that reads a service WITHOUT an inject declaration (undefined when
// not provided). That matters twice over: a static inject would leave this
// plugin PENDING forever in headless compositions (no web server, no picker
// service, fiber never activates), and the real cordis ctx is a proxy that
// throws on reads of undeclared service properties — the guarded probe below
// survives both hand-rolled embeds and proxy quirks (the openLauncher lesson,
// HA 70a36b5). The native dialog can only choose a FOLDER (FOS_PICKFOLDERS);
// picking the .html file itself stays with the dialog's own list.
// Capability gating follows the host's documented default: an unknown or
// non-native kind hides the affordance, it never errors at the UI.
const PICK_TIMEOUT_MS = 600_000

// Resolve the optional host directory-picker service, or null. Never throws.
function resolvePicker(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get('directoryPicker') ?? null
  } catch { /* undeclared-read proxies / hand-rolled embeds: no picker here */ }
  return null
}

// Advertise the picker's capability for the client's affordance gating:
// 'native' (OS folder dialog available — show the system browse button),
// 'browse' (host fell back to listing primitives — our own listing already
// covers that, hide the button), or 'none' (no service: headless embeds).
// Never throws.
export function pickerCapability(ctx) {
  const picker = resolvePicker(ctx)
  if (!picker || typeof picker.capability !== 'function') return 'none'
  try {
    const kind = picker.capability()?.kind
    return kind === 'native' || kind === 'browse' ? kind : 'none'
  } catch { return 'none' }
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
  if (!picker || typeof picker.capability !== 'function' || typeof picker.pick !== 'function') {
    return { error: 'directory picker unavailable on this host', code: 503 }
  }
  let kind
  try { kind = picker.capability()?.kind } catch { kind = undefined }
  if (kind !== 'native') {
    // the browse backend has list/createDirectory but no pick — the dialog's
    // own listing is the fallback there, so this is a plain "not available"
    return { error: `directory picker is not native on this host (kind: ${kind ?? 'unknown'})`, code: 503 }
  }
  try {
    const p = await picker.pick(AbortSignal.timeout(PICK_TIMEOUT_MS))
    if (p === null || p === undefined) return { canceled: true }
    if (typeof p !== 'string' || !p.trim()) return { error: 'directory picker returned an invalid path', code: 500 }
    return { path: p }
  } catch (e) {
    return { error: `directory picker failed: ${String(e?.message ?? e)}`, code: 500 }
  }
}
