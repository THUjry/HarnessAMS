// HarnessAMS top-level plugin entry: server health checks / disk usage / storage capacity / workspace directory management.
// Design notes:
// - Host half: ctx.webServer.register serves /harnessams/* APIs and a self-contained HTML console
//   (no dependency on the client-bundle mechanism);
// - Health checks: local-mode items are checked directly; remote nodes follow the channel priority —
//   (1) dsh-remote-ssh-ops HTTP (presence probe only; the command-execution route surface is not
//       yet inventoried),
//   (3) fallback: system OpenSSH wrapped in `bash -c`, BatchMode + keys, credentials left to the
//       system (never persisted by us);
// - Disk usage: local du (first-level workspace dirs) + fs.statfs capacity; remote nodes via the
//   du check in the remote command set;
// - Workspace directory management: local workspace config readout (harnessams.json + nodes.yaml
//   template display);
// - sidebar.right tab registration (client half): enabled after the spike; the console itself is
//   served at /harnessams/ui.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ---------- Workspace location and config ----------

function findWorkspaceConfig() {
  // Convention: harnessams-workspace/harnessams.json (or a bare harnessams.json); search upward
  // from the plugin package and from cwd. Two levels above this file is the project root
  // when dev-mounted (src -> HarnessAMS -> <project root>).
  const roots = [process.cwd(), path.resolve(import.meta.dirname ?? '.', '../..'), os.homedir()]
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
function parseNodesYaml(text) {
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

function readNodes(wsDir) {
  const p = path.join(wsDir, 'nodes.yaml')
  if (!fs.existsSync(p)) return { path: p, nodes: [] }
  return { path: p, nodes: parseNodesYaml(fs.readFileSync(p, 'utf8')) }
}

// ---------- Local-mode checks (local items run locally) ----------

async function runLocalChecks(ws) {
  const results = []
  const t = async (name, fn) => {
    const t0 = Date.now()
    try { results.push({ item: name, ...(await fn()), ms: Date.now() - t0, ok: true }) }
    catch (e) { results.push({ item: name, ok: false, detail: String(e.message ?? e), ms: Date.now() - t0 }) }
  }
  await t('Connectivity (local)', async () => ({ result: 'local', detail: os.hostname() }))
  await t('Node', async () => ({ result: process.version }))
  await t('Python', async () => {
    const { stdout } = await execFileAsync('python', ['--version'], { timeout: 15000 })
    return { result: stdout.trim() }
  })
  await t('ngspice present', async () => {
    const cmd = ws?.config?.ngspice_cmd
    if (!cmd || !fs.existsSync(cmd)) throw new Error(`missing or not configured: ${cmd ?? '(none)'}`)
    const { stdout } = await execFileAsync(cmd, ['-v'], { timeout: 20000 })
    const line = stdout.split(/\r?\n/).find((l) => /version|ngspice/i.test(l) && /\d/.test(l))
    return { result: (line || stdout.split(/\r?\n/)[0] || 'ngspice').trim().slice(0, 80) }
  })
  await t('sky130 PDK present', async () => {
    const lib = ws?.config?.pdk_lib
    if (!lib || !fs.existsSync(lib)) throw new Error(`missing or not configured: ${lib ?? '(none)'}`)
    const dir = path.dirname(lib) // the combined_models directory (real footprint)
    let bytes = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name)
        if (e.isDirectory()) walk(q)
        else bytes += fs.statSync(q).size
      }
    }
    walk(dir)
    return { result: `fossi combined_models, entry ${path.basename(lib)} (directory totals ${(bytes / 1024 / 1024).toFixed(1)} MB)` }
  })
  await t('Disk capacity (workspace)', async () => {
    const st = await fsp.statfs(ws?.config?.workspace_root ?? process.cwd())
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!total) throw new Error('statfs returned 0')
    return { result: `${(total / 2 ** 30).toFixed(1)} GiB total, ${(free / 2 ** 30).toFixed(1)} GiB free`
             + ` (${(100 * (total - free) / total).toFixed(0)}% used)`,
             warn: free / total < 0.1 ? 'free space < 10%' : undefined }
  })
  await t('Workspace writable', async () => {
    const probe = path.join(ws?.config?.workspace_root ?? process.cwd(), '.write_probe')
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe)
    return { result: 'writable' }
  })
  return results
}

