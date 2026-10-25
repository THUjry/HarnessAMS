// Workspace configuration: locating the runtime harnessams.json and resolving its
// relative path fields. (The former nodes.yaml server-registry block was removed in
// the 2026-10-26 rework — remote connectivity is delegated entirely to dsh-remote.)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function findWorkspaceConfig() {
  // Convention: harnessams-workspace/harnessams.json (or a bare harnessams.json); search upward
  // from the plugin package and from cwd. Two levels above this file is the project root
  // when dev-mounted (src -> HarnessAMS -> <project root>).
  const roots = [process.cwd(), path.resolve(import.meta.dirname ?? '.', '../../..'), os.homedir()]
  const candidates = []
  for (const r of roots) {
    let d = r
    for (let i = 0; i < 6; i++) {
      candidates.push(path.join(d, 'harnessams-workspace', 'harnessams.json'))
      candidates.push(path.join(d, 'harnessams.json'))
      const parent = path.dirname(d)
      if (parent === d) break
      d = parent
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const config = JSON.parse(fs.readFileSync(c, 'utf8'))
      // Relative path fields resolve against the config file's directory, so a checked-in
      // example workspace works from any clone location
      const base = path.dirname(c)
      for (const k of ['workspace_root', 'ngspice_cmd', 'pdk_lib', 'trash_dir', 'sim_scripts_dir']) {
        const v = config[k]
        if (typeof v === 'string' && v && !path.isAbsolute(v)) config[k] = path.resolve(base, v)
      }
      return { configPath: c, config }
    }
  }
  return null
}
