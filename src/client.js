// HarnessAMS client half — the three-tier UI:
//   tier 1: global console page ("HarnessAMS" entry in the left sidebar -> full panel):
//           remote projects (dsh-remote machines + one-click remote-project creation),
//           digital assets (plotly status + report library), disk usage;
//   tier 2: project = DSH workspace (a local folder) — no per-session data; every
//           session of a workspace shares one task list; a workspace inside a
//           dsh-remote mirror is a REMOTE PROJECT and renders NO sidebar (connection
//           anchor only; dsh-remote itself browses its files);
//   tier 3: right-sidebar task tab, LOCAL projects only — a tab strip over the active
//           project's tasks with "+" to create; the Overview sub-view carries the
//           health-check buttons (local environment + one block per machine with a
//           remote project: load / LSF jobs / batch dirs / script sync, borrowed from
//           that remote project's live session); the Dashboard sub-view shows the
//           task-registered local HTML reports (browse-to-add / dropdown / reload).
//           Remote file browsing/editing is NOT here — dsh-remote's own tools do it.
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
    const { useState, useEffect, useMemo, useRef } = React

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
        'chk.remoteArea': '远程区：{path}',
        'chk.mirrorDir': '本地镜像：{p}',
        'chk.sessions': '项目会话：{n}',
        'chk.lastConnected': '上次连接：{t}',
        'chk.latency': '{n} ms 延迟',
        'chk.noSession': '无项目会话——在远程项目“{title}”中打开一个会话后即可检查',
        'chk.needRemoteProject': '还没有机器建立远程项目——在 HarnessAMS 控制台页创建后即可在此检查。',
        'chk.running': '检查中…',
        'chk.colItem': '检查项',
        'chk.colResult': '结果',
        'chk.colElapsed': '耗时',
        'chk.colStatus': '状态',
        'chk.diagnose': '交给 agent 诊断',
        'chk.promptCopied': '提示词已复制 — 请粘贴到 DSH 会话中。',
        'chk.copyPrompt': '请将下面的提示词复制到 DSH 会话：',
        'chk.noneYet': '点击按钮运行一项检查。',
        'chk.truncated': '（列表已截断）',
        'chk.rootLegend': '$ROOT = {path}',
        'chk.btn.load': '负载',
        'chk.btn.jobs': 'LSF 作业',
        'chk.btn.batches': '批次目录',
        'chk.btn.scripts': '脚本同步',
        'chk.btn.local': '本机环境',
        'chk.lc.load1': '1 分钟',
        'chk.lc.load5': '5 分钟',
        'chk.lc.load15': '15 分钟',
        'chk.lc.procs': '进程 (可运行/总数)',
        'chk.lc.cpus': 'CPU 核数',
        'chk.jc.jobid': '作业号',
        'chk.jc.stat': '状态',
        'chk.jc.exec': '执行节点',
        'chk.jc.name': '作业名',
        'chk.jc.submit': '提交时间',
        'chk.bc.dir': '目录',
        'chk.bc.status': '状态',
        'chk.bc.progress': '进度',
        'chk.sc.file': '文件',
        'chk.sc.state': '同步状态',
        'chk.sync.in-sync': '一致',
        'chk.sync.differs': '不一致',
        'chk.sync.only-local': '仅本地',
        'chk.sync.only-remote': '仅远程',
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
        'tasks.remoteProjectNote': '远程项目不提供 HarnessAMS 侧边栏——远程文件的浏览与编辑请直接使用 dsh-remote；检查与任务请在本地项目中进行。',
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
        'dash.noReports': '（暂无报告）',
        'dash.addTitle': '添加 HTML 报告',
        'dash.refresh': '刷新报告（强制重载）',
        'dash.remove': '移除当前报告（只解除登记，不删除文件）',
        'dash.openTab': '在新标签页打开',
        'dash.empty': '尚未添加报告 — 浏览本地磁盘加入已有的 HTML 报告。',
        'dash.addFirst': '+ 添加报告',
        'dash.currentDir': '当前目录',
        'dash.parentDir': '上一级',
        'dash.pickFile': '选择 HTML 文件（点击即添加）',
        'dash.emptyDir': '（此目录没有子目录或 HTML 文件）',
        'dash.manualLabel': '或输入报告的绝对路径',
        'dash.manualPlaceholder': 'D:\\path\\to\\report.html',
        'dash.add': '添加',
        'tasks.viewTerm': '远程终端',
        'term.noMachines': '没有可连的远程机器 — 在 dsh-remote 里选择机器并创建远程项目后，从总览页运行一次检查即可出现在这里。',
        'term.infoMissing': '机器信息未加载（总览检查信息不可用）。',
        'term.connect': '连接',
        'term.reopen': '重新打开终端',
        'term.dead': '终端会话已失效（空闲超时或远端会话已结束）。',
        'term.closed': '远端会话已结束。',
        'term.startDir': '起始目录',
        'term.noSession': '无活会话 — 切到该机远程项目一次后再来（保持连接）。',
        'term.search': '搜索（Enter 下一个 / Shift+Enter 上一个 / Esc 关闭）',
        'term.searchNo': '无匹配',
        'term.snippets': '快捷命令（点击填入，回车执行）',
        'term.loading': '正在加载终端组件…',
        'term.vendorFail': '终端组件加载失败：{msg}',
        'term.unavailable': 'dsh-remote 终端路由不可用（需 dsh-remote ≥ 0.8.54）。',
        'term.fontSize': '字号（Ctrl+滚轮可调）',
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
        'chk.remoteArea': 'Remote area: {path}',
        'chk.mirrorDir': 'Local mirror: {p}',
        'chk.sessions': 'Project sessions: {n}',
        'chk.lastConnected': 'Last connected: {t}',
        'chk.latency': '{n} ms latency',
        'chk.noSession': 'no live session — open a session in the remote project "{title}" to enable checks',
        'chk.needRemoteProject': 'no machine has a remote project yet — create one on the HarnessAMS console page to check it here.',
        'chk.running': 'Running…',
        'chk.colItem': 'Item',
        'chk.colResult': 'Result',
        'chk.colElapsed': 'Elapsed',
        'chk.colStatus': 'Status',
        'chk.diagnose': 'Diagnose with agent',
        'chk.promptCopied': 'Prompt copied — paste it into a DSH session.',
        'chk.copyPrompt': 'Copy the prompt below into a DSH session:',
        'chk.noneYet': 'Click a button to run a check.',
        'chk.truncated': '(list truncated)',
        'chk.rootLegend': '$ROOT = {path}',
        'chk.btn.load': 'Load',
        'chk.btn.jobs': 'LSF jobs',
        'chk.btn.batches': 'Batch dirs',
        'chk.btn.scripts': 'Script sync',
        'chk.btn.local': 'Local environment',
        'chk.lc.load1': '1 min',
        'chk.lc.load5': '5 min',
        'chk.lc.load15': '15 min',
        'chk.lc.procs': 'procs (run/total)',
        'chk.lc.cpus': 'CPUs',
        'chk.jc.jobid': 'job',
        'chk.jc.stat': 'stat',
        'chk.jc.exec': 'exec host',
        'chk.jc.name': 'name',
        'chk.jc.submit': 'submitted',
        'chk.bc.dir': 'directory',
        'chk.bc.status': 'status',
        'chk.bc.progress': 'progress',
        'chk.sc.file': 'file',
        'chk.sc.state': 'sync state',
        'chk.sync.in-sync': 'in sync',
        'chk.sync.differs': 'differs',
        'chk.sync.only-local': 'local only',
        'chk.sync.only-remote': 'remote only',
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
        'tasks.remoteProjectNote': 'No HarnessAMS sidebar in remote projects — browse and edit remote files with dsh-remote; run checks and manage tasks in a local project.',
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
        'dash.noReports': '(no reports)',
        'dash.addTitle': 'Add an HTML report',
        'dash.refresh': 'Reload the report (hard reload)',
        'dash.remove': 'Remove the current report (unregisters it; the file is kept)',
        'dash.openTab': 'Open in a new tab',
        'dash.empty': 'No report added yet — browse the local disk to add an existing HTML report.',
        'dash.addFirst': '+ Add report',
        'dash.currentDir': 'Current directory',
        'dash.parentDir': 'Parent directory',
        'dash.pickFile': 'Pick an HTML file (click to add it)',
        'dash.emptyDir': '(no subdirectories or HTML files here)',
        'dash.manualLabel': 'Or type the report’s absolute path',
        'dash.manualPlaceholder': '/path/to/report.html',
        'dash.add': 'Add',
        'tasks.viewTerm': 'Terminal',
        'term.noMachines': 'No reachable remote machine — pick a machine and create a remote project in dsh-remote, then run one check from the Overview for it to appear here.',
        'term.infoMissing': 'Machine info not loaded (Overview check info unavailable).',
        'term.connect': 'Connect',
        'term.reopen': 'Reopen the terminal',
        'term.dead': 'The terminal session is gone (idle timeout or the remote session ended).',
        'term.closed': 'The remote session ended.',
        'term.startDir': 'Start directory',
        'term.noSession': 'No live session — switch to this machine’s remote project once (keep it connected), then come back.',
        'term.search': 'Search (Enter next / Shift+Enter previous / Esc closes)',
        'term.searchNo': 'No match',
        'term.snippets': 'Snippets (click to fill, press Enter to run)',
        'term.loading': 'Loading the terminal component…',
        'term.vendorFail': 'Failed to load the terminal component: {msg}',
        'term.unavailable': 'dsh-remote terminal routes unavailable (needs dsh-remote ≥ 0.8.54).',
        'term.fontSize': 'Font size (Ctrl+wheel adjusts)',
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
.hams-page { padding: 20px 28px 48px; max-width: 1000px; font-size: var(--dsh-content-font-size, 14px); }
.hams-h1 { font-size: calc(20px + var(--dsh-content-font-delta, 0px)); margin: 0 0 4px; font-weight: 600; }
.hams-meta { opacity: .7; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); margin-bottom: 14px; }
.hams-section { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 12px 16px 14px; margin: 14px 0; }
.hams-section > h2 { font-size: calc(15px + var(--dsh-content-font-delta, 0px)); margin: 0 0 8px; font-weight: 600; }
.hams-table { border-collapse: collapse; width: 100%; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); margin: 8px 0; }
.hams-table th, .hams-table td { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 3px 8px; text-align: left; vertical-align: top; }
.hams-table th { opacity: .7; font-weight: 500; }
.hams-rowbad td { background: color-mix(in srgb, #e05252 12%, transparent); }
.hams-good { color: #3fb950; } .hams-bad { color: #e05252; font-weight: 600; } .hams-warn { color: #d29922; } .hams-faint { opacity: .6; }
.hams-btn { padding: 3px 12px; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); border-radius: 6px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent); color: inherit; }
.hams-btn:disabled { opacity: .45; cursor: default; }
.hams-btn-sm { padding: 0 7px; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); }
.hams-input, .hams-select, .hams-textarea { font-size: calc(13px + var(--dsh-content-font-delta, 0px)); border-radius: 5px; padding: 3px 7px; color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 4%, transparent); font-family: inherit; }
.hams-input, .hams-textarea { width: 100%; box-sizing: border-box; }
.hams-textarea { min-height: 90px; resize: vertical; }
.hams-badge { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: calc(12px + var(--dsh-content-font-delta, 0px));
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.hams-badge-good { color: #3fb950; border-color: color-mix(in srgb, #3fb950 45%, transparent); }
.hams-badge-bad { color: #d29922; border-color: color-mix(in srgb, #d29922 45%, transparent); }
.hams-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.hams-err { color: #e05252; padding: 8px; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); }
.hams-pre { font-size: calc(11.5px + var(--dsh-content-font-delta, 0px)); white-space: pre-wrap; margin: 4px 0; opacity: .8; overflow: auto; }
.hams-link { color: inherit; }
.hams-dim { opacity: .65; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
/* tier 3: task tab strip (modeled after dsh-ssh-ops' server tab strip) */
.hams-tabstrip { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 6px 8px 0;
  border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.hams-tasktab { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; max-width: 180px;
  border-radius: 6px 6px 0 0; cursor: pointer; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px));
  border: 1px solid transparent; border-bottom: none; }
.hams-tasktab.active { border-color: color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 7%, transparent); }
.hams-tasktab .hams-tabname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-tasktab .hams-x { opacity: .55; cursor: pointer; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); line-height: 1; }
.hams-tasktab .hams-x:hover { opacity: 1; color: #e05252; }
.hams-addbtn { border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); background: none;
  color: inherit; border-radius: 6px; padding: 2px 9px; cursor: pointer; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); }
.hams-body { padding: 10px 12px; overflow: auto; }
.hams-dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.38); display: flex;
  align-items: center; justify-content: center; z-index: 90; }
