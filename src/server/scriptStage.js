// One-time project script staging (2026-11-24 wave): a project keeps its own
// reusable copy of the simulation scripts, so everything the self-check
// exercised stays usable after the run — the self-check's gen step needs
// <project>/script/analysis/gen_*.py (it runs the staged script directly
// since 2026-11-25) and the batch channel needs a worker scripts tree plus
// the sibling assets/ bucket (snp_common resolves its pure-stdlib fallback at
// <scripts root>/../assets/numfallback.py — the SmartAnaSim package layout,
// mirrored here as .harnessams/scripts + .harnessams/assets).
//
// Copy-if-missing per file: a copy the user edited is never clobbered, a
// partial tree gets completed, an up-to-date project is a no-op. The source
// root is resolved by the caller (env override -> the project's configured
// sim_scripts_dir pre-flip -> the dev-sibling default, see
// resolveScriptsSource in settings.js) and passed in, keeping this module
// dependency-free.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const PKG_ROOT = path.resolve(import.meta.dirname ?? '.', '..') // src/
export const GEN_SELFCHECK_RC = 'gen_selfcheck_rc.py'
const GEN_SRC = path.join(PKG_ROOT, 'selfcheck', 'script', 'analysis', GEN_SELFCHECK_RC)

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

  let genStaged = false
  if (fs.existsSync(GEN_SRC)) {
    genStaged = await copyIfMissing(GEN_SRC, path.join(workspacePath, 'script', 'analysis', GEN_SELFCHECK_RC))
  }
  return { scriptsDir, assetsDir, staged, genStaged }
}
