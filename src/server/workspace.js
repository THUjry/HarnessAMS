// Workspace location and node configuration: locating the runtime harnessams.json,
// reading and validating the nodes.yaml template, and writing node edits back.
// Extracted from the former single-file entry; behavior of findWorkspaceConfig and
// the nodes parser is unchanged (dev-mount and installed layouts both resolve).
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

// Minimal nodes.yaml parser (supports only this project's nodes.yaml template field surface; no
// third-party dependency)
export function parseNodesYaml(text) {
  const nodes = []
  let current = null
  let inNodes = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '')
    if (/^\s*nodes\s*:/.test(line)) { inNodes = true; continue }
    if (!inNodes) continue
    const item = line.match(/^\s*-\s+(\w+)\s*:\s*(.*)$/)
    if (item) {
      current = { [item[1]]: strip(item[2]) }
      nodes.push(current)
      continue
    }
    const kv = line.match(/^\s+(\w+)\s*:\s*(.*)$/)
    if (kv && current) current[kv[1]] = strip(kv[2])
  }
  return nodes.filter((n) => n.HOST)
}

function strip(v) { return v.replace(/^['"]|['"]$/g, '').trim() }

export function readNodes(wsDir) {
  const p = path.join(wsDir, 'nodes.yaml')
  if (!fs.existsSync(p)) return { path: p, nodes: [] }
  return { path: p, nodes: parseNodesYaml(fs.readFileSync(p, 'utf8')) }
}

const NODE_FIELDS = ['HOST', 'HOSTNAME', 'PORT', 'WORKSPACE', 'reserved']

// Validate an incoming node list (from the console page's server editor). Returns
// { nodes } normalized for persistence, or { error } with a user-facing reason.
export function validateNodes(input) {
  if (!Array.isArray(input)) return { error: 'body must be { "nodes": [...] }' }
  const seen = new Set()
  const nodes = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'each node must be an object' }
    const node = {}
    for (const k of NODE_FIELDS) {
      const v = raw[k]
      if (v === undefined || v === null || v === '') continue
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        return { error: `field ${k} must be a scalar` }
      }
      node[k] = typeof v === 'number' ? String(v) : String(v)
    }
    if (!node.HOST) return { error: 'each node needs a non-empty HOST' }
    if (!/^[\w.@-]+$/.test(node.HOST)) return { error: `HOST contains unexpected characters: ${node.HOST}` }
    if (seen.has(node.HOST)) return { error: `duplicate HOST: ${node.HOST}` }
    seen.add(node.HOST)
    if (node.PORT && !/^\d+$/.test(node.PORT)) return { error: `PORT must be numeric, got: ${node.PORT}` }
    if (node.reserved !== undefined && !['true', 'false'].includes(node.reserved)) {
      return { error: `reserved must be true/false, got: ${node.reserved}` }
    }
    nodes.push(node)
  }
  return { nodes }
}

// Write the node list back to nodes.yaml in the template's field order. The rewrite is
// whole-file: custom comments are lost (the fixed header explains the file), which the
// console page states when saving. Credentials never go here by convention.
export function writeNodes(nodesPath, nodes) {
  const lines = [
    '# harnessams-workspace/nodes.yaml — remote node list (managed by the HarnessAMS console).',
    '# HOST is also the ~/.ssh/config alias; credentials stay with the system OpenSSH.',
    '# NOTE: saving from the console rewrites this file (custom comments are lost).',
    'nodes:',
  ]
  for (const n of nodes) {
    lines.push(`  - HOST: ${n.HOST}`)
    for (const k of NODE_FIELDS.slice(1)) {
      if (n[k] !== undefined) lines.push(`    ${k}: ${n[k]}`)
    }
  }
  fs.writeFileSync(nodesPath, lines.join('\n') + '\n', 'utf8')
}
