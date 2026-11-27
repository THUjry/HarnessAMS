// Package-location and host-home primitives — the single implementation of
// each. src/ IS the npm package root in this plugin (unlike SmartAnaSim,
// whose package root sits above src/); DSH_HOME is the host's profile root
// (~/.dsh by default, DSH_HOME override).
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The npm package root (src/), resolved from this module (src/lib/ is one
// level down).
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The DSH host home: the DSH_HOME override when set, else ~/.dsh.
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