.hams-dialog { border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: 9px;
  padding: 16px 18px; min-width: 320px; max-width: 440px;
  background: color-mix(in srgb, black 20%, canvas); color: fieldtext;
  color: light-dark(canvasText, #e6e6e6); backdrop-filter: blur(3px); }
.hams-dialog h3 { margin: 0 0 10px; font-size: calc(14.5px + var(--dsh-content-font-delta, 0px)); font-weight: 600; }
.hams-field { margin: 8px 0; }
.hams-field label { display: block; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); opacity: .7; margin-bottom: 3px; }
.hams-taskdesc { margin-top: 8px; }
.hams-subtabs { display: flex; gap: 2px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  margin-bottom: 8px; }
.hams-subtab { padding: 3px 10px; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); cursor: pointer; color: inherit; background: none;
  border: none; border-bottom: 2px solid transparent; opacity: .7; }
.hams-subtab.active { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
.hams-dash { margin-top: 12px; border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 14px; opacity: .75; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
/* tier 3 Dashboard: report viewer (toolbar + iframe) and the add-report browser */
.hams-dashview { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; min-height: 0; }
.hams-dashtoolbar { margin: 0; flex-wrap: nowrap; }
.hams-dashtoolbar .hams-select { flex: 1 1 120px; min-width: 60px; max-width: 100%; }
.hams-btn { text-decoration: none; }
.hams-dashframe { width: 100%; height: calc(100vh - 230px); min-height: 300px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; }
.hams-list { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px;
  max-height: 240px; overflow: auto; display: flex; flex-direction: column; }
.hams-listitem { display: flex; align-items: center; gap: 6px; text-align: left; padding: 3px 8px;
  cursor: pointer; background: none; border: none; color: inherit;
  font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
.hams-listitem:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.hams-listitem .hams-dim { margin-left: auto; }
.hams-listitem .hams-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-browse-dialog { max-width: 560px; width: min(560px, 92vw); }
.hams-headerbtn { display: inline-flex; align-items: center; gap: 4px; }
.hams-pin-on { border-color: color-mix(in srgb, #3fb950 45%, transparent); color: #3fb950; }
/* tier 3 remote terminal: machine tab strip + pooled xterm viewport (dsh-ssh-ops-shaped) */
.hams-termtabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0 6px; }
.hams-termtab { padding: 2px 10px; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); cursor: pointer;
  color: inherit; background: none; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 6px 6px 0 0; opacity: .75; }
.hams-termtab.active { opacity: 1; font-weight: 600;
  border-bottom-color: transparent; background: color-mix(in srgb, currentColor 8%, transparent); }
.hams-termtab:disabled { opacity: .35; cursor: default; }
.hams-termhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: calc(12px + var(--dsh-content-font-delta, 0px)); opacity: .85; margin-bottom: 4px; }
.hams-termhead .hams-termtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-termstate { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.hams-termstate.live { background: #3fb950; }
.hams-termstate.dead { background: #e05252; }
.hams-termstate.busy { background: #d29922; }
.hams-termwrap { position: relative; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 8px; padding: 4px; height: calc(100vh - 262px); min-height: 260px; overflow: hidden; }
.hams-termhost { width: 100%; height: 100%; }
.hams-termhost .terminal { width: 100%; height: 100%; }
.hams-termsearch { display: flex; gap: 6px; align-items: center; margin: 0 0 4px;
  font-size: calc(12px + var(--dsh-content-font-delta, 0px)); }
.hams-termsnip { display: flex; gap: 4px; flex-wrap: wrap; align-items: center;
  margin: 4px 0 0; font-size: calc(11.5px + var(--dsh-content-font-delta, 0px)); }
.hams-termsnip .hams-btn-sm { opacity: .85; }
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

    // Session -> remote-project classification (from /api/project), shared by the
    // sidebar body and the pinned-reopen logic so remote projects never get the
    // sidebar auto-opened. Sessions are few; a hard cap keeps the cache bounded.
    const remoteProjectCache = new Map()
    function rememberProjectKind(sessionId, remote) {
      if (!sessionId) return
      if (remoteProjectCache.size > 100) remoteProjectCache.clear()
      remoteProjectCache.set(sessionId, !!remote)
    }
    async function isRemoteProject(sessionId) {
      if (!sessionId) return false
      if (remoteProjectCache.has(sessionId)) return remoteProjectCache.get(sessionId)
      // A freshly switched session may not be associated with its workspace yet
      // (/api/project answers project: null for a moment) — retry briefly. An
      // unresolved answer suppresses the reopen: opening the sidebar inside a
      // remote project would defeat its purpose, while skipping once for a local
      // project self-heals as soon as the cache fills.
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
          if (r?.project) {
            rememberProjectKind(sessionId, !!r.project.remote)
            return !!r.project.remote
          }
        } catch { /* transient — retry */ }
        if (i < 2) await new Promise((res) => setTimeout(res, 250))
      }
      return true
    }

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
    // (register the machine's existing mirror directory as a DSH workspace; the
    // mirror itself must be created in dsh-remote — machines without one render no
    // button, just the pick-a-workspace hint).
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

    // Lowest navigation level inside a task: overview / dashboard / remote terminal /
    // sim settings (sim settings is a placeholder until its milestone lands).
    const TASK_VIEWS = [
      { id: 'overview', labelKey: 'tasks.viewOverview' },
      { id: 'dashboard', labelKey: 'tasks.viewDashboard' },
      { id: 'term', labelKey: 'tasks.viewTerm' },
      { id: 'sim', labelKey: 'tasks.viewSim' },
    ]

    // Overview health-check panel (LOCAL projects): one local-environment button plus
    // one block per machine that has a remote project — its four check buttons run
    // through that remote project's live session (borrowed server-side). Every button
    // runs independently; results replace whatever showed below.
    const REMOTE_CHECK_IDS = ['load', 'jobs', 'batches', 'scripts']
    const CHECK_TABLES = {
      load: { cols: ['chk.lc.load1', 'chk.lc.load5', 'chk.lc.load15', 'chk.lc.procs', 'chk.lc.cpus'] },
      jobs: { cols: ['chk.jc.jobid', 'chk.jc.stat', 'chk.jc.exec', 'chk.jc.name', 'chk.jc.submit'] },
      batches: { cols: ['chk.bc.dir', 'chk.bc.status', 'chk.bc.progress'] },
      scripts: { cols: ['chk.sc.file', 'chk.sc.state'] },
    }
    const JOB_STAT_COLOR = {
      RUN: 'hams-good', DONE: 'hams-good', EXIT: 'hams-bad', ERROR: 'hams-bad', ZOMBI: 'hams-bad', UDONE: 'hams-good',
      PEND: 'hams-warn', PSUSP: 'hams-warn', USUSP: 'hams-warn', SSUSP: 'hams-warn',
    }
    const SYNC_COLOR = { 'in-sync': 'hams-good', 'differs': 'hams-bad', 'only-local': 'hams-warn', 'only-remote': 'hams-faint' }
    const batchStatusColor = (s) => (s === 'completed' ? 'hams-good' : s === 'running' ? 'hams-warn'
      : s === 'failed' || s === 'error' ? 'hams-bad' : 'hams-faint')
    // Semantic class for one cell of a check table (column index + raw server value).
    function checkCellClass(check, col, value) {
      const v = String(value ?? '')
      if (check === 'jobs' && col === 1) return JOB_STAT_COLOR[v] ?? 'hams-faint'
      if (check === 'batches' && col === 1) return batchStatusColor(v)
      if (check === 'scripts' && col === 1) return SYNC_COLOR[v] ?? ''
      return ''
    }

    // One columned result table; the server sends rows as string[][]. scripts state
    // cells are translated here (server keeps protocol values untranslated).
    function CheckResultTable({ check, x }) {
      const spec = CHECK_TABLES[check]
      if (!spec) return null
      return h('table', { className: 'hams-table' },
        h('thead', null, h('tr', null, spec.cols.map((k) => h('th', { key: k }, tr(k))))),
        h('tbody', null, x.rows.map((r, i) => h('tr', { key: i, title: x.rowsRaw?.[i] ?? '' },
          r.map((cell, j) => h('td', { key: j, className: checkCellClass(check, j, cell) },
            check === 'scripts' && j === 1 ? tr('chk.sync.' + cell) : esc(cell)))))))
    }

    // Results of one run: a local run keeps the classic Item/Result table; a remote
    // run renders one block per entry — head line + columned table (or plain text
    // fallback when the server could not parse rows) + warn/truncation notes.
    function CheckResults({ run, machines, diagnose }) {
      if (!run.machineId) {
        return h('div', null,
          h('table', { className: 'hams-table' },
            h('thead', null, h('tr', null, [tr('chk.colItem'), tr('chk.colResult'), tr('chk.colElapsed'), tr('chk.colStatus'), ''].map((c) => h('th', { key: c }, c)))),
            h('tbody', null, (run.results ?? []).map((x, i) => h('tr', { key: i, className: x.ok ? '' : 'hams-rowbad' },
              h('td', { title: x.cmd ?? '' }, esc(x.item)),
              h('td', null,
                esc(x.result || x.detail || '-'),
                x.warn ? h('span', { className: 'hams-warn' }, ' ⚠ ' + esc(x.warn)) : null,
                x.ok && x.detail ? h('div', { className: 'hams-pre' }, esc(x.detail)) : null),
              h('td', null, x.ms + ' ms'),
              h('td', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'),
              h('td', null, x.ok ? null : h('button', { className: 'hams-btn hams-btn-sm', onClick: () => diagnose(x.item) }, tr('chk.diagnose'))))))),
          run.channel && h('div', { className: 'hams-dim' }, esc(run.channel)))
      }
      const m = machines.find((x) => x.id === run.machineId)
      return h('div', null,
        (run.results ?? []).map((x, i) => h('div', { key: i, style: { margin: '6px 0' } },
          h('div', { className: 'hams-row' },
            h('b', null, esc(x.item)),
            h('span', { className: 'hams-dim' }, x.ms + ' ms'),
            h('span', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'),
            x.warn ? h('span', { className: 'hams-warn' }, '⚠ ' + esc(x.warn)) : null,
            !x.ok ? h('button', { className: 'hams-btn hams-btn-sm', onClick: () => diagnose(x.item) }, tr('chk.diagnose')) : null),
          !x.ok && x.detail ? h('div', { className: 'hams-pre' }, esc(x.detail)) : null,
          x.rows && x.rows.length ? h(CheckResultTable, { check: run.check, x })
            : h('div', { className: 'hams-dim' }, esc(x.result || x.detail || '-')),
          x.truncated ? h('div', { className: 'hams-dim' }, tr('chk.truncated')) : null,
          run.check === 'batches' && x.rows && x.rows.length && m
            ? h('div', { className: 'hams-dim' }, tr('chk.rootLegend', { path: m.remotePath })) : null)),
        run.channel && h('div', { className: 'hams-dim' }, esc(run.channel)))
    }

    // One machine block: identity/status lines + the four remote check buttons. The
    // buttons stay disabled until the remote project holds a live session.
    function MachineCheckBlock({ m, run, running, onRun }) {
      const machineRun = run && run.machineId === m.id ? run : null
      const noSession = !m.liveSessions
      const hostLine = (m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22)
      return h('div', { style: { margin: '10px 0 2px' } },
        h('div', { style: { fontSize: 'calc(12.5px + var(--dsh-content-font-delta, 0px))', lineHeight: 1.6 } },
          h('div', null,
            h('b', null, esc(m.name || m.host) + (m.current ? tr('rproj.current') : '')), ' ', esc(hostLine),
            m.latencyMs != null ? ' · ' + tr('chk.latency', { n: m.latencyMs }) : '',
            m.lastConnectedAt ? ' · ' + tr('chk.lastConnected', { t: String(m.lastConnectedAt).slice(0, 19).replace('T', ' ') }) : ''),
          h('div', { title: tr('chk.mirrorDir', { p: m.mirrorDir }) }, tr('chk.remoteArea', { path: m.remotePath || '—' })),
          h('div', { className: noSession ? 'hams-warn' : 'hams-dim' },
            noSession ? tr('chk.noSession', { title: m.projectTitle }) : tr('chk.sessions', { n: m.liveSessions }))),
        h('div', { className: 'hams-row' },
          REMOTE_CHECK_IDS.map((id) => h('button', {
            key: id,
            className: 'hams-btn hams-btn-sm',
            disabled: running || noSession,
            title: noSession ? tr('chk.noSession', { title: m.projectTitle }) : tr('chk.btn.' + id),
            onClick: () => onRun(m.id, id),
          }, running && machineRun && machineRun.id === m.id + ':' + id ? tr('chk.running') : tr('chk.btn.' + id)))))
    }

    function CheckPanel({ info, run, onRun }) {
      const running = run?.status === 'running'
      const diagnose = (item) => {
        const t = 'HarnessAMS health-check failure [' + item + '] — please diagnose: read the ' +
          '/harnessams/api/checks/run results, reproduce the failing command with the rw_* tools ' +
          "(dsh-remote) in this project's session, and report the conclusion."
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => alert(tr('chk.promptCopied')), () => prompt(tr('chk.copyPrompt'), t))
        else prompt(tr('chk.copyPrompt'), t)
      }
      const machines = info?.machines ?? []
      return h('div', { style: { marginTop: '10px' } },
        h('div', { className: 'hams-dim' }, h('b', null, tr('chk.title'))),
        h('div', { className: 'hams-row' },
          (info?.buttons ?? []).map((b) => h('button', {
            key: b.id,
            className: 'hams-btn hams-btn-sm',
            disabled: running,
            title: b.item,
            onClick: () => onRun(null, b.id),
          }, running && run?.id === b.id ? tr('chk.running') : tr('chk.btn.' + b.id)))),
        info?.machinesReason && h('div', { className: 'hams-dim' }, esc(info.machinesReason)),
        !info?.machinesReason && machines.length === 0 && info
          && h('div', { className: 'hams-dim' }, tr(info.machinesTotal ? 'chk.needRemoteProject' : 'rproj.empty')),
        machines.map((m) => h(MachineCheckBlock, { key: m.id, m, run, running, onRun })),
        run?.status === 'failed' && h('div', { className: 'hams-err' }, run.error),
        run?.status === 'done' && h(CheckResults, { run, machines, diagnose }),
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
      const projectRemote = !!project?.remote

      useEffect(() => {
        let alive = true
        setError(null)
        if (!sessionId) { setProject(null); setReason(tr('tasks.noSession')); return }
        setProject(undefined)
        fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return
            rememberProjectKind(sessionId, !!r?.project?.remote)
            setProject(r.project ?? null)
            setReason(r.project ? null : r.reason ?? null)
          })
          .catch((e) => { if (alive) { setProject(null); setReason(String(e.message ?? e)) } })
        return () => { alive = false }
      }, [sessionId])

      // Remote projects are connection anchors — no task store, no check surface.
      useEffect(() => {
        let alive = true
        if (!projectPath || !sessionId || projectRemote) { setTasks([]); setSelectedId(null); return }
        fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId))
          .then((d) => {
            if (!alive) return
            setTasks(d.tasks ?? [])
            setSelectedId((prev) => (d.tasks ?? []).some((t) => t.id === prev) ? prev : (d.tasks?.[0]?.id ?? null))
          })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [projectPath, sessionId, projectRemote])

      // Overview check surface (local projects: local environment + per-machine
      // remote checks); fetched independently so it never blocks the task list.
      useEffect(() => {
        let alive = true
        setChecksInfo(null); setCheckRun(null)
        if (!projectPath || !sessionId || projectRemote) return
        fetchJson(API + '/checks?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => { if (alive) setChecksInfo(r) })
          .catch(() => { if (alive) setChecksInfo(null) })
        return () => { alive = false }
      }, [projectPath, sessionId, projectRemote])

      // mid=null runs the local-environment check; otherwise mid is the machineId of
      // the machine block the button sits in (remote checks borrow that machine's
      // remote-project session server-side).
      const runCheck = async (mid, id) => {
        const key = mid ? mid + ':' + id : id
        setCheckRun({ id: key, machineId: mid ?? null, check: id, status: 'running', results: null })
        try {
          const q = 'sessionId=' + encodeURIComponent(sessionId) + '&check=' + encodeURIComponent(id)
            + (mid ? '&machineId=' + encodeURIComponent(mid) : '')
          const r = await fetchJson(API + '/checks/run?' + q)
          setCheckRun({ id: key, machineId: mid ?? null, check: id, status: 'done', results: r.results, channel: r.channel })
        } catch (e) {
          setCheckRun({ id: key, machineId: mid ?? null, check: id, status: 'failed', error: String(e.message ?? e), results: null })
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
      // Dashboard sub-view mutator: applies fn to the selected task and persists
      // the whole list (same single-writer channel as description edits).
      const updateTask = (fn) => persist(tasks.map((t) => t.id === selected.id ? fn(t) : t))

      // Remote projects render nothing but the explanatory note — no tab strip, no
      // tasks, no checks. Their role is anchoring the connection; remote files go
      // through dsh-remote itself, and checks run from local projects.
      if (project && projectRemote) {
        return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, fontSize: 'var(--dsh-content-font-size, 14px)' } },
          h('div', { className: 'hams-body' },
            h('div', { className: 'hams-dim' }, tr('tasks.remoteProjectNote'))))
      }

      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, fontSize: 'var(--dsh-content-font-size, 14px)' } },
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
            view === 'dashboard' && h(TaskDashboard, { task: selected, updateTask }),
            view === 'term' && h(TaskTerminal, { info: checksInfo }),
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

    // Dashboard sub-view: the task's registered local HTML reports. The report
    // list + current selection live in the task store (reports[] /
    // dashboard_selected); files are served read-only from
    // /harnessams/dash/<taskId>/<reportId>/… with the report's own directory as
    // root, so the document's relative references (data/*.js, images) keep
    // working inside the iframe. Refresh remounts the iframe via the key/nonce
    // (a plain location.reload is unreliable across same-origin documents).
    function TaskDashboard({ task, updateTask }) {
      const [nonce, setNonce] = useState(0)
      const [dialogOpen, setDialogOpen] = useState(false)
      const reports = task.reports ?? []
      const selectedId = reports.some((r) => r.id === task.dashboard_selected)
        ? task.dashboard_selected
        : (reports[0]?.id ?? null)
      const current = reports.find((r) => r.id === selectedId) ?? null

      const addReport = (absPath, name) => {
        // Client-generated id (same shape the server assigns) so adding +
        // selecting the new report is one persist round-trip.
        const id = 'r-' + Math.random().toString(36).slice(2, 10)
        const base = absPath.split(/[\\/]/).pop() || absPath
        updateTask((t) => ({
          ...t,
          reports: [...(t.reports ?? []), { id, name: name || base, path: absPath }],
          dashboard_selected: id,
        }))
      }
      const removeCurrent = () => updateTask((t) => {
        const rest = (t.reports ?? []).filter((r) => r.id !== selectedId)
        return { ...t, reports: rest, dashboard_selected: rest[0]?.id ?? null }
      })
      const dashUrl = current ? '/harnessams/dash/' + encodeURIComponent(task.id) + '/' + encodeURIComponent(current.id) + '/' : null

      return h('div', { className: 'hams-dashview' },
        h('div', { className: 'hams-row hams-dashtoolbar' },
          h('select', {
              className: 'hams-select',
              value: selectedId ?? '',
              disabled: !reports.length,
              title: current ? current.path : tr('dash.noReports'),
              onChange: (e) => updateTask((t) => ({ ...t, dashboard_selected: e.target.value })),
            },
            reports.length
              ? reports.map((r) => h('option', { key: r.id, value: r.id }, esc(r.name)))
              : h('option', { value: '' }, tr('dash.noReports'))),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.addTitle'), onClick: () => setDialogOpen(true) }, '＋'),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.refresh'), disabled: !current, onClick: () => setNonce(nonce + 1) }, '↻'),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.remove'), disabled: !current, onClick: removeCurrent }, '×'),
          current && h('a', { className: 'hams-btn hams-btn-sm', title: tr('dash.openTab'), href: dashUrl, target: '_blank', rel: 'noopener' }, '↗')),
        current
          ? h('iframe', {
              key: current.id + ':' + nonce,
              className: 'hams-dashframe',
              title: current.name,
              src: dashUrl + '?_r=' + nonce,
            })
          : h('div', { className: 'hams-dash' },
              tr('dash.empty'), ' ',
              h('button', { className: 'hams-btn hams-btn-sm', onClick: () => setDialogOpen(true) }, tr('dash.addFirst'))),
        dialogOpen && h(AddReportDialog, {
          onCancel: () => setDialogOpen(false),
          onAdd: (p, n) => { setDialogOpen(false); addReport(p, n) },
        }),
      )
    }

    // Add-report browser: a one-level directory listing (server /api/browse —
    // subdirectories + *.html files, dot-directories hidden) starting at the
    // workspace root; clicking an HTML file registers it. The manual path field
    // covers paths outside the browsable tree.
    function AddReportDialog({ onCancel, onAdd }) {
      const [cwd, setCwd] = useState(null) // null = server default (workspace root)
      const [listing, setListing] = useState(null)
      const [error, setError] = useState(null)
      const [manual, setManual] = useState('')
      useEffect(() => {
        let alive = true
        setError(null); setListing(null)
        fetchJson(API + '/browse' + (cwd ? '?path=' + encodeURIComponent(cwd) : ''))
          .then((r) => { if (alive) setListing(r) })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [cwd])
      const addManual = () => { const p = manual.trim(); if (p) onAdd(p, '') }
      return h('div', { className: 'hams-dialog-backdrop', onClick: (e) => { if (e.target === e.currentTarget) onCancel() } },
        h('div', { className: 'hams-dialog hams-browse-dialog' },
          h('h3', null, tr('dash.addTitle')),
          h('div', { className: 'hams-field' },
            h('label', null, tr('dash.currentDir')),
            h('div', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
              h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.parentDir'),
                disabled: !listing?.parent, onClick: () => setCwd(listing.parent) }, '↑'),
              h('span', { className: 'hams-dim',
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                esc(listing ? listing.path : '…')))),
          h('div', { className: 'hams-field' },
            h('label', null, tr('dash.pickFile')),
            h('div', { className: 'hams-list' },
              error && h('div', { className: 'hams-err' }, error),
              listing && !error && h('div', null,
                listing.dirs.map((d) => h('button', { key: 'd:' + d, className: 'hams-listitem',
                  onClick: () => setCwd(listing.path + '/' + d) },
                  h('span', { className: 'hams-name' }, '📁 ' + esc(d)))),
                listing.htmls.map((f) => h('button', { key: 'f:' + f.name, className: 'hams-listitem',
                  onClick: () => onAdd(listing.path + '/' + f.name, f.name) },
                  h('span', { className: 'hams-name' }, '📄 ' + esc(f.name)),
                  h('span', { className: 'hams-dim' }, fmtBytes(f.bytes)))),
                !listing.dirs.length && !listing.htmls.length && h('div', { className: 'hams-dim', style: { padding: '4px 8px' } }, tr('dash.emptyDir'))))),
          h('div', { className: 'hams-field' },
            h('label', null, tr('dash.manualLabel')),
            h('div', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
              h('input', { className: 'hams-input', placeholder: tr('dash.manualPlaceholder'), value: manual,
                onChange: (e) => setManual(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') addManual() } }),
              h('button', { className: 'hams-btn', disabled: !manual.trim(), onClick: addManual }, tr('dash.add')))),
          h('div', { className: 'hams-row', style: { justifyContent: 'flex-end' } },
            h('button', { className: 'hams-btn', onClick: onCancel }, tr('common.cancel')))))
    }

    // ---------- tier 3 remote terminal (dsh-ssh-ops-shaped UI over dsh-remote's PTY) ----------
    // Channel discipline: no SSH layer of our own — every byte rides dsh-remote's
    // /dsh-remote/term/* polling routes (host-owned ssh2 PTYs behind its guardRoute
    // auth). Multi-machine targeting = the binding hint: each machine entry from
    // /api/checks carries `sessionId`, the id of one live session of that machine's
    // remote project; dsh-remote resolves the hint to the machine and opens the PTY on
    // ITS pool (resolveRequestBinding: a hinted session inside its mirror binds to that
    // machine). A fresh session lands in the project root via a first `cd` input.
    // xterm instances are pooled per machine, so tab switches, task switches, chat
    // switches and page reloads keep scrollback (the remote session survives all of
    // them; dsh-remote GCs it only after 30 idle minutes).
    const TERM_API = '/dsh-remote/term'
    const TERM_FONT_KEY = 'hams-term-font'
    const TERM_SNIPPETS = ['ll', 'df -h', 'bjobs -a', 'cd ..']
    const TERM_POOL = new Map() // machineId -> { el, term, fit, search, sessionId, from, attached }

    // Vendored @xterm/xterm 5.5.0 + fit/search addons, loaded as classic scripts from
    // the plugin's whitelisted asset route (UMD globals: Terminal, FitAddon, SearchAddon).
    let xtermLoading = null
    function loadXtermBundle() {
      if (window.Terminal && window.FitAddon?.FitAddon && window.SearchAddon?.SearchAddon) return Promise.resolve()
      if (xtermLoading) return xtermLoading
      xtermLoading = new Promise((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = '/harnessams/assets/xterm.css'
        document.head.append(link)
        const files = ['xterm.js', 'xterm-addon-fit.js', 'xterm-addon-search.js']
        let done = 0
        for (const f of files) {
          const s = document.createElement('script')
          s.src = '/harnessams/assets/' + f
          s.onload = () => { done++; if (done === files.length) resolve() }
          s.onerror = () => { xtermLoading = null; reject(new Error(f)) }
          document.head.append(s)
        }
      })
      return xtermLoading
    }

    function termFontSize() {
      const v = Number(localStorage.getItem(TERM_FONT_KEY))
      return v >= 8 && v <= 28 ? v : 12
    }
    // xterm paints its own canvas — the palette cannot inherit CSS, so pick light/dark
    // from the host page's body background luminance (follows the DSH theme).
    function termPalette() {
      let dark = true
      try {
        const m = getComputedStyle(document.body).backgroundColor.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
        if (m) dark = (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128
      } catch { /* keep dark */ }
      return dark
        ? { background: '#14171c', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#14171c', selectionBackground: 'rgba(88,140,255,.35)' }
        : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff', selectionBackground: 'rgba(60,120,255,.25)' }
    }

    // term routes answer { ok:false, error } with an HTTP status — no throwing, callers
    // branch on status (404 = session lost, 403/409/503 = actionable dsh-remote text).
    async function termFetch(url, opts) {
      const r = await fetch(url, opts)
      const body = await r.json().catch(() => ({}))
      return { ok: r.ok, status: r.status, body }
    }
    const termPost = (path, m, payload) => termFetch(TERM_API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, sessionId: m.sessionId }),
    })

    function TaskTerminal({ info }) {
      const machines = (info?.machines ?? []).filter((x) => x.sessionId)
      const [activeId, setActiveId] = useState(null)
      const [conn, setConn] = useState({}) // machineId -> { status: connecting|live|dead|error, error? }
      const [loaded, setLoaded] = useState(false)
      const [loadError, setLoadError] = useState(null)
      const [searchOpen, setSearchOpen] = useState(false)
      const [searchQ, setSearchQ] = useState('')
      const hostRef = useRef(null)
      const wrapRef = useRef(null)
      const searchRef = useRef(null)

      const active = machines.find((m) => m.id === activeId)
        ?? machines.find((m) => m.current) ?? machines[0] ?? null
      const activeIdSafe = active?.id ?? null

      const machinesRef = useRef(machines); machinesRef.current = machines
      const connRef = useRef(conn); connRef.current = conn
      // runtime effects (poll/resize/reopen/search) must follow the machine the user
      // SEES — the same fallback-resolved id the attach effect connects — not the raw
      // click state, or the default-active machine connects but never paints (blind typing).
      const activeIdRef = useRef(activeIdSafe); activeIdRef.current = activeIdSafe

      const setMachineConn = (id, patch) => setConn((c) => ({ ...c, [id]: { ...(c[id] ?? {}), ...patch } }))

      const markDead = (id, message) => {
        const entry = TERM_POOL.get(id)
        if (entry) entry.sessionId = null
        setMachineConn(id, { status: 'dead', error: message ?? tr('term.dead') })
      }

      const termInput = async (machineId, data) => {
        const m = machinesRef.current.find((x) => x.id === machineId)
        const entry = TERM_POOL.get(machineId)
        if (!m || !entry?.sessionId) return
        const r = await termPost('/input', m, { id: entry.sessionId, data: String(data).slice(0, 65536) })
        if (r.status === 404) markDead(machineId)
      }

      const ensureSession = async (m) => {
        const entry = TERM_POOL.get(m.id)
        if (!entry || (entry.sessionId && connRef.current[m.id]?.status === 'live')) return
        setMachineConn(m.id, { status: 'connecting', error: null })
        // 1) reattach: dsh-remote keeps host-owned sessions alive across reloads/switches
        const l = await termFetch(TERM_API + '/list?sessionId=' + encodeURIComponent(m.sessionId))
        if (l.ok) {
          const mine = (l.body?.sessions ?? []).filter((s) => !s.closed)
          if (mine.length) {
            const sid = mine[mine.length - 1].id // most recent of this machine
            const same = entry.sessionId === sid
            entry.sessionId = sid
            // same-PTY reattach (sub-tab/session switch): keep the polling offset so only
            // the ring delta appends — replaying from 0 would duplicate everything still
            // on screen. A different PTY starts clean: reset, then replay its ring.
            if (!same) { entry.from = 0; entry.term?.reset() }
            setMachineConn(m.id, { status: 'live' })
            return
          }
        } else if (l.status === 404) {
          setMachineConn(m.id, { status: 'error', error: tr('term.unavailable') })
          return
        }
        // 2) open fresh (cols estimated from the viewport; refined by fit right after)
        const wrap = wrapRef.current
        const cols = Math.max(40, Math.min(400, Math.floor(((wrap?.clientWidth ?? 400) - 12) / 7.2)))
        const o = await termPost('/open', m, { cols, rows: 30 })
        if (!o.ok || !o.body?.id) {
          setMachineConn(m.id, { status: 'error', error: o.body?.error ?? (o.status === 404 ? tr('term.unavailable') : String(o.status)) })
          return
        }
        entry.sessionId = o.body.id
        entry.from = 0
        entry.term?.reset() // a reused pooled term must not keep the previous PTY's screen
        if (m.remotePath) void termInput(m.id, "cd '" + String(m.remotePath).replace(/'/g, "'\\''") + "'\n")
        setMachineConn(m.id, { status: 'live' })
      }

      // vendor bundle once per page
      useEffect(() => {
        let alive = true
        loadXtermBundle().then(() => { if (alive) setLoaded(true) })
          .catch((e) => { if (alive) setLoadError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [])

      // attach the active machine's pooled xterm into the host div (+ session bring-up)
      useEffect(() => {
        if (!loaded || activeIdSafe == null) return
        const m = machinesRef.current.find((x) => x.id === activeIdSafe)
        const host = hostRef.current
        if (!m || !host) return
        let entry = TERM_POOL.get(m.id)
        if (!entry) {
          entry = { el: document.createElement('div'), term: null, fit: null, search: null, sessionId: null, from: 0, attached: false }
          TERM_POOL.set(m.id, entry)
        }
        const fresh = !entry.term
        if (fresh) {
          const term = new window.Terminal({
            cursorBlink: true, scrollback: 5000, convertEol: true, allowProposedApi: true,
            fontFamily: "Consolas, 'Courier New', monospace", fontSize: termFontSize(), theme: termPalette(),
          })
          const fit = new window.FitAddon.FitAddon()
          const search = new window.SearchAddon.SearchAddon()
          term.loadAddon(fit); term.loadAddon(search)
          term.onData((data) => { void termInput(m.id, data) })
          term.onSelectionChange(() => {
            const sel = term.getSelection()
            if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => { /* no permission */ })
          })
          entry.term = term; entry.fit = fit; entry.search = search
        }
        for (const [id, e] of TERM_POOL) {
          if (id !== m.id && e.attached) { e.el.remove(); e.attached = false }
        }
        if (!entry.attached) { host.append(entry.el); entry.attached = true }
        if (fresh) entry.term.open(entry.el)
        entry.term.refresh(0, entry.term.rows - 1)
        try { entry.fit.fit() } catch { /* zero-size until first layout */ }
        void ensureSession(m)
        return () => { /* keep the element pooled; cleanup happens on full unmount */ }
      }, [loaded, activeIdSafe])

      // detach everything when the sub-view unmounts (instances stay pooled)
      useEffect(() => () => {
        for (const e of TERM_POOL.values()) {
          if (e.attached) { e.el.remove(); e.attached = false }
        }
      }, [])

      // output polling: active machine only, paused while the page is hidden
      useEffect(() => {
        let alive = true
        let inflight = false
        const tick = async () => {
          if (!alive || document.hidden || inflight) return
          const m = machinesRef.current.find((x) => x.id === activeIdRef.current)
          const entry = m && TERM_POOL.get(m.id)
          if (!m || !entry?.sessionId || connRef.current[m.id]?.status !== 'live') return
          inflight = true
          try {
            const r = await termFetch(TERM_API + '/output?id=' + encodeURIComponent(entry.sessionId)
              + '&from=' + entry.from + '&sessionId=' + encodeURIComponent(m.sessionId))
            if (!alive) return
            if (r.status === 404) { markDead(m.id); return }
            if (!r.ok) return // transient — next tick retries
            if (r.body?.closed) { markDead(m.id, tr('term.closed')); return }
            const chunks = r.body?.chunks ?? []
            if (chunks.length) entry.term?.write(chunks.join(''))
            if (typeof r.body?.next === 'number') entry.from = r.body.next
          } catch { /* network hiccup — retry on the next tick */ }
          finally { inflight = false }
        }
        const iv = setInterval(tick, 150)
        const wake = () => { void tick() }
        document.addEventListener('visibilitychange', wake)
        return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', wake) }
      }, [activeIdSafe])

      // adaptive fit + PTY resize
      useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap || typeof ResizeObserver === 'undefined') return
        let raf = 0
        const ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(() => {
            const m = machinesRef.current.find((x) => x.id === activeIdRef.current)
            const entry = m && TERM_POOL.get(m.id)
            if (!entry?.term || !entry.attached) return
            try { entry.fit.fit() } catch { /* not laid out yet */ }
            if (entry.sessionId && connRef.current[m.id]?.status === 'live') {
              void termPost('/resize', m, { id: entry.sessionId, cols: entry.term.cols, rows: entry.term.rows })
            }
          })
        })
        ro.observe(wrap)
        return () => { ro.disconnect(); cancelAnimationFrame(raf) }
      }, [])

      // follow the host theme (palette cannot inherit; repaint pooled instances)
      useEffect(() => {
        const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
        const apply = () => {
          for (const e of TERM_POOL.values()) if (e.term) e.term.options.theme = termPalette()
        }
        mq?.addEventListener?.('change', apply)
        return () => mq?.removeEventListener?.('change', apply)
      }, [])

      // Ctrl+F opens the search bar; Ctrl+wheel zooms the pooled terminals
      useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
            e.preventDefault(); setSearchOpen(true)
            setTimeout(() => searchRef.current?.focus(), 0)
          }
        }
        const onWheel = (e) => {
          if (!e.ctrlKey) return
          e.preventDefault()
          const v = Math.min(28, Math.max(8, termFontSize() + (e.deltaY < 0 ? 1 : -1)))
          localStorage.setItem(TERM_FONT_KEY, String(v))
          for (const en of TERM_POOL.values()) {
            if (!en.term) continue
            en.term.options.fontSize = v
            try { en.fit?.fit() } catch { /* not attached */ }
          }
        }
        wrap.addEventListener('keydown', onKey)
        wrap.addEventListener('wheel', onWheel, { passive: false })
        return () => { wrap.removeEventListener('keydown', onKey); wrap.removeEventListener('wheel', onWheel) }
      }, [])

      const reopen = async () => {
        const m = machinesRef.current.find((x) => x.id === activeIdRef.current)
        if (!m) return
        const entry = TERM_POOL.get(m.id)
        if (entry?.sessionId) {
          void termPost('/close', m, { id: entry.sessionId })
          entry.sessionId = null; entry.from = 0
          entry.term?.reset()
        }
        entry?.term?.clear()
        await ensureSession(m)
      }

      const doSearch = (backward) => {
        const entry = TERM_POOL.get(activeIdRef.current)
        if (!entry?.search || !searchQ) return
        try { backward ? entry.search.findPrevious(searchQ) : entry.search.findNext(searchQ) }
        catch { /* addon unavailable */ }
      }

      if (!info) return h('div', { className: 'hams-dim', style: { marginTop: 8 } }, tr('term.infoMissing'))
      if (!machines.length) return h('div', { className: 'hams-dim', style: { marginTop: 8 } }, tr('term.noMachines'))

      const st = conn[activeIdSafe] ?? { status: 'connecting' }
      const hostLine = active
        ? (active.username ? active.username + '@' : '') + (active.host ?? '') + ':' + (active.port ?? 22)
        : ''

      return h('div', { style: { marginTop: 8 } },
        h('div', { className: 'hams-termtabs', role: 'tablist' },
          machines.map((m) => h('button', {
            key: m.id,
            className: 'hams-termtab' + (m.id === activeIdSafe ? ' active' : ''),
            disabled: !m.sessionId,
            title: m.sessionId
              ? (m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22) + (m.remotePath ? ' · ' + m.remotePath : '')
              : tr('term.noSession'),
            onClick: () => setActiveId(m.id),
          }, esc(m.name || m.host)))),
        active && h('div', null,
          h('div', { className: 'hams-termhead' },
            h('span', { className: 'hams-termstate ' + (st.status === 'live' ? 'live' : st.status === 'connecting' ? 'busy' : 'dead'),
              title: st.status }),
            h('span', { className: 'hams-termtitle' },
              hostLine + (active.remotePath ? ' · ' + tr('term.startDir') + ' ' + active.remotePath : '')),
            h('button', { className: 'hams-btn hams-btn-sm', onClick: reopen, disabled: !active.sessionId }, tr('term.reopen'))),
          loadError && h('div', { className: 'hams-err' }, tr('term.vendorFail', { msg: loadError })),
          !loaded && !loadError && h('div', { className: 'hams-dim' }, tr('term.loading')),
          searchOpen && h('div', { className: 'hams-termsearch' },
            h('input', { ref: searchRef, className: 'hams-input', autoFocus: true, value: searchQ,
              placeholder: tr('term.search'),
              onChange: (e) => setSearchQ(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey) }
                if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false) }
              } }),
            h('button', { className: 'hams-btn hams-btn-sm', onClick: () => doSearch(false) }, '↓'),
            h('button', { className: 'hams-btn hams-btn-sm', onClick: () => doSearch(true) }, '↑'),
            h('button', { className: 'hams-btn hams-btn-sm', onClick: () => setSearchOpen(false) }, '×')),
          st.status === 'error' && h('div', { className: 'hams-err' }, st.error ?? ''),
          st.status === 'dead' && h('div', { className: 'hams-warn' }, st.error ?? tr('term.dead')),
          h('div', { ref: wrapRef, className: 'hams-termwrap', tabIndex: -1 },
            h('div', { ref: hostRef, className: 'hams-termhost' })),
          h('div', { className: 'hams-termsnip' },
            h('span', { className: 'hams-dim' }, tr('term.snippets') + '：'),
            TERM_SNIPPETS.map((s) => h('button', {
              key: s, className: 'hams-btn hams-btn-sm',
              disabled: st.status !== 'live',
              onClick: () => { void termInput(active.id, s) },
            }, s)))),
      )
    }

    // Sticky task sidebar: DSH resets the right sidebar to its start page whenever the
    // conversation switches. While pinned (default on), the header button re-opens the
    // task tab on every sessionId change so the sidebar follows workspace switches
    // instead of collapsing — EXCEPT for remote projects, which get no sidebar at all.
    // Clicking the header button always opens + pins; the pin toggle lives at the end
    // of the task tab strip.
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
        let cancelled = false
        // the host tears the right pane down and up around a switch; a short delay
        // keeps the reopen from landing on the intermediate state
        const t = setTimeout(() => {
          if (cancelled || !openSidebarTab) return
          // remote projects must NOT get the sidebar auto-opened (cache-backed check)
          void isRemoteProject(sessionId).then((remote) => {
            if (!cancelled && !remote && openSidebarTab) openSidebarTab()
          })
        }, 350)
        return () => { cancelled = true; clearTimeout(t) }
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