async function localDiskUsage(ws) {
  const root = ws?.config?.workspace_root
  if (!root || !fs.existsSync(root)) return []
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(root, e.name)
    let bytes = 0, files = 0
    const walk = async (d) => {
      let dirs = []
      try {
        for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
          const q = path.join(d, ent.name)
          if (ent.isDirectory()) dirs.push(q)
          else { try { bytes += (await fsp.stat(q)).size; files++ } catch { /* skip */ } }
        }
      } catch { /* permissions etc. */ }
      await Promise.all(dirs.map(walk))
    }
    await walk(p)
    out.push({ name: e.name, bytes, files })
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, 20)
}

// ---------- Remote node checks (fixed command set; fallback channel = bash -c wrapped MSYS2 ssh) ----------

const REMOTE_CHECKS = [
  { id: 'connect', item: 'Connectivity', cmd: 'echo ok', judge: (out) => out.includes('ok') },
  { id: 'load', item: 'Load', cmd: 'cat /proc/loadavg && nproc', judge: () => true },
  { id: 'mem', item: 'Memory', cmd: 'free -m | head -2', judge: () => true },
  { id: 'disk', item: 'Disk', cmd: 'df -h ${WORKSPACE:-$HOME} | tail -1', judge: () => true },
  { id: 'ws', item: 'Workspace reachable', cmd: 'ls -ld ${WORKSPACE:-$HOME}', judge: (out) => out.trim().startsWith('d') },
  { id: 'ngspice', item: 'ngspice present', cmd: 'which ngspice && ngspice -v 2>&1 | head -1', judge: (out) => out.trim().length > 0 },
  { id: 'du', item: 'Disk usage detail', cmd: 'du -sh ${WORKSPACE:-$HOME}/* 2>/dev/null | sort -rh | head -20', judge: () => true },
]

async function sshRun(node, remoteCmd, timeoutMs = 15000) {
  // Fallback channel: always wrapped in `bash -c` (PATH resolves to the MSYS2 ssh,
  // avoiding System32 9.5p2); BatchMode forbids interactive passwords; keys are left to the system
  // OpenSSH (credentials never persisted).
  const target = node.HOSTNAME ? `${node.HOST}@${node.HOSTNAME}${node.PORT && node.PORT !== 22 ? ' -p ' + node.PORT : ''}`
    : String(node.HOST)
  const cli = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
               '-o', 'StrictHostKeyChecking=accept-new', target, remoteCmd]
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', cli.map(q => `'${String(q).replace(/'/g, `'\\''`)}'`).join(' ')],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
    return { ok: true, stdout, stderr, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: String(e.message ?? e), ms: Date.now() - t0 }
  }
}

async function runNodeChecks(node, ws) {
  const workspace = node.WORKSPACE || ws?.config?.remote_workspace || '$HOME'
  const results = []
  for (const c of REMOTE_CHECKS) {
    const cmd = c.cmd.replaceAll('${WORKSPACE:-$HOME}', workspace)
    const r = await sshRun(node, cmd)
    const out = (r.stdout || '') + (r.stderr || '')
    results.push({ item: c.item, cmd: `ssh ${node.HOST} ${cmd}`, ok: r.ok && c.judge(out),
                   result: (r.ok ? (r.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' | ') : '').slice(0, 200),
                   detail: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 200), ms: r.ms })
  }
  return results
}

async function probeOpsPlugin(req) {
  // Main-channel presence probe: verified anchor GET /remote-ssh-ops/v1/hosts -> 200.
  // The port comes from this request's Host header (probing the DSH Web instance serving us).
  // The full command-execution route surface is not yet inventoried, so this only
  // reports presence — no guessed endpoints.
  try {
    const host = req?.headers?.host ?? '127.0.0.1:3080'
    const res = await fetch(`http://${host}/remote-ssh-ops/v1/hosts`, { signal: AbortSignal.timeout(3000) })
    return { present: res.ok, status: res.status }
  } catch (e) {
    return { present: false, status: 0, error: String(e.message ?? e) }
  }
}

