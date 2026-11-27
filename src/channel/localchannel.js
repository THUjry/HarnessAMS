// In-cluster local channel primitives (D-002: two working environments, one
// shared cluster filesystem). When the DSH host itself is a cluster node,
// bsub/bjobs run on THIS host and file "transfers" are plain local copies
// between two paths on the same filesystem — nothing crosses ssh. Command
// execution goes through the host's official ctx.shell seam (cross-platform:
// the host picks its shell; never a hand-rolled `sh -c` + `timeout` pair), and
// the return shape mirrors execRemote in remote.js so the batch channel code
// in tools/batch.js stays uniform across both backends.
import fs from 'node:fs'
import path from 'node:path'

// Foreground one-shot on this host via ctx.shell. Resolves {ok, stdout,
// stderr, exitCode, timedOut, aborted} — infrastructure failures (seam
// missing, spawn rejected) also land as values, matching execRemote's
// never-throw contract. `signal` (the turn's exec.signal) rides the spec:
// the host shell seam kills the process on abort and settles the result
// with `aborted: true`, so an aborted turn ends this call at once (the
// process itself is dead; nothing is orphaned on this path).
export async function execLocal(ctx, command, { timeoutMs = 40_000, workdir, signal } = {}) {
  const shell = ctx?.shell
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
    const text = 'ctx.shell is unavailable (the host shell seam is not injected)'
    return { ok: false, isError: true, text, stdout: '', stderr: text, exitCode: -1, timedOut: false, aborted: !!signal?.aborted }
  }
  if (signal?.aborted) {
    return { ok: false, isError: true, text: 'aborted before dispatch', stdout: '', stderr: 'aborted before dispatch', exitCode: -1, timedOut: false, aborted: true }
  }
  try {
    const spec = shell.resolve({
      command,
      timeoutMs,
      onExpiry: 'kill',
      ...(workdir ? { workdir } : {}),
      ...(signal ? { signal } : {}),
    })
    const run = await shell.execute(spec)
    const res = await run.result()
    const stdout = String(res.stdout?.text ?? '')
    const stderr = String(res.stderr?.text ?? '')
    const timedOut = !!res.timedOut
    const aborted = !!res.aborted
    return {
      ok: res.exitCode === 0 && !timedOut && !aborted,
      isError: false,
      text: stdout || stderr,
      stdout,
      stderr,
      exitCode: res.exitCode ?? null,
      timedOut,
      aborted,
    }
  } catch (e) {
    const text = String(e?.message ?? e)
    return { ok: false, isError: true, text, stdout: '', stderr: text, exitCode: -1, timedOut: false, aborted: !!signal?.aborted }
  }
}

// Local "transfer": copy one file, creating parent directories. Either side
// may be the POSIX-shaped run path (in-cluster the remote root is a host path,
// so path.dirname/copyFileSync resolve it natively on the Linux host).
export async function localCopy(from, to) {
  try {
    fs.mkdirSync(path.dirname(String(to)), { recursive: true })
    fs.copyFileSync(String(from), String(to))
    return { ok: true, text: `copied to ${to}` }
  } catch (e) {
    return { ok: false, text: String(e?.message ?? e) }
  }
}
