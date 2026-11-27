// Remote (POSIX) path primitives — the single implementation of each, shared
// by the batch channel, the self-check chains and the AGENTS.md block writer
// (agentsmd importing these from core/batch.js would close a cycle through
// settings: agentsmd <- settings <- batch <- agentsmd). Pure string-level
// logic: no fs, no channel.
import path from 'node:path'

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

// The default remote scripts root convention: <remote_root>/.harnessams/scripts
// (the AGENTS.md yaml row renders the same path).
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