export const name = 'dsh-harnessams'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => {
    ctx.webServer.register({
      kind: 'prefix',
      path: '/harnessams',
      handler: (req, res) => { void handle(req, res).catch((e) => { try { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })) } catch { /* already responded */ } }) },
    }, 'harnessams routes')
    if (ctx.logger?.info) ctx.logger.info('[harnessams] routes mounted at /harnessams')
    else console.log('[harnessams] routes mounted at /harnessams')
  }, 'harnessams webserver routes')
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.replace(/^\/harnessams/, '') || '/'
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

  const ws = findWorkspaceConfig()

  if (req.method !== 'GET' && req.method !== 'HEAD') { json(405, { error: 'GET only' }); return }

  if (route === '/' || route === '/ui') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(UI_HTML)
    return
  }
  if (route === '/api/info') {
    json(200, {
      ok: true, plugin: 'dsh-harnessams', workspace: ws ? { root: ws.config.workspace_root, config_path: ws.configPath } : null,
      ops_plugin: await probeOpsPlugin(req),
    })
    return
  }
  if (route === '/api/check-local') {
    if (!ws) { json(503, { error: 'harnessams-workspace/harnessams.json not found' }); return }
    json(200, { ok: true, node: 'local', results: await runLocalChecks(ws) })
    return
  }
  if (route === '/api/check') {
    const host = url.searchParams.get('node')
    if (!host) { json(400, { error: 'missing node parameter' }); return }
    if (host === 'local') { json(200, { ok: true, node: 'local', results: await runLocalChecks(ws) }); return }
    const nodes = ws ? readNodes(path.dirname(ws.configPath)).nodes : []
    const node = nodes.find((n) => String(n.HOST) === host)
    if (!node) { json(404, { error: `no such node in nodes.yaml: ${host} (or nodes.yaml has no real nodes configured)` }); return }
    json(200, { ok: true, node: host, results: await runNodeChecks(node, ws) })
    return
  }
  if (route === '/api/nodes') {
    const data = ws ? readNodes(path.dirname(ws.configPath)) : { path: null, nodes: [] }
    json(200, { ok: true, path: data.path, nodes: data.nodes,
                ops_plugin: await probeOpsPlugin(req),
                hint: 'HOST is also the ~/.ssh/config alias; credentials stay with the system OpenSSH; the programmatic path is BatchMode' })
    return
  }
  if (route === '/api/disk') {
    if (!ws) { json(503, { error: 'workspace config not found' }); return }
    json(200, { ok: true, root: ws.config.workspace_root, entries: await localDiskUsage(ws) })
    return
  }
  if (route === '/api/dirs') {
    if (!ws) { json(503, { error: 'workspace config not found' }); return }
    const root = ws.config.workspace_root
    const demos = []
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        demos.push({ name: e.name,
                     has_sweep: fs.existsSync(path.join(root, e.name, 'sweep')),
                     reports: fs.existsSync(path.join(root, e.name, 'Analysis'))
                       ? (await fsp.readdir(path.join(root, e.name, 'Analysis'))).filter((f) => f.endsWith('.html')) : [] })
      }
    }
    const nodes = readNodes(path.dirname(ws.configPath))
    json(200, { ok: true, workspace_root: root, config_path: ws.configPath, demos, nodes_path: nodes.path,
                nodes: nodes.nodes.map((n) => ({ host: n.HOST, workspace: n.WORKSPACE ?? null, reserved: n.reserved === 'true' })),
                remote_workspace: ws.config.remote_workspace ?? null })
    return
  }
  if (route.startsWith('/reports/')) {
    // Embedded reports (decision #4): static read-only, whitelist root = workspace, no traversal
    const rel = decodeURIComponent(route.slice('/reports/'.length)).replace(/\\/g, '/')
    if (!ws || rel.includes('..')) { json(403, { error: 'forbidden' }); return }
    const abs = path.resolve(ws.config.workspace_root, rel)
    if (!abs.startsWith(path.resolve(ws.config.workspace_root)) || !fs.existsSync(abs)) { json(404, { error: 'not found' }); return }
    const st = await fsp.stat(abs)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': st.size })
    res.end(await fsp.readFile(abs))
    return
  }
  json(404, { error: `unknown route: ${route}` })
}

