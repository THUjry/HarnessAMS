// HarnessAMS client half — the three-tier UI:
//   tier 1: global console page ("HarnessAMS" entry in the left sidebar -> full panel):
//           remote projects (dsh-remote machines + one-click remote-project creation),
//           digital assets (plotly status + report library), disk usage;
//   tier 2: project = DSH workspace (a local folder) — no per-session data; every
//           session of a workspace shares one task list; a workspace inside a
//           dsh-remote mirror is a REMOTE PROJECT;
//   tier 3: right-sidebar task tab — a tab strip over the active project's tasks with
//           "+" to create; the Overview sub-view carries the health-check buttons
//           (remote projects: per-machine one-click checks; local projects: one
//           local-environment report). Remote file browsing/editing is NOT here —
//           dsh-remote's own tools and web surface do that.
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
        'rproj.title': '远程项目',
        'rproj.dshremoteOk': 'dsh-remote：{n} 台机器',
        'rproj.dshremoteMissing': 'dsh-remote 不可用',
        'rproj.colMachine': '机器',
        'rproj.colHost': '主机',
        'rproj.colWorkspace': '远程工作区',
        'rproj.colMirror': '本地镜像',
        'rproj.colProject': '远程项目',
        'rproj.mirrorYes': '镜像',
        'rproj.mirrorNone': '无 — 需先在 dsh-remote 选择一次远程工作区',
        'rproj.projectNone': '未创建',
        'rproj.create': '创建远程项目',
        'rproj.creating': '创建中…',
        'rproj.created': '已创建：{title}',
        'rproj.current': ' · 当前',
        'rproj.hint': '推荐每台机器一个远程项目；远程文件的浏览与编辑直接使用 dsh-remote 自带功能。',
        'rproj.empty': 'dsh-remote 中还没有机器 — 请先在 dsh-remote 里添加。',
        'chk.title': '健康检查',
        'chk.machine': '机器：{m}',
        'chk.remoteArea': '远程区：{path}',
        'chk.mirrorDir': '本地镜像：{p}',
        'chk.sessions': '项目会话：{n}',
        'chk.lastConnected': '上次连接：{t}',
        'chk.latency': '{n} ms 延迟',
        'chk.notInRegistry': '（未匹配到 dsh-remote 机器记录）',
        'chk.running': '检查中…',
        'chk.colItem': '检查项',
        'chk.colResult': '结果',
        'chk.colElapsed': '耗时',
        'chk.colStatus': '状态',
        'chk.diagnose': '交给 agent 诊断',
        'chk.promptCopied': '提示词已复制 — 请粘贴到 DSH 会话中。',
        'chk.copyPrompt': '请将下面的提示词复制到 DSH 会话：',
        'chk.noneYet': '点击按钮运行一项检查。',
        'chk.btn.load': '负载',
        'chk.btn.jobs': 'LSF 作业',
        'chk.btn.batches': '批次目录',
        'chk.btn.scripts': '脚本同步',
        'chk.btn.local': '本机环境',
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
        'rproj.title': 'Remote projects',
        'rproj.dshremoteOk': 'dsh-remote: {n} machine(s)',
        'rproj.dshremoteMissing': 'dsh-remote not available',
        'rproj.colMachine': 'machine',
        'rproj.colHost': 'host',
        'rproj.colWorkspace': 'remote workspace',
        'rproj.colMirror': 'local mirror',
        'rproj.colProject': 'remote project',
        'rproj.mirrorYes': 'mirror',
        'rproj.mirrorNone': 'none — pick a remote workspace once in dsh-remote',
        'rproj.projectNone': 'not created',
        'rproj.create': 'Create remote project',
        'rproj.creating': 'Creating…',
        'rproj.created': 'created: {title}',
        'rproj.current': ' · current',
        'rproj.hint': 'One remote project per machine is the recommended setup; browse and edit remote files with dsh-remote itself.',
        'rproj.empty': 'no machines in dsh-remote yet — add one there.',
        'chk.title': 'Health check',
        'chk.machine': 'Machine: {m}',
        'chk.remoteArea': 'Remote area: {path}',
        'chk.mirrorDir': 'Local mirror: {p}',
        'chk.sessions': 'Project sessions: {n}',
        'chk.lastConnected': 'Last connected: {t}',
        'chk.latency': '{n} ms latency',
        'chk.notInRegistry': ' (no matching dsh-remote machine record)',
        'chk.running': 'Running…',
        'chk.colItem': 'Item',
        'chk.colResult': 'Result',
        'chk.colElapsed': 'Elapsed',
        'chk.colStatus': 'Status',
        'chk.diagnose': 'Diagnose with agent',
        'chk.promptCopied': 'Prompt copied — paste it into a DSH session.',
        'chk.copyPrompt': 'Copy the prompt below into a DSH session:',
        'chk.noneYet': 'Click a button to run a check.',
        'chk.btn.load': 'Load',
        'chk.btn.jobs': 'LSF jobs',
        'chk.btn.batches': 'Batch dirs',
        'chk.btn.scripts': 'Script sync',
        'chk.btn.local': 'Local environment',
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
        h(Boundary, null, h(RemoteProjectsSection, null)),
        h(Boundary, null, h(AssetsSection, null)),
        h(Boundary, null, h(DiskSection, null)),
      )
    }

    // Remote projects (tier 1): the dsh-remote machine list with each machine's mirror
    // and remote-project workspace. Machine management itself lives in dsh-remote —
    // here we only read the registry and offer one-click remote-project creation
    // (ensure mirror + register the mirror directory as a DSH workspace).
    function RemoteProjectsSection() {
      const [machines, setMachines] = useState(null)
      const [err, setErr] = useState(null)
      const [msg, setMsg] = useState(null)
      const [creating, setCreating] = useState(null)
      const load = () => {
        fetchJson(API + '/machines').then(setMachines).catch((e) => setMachines({ installed: false, reason: String(e.message ?? e) }))
      }
      useEffect(load, [])
      const create = async (m) => {
        setCreating(m.id); setErr(null); setMsg(null)
        try {
          const r = await fetchJson(API + '/remote-project',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machineId: m.id }) })
          setMsg(tr('rproj.created', { title: r.workspace?.title ?? r.workspace?.path ?? '' }))
          load()
        } catch (e) { setErr(String(e.message ?? e)) }
        setCreating(null)
      }
      return h('section', { className: 'hams-section' },
        h('h2', null, tr('rproj.title')),
        h('div', { className: 'hams-row' },
          machines && (machines.installed
            ? h('span', { className: 'hams-badge hams-badge-good', title: machines.source }, tr('rproj.dshremoteOk', { n: machines.machines?.length ?? 0 }))
            : h('span', { className: 'hams-badge hams-badge-bad', title: machines.reason ?? '' }, tr('rproj.dshremoteMissing'))),
        ),
        err && h('div', { className: 'hams-err' }, err),
        msg && h('div', { className: 'hams-dim' }, msg),
        machines?.installed && (machines.machines?.length ?? 0) > 0 && h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null, [tr('rproj.colMachine'), tr('rproj.colHost'), tr('rproj.colWorkspace'), tr('rproj.colMirror'), tr('rproj.colProject'), ''].map((c) => h('th', null, c)))),
          h('tbody', null, machines.machines.map((m) => h('tr', { key: m.id },
            h('td', null, esc(m.name || m.host) + (m.current ? tr('rproj.current') : '')),
            h('td', null, esc((m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22))),
            h('td', null, esc(m.workspace ?? '')),
            h('td', { title: m.mirror?.mirrorDir ?? '' },
              m.mirror ? h('span', { className: 'hams-good' }, tr('rproj.mirrorYes'))
                : h('span', { className: 'hams-warn' }, tr('rproj.mirrorNone'))),
            h('td', null,
              m.remoteProject ? esc(m.remoteProject.title || m.remoteProject.path)
                : m.mirror
                  ? h('button', { className: 'hams-btn hams-btn-sm', disabled: creating === m.id, onClick: () => create(m) },
                      creating === m.id ? tr('rproj.creating') : tr('rproj.create'))
                  : h('span', { className: 'hams-dim' }, tr('rproj.projectNone'))))))),
        machines?.installed && (machines.machines?.length ?? 0) === 0 && h('div', { className: 'hams-dim' }, tr('rproj.empty')),
        h('div', { className: 'hams-dim' }, tr('rproj.hint')),
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

    // Overview health-check panel: for a remote project, a status header (machine,
    // remote area, local mirror, project sessions) plus one button per check; for a
    // local project, a single local-environment report button. Every button runs
    // independently and replaces the results table below it.
    function CheckPanel({ info, run, onRun }) {
      const remote = info?.type === 'remote' ? info.remote : null
      const running = run?.status === 'running'
      const diagnose = (item) => {
        const t = 'HarnessAMS health-check failure [' + item + '] — please diagnose: read the ' +
          '/harnessams/api/checks/run results, reproduce the failing command with the rw_* tools ' +
          "(dsh-remote) in this project's session, and report the conclusion."
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => alert(tr('chk.promptCopied')), () => prompt(tr('chk.copyPrompt'), t))
        else prompt(tr('chk.copyPrompt'), t)
      }
      const machineName = remote
        ? (remote.machine ? remote.machine.name : (remote.username ? remote.username + '@' : '') + remote.host + ':' + remote.port)
        : ''
      return h('div', { style: { marginTop: '10px' } },
        h('div', { className: 'hams-dim' }, h('b', null, tr('chk.title'))),
        remote && h('div', { style: { fontSize: '12.5px', margin: '4px 0', lineHeight: 1.6 } },
          h('div', null, tr('chk.machine', { m: machineName + (remote.machine?.current ? tr('rproj.current') : '') })
            + (remote.machine?.latencyMs != null ? ' · ' + tr('chk.latency', { n: remote.machine.latencyMs }) : '')),
          h('div', null, tr('chk.remoteArea', { path: remote.remotePath || '—' })),
          h('div', { title: remote.mirrorDir }, tr('chk.mirrorDir', { p: remote.mirrorDir })),
          h('div', null, tr('chk.sessions', { n: remote.liveSessions })
            + (remote.machine?.lastConnectedAt ? ' · ' + tr('chk.lastConnected', { t: String(remote.machine.lastConnectedAt).slice(0, 19).replace('T', ' ') }) : '')),
          !remote.machine && h('div', { className: 'hams-warn' }, tr('chk.notInRegistry'))),
        h('div', { className: 'hams-row' },
          (info?.buttons ?? []).map((b) => h('button', {
            key: b.id,
            className: 'hams-btn hams-btn-sm',
            disabled: running,
            title: b.item,
            onClick: () => onRun(b.id),
          }, running && run?.id === b.id ? tr('chk.running') : tr('chk.btn.' + b.id)))),
        run?.status === 'failed' && h('div', { className: 'hams-err' }, run.error),
        run?.results && h('div', null,
          h('table', { className: 'hams-table' },
            h('thead', null, h('tr', null, [tr('chk.colItem'), tr('chk.colResult'), tr('chk.colElapsed'), tr('chk.colStatus'), ''].map((c) => h('th', null, c)))),
            h('tbody', null, run.results.map((x, i) => h('tr', { key: i, className: x.ok ? '' : 'hams-rowbad' },
              h('td', { title: x.cmd ?? '' }, esc(x.item)),
              h('td', null,
                esc(x.result || x.detail || '-'),
                x.warn ? h('span', { className: 'hams-warn' }, ' ⚠ ' + esc(x.warn)) : null,
                x.ok && x.detail ? h('div', { className: 'hams-pre' }, esc(x.detail)) : null),
              h('td', null, x.ms + ' ms'),
              h('td', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'),
              h('td', null, x.ok ? null : h('button', { className: 'hams-btn hams-btn-sm', onClick: () => diagnose(x.item) }, tr('chk.diagnose'))))))),
          run.channel && h('div', { className: 'hams-dim' }, esc(run.channel))),
        !run && h('div', { className: 'hams-dim' }, tr('chk.noneYet')),
      )
    }

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
      const [checksInfo, setChecksInfo] = useState(null)
      const [checkRun, setCheckRun] = useState(null) // { id, status, results?, channel?, error? }

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

      // Overview check surface for the current project (remote vs local); fetched
      // independently of the task list so a failed check surface never blocks tasks.
      useEffect(() => {
        let alive = true
        setChecksInfo(null); setCheckRun(null)
        if (!projectPath || !sessionId) return
        fetchJson(API + '/checks?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => { if (alive) setChecksInfo(r) })
          .catch(() => { if (alive) setChecksInfo(null) })
        return () => { alive = false }
      }, [projectPath, sessionId])

      const runCheck = async (id) => {
        setCheckRun({ id, status: 'running', results: null })
        try {
          const r = await fetchJson(API + '/checks/run?sessionId=' + encodeURIComponent(sessionId) + '&check=' + encodeURIComponent(id))
          setCheckRun({ id, status: 'done', results: r.results, channel: r.channel })
        } catch (e) {
          setCheckRun({ id, status: 'failed', error: String(e.message ?? e), results: null })
        }
      }

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
              checksInfo && h(CheckPanel, { info: checksInfo, run: checkRun, onRun: runCheck }),
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
