// Lazy project script staging — the copy-if-missing half of the 2026-11-26
// package-path-first policy (the plotly shape): a fresh project resolves its
// worker scripts tree straight from the PACKAGE install location (the
// SmartAnaSim sibling in either layout — see defaultSimScriptsDir /
// resolveScriptsSource in settings.js) and never seeds .harnessams/scripts
// at init. A local copy exists only where a config EXPLICITLY points at one
// — the legacy flipped layout (pre-2026-11-26 inits wrote
// <project>/.harnessams/scripts into sim_scripts_dir) or a hand-set root —
// and those are healed lazily at self-check start (the
// isProjectLocalScriptsRoot gate). The batch channel needs the sibling
// assets/ bucket either way (snp_common resolves its pure-stdlib fallback
// at <scripts root>/../assets/numfallback.py — the SmartAnaSim package
// layout, mirrored by the legacy project-local .harnessams pair).
// The self-check gen script is NOT staged (2026-11-25 ruling): the
// orchestrator runs gen_selfcheck_rc.py straight from the package install
// location (genSelfcheckRcPath() below — the import.meta.dirname resolution
// works identically in the dev checkout and an npm-installed package).
//
// Copy-if-missing per file: a copy the user edited is never clobbered, a
// partial tree gets completed, an up-to-date project is a no-op. The source
// root is resolved by the caller and passed in, keeping this module
// dependency-free.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const PKG_ROOT = path.resolve(import.meta.dirname ?? '.', '..') // src/
export const GEN_SELFCHECK_RC = 'gen_selfcheck_rc.py'
const GEN_SRC = path.join(PKG_ROOT, 'selfcheck', 'script', 'analysis', GEN_SELFCHECK_RC)

// The self-check gen script, resolved from THIS package's install location —
// same mechanism for the dev checkout and an npm-installed bundle (the file
// ships through package.json "files", which includes src/).
export function genSelfcheckRcPath() {
  return GEN_SRC
}

function listPyTree(root) {
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

function listAssets(srcRoot) {
  // sibling assets/ of the scripts root (see the header comment)
  const dir = path.join(path.resolve(srcRoot), '..', 'assets')
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { dir, files: [] }
  }
  return {
    dir,
    files: entries.filter((e) => e.isFile() && e.name.endsWith('.py'))
      .map((e) => ({ rel: e.name, local: path.join(dir, e.name) }))
      .sort((a, b) => a.rel.localeCompare(b.rel)),
  }
}

async function copyIfMissing(local, dest) {
  if (fs.existsSync(dest)) return false
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(local, dest)
  return true
}

// True when the resolved scripts root is the project's OWN .harnessams tree
// (the legacy flipped layout or an explicit config) — the only root shape a
// local copy-if-missing heal still makes sense for under the
// package-path-first policy.
export function isProjectLocalScriptsRoot(projectPath, scriptsRoot) {
  if (typeof projectPath !== 'string' || !projectPath) return false
  const local = path.join(path.resolve(projectPath), '.harnessams', 'scripts')
  return path.resolve(String(scriptsRoot)) === local
}

// Stage the project's reusable simulation scripts. Returns what it laid down
// (for observability); missing sources fail open (an empty staged list — the
// batch channel's own guidance fires later if the configured root is unusable).
export async function ensureProjectScripts(workspacePath, srcRoot) {
  const scriptsDir = path.join(workspacePath, '.harnessams', 'scripts')
  const assetsDir = path.join(workspacePath, '.harnessams', 'assets')
  const staged = []

  // the dir must exist even when nothing was copied (an empty scripts root is
  // still a resolvable one — simScriptsDir() requires existence)
  await fsp.mkdir(scriptsDir, { recursive: true })

  const src = srcRoot ? path.resolve(srcRoot) : null
  if (src && fs.existsSync(src) && fs.statSync(src).isDirectory()
    && path.resolve(scriptsDir) !== path.resolve(src)) {
    for (const f of listPyTree(src)) {
      if (await copyIfMissing(f.local, path.join(scriptsDir, ...f.rel.split('/')))) staged.push(f.rel)
    }
    for (const f of listAssets(src).files) {
      if (await copyIfMissing(f.local, path.join(assetsDir, f.rel))) staged.push(`assets/${f.rel}`)
    }
  }

  return { scriptsDir, assetsDir, staged }
}