// ---------- Self-contained console UI (same shape as the reports: no build step, no external
// dependencies; API-driven) ----------

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>HarnessAMS Console</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0 24px 40px; color: #1c2733; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin: 22px 0 8px; border-left: 4px solid #2b6cb0; padding-left: 8px; }
  .meta { color: #5a6b7b; font-size: 13px; }
  button { padding: 5px 14px; font-size: 14px; cursor: pointer; }
  select { padding: 4px 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
  th, td { border: 1px solid #d7e0e8; padding: 4px 8px; text-align: left; }
  th { background: #eef3f8; }
  tr.fail td { background: #fde8e8; }
  .ok { color: #1a7f37; } .bad { color: #c62828; font-weight: 600; }
  .warn { color: #b26a00; }
  pre { background: #f6f8fa; padding: 8px; font-size: 12px; overflow: auto; }
  #ops-badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 12px; }
</style>
</head>
<body>
<h1>HarnessAMS Console</h1>
<div class="meta" id="info">Loading…</div>
<h2>Server health checks</h2>
<div>
  Node:<select id="node-sel"></select>
  <button id="btn-check">Check</button>
  <span class="meta" id="check-status"></span>
</div>
<table id="check-table" style="display:none">
  <thead><tr><th>Item</th><th>Command</th><th>Result</th><th>Elapsed</th><th>Status</th><th>Diagnose</th></tr></thead>
  <tbody id="check-body"></tbody>
</table>
<h2>Disk usage (local workspace)</h2>
<button id="btn-disk">Refresh usage</button>
<table id="disk-table" style="display:none">
  <thead><tr><th>Directory</th><th>Size</th><th>Files</th></tr></thead><tbody id="disk-body"></tbody>
</table>
<h2>Workspace directory management</h2>
<div id="dirs" class="meta">Loading…</div>
<h2>Sweep reports</h2>
<div id="reports" class="meta">Loading…</div>
<script>
async function jget(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " -> " + r.status); return r.json(); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;"); }
function fmtBytes(b) { const u=["B","KiB","MiB","GiB"]; let i=0; while (b>=1024&&i<3){b/=1024;i++;} return b.toFixed(1)+" "+u[i]; }

(async function init() {
  try {
    const info = await jget("/harnessams/api/info");
    document.getElementById("info").textContent =
      "Workspace: " + (info.workspace ? info.workspace.root : "harnessams-workspace not found");
    const ops = info.ops_plugin;
    const badge = document.createElement("span");
    badge.id = "ops-badge";
    badge.textContent = ops.present ? "dsh-remote-ssh-ops loaded (main channel present)"
                                    : "dsh-remote-ssh-ops not loaded (remote commands use the direct-ssh fallback)";
    badge.style.background = ops.present ? "#e6f4ea" : "#fdf3e3";
    document.getElementById("info").appendChild(document.createElement("br"));
    document.getElementById("info").appendChild(badge);
  } catch (e) { document.getElementById("info").textContent = "info failed: " + e; }

  const sel = document.getElementById("node-sel");
  sel.innerHTML = '<option value="local">local</option>';
  try {
    const n = await jget("/harnessams/api/nodes");
    (n.nodes || []).forEach(function (nd) {
      const o = document.createElement("option");
      o.value = nd.HOST; o.textContent = nd.HOST + (nd.WORKSPACE ? " (" + nd.WORKSPACE + ")" : "");
      sel.appendChild(o);
    });
  } catch (e) { /* keep local only */ }

  document.getElementById("btn-check").onclick = async function () {
    const st = document.getElementById("check-status"); st.textContent = "Checking…";
    try {
      const node = sel.value;
      const r = await jget("/harnessams/api/check?node=" + encodeURIComponent(node));
      const tb = document.getElementById("check-table"); tb.style.display = "";
      const body = document.getElementById("check-body"); body.innerHTML = "";
      let fails = 0;
      r.results.forEach(function (x) {
        if (!x.ok) fails++;
        const tr = document.createElement("tr");
        if (!x.ok) tr.className = "fail";
        tr.innerHTML = "<td>" + esc(x.item) + "</td><td><code>" + esc(x.cmd || "-") + "</code></td>" +
          "<td>" + esc(x.result || x.detail || "-") + (x.warn ? ' <span class="warn">⚠ ' + esc(x.warn) + "</span>" : "") + "</td>" +
          "<td>" + x.ms + " ms</td>" +
          "<td class='" + (x.ok ? "ok" : "bad") + "'>" + (x.ok ? "✅" : "✗") + "</td>" +
          "<td>" + (x.ok ? "" : '<button class="diag-btn" data-i="' + esc(x.item) + '">Diagnose with agent</button>') + "</td>";
        body.appendChild(tr);
      });
      st.textContent = fails ? "Done: " + fails + " failure(s)" : "Done: all checks passed";
    } catch (e) { st.textContent = "failed: " + e; }
  };

  document.getElementById("check-body").addEventListener("click", function (e) {
    const b = e.target.closest(".diag-btn");
    if (!b) return;
    // One-click diagnosis of a failing item: produce a prompt pasteable into a DSH session
    // (remote items go through host_* tools)
    const t = "HarnessAMS health-check failure [" + b.dataset.i + "] — please diagnose: read the " +
      "/harnessams/api/check results, reproduce the failing command via host_* tools " +
      "(dsh-remote-ssh-ops) or a BatchMode ssh direct connection, and report the conclusion.";
    prompt("Copy the following instruction into a DSH session (degraded form: no deep link into sessions):", t);
  };

  document.getElementById("btn-disk").onclick = async function () {
    try {
      const r = await jget("/harnessams/api/disk");
      const tb = document.getElementById("disk-table"); tb.style.display = "";
      const body = document.getElementById("disk-body"); body.innerHTML = "";
      r.entries.forEach(function (e) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(e.name) + "</td><td>" + fmtBytes(e.bytes) + "</td><td>" + e.files + "</td>";
        body.appendChild(tr);
      });
    } catch (e) { alert("disk failed: " + e); }
  };

  try {
    const d = await jget("/harnessams/api/dirs");
    let html = "<b>workspace_root</b>: " + esc(d.workspace_root) + "<br><b>demo projects</b>:<ul>" +
      d.demos.map(function (p) { return "<li>" + esc(p.name) + (p.has_sweep ? " (has sweep)" : "") + "</li>"; }).join("") + "</ul>";
    html += "<b>Remote node config</b> (config storage only; no remote switching): " +
      (d.nodes.length ? "<ul>" + d.nodes.map(function (n) {
        return "<li>" + esc(n.host) + " → " + esc(n.workspace || "(WORKSPACE unset)") + (n.reserved ? " [reserved]" : "") + "</li>";
      }).join("") + "</ul>" : "nodes.yaml has no configured nodes yet (see the workspace template)");
    document.getElementById("dirs").innerHTML = html;
    let reps = "(none)";
    for (const p of d.demos) for (const f of p.reports) {
      reps = "";
      const a = document.createElement("a");
      a.href = "/harnessams/reports/" + encodeURIComponent(p.name) + "/Analysis/" + encodeURIComponent(f);
      a.textContent = p.name + " / " + f;
      a.target = "_blank";
      const wrap = document.getElementById("reports");
      if (wrap.dataset.started !== "1") { wrap.innerHTML = ""; wrap.dataset.started = "1"; }
      wrap.appendChild(a); wrap.appendChild(document.createElement("br"));
    }
    if (reps) document.getElementById("reports").textContent = reps;
  } catch (e) { document.getElementById("dirs").textContent = "dirs failed: " + e; }
})();
</script>
</body>
</html>
`
