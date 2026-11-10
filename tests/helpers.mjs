// Shared test scaffolding for the HarnessAMS suite: the bash -n syntax guard,
// the apply()-registered route driver (fake res + macrotask polling), the
// DSH_HOME mirror fixture, and the client.js static-contract readers. Keeping
// these in one place keeps the per-file tests focused on their contracts.
// Run: bare `node --test` from the repo root.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'

// ---- shell guard ----------------------------------------------------------
// Generated one-liners must be valid shell — a misplaced quote shipped once and
// only failed live ("bash: -c: syntax error"). Skipped when bash is absent
// (a Windows runner may not have Git Bash on PATH).
let bashAvailable = true
try { execFileSync('bash', ['--version'], { stdio: 'pipe' }) } catch { bashAvailable = false }

export function assertValidShell(cmd) {
  if (!bashAvailable) return
  execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
}

// ---- route driver ---------------------------------------------------------
export function fakeRes() {
  return { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b ?? '') } }
}

// Register the plugin's prefix route against a partial ctx (workspaceRegistry,
// tools shell, services via get, ...) and return the route handler.
export async function registerRoutes(ctx = {}) {
  const routes = []
  await apply({
    effect: (fn) => { fn() },
    webServer: { register: (r) => routes.push(r) },
    tools: { register: () => {} },
    ...ctx,
  })
  return routes[0].handler
}

// The route handler fire-and-forgets its async work — drive it on macrotasks
// until a status code lands, then parse the JSON body.
export async function callRoute(handler, req) {
  const res = fakeRes()
  handler(req, res)
  for (let i = 0; i < 200 && res.code === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(res.code, `route never responded: ${req.method} ${req.url}`)
  return { code: res.code, body: res.body ? JSON.parse(res.body) : null }
}

export const getReq = (url) => ({ method: 'GET', url, headers: {} })
export const postReq = (url, payload) => ({
  method: 'POST', url, headers: {},
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
  },
})
export const putReq = (url, payload) => ({
  method: 'PUT', url, headers: {},
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
  },
})
export const callGet = (handler, url) => callRoute(handler, getReq(url))
export const callPost = (handler, url, payload) => callRoute(handler, postReq(url, payload))
export const callPut = (handler, url, payload) => callRoute(handler, putReq(url, payload))

// ---- DSH_HOME mirror fixture ----------------------------------------------
// remoteWorkspacesRoot() resolves mirrors under $DSH_HOME/remote-workspaces;
// the .dsh-remote-meta.json shape is what the remote-project model matches on.
export function makeMirrorHome({ host, port, user, remotePath, segments = ['m1', 'ws'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hams-dsh-'))
  const mirror = path.join(home, 'remote-workspaces', ...segments)
  fs.mkdirSync(mirror, { recursive: true })
  fs.writeFileSync(path.join(mirror, '.dsh-remote-meta.json'),
    JSON.stringify({ host, port, username: user, remotePath }))
  return { home, mirror }
}

export function setDSHHome(home) {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

// ---- client.js static contract --------------------------------------------
// The client half is a combo-loaded classic script (no ESM import), so its
// contract is asserted against the source text.
let clientSource = null
export async function clientSrc() {
  if (clientSource === null) {
    const { readFile } = await import('node:fs/promises')
    clientSource = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  }
  return clientSource
}

// Every listed key must appear exactly twice (once in zh, once in en). The full
// zh/en key-set equality lives in entry.test.mjs; this catches a listed key
// missing from one language or gaining a stray third copy.
export function assertDictKeys(src, keys) {
  for (const key of keys) {
    const hits = src.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `dictionary key ${key} must exist exactly twice (zh + en), found ${hits}`)
  }
}
