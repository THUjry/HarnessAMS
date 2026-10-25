// HarnessAMS client half — the three-tier UI:
//   tier 1: global console page ("HarnessAMS" entry in the left sidebar -> full panel):
//           server management (nodes.yaml CRUD + per-node checks + dsh-remote alignment),
//           digital assets (plotly status + report library), disk usage;
//   tier 2: project = DSH workspace (a local folder) — no per-session data; every
//           session of a workspace shares one task list;
//   tier 3: right-sidebar task tab — a tab strip over the active project's tasks with
//           "+" to create, following the active conversation's workspace switch.
// Classic script on the host module loader (same shape as dsh-remote's client): the
// factory receives a synchronous require, React comes from the host page, and the whole
// client is one file — combo-loaded classic scripts cannot import sibling modules.
// Each section is wrapped in an error boundary: one failing area never blanks the rest.
window.__ModuleLoader__.load({
  id: 'dsh-harnessams',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React

    const name = 'dsh-harnessams'
    const PANEL_ID = 'dsh-harnessams'
    const TAB_ID = 'dsh-harnessams'
    const TAB_KIND = 'harnessams'
    const API = '/harnessams/api'

    // ---------- i18n ----------
    // Client copy is locale-owned: zh/en dictionaries with stable keys and
    // {param} interpolation, en as the fallback so a missing translation shows
    // the English text (never the raw key) when the active locale is zh. The
    // active language follows the DSH locale service once wired in apply();
    // before that (or when the service is absent) it falls back to the browser
    // language, else English. Same shape as dsh-remote's client.
    const NS = 'dsh-harnessams'
    const L = {
      zh: {
        'common.loading': '加载中…',
        'common.save': '保存',
        'common.cancel': '取消',
        'common.none': '（无）',
        'common.sectionFailed': '此区块加载失败：',
        'console.title': 'HarnessAMS 控制台',
        'console.infoFailed': 'info 读取失败：{msg}',
        'console.workspace': '工作区：{path}',
        'console.noWorkspace': '未找到 harnessams-workspace — 服务器检查需要 harnessams.json',
        'servers.title': '服务器',
        'servers.dshremoteOk': 'dsh-remote：{n} 台机器',
        'servers.dshremoteMissing': 'dsh-remote 不可用',
        'servers.nodesMissing': '未找到 nodes.yaml',
        'servers.colMachine': 'dsh-remote 机器',
        'servers.colHost': '主机',
        'servers.colWorkspace': '工作区',
        'servers.colChannel': 'rw_exec 通道',
        'servers.currentSuffix': ' · 当前',
        'servers.mirror': '镜像',
        'servers.activeMachine': '活动机器',
        'servers.noWorkspacePick': '无 — 请先选择一次工作区',
        'servers.noNodes': 'nodes.yaml 中还没有配置节点',
        'servers.reserved': '保留',
        'servers.known': '已登记',
        'servers.notInRegistry': '不在注册表中',
        'servers.editNodes': '编辑节点',
        'servers.saved': '已保存到 {path}（注释已重写）',
        'servers.addNode': '+ 节点',
        'servers.saveHint': '保存会重写 nodes.yaml；凭据绝不写入此文件。',
        'servers.healthCheck': '健康检查：',
        'servers.local': '本机',
        'servers.nodeOption': '{host}（nodes.yaml）',
        'servers.dshrmOption': '{name}（dsh-remote{suffix}）',
        'servers.suffixMirror': '，镜像',
        'servers.suffixCurrent': '，当前',
        'servers.checking': '检查中…',
        'servers.check': '检查',
        'servers.colItem': '检查项',
        'servers.colCommand': '命令',
        'servers.colResult': '结果',
        'servers.colElapsed': '耗时',
        'servers.colChannel': '通道',
        'servers.colStatus': '状态',
        'servers.diagnose': '交给 agent 诊断',
        'servers.promptCopied': '提示词已复制 — 请粘贴到 DSH 会话中。',
        'servers.copyPrompt': '请将下面的提示词复制到 DSH 会话：',
        'assets.title': '数字资产',
        'assets.plotlyOk': 'plotly.min.js 已就绪 — {size}',
        'assets.plotlyMissing': '缺少 plotly 资产',
        'assets.openAsset': '打开资产',
        'assets.sharedCopy': '离线报告渲染共用这一份副本（MIT，见 THIRD_PARTY_NOTICES.md）。',
        'assets.sweepReports': '扫描报告：',
        'disk.title': '磁盘占用（本地工作区）',
        'disk.refresh': '刷新占用',
        'disk.colDir': '目录',
        'disk.colSize': '大小',
        'disk.colFiles': '文件数',
        'disk.empty': '（工作区为空或未配置）',
        'tasks.noSession': '无活动会话',
        'tasks.loadingProject': '正在加载项目…',
        'tasks.noProject': '此会话没有对应项目。',
        'tasks.noTasks': '还没有任务 — 点“+”创建第一个。',
        'tasks.projectLabel': '项目：',
        'tasks.viewOverview': '概览',
        'tasks.viewDashboard': '仪表盘',
        'tasks.viewSim': '仿真设置',
        'tasks.deleteAria': '删除 {name}',
        'tasks.newTask': '新建任务',
        'tasks.addTask': '+ 任务',
        'tasks.deleteConfirm': '删除任务“{name}”？',
        'tasks.descPlaceholder': '任务描述…',
        'tasks.nameLabel': '名称',
        'tasks.descOptional': '描述（可选）',
        'tasks.create': '创建',
        'tasks.dashPlaceholder': '占位 — 本任务的扫描报告与图表将在后续里程碑落地。',
        'tasks.simTitle': '仿真设置',
        'tasks.simPlaceholder': '占位 — 本任务的 SmartAnaSim 配置将在后续里程碑落地。',
        'tasks.pinOn': '已固定：切换会话/工作区时任务侧栏会自动重开 — 点击取消跟随',
        'tasks.pinOff': '未固定：切换会话时侧栏收起 — 点击让它跟随切换',
        'tasks.headerPinOn': 'HarnessAMS 任务 — 已固定：随会话/工作区切换重开',
        'tasks.headerPinOff': 'HarnessAMS 任务 — 打开侧栏（固定以跟随会话切换）',
        'tasks.headerTasks': '任务',
        'tasks.guideDesc': '项目任务',
      },
      en: {
        'common.loading': 'Loading…',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.none': '(none)',
        'common.sectionFailed': 'This section failed: ',
        'console.title': 'HarnessAMS Console',
        'console.infoFailed': 'info failed: {msg}',
        'console.workspace': 'Workspace: {path}',
        'console.noWorkspace': 'harnessams-workspace not found — server checks need harnessams.json',
        'servers.title': 'Servers',
        'servers.dshremoteOk': 'dsh-remote: {n} machine(s)',
        'servers.dshremoteMissing': 'dsh-remote not available',
        'servers.nodesMissing': 'nodes.yaml not found',
        'servers.colMachine': 'dsh-remote machine',
        'servers.colHost': 'host',
        'servers.colWorkspace': 'workspace',
        'servers.colChannel': 'rw_exec channel',
        'servers.currentSuffix': ' · current',
        'servers.mirror': 'mirror',
        'servers.activeMachine': 'active machine',
        'servers.noWorkspacePick': 'none — pick a workspace once',
        'servers.noNodes': 'nodes.yaml has no configured nodes yet',
        'servers.reserved': 'reserved',
        'servers.known': 'known',
        'servers.notInRegistry': 'not in registry',
        'servers.editNodes': 'Edit nodes',
        'servers.saved': 'saved to {path} (comments rewritten)',
        'servers.addNode': '+ node',
        'servers.saveHint': 'Saving rewrites nodes.yaml; credentials never go in this file.',
        'servers.healthCheck': 'Health check:',
        'servers.local': 'local',
        'servers.nodeOption': '{host} (nodes.yaml)',
        'servers.dshrmOption': '{name} (dsh-remote{suffix})',
        'servers.suffixMirror': ', mirror',
        'servers.suffixCurrent': ', current',
        'servers.checking': 'Checking…',
        'servers.check': 'Check',
        'servers.colItem': 'Item',
        'servers.colCommand': 'Command',
        'servers.colResult': 'Result',
        'servers.colElapsed': 'Elapsed',
        'servers.colChannel': 'Channel',
        'servers.colStatus': 'Status',
        'servers.diagnose': 'Diagnose with agent',
        'servers.promptCopied': 'Prompt copied — paste it into a DSH session.',
        'servers.copyPrompt': 'Copy the prompt below into a DSH session:',
        'assets.title': 'Digital assets',
        'assets.plotlyOk': 'plotly.min.js served — {size}',
        'assets.plotlyMissing': 'plotly asset missing',
        'assets.openAsset': 'open asset',
        'assets.sharedCopy': 'Offline report rendering shares this single copy (MIT, see THIRD_PARTY_NOTICES.md).',
        'assets.sweepReports': 'Sweep reports:',
        'disk.title': 'Disk usage (local workspace)',
        'disk.refresh': 'Refresh usage',
        'disk.colDir': 'Directory',
        'disk.colSize': 'Size',
        'disk.colFiles': 'Files',
        'disk.empty': '(workspace empty or not configured)',
        'tasks.noSession': 'no active session',
        'tasks.loadingProject': 'Loading project…',
        'tasks.noProject': 'No project for this session.',
        'tasks.noTasks': 'No tasks yet — create the first one with “+”.',
        'tasks.projectLabel': 'Project: ',
        'tasks.viewOverview': 'Overview',
        'tasks.viewDashboard': 'Dashboard',
        'tasks.viewSim': 'Sim settings',
        'tasks.deleteAria': 'Delete {name}',
        'tasks.newTask': 'New task',
        'tasks.addTask': '+ task',
        'tasks.deleteConfirm': 'Delete task “{name}”?',
        'tasks.descPlaceholder': 'Task description…',
        'tasks.nameLabel': 'Name',
        'tasks.descOptional': 'Description (optional)',
        'tasks.create': 'Create',
        'tasks.dashPlaceholder': 'Placeholder — sweep reports and plots for this task land here in later milestones.',
        'tasks.simTitle': 'Simulation settings',
        'tasks.simPlaceholder': 'Placeholder — SmartAnaSim configuration for this task lands here in later milestones.',
        'tasks.pinOn': 'Pinned: the task tab reopens when you switch sessions/workspaces — click to stop following',
        'tasks.pinOff': 'Not pinned: the sidebar collapses on session switch — click to make it follow switches',
        'tasks.headerPinOn': 'HarnessAMS tasks — pinned: reopens on session/workspace switch',
        'tasks.headerPinOff': 'HarnessAMS tasks — open the tab (pin it to follow session switches)',
        'tasks.headerTasks': 'Tasks',
        'tasks.guideDesc': 'Project tasks',
      },
    }

    let ACTIVE_LANG = 'en'
    try {
      const nav = (typeof navigator !== 'undefined' && navigator.languages) ? navigator.languages : (typeof navigator !== 'undefined' ? [navigator.language] : [])
      for (const tag of nav) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh') { ACTIVE_LANG = 'zh'; break }
        if (primary === 'en') { ACTIVE_LANG = 'en'; break }
      }
    } catch { /* keep en */ }

    function makeTr() {
      const dict = L[ACTIVE_LANG] || L.en
      return (key, params) => {
        let text = dict[key]
        if (text === undefined && ACTIVE_LANG !== 'en') text = L.en[key]
        if (text === undefined) text = key
        if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
        return text
      }
    }
    let tr = makeTr()
    // Called from apply() once the real locale service is reachable; registers
    // both dictionaries and rebinds tr so the client's Language setting wins.
    function wireLocale(ctx) {
      try {
        const locale = ctx && ctx.get && ctx.get('locale')
        if (!locale || typeof locale.register !== 'function') return
        const dispose = locale.register(NS, { zh: L.zh, en: L.en })
        const bound = locale.bind(NS)
        tr = (key, params) => {
          let text = bound(key, params)
          if (text === key) {
            const d = L[ACTIVE_LANG] || L.en
            text = d[key] !== undefined ? d[key] : L.en[key]
            if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
          }
          return text
        }
        if (ctx.effect) ctx.effect(() => dispose, 'dsh-harnessams.locale')
      } catch (e) { /* keep local dict fallback */ }
    }

    // ---------- shared helpers ----------

    async function fetchJson(url, opts) {
      const r = await fetch(url, opts)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error ?? url + ' -> ' + r.status)
      return body
    }

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() {
        if (this.state.err) {
          return h('div', { className: 'hams-err' },
            tr('common.sectionFailed'), String(this.state.err?.message ?? this.state.err))
        }
        return this.props.children
      }
    }

    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 2, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M4.5 6h7M4.5 8.5h7M4.5 11h4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    }

    function ensureCss() {
      if (document.getElementById('dsh-harnessams-css')) return
      const el = document.createElement('style')
      el.id = 'dsh-harnessams-css'
      el.textContent = `
.hams-page { padding: 20px 28px 48px; max-width: 1000px; font-size: 14px; }
.hams-h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
.hams-meta { opacity: .7; font-size: 12.5px; margin-bottom: 14px; }
.hams-section { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 12px 16px 14px; margin: 14px 0; }
.hams-section > h2 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
.hams-table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
.hams-table th, .hams-table td { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 3px 8px; text-align: left; vertical-align: top; }
.hams-table th { opacity: .7; font-weight: 500; }
.hams-rowbad td { background: color-mix(in srgb, #e05252 12%, transparent); }
.hams-good { color: #3fb950; } .hams-bad { color: #e05252; font-weight: 600; } .hams-warn { color: #d29922; }
.hams-btn { padding: 3px 12px; font-size: 13px; border-radius: 6px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent); color: inherit; }
.hams-btn:disabled { opacity: .45; cursor: default; }
.hams-btn-sm { padding: 0 7px; font-size: 12px; }
.hams-input, .hams-select, .hams-textarea { font-size: 13px; border-radius: 5px; padding: 3px 7px; color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 4%, transparent); font-family: inherit; }
.hams-input, .hams-textarea { width: 100%; box-sizing: border-box; }
.hams-textarea { min-height: 90px; resize: vertical; }
.hams-badge { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 12px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.hams-badge-good { color: #3fb950; border-color: color-mix(in srgb, #3fb950 45%, transparent); }
.hams-badge-bad { color: #d29922; border-color: color-mix(in srgb, #d29922 45%, transparent); }
.hams-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.hams-err { color: #e05252; padding: 8px; font-size: 13px; }
.hams-pre { font-size: 11.5px; white-space: pre-wrap; margin: 4px 0; opacity: .8; overflow: auto; }
.hams-link { color: inherit; }
.hams-dim { opacity: .65; font-size: 12.5px; }
/* tier 3: task tab strip (modeled after dsh-ssh-ops' server tab strip) */
.hams-tabstrip { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 6px 8px 0;
  border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.hams-tasktab { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; max-width: 180px;
  border-radius: 6px 6px 0 0; cursor: pointer; font-size: 12.5px;
  border: 1px solid transparent; border-bottom: none; }
.hams-tasktab.active { border-color: color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 7%, transparent); }
.hams-tasktab .hams-tabname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-tasktab .hams-x { opacity: .55; cursor: pointer; font-size: 13px; line-height: 1; }
.hams-tasktab .hams-x:hover { opacity: 1; color: #e05252; }
.hams-addbtn { border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); background: none;
  color: inherit; border-radius: 6px; padding: 2px 9px; cursor: pointer; font-size: 13px; }
.hams-body { padding: 10px 12px; overflow: auto; }
.hams-dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.38); display: flex;
  align-items: center; justify-content: center; z-index: 90; }
.hams-dialog { border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: 9px;
  padding: 16px 18px; min-width: 320px; max-width: 440px;
  background: color-mix(in srgb, black 20%, canvas); color: fieldtext;
  color: light-dark(canvasText, #e6e6e6); backdrop-filter: blur(3px); }
.hams-dialog h3 { margin: 0 0 10px; font-size: 14.5px; font-weight: 600; }
.hams-field { margin: 8px 0; }
.hams-field label { display: block; font-size: 12px; opacity: .7; margin-bottom: 3px; }
.hams-taskdesc { margin-top: 8px; }
.hams-subtabs { display: flex; gap: 2px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  margin-bottom: 8px; }
.hams-subtab { padding: 3px 10px; font-size: 12px; cursor: pointer; color: inherit; background: none;
  border: none; border-bottom: 2px solid transparent; opacity: .7; }
.hams-subtab.active { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
.hams-dash { margin-top: 12px; border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 14px; opacity: .75; font-size: 12.5px; }
.hams-headerbtn { display: inline-flex; align-items: center; gap: 4px; }
.hams-pin-on { border-color: color-mix(in srgb, #3fb950 45%, transparent); color: #3fb950; }
`
      document.head.append(el)
    }

    function fmtBytes(b) {
      const u = ['B', 'KiB', 'MiB', 'GiB']
      let i = 0
      while (b >= 1024 && i < 3) { b /= 1024; i++ }
      return b.toFixed(1) + ' ' + u[i]
    }

    function esc(s) { return String(s ?? '') }

    // ---------- tier 1: global console page ----------

    function ConsolePage() {
      const [info, setInfo] = useState(null)
      const [infoErr, setInfoErr] = useState(null)
      useEffect(() => {
        fetchJson(API + '/info').then(setInfo).catch((e) => setInfoErr(String(e.message ?? e)))
      }, [])
      return h('div', { className: 'hams-page' },
        h('h1', { className: 'hams-h1' }, tr('console.title')),
        h('div', { className: 'hams-meta' },
          infoErr ? h('span', { className: 'hams-bad' }, tr('console.infoFailed', { msg: infoErr }))
            : info ? (info.workspace
              ? tr('console.workspace', { path: info.workspace.root }) + (info.tiers?.project === 'workspaceRegistry mapped' ? '' : ' — ' + info.tiers?.project)
              : tr('console.noWorkspace'))
            : tr('common.loading')),
        h(Boundary, null, h(ServersSection, null)),
        h(Boundary, null, h(AssetsSection, null)),
        h(Boundary, null, h(DiskSection, null)),
      )
    }

    const NODE_FIELDS = ['HOST', 'HOSTNAME', 'PORT', 'WORKSPACE', 'reserved']

    function ServersSection() {
      const [nodes, setNodes] = useState(null)
      const [nodesPath, setNodesPath] = useState(null)
      const [draft, setDraft] = useState([])
      const [editing, setEditing] = useState(false)
      const [err, setErr] = useState(null)
      const [saveMsg, setSaveMsg] = useState(null)
      const [machines, setMachines] = useState(null)
      const [checkNode, setCheckNode] = useState('local')
      const [check, setCheck] = useState(null) // { status, results }

      const load = () => {
        fetchJson(API + '/nodes').then((d) => { setNodes(d.nodes); setNodesPath(d.path) }).catch((e) => setErr(String(e.message ?? e)))
        fetchJson(API + '/machines').then(setMachines).catch((e) => setMachines({ installed: false, reason: String(e.message ?? e) }))
      }
      useEffect(load, [])

      const startEdit = () => {
        setDraft((nodes ?? []).map((n) => ({ ...n })))
        setEditing(true); setErr(null); setSaveMsg(null)
      }
      const setField = (i, k, v) => {
        setDraft((d) => d.map((row, j) => j === i ? { ...row, [k]: v } : row))
      }
      const addRow = () => setDraft((d) => [...d, { HOST: '', HOSTNAME: '', PORT: '', WORKSPACE: '', reserved: 'false' }])
      const delRow = (i) => setDraft((d) => d.filter((_, j) => j !== i))
      const save = async () => {
        try {
          const r = await fetchJson(API + '/nodes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: draft }) })
          setNodes(r.nodes); setEditing(false); setSaveMsg(tr('servers.saved', { path: r.path }))
        } catch (e) { setErr(String(e.message ?? e)) }
      }
      const runCheck = async () => {
        setCheck({ status: 'running', results: null })
        try {
          let r
          if (checkNode.startsWith('dshrm:')) {
            const id = checkNode.slice('dshrm:'.length)
            const m = (machines?.machines ?? []).find((x) => x.id === id)
            r = await fetchJson(API + '/check-remote?machine=' + encodeURIComponent(id))
            setCheck({ status: 'done', node: (m ? (m.name || m.host) : id) + ' (dsh-remote)', results: r.results })
          } else {
            r = await fetchJson(API + '/check?node=' + encodeURIComponent(checkNode))
            setCheck({ status: 'done', node: checkNode, results: r.results })
          }
        } catch (e) { setCheck({ status: 'failed: ' + e.message, results: null }) }
      }
      const diagnose = (item) => {
        const t = 'HarnessAMS health-check failure [' + item + '] — please diagnose: read the ' +
          '/harnessams/api/check results, reproduce the failing command via rw_* tools ' +
          '(dsh-remote) or a BatchMode ssh direct connection, and report the conclusion.'
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => alert(tr('servers.promptCopied')), () => prompt(tr('servers.copyPrompt'), t))
        else prompt(tr('servers.copyPrompt'), t)
      }

      const known = useMemo(() => new Set((machines?.machines ?? []).map((m) => m.name.toLowerCase())), [machines])

      return h('section', { className: 'hams-section' },
        h('h2', null, tr('servers.title')),
        h('div', { className: 'hams-row' },
          machines && (machines.installed
            ? h('span', { className: 'hams-badge hams-badge-good', title: machines.source }, tr('servers.dshremoteOk', { n: machines.machines?.length ?? 0 }))
            : h('span', { className: 'hams-badge hams-badge-bad', title: machines.reason ?? '' }, tr('servers.dshremoteMissing'))),
          machines && !machines.installed && h('span', { className: 'hams-dim' }, machines.fallback ?? ''),
          h('span', { className: 'hams-dim' }, nodesPath ? nodesPath : tr('servers.nodesMissing')),
        ),
        err && h('div', { className: 'hams-err' }, err),
        machines?.installed && (machines.machines?.length ?? 0) > 0 && h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null, [tr('servers.colMachine'), tr('servers.colHost'), tr('servers.colWorkspace'), tr('servers.colChannel')].map((c) => h('th', null, c)))),
          h('tbody', null, machines.machines.map((m) => h('tr', { key: m.id },
            h('td', null, esc(m.name || m.host) + (m.current ? tr('servers.currentSuffix') : '')),
            h('td', null, esc((m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22))),
            h('td', null, esc(m.workspace ?? '')),
            h('td', null, m.mirror ? h('span', { className: 'hams-good' }, tr('servers.mirror'))
              : m.current ? h('span', { className: 'hams-good' }, tr('servers.activeMachine'))
              : h('span', { className: 'hams-warn' }, tr('servers.noWorkspacePick')))))),
        !editing
          ? h('div', null,
              h('table', { className: 'hams-table' },
                h('thead', null, h('tr', null, ['HOST', 'HOSTNAME', 'PORT', 'WORKSPACE', 'reserved', 'dsh-remote'].map((c) => h('th', null, c)))),
                h('tbody', null,
                  (nodes ?? []).length === 0 && h('tr', null, h('td', { colSpan: 6 }, h('span', { className: 'hams-dim' }, tr('servers.noNodes')))),
                  (nodes ?? []).map((n) => h('tr', null,
                    h('td', null, h('b', null, esc(n.HOST))),
                    h('td', null, esc(n.HOSTNAME ?? '')),
                    h('td', null, esc(n.PORT ?? '')),
                    h('td', null, esc(n.WORKSPACE ?? '')),
                    h('td', null, n.reserved === 'true' ? tr('servers.reserved') : ''),
                    h('td', null, machines?.installed
                      ? (known.has(String(n.HOST).toLowerCase())
                        ? h('span', { className: 'hams-good' }, tr('servers.known'))
                        : h('span', { className: 'hams-warn' }, tr('servers.notInRegistry')))
                      : '—'),
                  )))),
              h('div', { className: 'hams-row' },
                h('button', { className: 'hams-btn', onClick: startEdit, disabled: !nodes }, tr('servers.editNodes')),
                saveMsg && h('span', { className: 'hams-dim' }, saveMsg)))
          : h('div', null,
              h('table', { className: 'hams-table' },
                h('thead', null, h('tr', null, NODE_FIELDS.concat(['']).map((c) => h('th', null, c)))),
                h('tbody', null, draft.map((n, i) => h('tr', null,
                  NODE_FIELDS.map((k) => h('td', { key: k },
                    k === 'reserved'
                      ? h('select', { className: 'hams-select', value: n[k] === 'true' ? 'true' : 'false', onChange: (e) => setField(i, k, e.target.value) },
                          h('option', { value: 'false' }, 'false'), h('option', { value: 'true' }, 'true'))
                      : h('input', { className: 'hams-input', value: esc(n[k] ?? ''), onChange: (e) => setField(i, k, e.target.value) }))),
                  h('td', null, h('button', { className: 'hams-btn hams-btn-sm', onClick: () => delRow(i) }, '✕')))))),
              h('div', { className: 'hams-row' },
                h('button', { className: 'hams-btn', onClick: save }, tr('common.save')),
                h('button', { className: 'hams-btn', onClick: () => { setEditing(false); setErr(null) } }, tr('common.cancel')),
                h('button', { className: 'hams-btn', onClick: addRow }, tr('servers.addNode')),
                h('span', { className: 'hams-dim' }, tr('servers.saveHint'))))),
        h('div', { className: 'hams-row', style: { marginTop: '10px' } },
          h('label', { className: 'hams-dim' }, tr('servers.healthCheck')),
          h('select', { className: 'hams-select', value: checkNode, onChange: (e) => setCheckNode(e.target.value) },
            h('option', { value: 'local' }, tr('servers.local')),
            (nodes ?? []).map((n) => h('option', { key: n.HOST, value: n.HOST }, tr('servers.nodeOption', { host: n.HOST }))),
            (machines?.machines ?? []).map((m) => h('option', { key: m.id, value: 'dshrm:' + m.id },
              tr('servers.dshrmOption', { name: m.name || m.host, suffix: m.mirror ? tr('servers.suffixMirror') : m.current ? tr('servers.suffixCurrent') : '' })))),
          h('button', { className: 'hams-btn', onClick: runCheck, disabled: check?.status === 'running' }, check?.status === 'running' ? tr('servers.checking') : tr('servers.check')),
          check?.status && check.status !== 'done' && check.status !== 'running' && h('span', { className: 'hams-bad' }, check.status)),
        check?.results && h('div', null,
          h('table', { className: 'hams-table' },
            h('thead', null, h('tr', null, [tr('servers.colItem'), tr('servers.colCommand'), tr('servers.colResult'), tr('servers.colElapsed'), tr('servers.colChannel'), tr('servers.colStatus'), ''].map((c) => h('th', null, c)))),
            h('tbody', null, check.results.map((x, i) => h('tr', { key: i, className: x.ok ? '' : 'hams-rowbad' },
              h('td', null, esc(x.item)),
              h('td', null, h('code', null, esc(x.cmd ?? '-'))),
              h('td', null, esc(x.result || x.detail || '-') + (x.warn ? ' ' : ''), x.warn ? h('span', { className: 'hams-warn' }, '⚠ ' + esc(x.warn)) : null),
              h('td', null, x.ms + ' ms'),
              h('td', { className: 'hams-dim' }, esc(x.channel ?? '')),
              h('td', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'),
              h('td', null, x.ok ? null : h('button', { className: 'hams-btn hams-btn-sm', onClick: () => diagnose(x.item) }, tr('servers.diagnose'))))))))
      )
    }

    function AssetsSection() {
      const [assets, setAssets] = useState(null)
      const [dirs, setDirs] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        fetchJson(API + '/assets').then(setAssets).catch((e) => setErr(String(e.message ?? e)))
        fetchJson(API + '/dirs').then(setDirs).catch((e) => setErr(String(e.message ?? e)))
      }, [])
      const reports = []
      for (const d of dirs?.demos ?? []) for (const f of d.reports ?? []) reports.push(d.name + '/Analysis/' + f)
      return h('section', { className: 'hams-section' },
        h('h2', null, tr('assets.title')),
        err && h('div', { className: 'hams-err' }, err),
        h('div', { className: 'hams-row' },
          assets?.plotly?.available
            ? h('span', { className: 'hams-badge hams-badge-good' }, tr('assets.plotlyOk', { size: fmtBytes(assets.plotly.bytes) }))
            : h('span', { className: 'hams-badge hams-badge-bad' }, tr('assets.plotlyMissing')),
          assets?.plotly?.available && h('a', { className: 'hams-link', href: assets.plotly.url, target: '_blank' }, tr('assets.openAsset')),
        ),
        h('div', { className: 'hams-dim' }, tr('assets.sharedCopy')),
        h('div', { style: { marginTop: '8px' } },
          h('div', { className: 'hams-dim' }, tr('assets.sweepReports')),
          reports.length === 0 && h('div', { className: 'hams-dim' }, tr('common.none')),
          reports.map((r) => h('div', { key: r },
            h('a', { className: 'hams-link', href: '/harnessams/reports/' + r.split('/').map(encodeURIComponent).join('/'), target: '_blank' }, r))),
        ),
      )
    }

    function DiskSection() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const refresh = () => { setData(null); fetchJson(API + '/disk').then(setData).catch((e) => setErr(String(e.message ?? e))) }
      useEffect(refresh, [])
      return h('section', { className: 'hams-section' },
        h('h2', null, tr('disk.title')),
        h('button', { className: 'hams-btn', onClick: refresh }, tr('disk.refresh')),
        err && h('div', { className: 'hams-err' }, err),
        data && h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null, [tr('disk.colDir'), tr('disk.colSize'), tr('disk.colFiles')].map((c) => h('th', null, c)))),
          h('tbody', null, data.entries.map((e) => h('tr', { key: e.name },
            h('td', null, e.name), h('td', null, fmtBytes(e.bytes)), h('td', null, String(e.files)))))),
        data && data.entries.length === 0 && h('div', { className: 'hams-dim' }, tr('disk.empty')),
      )
    }

    // ---------- tier 3: per-project task sidebar ----------

    // Lowest navigation level inside a task: overview / dashboard / sim settings
    // (dashboard and sim settings are placeholders until their milestones land).
    const TASK_VIEWS = [
      { id: 'overview', labelKey: 'tasks.viewOverview' },
      { id: 'dashboard', labelKey: 'tasks.viewDashboard' },
      { id: 'sim', labelKey: 'tasks.viewSim' },
    ]

    function TaskSidebarBody(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const [project, setProject] = useState(undefined) // undefined=loading, null=none
      const [reason, setReason] = useState(null)
      const [tasks, setTasks] = useState([])
      const [selectedId, setSelectedId] = useState(null)
      const [view, setView] = useState('overview')
      const [error, setError] = useState(null)
      const [dialogOpen, setDialogOpen] = useState(false)
      const [descDraft, setDescDraft] = useState(null)

      const projectPath = project?.path ?? null

      useEffect(() => {
        let alive = true
        setError(null)
        if (!sessionId) { setProject(null); setReason(tr('tasks.noSession')); return }
        setProject(undefined)
        fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return
            setProject(r.project ?? null)
            setReason(r.project ? null : r.reason ?? null)
          })
          .catch((e) => { if (alive) { setProject(null); setReason(String(e.message ?? e)) } })
        return () => { alive = false }
      }, [sessionId])

      useEffect(() => {
        let alive = true
        if (!projectPath || !sessionId) { setTasks([]); setSelectedId(null); return }
        fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId))
          .then((d) => {
            if (!alive) return
            setTasks(d.tasks ?? [])
            setSelectedId((prev) => (d.tasks ?? []).some((t) => t.id === prev) ? prev : (d.tasks?.[0]?.id ?? null))
          })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [projectPath, sessionId])

      // persist() returns the server-confirmed list (new tasks get their ids server-side),
      // or null on failure (the optimistic update stays and the error shows inline).
      const persist = async (next) => {
        setTasks(next)
        try {
          const r = await fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId),
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: next }) })
          const saved = r.tasks ?? next
          setTasks(saved)
          return saved
        } catch (e) {
          setError(String(e.message ?? e))
          return null
        }
      }

      const selected = tasks.find((t) => t.id === selectedId) ?? null

      const createTask = async (name, description) => {
        const saved = await persist([...tasks, { name, description: description || '' }])
        if (saved && saved.length) setSelectedId(saved[saved.length - 1].id)
      }
      const removeTask = (id) => {
        const t = tasks.find((x) => x.id === id)
        if (!t) return
        if (!window.confirm(tr('tasks.deleteConfirm', { name: t.name }))) return
        const next = tasks.filter((x) => x.id !== id)
        if (selectedId === id) setSelectedId(next[0]?.id ?? null)
        persist(next)
      }
      const saveDescription = () => {
        if (!selected || descDraft === null) return
        persist(tasks.map((t) => t.id === selected.id ? { ...t, description: descDraft } : t))
        setDescDraft(null)
      }

      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
        // tab strip: one card per task, "+" to create (modeled after dsh-ssh-ops' server tabs);
        // trailing pin toggle controls the reopen-on-switch behavior
        h('div', { className: 'hams-tabstrip' },
          tasks.map((t) => h('div', {
              key: t.id,
              className: 'hams-tasktab' + (t.id === selectedId ? ' active' : ''),
              title: t.name,
              onClick: () => { setSelectedId(t.id); setDescDraft(null) },
            },
            h('span', { className: 'hams-tabname' }, t.name),
            h('span', { className: 'hams-x', role: 'button', 'aria-label': tr('tasks.deleteAria', { name: t.name }),
              onClick: (e) => { e.stopPropagation(); removeTask(t.id) } }, '×'))),
          project && h('button', { className: 'hams-addbtn', title: tr('tasks.newTask'), onClick: () => setDialogOpen(true) },
            tasks.length ? '+' : tr('tasks.addTask')),
          h(PinToggle, null),
        ),
        h('div', { className: 'hams-body' },
          error && h('div', { className: 'hams-err' }, error),
          project === undefined && h('div', { className: 'hams-dim' }, tr('tasks.loadingProject')),
          project === null && h('div', { className: 'hams-dim' }, tr('tasks.noProject'), h('br'), null, esc(reason ?? '')),
          project && tasks.length === 0 && !error && h('div', { className: 'hams-dim' },
            tr('tasks.noTasks')),
          project && h('div', { className: 'hams-dim' },
            tr('tasks.projectLabel'), h('b', null, esc(project.title || project.path)), h('br'), null, esc(project.path)),
          selected && h('div', { style: { marginTop: '10px' } },
            // lowest level: per-task sub navigation (overview / dashboard / sim settings)
            h('div', { className: 'hams-subtabs', role: 'tablist' },
              TASK_VIEWS.map((v) => h('button', {
                key: v.id,
                className: 'hams-subtab' + (view === v.id ? ' active' : ''),
                role: 'tab',
                'aria-selected': view === v.id,
                onClick: () => setView(v.id),
              }, tr(v.labelKey)))),
            view === 'overview' && h('div', null,
              h('div', { className: 'hams-row' },
                h('b', null, selected.name),
                h('span', { className: 'hams-dim' }, selected.created_at ? selected.created_at.slice(0, 10) : '')),
              h('div', { className: 'hams-taskdesc' },
                h('textarea', {
                  className: 'hams-textarea',
                  value: descDraft ?? selected.description ?? '',
                  placeholder: tr('tasks.descPlaceholder'),
                  onChange: (e) => setDescDraft(e.target.value),
                }),
                descDraft !== null && h('div', { className: 'hams-row' },
                  h('button', { className: 'hams-btn hams-btn-sm', onClick: saveDescription }, tr('common.save')),
                  h('button', { className: 'hams-btn hams-btn-sm', onClick: () => setDescDraft(null) }, tr('common.cancel'))))),
            view === 'dashboard' && h('div', { className: 'hams-dash' },
              h('b', null, tr('tasks.viewDashboard')), h('br'),
              tr('tasks.dashPlaceholder')),
            view === 'sim' && h('div', { className: 'hams-dash' },
              h('b', null, tr('tasks.simTitle')), h('br'),
              tr('tasks.simPlaceholder'))),
        ),
        dialogOpen && h(NewTaskDialog, {
          onCancel: () => setDialogOpen(false),
          onCreate: async (n, d) => { setDialogOpen(false); await createTask(n, d) },
        }),
      )
    }

    function PinToggle() {
      const [pinned] = usePinned()
      return h('button', {
        className: 'hams-addbtn' + (pinned ? ' hams-pin-on' : ''),
        style: { marginLeft: 'auto' },
        'aria-pressed': pinned,
        title: pinned
          ? tr('tasks.pinOn')
          : tr('tasks.pinOff'),
        onClick: () => setPinnedValue(!pinStore.pinned),
      }, pinned ? '📌' : '📍')
    }

    function NewTaskDialog({ onCancel, onCreate }) {
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const valid = name.trim().length > 0
      return h('div', { className: 'hams-dialog-backdrop', onClick: (e) => { if (e.target === e.currentTarget) onCancel() } },
        h('div', { className: 'hams-dialog' },
          h('h3', null, tr('tasks.newTask')),
          h('div', { className: 'hams-field' },
            h('label', null, tr('tasks.nameLabel')),
            h('input', { className: 'hams-input', autoFocus: true, value: name,
              onChange: (e) => setName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && valid) onCreate(name.trim(), description) } })),
          h('div', { className: 'hams-field' },
            h('label', null, tr('tasks.descOptional')),
            h('textarea', { className: 'hams-textarea', value: description, onChange: (e) => setDescription(e.target.value) })),
          h('div', { className: 'hams-row', style: { justifyContent: 'flex-end' } },
            h('button', { className: 'hams-btn', onClick: onCancel }, tr('common.cancel')),
            h('button', { className: 'hams-btn', disabled: !valid, onClick: () => onCreate(name.trim(), description) }, tr('tasks.create')))))
    }

    // Sticky task sidebar: DSH resets the right sidebar to its start page whenever the
    // conversation switches. While pinned (default on), the header button re-opens the
    // task tab on every sessionId change so the sidebar follows workspace switches
    // instead of collapsing. Clicking the header button always opens + pins; the pin
    // toggle lives at the end of the task tab strip.
    let openSidebarTab = null
    const STICKY_KEY = 'hams-task-sidebar-pinned'
    const pinStore = {
      pinned: (() => { try { return localStorage.getItem(STICKY_KEY) !== '0' } catch { return true } })(),
      listeners: new Set(),
    }
    function setPinnedValue(v) {
      pinStore.pinned = v
      try { localStorage.setItem(STICKY_KEY, v ? '1' : '0') } catch { /* private mode */ }
      for (const l of pinStore.listeners) l(v)
    }
    function usePinned() {
      const [v, setV] = useState(pinStore.pinned)
      useEffect(() => {
        pinStore.listeners.add(setV)
        return () => { pinStore.listeners.delete(setV) }
      }, [])
      return [v]
    }

    function SessionHeaderButton(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const [pinned] = usePinned()
      useEffect(() => {
        if (!pinned || !sessionId || !openSidebarTab) return
        // the host tears the right pane down and up around a switch; a short delay
        // keeps the reopen from landing on the intermediate state
        const t = setTimeout(() => { if (openSidebarTab) openSidebarTab() }, 350)
        return () => clearTimeout(t)
      }, [sessionId, pinned])
      return h('button', {
        className: 'hams-btn hams-btn-sm hams-headerbtn' + (pinned ? ' hams-pin-on' : ''),
        'aria-pressed': pinned,
        title: pinned
          ? tr('tasks.headerPinOn')
          : tr('tasks.headerPinOff'),
        onClick: () => { if (!pinStore.pinned) setPinnedValue(true); if (openSidebarTab) openSidebarTab() },
      }, tr('tasks.headerTasks'), pinned ? ' 📌' : '')
    }

    // ---------- assembly ----------

    function apply(ctx) {
      ensureCss()
      wireLocale(ctx)
      const slots = ctx.get('slots')
      // tier 1: global page — keyed "main" panel plus its left-sidebar entry (official
      // providers sit at order 0 Plugins / 10 Automation tasks; 20 lands right after).
      slots.inject('main', () =>
        slots.register({ name: 'main', key: PANEL_ID }, ConsolePage))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'HarnessAMS' }, PanelIcon))
      // tier 3: right-sidebar tab — body keyed to the tab id receives the active
      // sessionId via props (verified: switching sessions updates the prop).
      slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, TaskSidebarBody))
      ctx.inject(['sidebarRightTabs'], (inner) => {
        const tabs = inner.get('sidebarRightTabs')
        inner.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'HarnessAMS',
          guide: [{ order: 20, title: () => 'HarnessAMS', description: () => tr('tasks.guideDesc'), icon: PanelIcon }],
        }), 'harnessams sidebar tab')
      })
      // One-click reopen: DSH resets the right sidebar to its start page on session
      // switch, so the conversation header keeps a direct entry point.
      ctx.inject(['sidebarRight'], (inner) => {
        const right = inner.get('sidebarRight')
        openSidebarTab = () => {
          try { right.openTab(TAB_KIND) } catch { try { right.openTab(TAB_ID) } catch { /* tab service unavailable */ } }
        }
        inner.effect(() => () => { if (openSidebarTab) openSidebarTab = null }, 'harnessams header button handler')
        slots.inject('conversation.session.header.actions', () =>
          slots.register({ name: 'conversation.session.header.actions', id: 'dsh-harnessams-open', order: 20 }, SessionHeaderButton))
      })
    }

    exports.name = name
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
