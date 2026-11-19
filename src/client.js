// HarnessAMS client half — the three-tier UI:
//   tier 1: global console page ("HarnessAMS" entry in the left sidebar -> full panel):
//           first-run guide (centered entry until seen, then a persistent guide button;
//           five sections chaining the scattered hints into one read), machines (the
//           dsh-ssh host registry with each alias's configured remote root), digital
//           assets (vendored .js packages with licenses + package/workspace copy
//           locations), disk usage;
//   tier 2: project = DSH workspace (a local folder) — every SESSION is a work
//           unit (the task concept was retired 2026-11-19, decisions.md D-008):
//           each session carries its own dashboard reports and confirmed check
//           params in <workspace>/.harnessams/sessions.json;
//   tier 3: right-sidebar tab — the first-level strip is exactly two entries,
//           the project overview (project-scoped so same-project session switches
//           never refresh it) and THIS session's own panel with its Dashboard
//           (local HTML reports: browse-to-add / dropdown / reload; sim_analysis
//           registers into the calling session) and Checks sub-views. A first-
//           seen FORKED session (log-marker verdict from the server) starts from
//           a copy of the previously active session's config — deliberately
//           branch-point-independent; a brand-new session starts empty.
//           Remote connectivity is dsh-ssh's (@linxin666): tools go by alias, the
//           user's interactive shell is dsh-ssh's own terminal panel — this client
//           adds no SSH surface of its own.
// Classic script on the host module loader (same loader shape as other dsh plugins):
// the factory receives a synchronous require, React comes from the host page, and the
// whole client is one file — combo-loaded classic scripts cannot import sibling modules.
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
    // language, else English. Same shape as the other dsh plugin clients.
    const NS = 'dsh-harnessams'
    const L = {
      zh: {
        'common.loading': '加载中…',
        'common.save': '保存',
        'common.cancel': '取消',
        'common.sectionFailed': '此区块加载失败：',
        'common.expand': '展开',
        'common.collapse': '收起',
        'console.title': 'HarnessAMS 控制台',
        'console.infoFailed': 'info 读取失败：{msg}',
        'console.config': '项目配置＝各工作区自己的 .harnessams/workspace_config.json（原家族 harnessams.json 已退役）',
        'guide.btn': '使用引导',
        'guide.caption': '第一次使用 HarnessAMS？从工作方式、提交作业到报告查看，一条引导走完。',
        'guide.title': '开始使用 HarnessAMS',
        'guide.back': '返回',
        'guide.done': '开始使用',
        'guide.s1t': '工作方式：本地还是远程',
        'guide.s1': '本地 — spectre 本地闭环（装配 → 检查 → 仿真 → 解析 → 报告；需本机自备 Spectre）。远程 — 机器（主机别名与凭据）在 dsh-ssh 插件里配置；本页「机器」卡展示各别名，远端根路径是各项目自己的设置（项目总览设置表「远端根路径」行）。',
        'guide.s2t': '提交作业方式',
        'guide.s2': '直接提交 — 仿真在本机前台运行（spectre 本地扫掠）。batch — 经 dsh-ssh 提交 LSF 队列（batch_submit / batch_poll / batch_fetch，按机器别名直发）。',
        'guide.s2slurm': 'slurm —— 暂不支持。',
        'guide.s3t': '工作区位置',
        'guide.s3': '配置＝各工作区自己的 .harnessams/workspace_config.json 单文件（运行设置含远端根路径、脚本目录、plotly、回收站）。远程 — 路径即远端真实路径（dsh-ssh 按别名直达，无本地镜像）。',
        'guide.s4t': '仿真插件套件',
        'guide.s4': '套件合计 13 个工具：SmartAnaSim 6（spectre 装配/扫掠/解析＋sNp 读取/提取，sNp 两件经 snp_guide 按需激活）＋HarnessAMS 7（batch 提交/轮询/取回＋分析/进度/回收站＋harnessams_selfcheck 自检）。除 sNp 外默认全注册；使用引导仅由 HarnessAMS 提供。',
        'guide.s5t': '日常入口速查',
        'guide.s5': 'HarnessAMS 侧栏「项目总览」— 项目设置表＋项目自检为主入口：保存到AGENTS.md（项目配置表一键落盘）/ 一键自检 / 列出本机环境（node/python 版本＋绝对路径）/ 全部检查并保存，工作目录经 dsh-ssh 远程目录浏览选取；「会话」— 当前会话自己的工作区：「仪表盘」HTML 报告查看器（sim_analysis 生成报告即自动登记进本会话，也可浏览添加已有报告；分支会话首见自动复制上一活跃会话的整份配置）、「参数检查」本会话的检查参数编辑（未确认按项目缺省∪内置缺省生效）；交互 shell 用 dsh-ssh 自带的 SSH 终端面板。',
        'hosts.title': '机器',
        'hosts.ok': 'dsh-ssh：{n} 台主机',
        'hosts.missing': 'dsh-ssh 不可用',
        'hosts.colAlias': '别名',
        'hosts.colHost': '主机',
        'hosts.colAuth': '认证',
        'hosts.empty': 'dsh-ssh 中还没有主机 — 请先在 dsh-ssh 面板里添加。',
        'hosts.hint': '主机与凭据在 dsh-ssh 插件里管理；此处只读展示注册表。各项目的远端根路径在项目总览的设置表里配置（随项目走）。',
        'chk.running': '检查中…',
        'chk.colItem': '检查项',
        'chk.colResult': '结果',
        'chk.colElapsed': '耗时',
        'chk.colStatus': '状态',
        'chk.truncated': '（列表已截断）',
        'chk.btn.local': '列出本机环境',
        'chk.bc.status': '状态',
        'chk.bc.progress': '进度',
        'agents.saveBtn': '保存到AGENTS.md',
        'agents.saving': '保存中…',
        'agents.saved': '已保存：{path}',
        'agents.saveFailed': '保存失败：{msg}',
        'agents.checkAll': '全部检查并保存',
        'agents.checkAllRunning': '检查并保存中…',
        'assets.title': '数字资产',
        'assets.plotlyOk': 'plotly.min.js 已就绪 — {size}',
        'assets.plotlyMissing': '缺少 plotly 资产',
        'assets.openAsset': '打开资产',
        'assets.notices': '第三方声明',
        'assets.colPkg': '包',
        'assets.colLicense': '协议',
        'assets.colPkgCopy': '随包副本',
        'assets.colRoute': '服务路由',
        'assets.colWsCopies': '工作区副本',
        'assets.noCopies': '（工作区无副本）',
        'tasks.noSession': '无活动会话',
        'tasks.loadingProject': '正在加载项目…',
        'tasks.noProject': '此会话没有对应项目。',
        'tasks.projectOverview': '项目总览',
        'tasks.sessionTab': '会话',
        'tasks.projectLabel': '项目：',
        'tasks.viewCheck': '参数检查',
        'tasks.viewDashboard': '仪表盘',
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
        'dash.manualPlaceholder': '/path/to/report.html',
        'dash.add': '添加',
        'tasks.headerOpen': '打开 HarnessAMS 侧栏（项目总览与会话面板）',
        'tasks.guideDesc': '项目总览、会话面板、检查与使用引导',
        'check.title': '装配层检查参数（本会话）',
        'check.desc': '本会话的检查阈值与开关；确认后随会话保存（sessions.json），下次装配生效。',
        'check.sourceOwn': '已确认 — 本会话参数生效中',
        'check.sourceFallback': '未确认 — 按项目缺省（check_params.json）∪内置缺省生效',
        'check.colParam': '参数',
        'check.colValue': '值',
        'check.colNote': '说明',
        'check.rclR': '理想电阻范围 (R)',
        'check.rclC': '理想电容范围 (C)',
        'check.rclL': '理想电感范围 (L)',
        'check.noteR': 'Ω；下限 < 上限（基本单位）',
        'check.noteC': 'F；下限 < 上限（基本单位）',
        'check.noteL': 'H；下限 < 上限（基本单位）',
        'check.unitCheck': '单位检查',
        'check.noteUnit': '长度 u/n、频率/电流后缀与裸数拦截',
        'check.biasCheck': '偏置 < Vdd 检查',
        'check.noteBias': '关闭后 check_bias_lt_vdd 不再拦截',
        'check.strictIncludes': 'include 严格模式',
        'check.noteStrict': '开启后无法核对的绝对路径 include 也算错误',
        'check.on': '开',
        'check.off': '关',
        'check.oldValue': '（旧值：{v}）',
        'check.confirm': '确认',
        'check.loadFailed': '读取检查参数失败：{msg}',
        'check.saveFailed': '保存失败：{msg}',
        'check.badPair': '“{p}”须为正数且下限 < 上限',
        'pset.title': '项目设置',
        'pset.dirLabel': '工作目录',
        'pset.dirLocalHint': '本地模式：自检产物写入本地 .harnessams/selfcheck/ 目录',
        'pset.dirRemoteRel': '相对路径按远端根路径解析',
        'pset.browse': '浏览',
        'pset.browseTitle': '浏览远程工作目录',
        'pset.browsePickDir': '目录（点名称进入，或点「选择」使用该目录）',
        'pset.pickDir': '选择',
        'pset.pickThisDir': '使用该目录',
        'pset.pickCurrentDir': '用当前目录',
        'pset.colName': '项目名',
        'pset.colValue': '当前值',
        'pset.colMode': '工作模式',
        'pset.colMachine': '远程机器',
        'pset.colRoot': '远端根路径',
        'pset.rootHint': '绝对远端路径（以 / 开头），围栏工作目录',
        'pset.rootMissing': '先在设置表填好「远端根路径」再浏览',
        'pset.unsaved': '未保存',
        'pset.confirmBtn': '确认',
        'pset.confirming': '写入中…',
        'pset.stagedHint': '表格有未确认修改（状态列红色）；「确认」写入 workspace_config.json 并同步 AGENTS.md',
        'pset.colSched': '调度器',
        'pset.colSim': '仿真器',
        'pset.colCompLocal': '本地计算',
        'pset.colCompRemote': '远端计算',
        'pset.mode.local': '本地',
        'pset.mode.remote': '远程',
        'pset.sched.lsf': 'LSF 队列',
        'pset.sched.direct': '直接运行',
        'pset.sim.spectre': 'spectre',
        'pset.sim.none': 'none（免仿真）',
        'pset.comp.python': 'python',
        'pset.comp.js': 'js（node）',
        'pset.noMachine': '（选择机器）',
        'pset.saveFailed': '保存失败：{msg}',
        'selfchk.title': '项目自检',
        'selfchk.desc': '按当前设置全链路验证机器、连接、环境、权限与计算（RC 理想元件 3×3；仿真器 none 用随包 golden 数据免仿真；核验为逐点误差 ≤1%）',
        'selfchk.run': '一键自检',
        'selfchk.running': '自检运行中…',
        'selfchk.startFailed': '启动失败：{msg}',
        'selfchk.scopeLocal': '本地链路',
        'selfchk.scopeRemote': '远程链路（{machine}）',
        'selfchk.noneYet': '尚未运行自检。',
        'selfchk.skipped': '跳过',
        'selfchk.summaryOk': '自检通过',
        'selfchk.summaryFallback': '通过（远程经直接运行回退）',
        'selfchk.summaryFail': '自检失败',
        'selfchk.diagDone': '已创建诊断会话 {id} — 请到左侧会话树查看。',
        'selfchk.diagFail': '创建诊断会话失败：{err}',
        'guide.s6t': '仿真进度卡片',
        'guide.s6': '会话里的仿真工具调用（batch 提交/轮询/取回、进度、分析、spectre 装配/扫掠/解析）渲染为专属进度卡片：实时显示已完成几批、多少个仿真、待完成多少；本地扫批运行中卡片自动刷新。不需要时可在控制台页「显示设置」关闭（默认开启）。',
        'set.title': '显示设置',
        'set.toolview': '会话内仿真进度卡片',
        'set.toolviewHint': '关闭后这些工具调用回退为原始 JSON 显示。浏览器本地偏好，对本机所有会话生效。',
        'card.title.batch_submit': '远程批提交',
        'card.title.batch_poll': '远程批轮询',
        'card.title.batch_fetch': '远程批取回',
        'card.title.sim_progress': '仿真进度',
        'card.title.sim_analysis': '仿真分析',
        'card.title.spectre_assemble': 'Spectre 装配',
        'card.title.spectre_run_sweep': 'Spectre 扫批',
        'card.title.spectre_parse': 'PSF 解析',
        'card.preparing': '等待参数…',
        'card.waitProgress': '等待首个进度文件（启动后约 30 秒出现）…',
        'card.interrupted': '已中断',
        'card.error': '调用失败',
        'card.status.completed': '已完成',
        'card.status.running': '运行中',
        'card.status.failed': '失败',
        'card.status.pending': '待运行',
        'card.status.submitted': '已提交',
        'card.status.queued': '排队中',
        'card.status.partial': '部分完成',
        'card.status.unknown': '未知',
        'card.label.progress': '已完成 {n}/{m}',
        'card.label.succeeded': '成功',
        'card.label.failed': '失败',
        'card.label.pending': '待完成',
        'card.label.node': '计算节点',
        'card.label.updated': '更新于',
        'card.label.job': '作业',
        'card.label.jobState': 'LSF 状态',
        'card.label.scheduler': '调度器',
        'card.label.remoteDir': '远端目录',
        'card.label.runDir': '运行目录',
        'card.label.projectDir': '项目目录',
        'card.label.planned': '本批计划 {n} 个仿真',
        'card.label.fetched': '取回 {n} 点 / {m} 个 sp 文件',
        'card.label.mode': '取回方式',
        'card.label.archive': '归档',
        'card.label.simulator': '仿真器',
        'card.label.results': '结果文件',
        'card.label.report': '报告',
        'card.label.metrics': '{n} 项指标',
        'card.label.registered': '已登记进任务仪表盘',
        'card.label.registerFailed': '仪表盘登记失败',
        'card.label.points': '解析 {n} 个点',
        'card.label.warnings': '警告',
        'card.label.details': '详情',
        'card.agg.line': '已完成 {done}/{batches} 批 · 仿真 {comp}/{total} · 待完成 {pending}',
        'card.agg.unplanned': '（另有 {n} 批未计划）',
        'card.agg.round': '批次',
      },
      en: {
        'common.loading': 'Loading…',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.sectionFailed': 'This section failed: ',
        'common.expand': 'Show more',
        'common.collapse': 'Show less',
        'console.title': 'HarnessAMS Console',
        'console.infoFailed': 'info failed: {msg}',
        'console.config': 'Project config = each workspace\'s own .harnessams/workspace_config.json (the family harnessams.json is retired)',
        'guide.btn': 'Guide',
        'guide.caption': 'First time here? One guided pass over working modes, job submission and reports.',
        'guide.title': 'Get started with HarnessAMS',
        'guide.back': 'Back',
        'guide.done': 'Get started',
        'guide.s1t': 'Working mode: local or remote',
        'guide.s1': 'Local — the spectre loop runs on this machine (assemble → check → simulate → parse → report; Spectre must be installed locally). Remote — hosts (aliases and credentials) are configured in the dsh-ssh plugin; this page\'s “Machines” card lists the aliases, and each remote root is a per-project setting (the “Remote root” row of the project overview settings table).',
        'guide.s2t': 'Job submission',
        'guide.s2': 'Direct — the simulation runs on this machine in the foreground (local spectre sweeps). batch — submit to an LSF queue over dsh-ssh (batch_submit / batch_poll / batch_fetch, sent straight to the machine alias).',
        'guide.s2slurm': 'slurm — not supported yet.',
        'guide.s3t': 'Workspace location',
        'guide.s3': 'Config = each workspace\'s own single file .harnessams/workspace_config.json (run settings incl. the remote root, script dir, plotly, trash). Remote — paths are the real remote paths (dsh-ssh goes by alias, no local mirror).',
        'guide.s4t': 'Simulation plugin suites',
        'guide.s4': 'The suite registers 13 tools in total: SmartAnaSim 6 (spectre assemble/sweep/parse + sNp read/extract — the two sNp tools activate on demand via snp_guide) and HarnessAMS 7 (batch submit/poll/fetch + analysis/progress/trash + the harnessams_selfcheck self-check). All except sNp are registered by default — guidance is provided by HarnessAMS only.',
        'guide.s5t': 'Where things live',
        'guide.s5': 'HarnessAMS sidebar “Project overview” — the project-settings table plus project self-check is the single entry: save to AGENTS.md (one-click project-config table), one-click self-check, list local environment (node/python versions + absolute paths), check all & save; the working directory is picked through the dsh-ssh remote directory browser; “Session” — the current session\'s own workspace: “Dashboard”, an HTML report viewer (sim_analysis registers generated reports into the calling session automatically; existing reports can be browsed in; a forked session starts from a copy of the previously active session\'s whole config) and “Checks”, the session\'s own check parameters (unconfirmed keys fall back to project defaults ∪ built-in defaults); for an interactive shell use dsh-ssh\'s own SSH terminal panel.',
        'hosts.title': 'Machines',
        'hosts.ok': 'dsh-ssh: {n} host(s)',
        'hosts.missing': 'dsh-ssh not available',
        'hosts.colAlias': 'alias',
        'hosts.colHost': 'host',
        'hosts.colAuth': 'auth',
        'hosts.empty': 'no hosts configured in dsh-ssh yet — add one in its panel.',
        'hosts.hint': 'Hosts and credentials are managed by the dsh-ssh plugin; this card is a read-only view of the registry. Each project\'s remote root is configured in the project overview settings table (it belongs to the project).',
        'chk.running': 'Running…',
        'chk.colItem': 'Item',
        'chk.colResult': 'Result',
        'chk.colElapsed': 'Elapsed',
        'chk.colStatus': 'Status',
        'chk.truncated': '(list truncated)',
        'chk.btn.local': 'List local environment',
        'chk.bc.status': 'status',
        'chk.bc.progress': 'progress',
        'agents.saveBtn': 'Save to AGENTS.md',
        'agents.saving': 'Saving…',
        'agents.saved': 'Saved: {path}',
        'agents.saveFailed': 'Save failed: {msg}',
        'agents.checkAll': 'Check all & save',
        'agents.checkAllRunning': 'Checking & saving…',
        'assets.title': 'Digital assets',
        'assets.plotlyOk': 'plotly.min.js served — {size}',
        'assets.plotlyMissing': 'plotly asset missing',
        'assets.openAsset': 'open asset',
        'assets.notices': 'third-party notices',
        'assets.colPkg': 'Package',
        'assets.colLicense': 'License',
        'assets.colPkgCopy': 'Package copy',
        'assets.colRoute': 'Served at',
        'assets.colWsCopies': 'Workspace copies',
        'assets.noCopies': '(no workspace copies)',
        'tasks.noSession': 'no active session',
        'tasks.loadingProject': 'Loading project…',
        'tasks.noProject': 'No project for this session.',
        'tasks.projectOverview': 'Project overview',
        'tasks.sessionTab': 'Session',
        'tasks.projectLabel': 'Project: ',
        'tasks.viewCheck': 'Checks',
        'tasks.viewDashboard': 'Dashboard',
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
        'tasks.headerOpen': 'Open the HarnessAMS sidebar (project overview and session panel)',
        'tasks.guideDesc': 'Project overview, session panel, checks and a guide',
        'check.title': 'Assembly check parameters (this session)',
        'check.desc': 'This session\'s check thresholds and switches; confirming saves them with the session (sessions.json) and they take effect on the next assembly.',
        'check.sourceOwn': 'Confirmed — this session\'s table is in effect',
        'check.sourceFallback': 'Not confirmed — project defaults (check_params.json) ∪ built-in defaults are in effect',
        'check.colParam': 'Parameter',
        'check.colValue': 'Value',
        'check.colNote': 'Note',
        'check.rclR': 'Ideal resistor range (R)',
        'check.rclC': 'Ideal capacitor range (C)',
        'check.rclL': 'Ideal inductor range (L)',
        'check.noteR': 'ohm; min < max (base unit)',
        'check.noteC': 'farad; min < max (base unit)',
        'check.noteL': 'henry; min < max (base unit)',
        'check.unitCheck': 'Unit checks',
        'check.noteUnit': 'length u/n suffixes, freq/current suffixes, bare-number rejection',
        'check.biasCheck': 'Bias < Vdd check',
        'check.noteBias': 'off disables the check_bias_lt_vdd gate',
        'check.strictIncludes': 'Strict includes',
        'check.noteStrict': 'on makes unverifiable absolute includes errors',
        'check.on': 'On',
        'check.off': 'Off',
        'check.oldValue': ' (old: {v})',
        'check.confirm': 'Confirm',
        'check.loadFailed': 'Failed to load check parameters: {msg}',
        'check.saveFailed': 'Failed to save: {msg}',
        'check.badPair': '"{p}" must be positive numbers with min < max',
        'pset.title': 'Project settings',
        'pset.dirLabel': 'Working directory',
        'pset.dirLocalHint': 'local mode: self-check artifacts go under the local .harnessams/selfcheck/ directory',
        'pset.dirRemoteRel': 'relative paths resolve under the remote root',
        'pset.browse': 'Browse',
        'pset.browseTitle': 'Browse remote working directory',
        'pset.browsePickDir': 'Directories (click a name to enter, or "Select" to use it)',
        'pset.pickDir': 'Select',
        'pset.pickThisDir': 'Use this directory',
        'pset.pickCurrentDir': 'Use current directory',
        'pset.colName': 'Item',
        'pset.colValue': 'Value',
        'pset.colMode': 'Mode',
        'pset.colMachine': 'Machine',
        'pset.colRoot': 'Remote root',
        'pset.rootHint': 'absolute remote path (starts with /); fences the working directory',
        'pset.rootMissing': 'fill in the "Remote root" row before browsing',
        'pset.unsaved': 'unsaved',
        'pset.confirmBtn': 'Confirm',
        'pset.confirming': 'Writing…',
        'pset.stagedHint': 'The table has unconfirmed edits (red status cells); "Confirm" writes workspace_config.json and syncs AGENTS.md',
        'pset.colSched': 'Scheduler',
        'pset.colSim': 'Simulator',
        'pset.colCompLocal': 'Local compute',
        'pset.colCompRemote': 'Remote compute',
        'pset.mode.local': 'local',
        'pset.mode.remote': 'remote',
        'pset.sched.lsf': 'LSF queue',
        'pset.sched.direct': 'direct',
        'pset.sim.spectre': 'spectre',
        'pset.sim.none': 'none (no simulation)',
        'pset.comp.python': 'python',
        'pset.comp.js': 'js (node)',
        'pset.noMachine': '(pick a machine)',
        'pset.saveFailed': 'save failed: {msg}',
        'selfchk.title': 'Project self-check',
        'selfchk.desc': 'Walks the full pipeline under the current settings to verify machine, connection, environment, permissions and compute (ideal RC 3×3; simulator "none" replays bundled golden data without simulation; pointwise tolerance 1%).',
        'selfchk.run': 'Run self-check',
        'selfchk.running': 'Self-check running…',
        'selfchk.startFailed': 'failed to start: {msg}',
        'selfchk.scopeLocal': 'Local pipeline',
        'selfchk.scopeRemote': 'Remote pipeline ({machine})',
        'selfchk.noneYet': 'No self-check yet.',
        'selfchk.skipped': 'skipped',
        'selfchk.summaryOk': 'self-check passed',
        'selfchk.summaryFallback': 'passed (remote fell back to the direct run)',
        'selfchk.summaryFail': 'self-check failed',
        'selfchk.diagDone': 'Diagnosis session {id} created — see the session tree.',
        'selfchk.diagFail': 'Failed to create a diagnosis session: {err}',
        'guide.s6t': 'Simulation progress cards',
        'guide.s6': 'Simulation tool calls in a conversation (batch submit/poll/fetch, progress, analysis, '
          + 'spectre assemble/sweep/parse) render as dedicated progress cards: live batches done, simulations '
          + 'finished and pending; a local sweep in flight refreshes the card automatically. Toggle them off in '
          + 'the console page display settings (on by default).',
        'set.title': 'Display settings',
        'set.toolview': 'Simulation progress cards in conversations',
        'set.toolviewHint': 'When off, these tool calls fall back to the raw JSON view. Browser-local preference, '
          + 'applies to every session on this machine.',
        'card.title.batch_submit': 'Remote batch submit',
        'card.title.batch_poll': 'Remote batch poll',
        'card.title.batch_fetch': 'Remote batch fetch',
        'card.title.sim_progress': 'Simulation progress',
        'card.title.sim_analysis': 'Simulation analysis',
        'card.title.spectre_assemble': 'Spectre assemble',
        'card.title.spectre_run_sweep': 'Spectre sweep',
        'card.title.spectre_parse': 'PSF parse',
        'card.preparing': 'Waiting for arguments…',
        'card.waitProgress': 'Waiting for the first progress file (appears ~30 s after start)…',
        'card.interrupted': 'Interrupted',
        'card.error': 'Call failed',
        'card.status.completed': 'Completed',
        'card.status.running': 'Running',
        'card.status.failed': 'Failed',
        'card.status.pending': 'Pending',
        'card.status.submitted': 'Submitted',
        'card.status.queued': 'Queued',
        'card.status.partial': 'Partial',
        'card.status.unknown': 'Unknown',
        'card.label.progress': 'Done {n}/{m}',
        'card.label.succeeded': 'Succeeded',
        'card.label.failed': 'Failed',
        'card.label.pending': 'Pending',
        'card.label.node': 'Compute node',
        'card.label.updated': 'Updated',
        'card.label.job': 'Job',
        'card.label.jobState': 'LSF state',
        'card.label.scheduler': 'Scheduler',
        'card.label.remoteDir': 'Remote dir',
        'card.label.runDir': 'Run dir',
        'card.label.projectDir': 'Project dir',
        'card.label.planned': 'This batch plans {n} simulations',
        'card.label.fetched': 'Fetched {n} points / {m} sp files',
        'card.label.mode': 'Fetch mode',
        'card.label.archive': 'Archive',
        'card.label.simulator': 'Simulator',
        'card.label.results': 'Results file',
        'card.label.report': 'Report',
        'card.label.metrics': '{n} metrics',
        'card.label.registered': 'Registered into the task dashboard',
        'card.label.registerFailed': 'Dashboard registration failed',
        'card.label.points': 'Parsed {n} points',
        'card.label.warnings': 'Warnings',
        'card.label.details': 'Details',
        'card.agg.line': '{done}/{batches} batches done · {comp}/{total} sims · {pending} pending',
        'card.agg.unplanned': '(+{n} unplanned batches)',
        'card.agg.round': 'Batch',
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
    // The DSH-locale-bound translator, kept by wireLocale; effectiveLang() probes it
    // to learn the language the UI is ACTUALLY rendered in (the DSH Language setting,
    // not the browser default) — diagnosis sessions ask the agent to answer in it.
    let boundLocaleTr = null
    function effectiveLang() {
      try {
        if (boundLocaleTr) {
          const probe = boundLocaleTr('common.sectionFailed')
          if (probe === L.zh['common.sectionFailed']) return 'zh'
          if (probe === L.en['common.sectionFailed']) return 'en'
        }
      } catch { /* fall back below */ }
      return ACTIVE_LANG
    }
    // Called from apply() once the real locale service is reachable; registers
    // both dictionaries and rebinds tr so the client's Language setting wins.
    function wireLocale(ctx) {
      try {
        const locale = ctx && ctx.get && ctx.get('locale')
        if (!locale || typeof locale.register !== 'function') return
        const dispose = locale.register(NS, { zh: L.zh, en: L.en })
        const bound = locale.bind(NS)
        boundLocaleTr = bound
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

    // The ONE funnel the Overview buttons use: POST /api/tool with an action
    // (run | status | env | save_agentsmd) plus optional pending settings —
    // the same harnessams_selfcheck surface a conversational agent calls.
    const callToolRoute = (body) => fetchJson(API + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

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
.hams-page { padding: 20px 28px 48px; max-width: 1000px; font-size: var(--dsh-content-font-size, 14px); overflow-wrap: anywhere;
  height: 100%; box-sizing: border-box; overflow-y: auto; }
.hams-h1 { font-size: calc(20px + var(--dsh-content-font-delta, 0px)); margin: 0 0 4px; font-weight: 600; }
.hams-meta { opacity: .7; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); margin-bottom: 14px; }
.hams-section { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 12px 16px 14px; margin: 14px 0; }
.hams-section > h2 { font-size: calc(15px + var(--dsh-content-font-delta, 0px)); margin: 0 0 8px; font-weight: 600; }
/* table-layout:fixed — auto layout lets a <select>'s intrinsic width (immune to
   overflow-wrap) and nowrap cells push the table past the pane; fixed keeps
   columns inside the container and cells wrap via overflow-wrap */
.hams-table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); margin: 8px 0; }
.hams-table .hams-select { max-width: 100%; }
.hams-table th, .hams-table td { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 3px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
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
/* color-scheme makes the native option popup follow the theme; without it the
   popup renders light while the inherited select text stays light too — options
   only became readable on hover (fixed 2026-11-18). System colors on <option>
   keep the popup readable in both themes. */
.hams-select { color-scheme: light dark; }
.hams-select option { background: canvas; color: canvasText; }
.hams-input, .hams-textarea { width: 100%; box-sizing: border-box; }
.hams-textarea { min-height: 90px; resize: vertical; }
.hams-badge { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: calc(12px + var(--dsh-content-font-delta, 0px));
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.hams-badge-good { color: #3fb950; border-color: color-mix(in srgb, #3fb950 45%, transparent); }
.hams-badge-bad { color: #d29922; border-color: color-mix(in srgb, #d29922 45%, transparent); }
.hams-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.hams-err { color: #e05252; padding: 8px; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); }
.hams-pre { font-size: calc(11.5px + var(--dsh-content-font-delta, 0px)); white-space: pre-wrap; margin: 4px 0; opacity: .8;
  overflow-wrap: anywhere; word-break: break-all; line-height: 1.5; }
/* ClampText: read-only text over 8 rendered lines collapses to 8 (max-height in
   em of the pre's own font-size: 8 lines x 1.5 line-height) behind a toggle. */
.hams-clamp { overflow: hidden; max-height: 12em; }
.hams-clamp-open { max-height: none; }
.hams-clamp-btn { background: none; border: none; padding: 0; cursor: pointer; color: inherit; opacity: .65;
  font-size: calc(12px + var(--dsh-content-font-delta, 0px)); text-decoration: underline; }
.hams-clamp-btn:hover { opacity: 1; }
.hams-link { color: inherit; }
.hams-dim { opacity: .65; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
/* tier 1 first-run guide: centered entry state + the sectioned guide page */
.hams-guidecenter { min-height: 70vh; display: flex; align-items: center; justify-content: center; }
.hams-guidecenter-box { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; max-width: 560px; }
.hams-guide-p { line-height: 1.55; margin: 0; }
/* tier 3: task tab strip (modeled after dsh-ssh-ops' server tab strip) */
.hams-tabstrip { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 6px 8px 0;
  border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
.hams-tasktab { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; max-width: 180px;
  border-radius: 6px 6px 0 0; cursor: pointer; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px));
  border: 1px solid transparent; border-bottom: none; }
.hams-tasktab.active { border-color: color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 7%, transparent); }
.hams-tasktab.cur { font-weight: 600; box-shadow: inset 0 -2px 0 currentColor; }
.hams-tasktab .hams-tabname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-body { padding: 8px 10px; overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
.hams-dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.38); display: flex;
  align-items: center; justify-content: center; z-index: 90; }
.hams-dialog { border: 1px solid color-mix(in srgb, currentColor 28%, transparent); border-radius: 9px;
  padding: 16px 18px; min-width: 320px; max-width: 440px; overflow-wrap: anywhere;
  background: color-mix(in srgb, black 20%, canvas); color: fieldtext;
  color: light-dark(canvasText, #e6e6e6); backdrop-filter: blur(3px); }
.hams-browse-dialog { width: 400px; max-width: 92vw; }
.hams-dialog h3 { margin: 0 0 10px; font-size: calc(14.5px + var(--dsh-content-font-delta, 0px)); font-weight: 600; }
.hams-field { margin: 8px 0; }
.hams-field label { display: block; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); opacity: .7; margin-bottom: 3px; }
.hams-subtabs { display: flex; gap: 2px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  margin-bottom: 6px; flex: none; }
.hams-subtab { padding: 3px 10px; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); cursor: pointer; color: inherit; background: none;
  border: none; border-bottom: 2px solid transparent; opacity: .7; }
.hams-subtab.active { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
.hams-dash { margin-top: 12px; border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 14px; opacity: .75; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
/* tier 3 Dashboard: report viewer (toolbar + iframe) and the add-report browser */
.hams-dashview { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; min-height: 0; flex: 1; }
.hams-dashtoolbar { margin: 0; flex-wrap: wrap; }
.hams-dashtoolbar .hams-select { flex: 1 1 120px; min-width: 0; max-width: 100%; }
.hams-btn { text-decoration: none; }
.hams-dashframe { width: 100%; flex: 1; min-height: 300px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; }
.hams-list { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px;
  max-height: 240px; overflow: auto; display: flex; flex-direction: column; }
.hams-listitem { display: flex; align-items: center; gap: 6px; text-align: left; padding: 3px 8px;
  cursor: pointer; background: none; border: none; color: inherit;
  font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
.hams-listitem:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.hams-listitem .hams-dim { margin-left: auto; }
.hams-listitem .hams-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-headerbtn { display: inline-flex; align-items: center; gap: 4px; }
/* session tool cards (tool.call.toolview): simulation progress renderers */
.hams-tc { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px;
  padding: 8px 12px; margin: 4px 0; font-size: var(--dsh-content-font-size, 14px); max-width: 680px; overflow-wrap: anywhere; }
.hams-tc-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hams-tc-title { font-weight: 600; }
.hams-tc-badge { display: inline-block; padding: 0 8px; border-radius: 10px;
  font-size: calc(12px + var(--dsh-content-font-delta, 0px));
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.hams-tc-kv { display: flex; gap: 2px 14px; flex-wrap: wrap; margin: 4px 0 0;
  font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
.hams-tc-kv .hams-tc-k { opacity: .6; }
.hams-tc-bar { height: 6px; border-radius: 4px; overflow: hidden; margin: 6px 0 2px; max-width: 420px;
  background: color-mix(in srgb, currentColor 12%, transparent); }
.hams-tc-fill { height: 100%; border-radius: 4px; background: #3fb950; transition: width .4s ease; }
.hams-tc-fill.run { background: #d29922; }
.hams-tc-fill.bad { background: #e05252; }
.hams-tc-agg { margin-top: 4px; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); opacity: .85; }
.hams-tc-details { margin-top: 6px; }
`
      document.head.append(el)
    }

    function fmtBytes(b) {
      const u = ['B', 'KiB', 'MiB', 'GiB']
      let i = 0
      while (b >= 1024 && i < 3) { b /= 1024; i++ }
      return b.toFixed(1) + ' ' + u[i]
    }

    // identity stringify for React children only — NOT an HTML escaper; never
    // feed its output into innerHTML
    function txt(s) { return String(s ?? '') }

    // ---------- tier 1: global console page ----------

    // First-run flag for the console page guide (global, browser-local — the console
    // page is not per-project). Same try/catch discipline as the strip-selection
    // persistence (readStripSel) in tier 3.
    const GUIDE_SEEN_KEY = 'hams-guide-seen'
    function guideSeenRead() {
      try { return localStorage.getItem(GUIDE_SEEN_KEY) === '1' } catch { return false }
    }
    function guideSeenMark() {
      try { localStorage.setItem(GUIDE_SEEN_KEY, '1') } catch { /* private mode */ }
    }

    function ConsolePage() {
      const [info, setInfo] = useState(null)
      const [infoErr, setInfoErr] = useState(null)
      const [showGuide, setShowGuide] = useState(false)
      const [guideSeen, setGuideSeen] = useState(guideSeenRead)
      useEffect(() => {
        fetchJson(API + '/info').then(setInfo).catch((e) => setInfoErr(String(e.message ?? e)))
      }, [])
      const openGuide = () => { guideSeenMark(); setGuideSeen(true); setShowGuide(true) }
      if (showGuide) return h(GuideView, { onClose: () => setShowGuide(false) })
      // first run: only the centered guide entry — the console sections come after
      if (!guideSeen) {
        return h('div', { className: 'hams-page hams-guidecenter' },
          h('div', { className: 'hams-guidecenter-box' },
            h('div', { className: 'hams-h1' }, tr('guide.title')),
            h('div', { className: 'hams-dim' }, tr('guide.caption')),
            h('button', { className: 'hams-btn', onClick: openGuide }, tr('guide.btn'))))
      }
      return h('div', { className: 'hams-page' },
        h('div', { className: 'hams-row', style: { margin: '0 0 4px' } },
          h('h1', { className: 'hams-h1', style: { margin: 0 } }, tr('console.title')),
          h('button', { className: 'hams-btn hams-btn-sm', style: { marginLeft: 'auto' }, title: tr('guide.title'), onClick: openGuide }, tr('guide.btn'))),
        h('div', { className: 'hams-meta' },
          infoErr ? h('span', { className: 'hams-bad' }, tr('console.infoFailed', { msg: infoErr }))
            : (info ? tr('console.config') + (info.tiers?.project === 'workspaceRegistry mapped' ? '' : ' — ' + info.tiers?.project)
              : tr('common.loading'))),
        h(Boundary, null, h(MachinesSection, null)),
        h(Boundary, null, h(AssetsSection, null)),
        h(Boundary, null, h(DisplaySettingsSection, null)),
      )
    }

    // First-run guide (tier 1 console page): six short sections chaining the scattered
    // per-feature hints into one read. Text only — no state, no requests.
    function GuideView(props) {
      const sec = (tk, k, extra) => h('section', { className: 'hams-section' },
        h('h2', null, tr(tk)),
        h('p', { className: 'hams-guide-p' }, tr(k)),
        extra ?? null)
      return h('div', { className: 'hams-page' },
        h('div', { className: 'hams-row', style: { margin: '0 0 4px' } },
          h('h1', { className: 'hams-h1', style: { margin: 0 } }, tr('guide.title')),
          h('button', { className: 'hams-btn hams-btn-sm', style: { marginLeft: 'auto' }, onClick: props.onClose }, tr('guide.back'))),
        sec('guide.s1t', 'guide.s1'),
        sec('guide.s2t', 'guide.s2', h('div', { className: 'hams-faint' }, tr('guide.s2slurm'))),
        sec('guide.s3t', 'guide.s3'),
        sec('guide.s4t', 'guide.s4'),
        sec('guide.s5t', 'guide.s5'),
        sec('guide.s6t', 'guide.s6'),
        h('div', { className: 'hams-row' },
          h('button', { className: 'hams-btn', onClick: props.onClose }, tr('guide.done'))),
      )
    }

    // ---------- session tool cards (DSH tool.call.toolview slot) ----------
    // DSH renders a generic JSON card per tool call; the tool.call.toolview slot
    // lets a plugin register custom renderers keyed by the exact wire tool name
    // (a typo never renders — the generic card stays). One component covers all
    // eight simulation tools; SmartAnaSim ships no client half and keyed matching
    // is by name across plugins, so the top-level plugin renders both families.
    // Local sweeps poll /api/progress live while their tool call blocks; result
    // cards add the cross-batch aggregate from /api/progress-summary (LOCAL view —
    // remote batches only after batch_fetch brought the progress files back, the
    // same dual-window semantics as the sim_progress tool).
    const SIM_CARD_TOOLS = ['batch_submit', 'batch_poll', 'batch_fetch', 'sim_progress',
      'sim_analysis', 'spectre_assemble', 'spectre_run_sweep', 'spectre_parse']

    // Display toggle (default on): a browser-local preference, NOT project settings —
    // cards render in every session (remote projects included) and remote projects
    // have no sidebar to host a per-project switch. The custom event flips already
    // mounted cards without a reload.
    const TOOLVIEW_KEY = 'hams-toolview'
    const TOOLVIEW_EVENT = 'hams-toolview-change'
    function toolviewEnabledRead() {
      try { return localStorage.getItem(TOOLVIEW_KEY) !== '0' } catch { return true }
    }
    function toolviewEnabledWrite(on) {
      try { localStorage.setItem(TOOLVIEW_KEY, on ? '1' : '0') } catch { /* private mode */ }
      try { window.dispatchEvent(new CustomEvent(TOOLVIEW_EVENT)) } catch { /* ancient host */ }
    }

    // Progress data for one card: /api/progress (single run) + /api/progress-summary
    // (cross-batch aggregate). While the tool call is in flight (active) poll every
    // 3 s with the visibility pause/resume discipline shared by the sidebar polls;
    // settled cards fetch once on mount (one fetch per scroll-back remount is fine).
    function useSimProgress({ runDir, projectDir, active }) {
      const [data, setData] = useState({ prog: null, agg: null })
      useEffect(() => {
        // API already ends with /api — the endpoints hang right off it.
        const progUrl = runDir ? API + '/progress?runDir=' + encodeURIComponent(runDir) : null
        const aggUrl = projectDir ? API + '/progress-summary?projectDir=' + encodeURIComponent(projectDir)
          : runDir ? API + '/progress-summary?runDir=' + encodeURIComponent(runDir) : null
        if (!progUrl && !aggUrl) return
        let alive = true
        let last = ''
        let seq = 0 // out-of-order guard: a slow older response must not clobber a newer one
        const fetchOne = () => {
          const my = ++seq
          return Promise.all([
            progUrl ? fetchJson(progUrl).catch(() => null) : Promise.resolve(null),
            aggUrl ? fetchJson(aggUrl).catch(() => null) : Promise.resolve(null),
          ]).then(([p, a]) => {
            if (!alive || my !== seq || (!p && !a)) return
            const s = JSON.stringify([p, a])
            if (s !== last) { last = s; setData({ prog: p, agg: a }) }
          })
        }
        if (!active) { fetchOne(); return () => { alive = false } }
        const timer = setInterval(() => { if (!document.hidden) fetchOne() }, 3000)
        const onVis = () => { if (!document.hidden) fetchOne() }
        document.addEventListener('visibilitychange', onVis)
        fetchOne()
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [runDir, projectDir, active])
      return data
    }

    function cardStatusText(s) {
      if (!s) return '—'
      const t = tr('card.status.' + s)
      return String(t).indexOf('card.status.') === 0 ? String(s) : t
    }
    const CARD_STATUS_TONE = {
      completed: 'hams-good', running: 'hams-warn', submitted: 'hams-warn', queued: 'hams-warn',
      partial: 'hams-warn', pending: 'hams-faint', failed: 'hams-bad', error: 'hams-bad', unknown: 'hams-faint',
    }
    function CardBadge({ s }) {
      if (!s) return null
      return h('span', { className: 'hams-tc-badge ' + (CARD_STATUS_TONE[String(s)] || 'hams-faint') }, cardStatusText(s))
    }
    function CardBar({ p }) {
      const total = Number(p && p.total) || 0
      if (!total) return null
      const done = Math.min(Number(p && p.completed) || 0, total)
      const pct = Math.round((done / total) * 100)
      const fill = p && p.status === 'failed' ? 'bad' : (p && p.status === 'completed' ? '' : 'run')
      return h('div', null,
        h('div', { className: 'hams-tc-bar' }, h('div', { className: 'hams-tc-fill ' + fill, style: { width: pct + '%' } })),
        h('div', { className: 'hams-dim' }, tr('card.label.progress', { n: done, m: total }) + ' · ' + pct + '%'))
    }
    // One label/value row family; items with an empty label render as bare values
    // (badge-like lines), null/undefined/'' values drop out.
    function CardKv({ items }) {
      const rows = (items || []).filter((x) => x && x.v !== undefined && x.v !== null && x.v !== '')
      if (!rows.length) return null
      return h('div', { className: 'hams-tc-kv' }, rows.map((x, i) => h('span', { key: i, className: x.cls || '' },
        x.k ? [h('span', { key: 'k', className: 'hams-tc-k' }, x.k + ': '), String(x.v)]
          : String(x.v))))
    }
    function dirName(p) {
      const s = String(p || '').replace(/[\\/]+$/, '')
      const cut = s.replace(/[\\/][^\\/]*$/, '')
      return cut && cut !== s ? cut : null
    }
    function cardArgsOf(props) {
      const b = props.block
      if (!b) return null
      const raw = props.phase === 'start' ? b.argsRaw : (b.call ? b.call.argsRaw : null)
      if (typeof raw !== 'string' || !raw) return null
      try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null } catch { return null }
    }
    function cardResultOf(props) {
      const b = props.block
      const text = (Array.isArray(b.content) ? b.content : []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
      let data = null
      try { const v = JSON.parse(text); if (v && typeof v === 'object') data = v } catch { /* raw only */ }
      return { text, data }
    }
    // (runDir, projectDir) candidates for the progress endpoints, per tool shape.
    function cardRoots(toolName, args, data) {
      const a = args || {}
      const r = data || {}
      let runDir = a.run_dir || a.work_dir || a.raw_dir || r.run_dir || null
      let projectDir = a.project_dir || (r.report_dir ? dirName(r.report_dir) : null) || null
      if (toolName === 'spectre_assemble') runDir = a.out_dir || null
      return { runDir: runDir || null, projectDir: projectDir || null }
    }

    function simStatusOf(toolName, phase, result, live) {
      if (phase === 'start') return 'running'
      if (phase !== 'result') return null
      const d = result && result.data
      if (!d) return null
      if (toolName === 'batch_poll') return d.state
      if (toolName === 'sim_progress') return d.status
      if (toolName === 'batch_submit') return d.state
      if (toolName === 'spectre_run_sweep') return (live.prog && live.prog.local && live.prog.status) || (d.ok ? 'completed' : 'failed')
      return d.ok ? 'completed' : 'failed'
    }

    function aggLine(agg) {
      const t = agg.totals || {}
      return tr('card.agg.line', { done: t.batches_done ?? 0, batches: t.batches ?? 0,
        comp: t.sims_completed ?? 0, total: t.sims_total ?? 0, pending: t.sims_pending ?? 0 })
        + (t.batches_unplanned ? ' ' + tr('card.agg.unplanned', { n: t.batches_unplanned }) : '')
    }
    function aggTable(agg) {
      // Status/progress columns reuse the Overview batch-check translations;
      // statuses stay protocol values server-side and get tone+text here.
      return h('table', { className: 'hams-table' },
        h('thead', null, h('tr', null,
          ['card.agg.round', 'chk.bc.status', 'chk.bc.progress'].map((k) => h('th', { key: k }, tr(k))))),
        h('tbody', null, (agg.batches || []).map((b) => h('tr', { key: b.round, title: b.dir || '' },
          h('td', null, txt(b.round)),
          h('td', { className: batchStatusColor(b.status) }, cardStatusText(b.status)),
          h('td', null, txt(b.total != null ? (Number(b.completed) || 0) + '/' + b.total : '—'))))))
    }

    function simBody(toolName, args, result, live, phase) {
      const els = []
      const p = live.prog && live.prog.local ? live.prog : null
      // While the tool call blocks (local sweep): live bar from the progress file.
      if (phase === 'start') {
        if (p && p.total) {
          els.push(h(CardBar, { key: 'bar', p }), h(CardKv, { key: 'kv', items: [
            { k: tr('card.label.succeeded'), v: p.succeeded },
            { k: tr('card.label.failed'), v: p.failed },
            { k: tr('card.label.pending'), v: p.pending },
            { k: tr('card.label.node'), v: p.compute_node },
          ] }))
        } else {
          els.push(h('div', { key: 'wait', className: 'hams-dim' }, tr('card.waitProgress')))
        }
        return els
      }
      const d = result && result.data
      if (!d) {
        els.push(h('div', { key: 'raw', className: 'hams-dim' }, '—'))
        return els
      }
      if (toolName === 'batch_poll' || toolName === 'sim_progress') {
        if (d.ok === false && d.error) els.push(h('div', { key: 'perr', className: 'hams-bad' }, txt(String(d.error).slice(0, 400))))
        if (d.total) els.push(h(CardBar, { key: 'bar', p: { total: d.total, completed: d.completed, status: d.state || d.status } }))
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.succeeded'), v: d.succeeded },
          { k: tr('card.label.failed'), v: d.failed },
          { k: tr('card.label.pending'), v: d.total != null ? Math.max((Number(d.total) || 0) - (Number(d.completed) || 0), 0) : null },
          { k: tr('card.label.jobState'), v: d.job_state },
          { k: tr('card.label.node'), v: d.compute_node },
          { k: tr('card.label.remoteDir'), v: d.remote_dir },
          { k: tr('card.label.updated'), v: d.updated_at },
        ] }))
        if (d.errlog_tail) els.push(h(ClampText, { key: 'err', text: String(d.errlog_tail), className: 'hams-warn' }))
        return els
      }
      if (toolName === 'batch_submit') {
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.job'), v: d.job_id },
          { k: tr('card.label.scheduler'), v: d.scheduler },
          { k: '', v: p && p.total ? tr('card.label.planned', { n: p.total }) : null },
          { k: tr('card.label.remoteDir'), v: d.remote_dir },
          { k: tr('card.label.warnings'), v: Array.isArray(d.warnings) && d.warnings.length ? d.warnings.length : null },
        ] }))
        return els
      }
      if (toolName === 'batch_fetch') {
        const f = d.fetched || {}
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.job'), v: d.job_id },
          { k: '', v: (f.points != null || f.sp_files != null) ? tr('card.label.fetched', { n: f.points ?? 0, m: f.sp_files ?? 0 }) : null },
          { k: tr('card.label.mode'), v: d.mode },
          { k: tr('card.label.archive'), v: d.archive },
        ] }))
        return els
      }
      if (toolName === 'sim_analysis') {
        const metrics = d.summary && typeof d.summary === 'object' ? Object.keys(d.summary).length : null
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.simulator'), v: d.simulator },
          { k: '', v: metrics ? tr('card.label.metrics', { n: metrics }) : null, cls: 'hams-good' },
          { k: tr('card.label.results'), v: d.results_file },
          { k: tr('card.label.report'), v: d.report_path },
          d.registered === true ? { k: '', v: tr('card.label.registered'), cls: 'hams-good' }
            : d.registered === false ? { k: '', v: tr('card.label.registerFailed'), cls: 'hams-warn' } : null,
        ] }))
        return els
      }
      if (toolName === 'spectre_assemble') {
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.projectDir'), v: d.project_dir || (args && args.project_dir) },
          { k: '', v: p && p.total ? tr('card.label.planned', { n: p.total }) : null },
        ] }))
        return els
      }
      if (toolName === 'spectre_run_sweep') {
        if (p && p.total) els.push(h(CardBar, { key: 'bar', p }))
        if (p && p.source === 'progress') {
          els.push(h(CardKv, { key: 'kv', items: [
            { k: tr('card.label.succeeded'), v: p.succeeded },
            { k: tr('card.label.failed'), v: p.failed },
            { k: tr('card.label.node'), v: p.compute_node },
            { k: tr('card.label.updated'), v: p.updated_at },
          ] }))
        }
        const doneLine = String(d.output || '').split('\n').map((l) => l.trim()).filter((l) => l.indexOf('[sweep] done:') === 0).pop()
        if (doneLine) els.push(h('div', { key: 'done', className: 'hams-dim' }, txt(doneLine)))
        els.push(h(CardKv, { key: 'dir', items: [{ k: tr('card.label.runDir'), v: d.run_dir }] }))
        return els
      }
      if (toolName === 'spectre_parse') {
        const n = d.summary && Array.isArray(d.summary.points) ? d.summary.points.length : null
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.results'), v: d.out_dir },
          { k: '', v: n ? tr('card.label.points', { n }) : null },
        ] }))
        return els
      }
      els.push(h('div', { key: 'raw', className: 'hams-dim' }, '—'))
      return els
    }

    function rawTextOf(props, result) {
      const args = cardArgsOf(props)
      const parts = []
      if (args) parts.push(JSON.stringify(args, null, 2))
      if (props.phase === 'result') parts.push(result && result.text ? result.text : '(no result text)')
      return parts.join('\n---\n')
    }

    // Long read-only text (check details, raw JSON, log tails) collapses past 8
    // rendered lines: a clamped <pre> plus a toggle that only renders when the
    // content actually overflows — measured after mount, so WRAPPING (not the
    // newline count) decides. Re-collapses whenever the text changes.
    function ClampText({ text, className }) {
      const [open, setOpen] = useState(false)
      const [overflows, setOverflows] = useState(false)
      const ref = useRef(null)
      useEffect(() => { setOpen(false) }, [text])
      useEffect(() => {
        if (open) return
        const el = ref.current
        if (!el) return
        setOverflows(el.scrollHeight > el.clientHeight + 1)
      }, [open, text])
      return h('div', null,
        h('pre', {
          ref,
          className: 'hams-pre hams-clamp' + (open ? ' hams-clamp-open' : '') + (className ? ' ' + className : ''),
        }, txt(text)),
        overflows && h('button', { className: 'hams-clamp-btn', onClick: () => setOpen(!open) },
          tr(open ? 'common.collapse' : 'common.expand')))
    }

    // One simulation tool call card, all three phases. Occupying the key means an
    // off toggle cannot fall back to the DSH generic card — the off view renders
    // the raw shape itself instead of leaving an empty row.
    function SimToolCard(props) {
      const [on, setOn] = useState(toolviewEnabledRead)
      useEffect(() => {
        const sync = () => setOn(toolviewEnabledRead())
        window.addEventListener(TOOLVIEW_EVENT, sync)
        return () => window.removeEventListener(TOOLVIEW_EVENT, sync)
      }, [])
      const phase = props.phase
      const toolName = props.toolName
      const d = props.useDisclosure()
      const args = cardArgsOf(props)
      const result = phase === 'result' && props.block ? cardResultOf(props) : null
      const roots = cardRoots(toolName, args, result ? result.data : null)
      const live = useSimProgress({ runDir: roots.runDir, projectDir: roots.projectDir, active: phase === 'start' })
      if (!on) {
        return h('div', { className: 'hams-tc' },
          h('div', { className: 'hams-tc-head' },
            h('span', { className: 'hams-tc-title' }, txt(toolName)),
            h('span', { className: 'hams-faint' }, txt(phase))),
          phase === 'start' && args ? h(ClampText, { text: JSON.stringify(args, null, 2) }) : null,
          result ? h(ClampText, { text: (result.text || '').slice(0, 4000) }) : null)
      }
      const agg = live.agg && live.agg.local ? live.agg : null
      let body
      let status = simStatusOf(toolName, phase, result, live)
      if (phase === 'result' && props.block && props.block.isError) {
        const err = (props.block.error || {})
        const interrupted = err.code === 'interrupted'
        status = interrupted ? 'unknown' : 'failed'
        body = h('div', { className: interrupted ? 'hams-warn' : 'hams-bad' },
          interrupted ? tr('card.interrupted') : tr('card.error'),
          err.name ? ' — ' + txt(String(err.name)) : null,
          err.reason ? ' · ' + txt(String(err.reason).slice(0, 300)) : null)
      } else if (phase === 'preparing') {
        body = h('div', { className: 'hams-dim' }, tr('card.preparing'))
        status = null
      } else {
        body = h('div', null, simBody(toolName, args, result, live, phase))
      }
      return h('div', { className: 'hams-tc' },
        h('div', { className: 'hams-tc-head' },
          h('span', { className: 'hams-tc-title' }, tr('card.title.' + toolName)),
          h(CardBadge, { s: status }),
          agg ? h('span', { className: 'hams-tc-agg' }, txt(aggLine(agg))) : null,
          h('button', { className: 'hams-btn hams-btn-sm', style: { marginLeft: 'auto' }, onClick: d.toggle }, tr('card.label.details'))),
        body,
        d.expanded ? h('div', { className: 'hams-tc-details' },
          agg && (agg.batches || []).length ? aggTable(agg) : null,
          h(ClampText, { text: rawTextOf(props, result) })) : null)
    }

    // Console-page display settings: the toggle backing the tool cards (guide s6
    // points here; the preference is browser-local by design — see TOOLVIEW_KEY).
    function DisplaySettingsSection() {
      const [on, setOn] = useState(toolviewEnabledRead)
      useEffect(() => {
        const sync = () => setOn(toolviewEnabledRead())
        window.addEventListener(TOOLVIEW_EVENT, sync)
        return () => window.removeEventListener(TOOLVIEW_EVENT, sync)
      }, [])
      return h('section', { className: 'hams-section' },
        h('h2', null, tr('set.title')),
        h('label', { className: 'hams-row', style: { cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: on,
            onChange: (e) => { toolviewEnabledWrite(e.target.checked); setOn(e.target.checked) } }),
          h('span', null, tr('set.toolview'))),
        h('div', { className: 'hams-dim' }, tr('set.toolviewHint')))
    }

    // Machines (tier 1): the dsh-ssh host registry read through /api/machines —
    // pure registry facts (the remote root is a per-project setting since the
    // 2026-11-19 config consolidation, not a machine column). Host credentials
    // and connections live in dsh-ssh itself.
    function MachinesSection() {
      const [machines, setMachines] = useState(null)
      useEffect(() => {
        fetchJson(API + '/machines').then(setMachines).catch((e) => setMachines({ installed: false, reason: String(e.message ?? e) }))
      }, [])
      return h('section', { className: 'hams-section' },
        h('h2', null, tr('hosts.title')),
        h('div', { className: 'hams-row' },
          machines && (machines.installed
            ? h('span', { className: 'hams-badge hams-badge-good', title: machines.source }, tr('hosts.ok', { n: machines.machines?.length ?? 0 }))
            : h('span', { className: 'hams-badge hams-badge-bad', title: machines.reason ?? '' }, tr('hosts.missing'))),
        ),
        machines?.installed && (machines.machines?.length ?? 0) > 0 && h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null, [tr('hosts.colAlias'), tr('hosts.colHost'), tr('hosts.colAuth')].map((c) => h('th', { key: c }, c)))),
          h('tbody', null, machines.machines.map((m) => h('tr', { key: m.id },
            h('td', null, txt(m.name || m.host)),
            h('td', null, txt((m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22))),
            h('td', null, txt(m.auth ?? '') + (m.auth === 'key' && !m.keyReady ? ' ⚠' : '')))))),
        machines?.installed && (machines.machines?.length ?? 0) === 0 && h('div', { className: 'hams-dim' }, tr('hosts.empty')),
        h('div', { className: 'hams-dim' }, tr('hosts.hint')),
      )
    }

    // Digital assets (tier 1): which .js packages the plugin vendors (with their
    // licenses), the served package copy, and where stray copies live in the
    // workspace. Reports are NOT listed here — they live in the task dashboard.
    function AssetsSection() {
      const [assets, setAssets] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        fetchJson(API + '/assets').then(setAssets).catch((e) => setErr(String(e.message ?? e)))
      }, [])
      return h('section', { className: 'hams-section' },
        h('h2', null, tr('assets.title')),
        err && h('div', { className: 'hams-err' }, err),
        h('div', { className: 'hams-row' },
          assets?.plotly?.available
            ? h('span', { className: 'hams-badge hams-badge-good' }, tr('assets.plotlyOk', { size: fmtBytes(assets.plotly.bytes) }))
            : h('span', { className: 'hams-badge hams-badge-bad' }, tr('assets.plotlyMissing')),
          h('a', { className: 'hams-link hams-dim', href: '/harnessams/assets/THIRD_PARTY_NOTICES.md', target: '_blank' }, tr('assets.notices')),
        ),
        assets?.packages?.length > 0 && h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null,
            [tr('assets.colPkg'), tr('assets.colLicense'), tr('assets.colPkgCopy'), tr('assets.colRoute'), tr('assets.colWsCopies')].map((c) => h('th', { key: c }, c)))),
          h('tbody', null, assets.packages.map((p) => h('tr', { key: p.file },
            h('td', null, txt(p.file), h('div', { className: 'hams-dim' }, p.label)),
            h('td', null, p.license),
            h('td', null,
              p.pkg
                ? [txt(p.pkg.path), h('div', { className: 'hams-dim' }, fmtBytes(p.pkg.bytes))]
                : h('span', { className: 'hams-warn' }, tr('assets.plotlyMissing'))),
            h('td', null, h('a', { className: 'hams-link', href: p.url, target: '_blank' }, tr('assets.openAsset'))),
            h('td', null,
              !p.copies?.length
                ? h('span', { className: 'hams-dim' }, tr('assets.noCopies'))
                : p.copies.map((c) => h('div', { key: c.path, title: c.path }, txt(c.path), ' — ', fmtBytes(c.bytes))))))),
        ),
      )
    }

    // ---------- tier 3: per-project session sidebar ----------

    // Lowest navigation level inside the session panel: dashboard / check
    // parameters (the sim-settings placeholder was removed with the task
    // retirement — SmartAnaSim keeps no per-task UI). The remote-terminal
    // sub-view was removed with the dsh-remote retirement — the user's
    // interactive shell is @linxin666/dsh-ssh's own terminal panel. Above this
    // sits the two-entry strip (project overview + this session), and above
    // that the tab itself — see ProjectOverviewView.
    const TASK_VIEWS = [
      { id: 'dashboard', labelKey: 'tasks.viewDashboard' },
      { id: 'check', labelKey: 'tasks.viewCheck' },
    ]

    // The DSH host occasionally remounts the sidebar slot body mid-conversation
    // (observed when agent tool cards render), which resets React state and used
    // to snap the sub-view back to overview. Keep the last selection outside the
    // component (module memory + localStorage) so a remount — or a page refresh
    // — reopens the same sub-view.
    const TASK_VIEW_KEY = 'hams-task-view'
    const isValidTaskView = (v) => TASK_VIEWS.some((t) => t.id === v)
    let taskViewMemory = null
    function readTaskView() {
      if (taskViewMemory) return taskViewMemory
      try {
        const v = localStorage.getItem(TASK_VIEW_KEY)
        if (isValidTaskView(v)) { taskViewMemory = v; return v }
      } catch { /* private mode */ }
      return 'dashboard'
    }
    function rememberTaskView(v) {
      taskViewMemory = v
      try { localStorage.setItem(TASK_VIEW_KEY, v) } catch { /* private mode */ }
    }

    // First-level strip + session config state, PER SESSION (decisions.md
    // D-008, 2026-11-19): each DSH session is a work unit carrying its own
    // config — which view the body shows ('overview' | 'session'), its
    // dashboard reports and confirmed check params — PERSISTED to
    // <workspace>/.harnessams/sessions.json (a reload must NOT lose it).
    // Module memory is the runtime truth; every change merge-PUTs the
    // session's entry. A FIRST-SEEN session splits on the server's fork
    // verdict (log-marker based): a fork DEEP-COPIES the previously active
    // session's CURRENT config — deliberately branch-point-independent (the
    // fork parent is not identified, no branch-cut state is reconstructed);
    // a brand-new session starts EMPTY, and its written entry doubles as the
    // tombstone that stops fork re-detection.
    const sessionConfigState = new Map() // sessionId -> { display, reports[], dashboard_selected, check_params? }
    const lastActiveSessionId = { id: null }
    const hydratedProjects = new Set() // projectPath values whose sessions.json is already in the map
    const emptySessionConfig = () => ({ display: 'overview', reports: [], dashboard_selected: null })
    function cloneSessionConfig(src) {
      if (!src || typeof src !== 'object') return emptySessionConfig()
      return {
        display: src.display === 'session' ? 'session' : 'overview',
        reports: Array.isArray(src.reports) ? src.reports.map((r) => ({ ...r })) : [],
        dashboard_selected: typeof src.dashboard_selected === 'string' ? src.dashboard_selected : null,
        ...(src.check_params && typeof src.check_params === 'object'
          ? { check_params: JSON.parse(JSON.stringify(src.check_params)) }
          : {}),
      }
    }
    function sessionConfigOf(sessionId, fork, fallbackSource) {
      if (!sessionId) return emptySessionConfig()
      if (!sessionConfigState.has(sessionId)) {
        const prev = fork ? (fallbackSource ?? null) : null
        sessionConfigState.set(sessionId, prev ? cloneSessionConfig(prev) : emptySessionConfig())
      }
      return sessionConfigState.get(sessionId)
    }
    // Copy source for a first-seen FORK (deliberately branch-point-independent,
    // D-008): the last-ACTIVE session of this page lifetime when there is one,
    // else the store's most recently written entry (sessions.json insertion
    // order doubles as recency — the fork source is almost always the last
    // writer). Never the session itself.
    function forkCopySource(sessionsMap, selfId) {
      if (lastActiveSessionId.id) {
        const own = sessionConfigState.get(lastActiveSessionId.id)
        if (own) return own
      }
      if (sessionsMap && typeof sessionsMap === 'object') {
        const keys = Object.keys(sessionsMap).filter((k) => k !== selfId)
        const last = keys[keys.length - 1]
        if (last && sessionsMap[last]) return sessionsMap[last]
      }
      return null
    }
    function putSessionConfig(sessionId) {
      if (!sessionId) return
      const st = sessionConfigState.get(sessionId) ?? null
      fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, state: st ? cloneSessionConfig(st) : null }),
      }).catch(() => { /* offline: the in-memory map keeps working */ })
    }

    // Host right-sidebar layout persistence is per session (localStorage
    // dsh.sidebar-right.v1.<sessionId>): the value's layout.nodes.*.tabs arrays
    // list the tabs that session's sidebar has EVER hosted — EMPTY tabs means
    // the user never touched that session's sidebar (the host writes the key
    // with an empty collapsed layout at session creation), which is exactly the
    // window where the project's default-open policy may act. Unreadable or
    // odd-shaped storage counts as "touched" so the default never forces itself.
    function sessionSidebarUntouched(sessionId) {
      let raw = null
      try { raw = localStorage.getItem('dsh.sidebar-right.v1.' + sessionId) } catch { return false }
      if (raw == null) {
        try { raw = localStorage.getItem('dsh.sidebar-right.v1') } catch { return false }
        if (raw == null) return true // no layout record at all
      }
      try {
        const v = JSON.parse(raw)
        const layout = v?.bySession?.[sessionId]?.layout ?? v?.layout ?? v
        const nodes = Object.values(layout?.nodes ?? {})
        const tabCount = nodes.reduce((n, node) => n + (Array.isArray(node?.tabs) ? node.tabs.length : 0), 0)
        return tabCount === 0
      } catch { return false }
    }
    // sessionIds this page lifetime already auto-opened for (bounds retries)
    const autoOpenedFor = new Set()

    // Last workspace state seen by any mounted surface: a brand-new session is
    // created under the CURRENT workspace, so this answers the default-open
    // question while the new session is still unaccounted in the workspace
    // registry (blank sessions enter it only after their first turn).
    const lastProjectInfo = { initialized: null }

    // Local-environment results table (the "list local environment" button in the
    // project-settings block): the classic Item/Result/Elapsed/Status rows; the
    // Node/Python rows carry their absolute executable paths in the detail clamp.
    function LocalEnvResults({ run }) {
      return h('div', null,
        h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null, [tr('chk.colItem'), tr('chk.colResult'), tr('chk.colElapsed'), tr('chk.colStatus')].map((c) => h('th', { key: c }, c)))),
          h('tbody', null, (run.results ?? []).map((x, i) => h('tr', { key: i, className: x.ok ? '' : 'hams-rowbad' },
            h('td', null, txt(x.item)),
            h('td', null,
              txt(x.result || x.detail || '-'),
              x.warn ? h('span', { className: 'hams-warn' }, ' ⚠ ' + txt(x.warn)) : null,
              x.ok && x.detail ? h(ClampText, { text: x.detail }) : null),
            h('td', null, x.ms + ' ms'),
            h('td', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'))))))
    }

    // Remote working-directory picker (settings table, remote mode): one
    // directory level per fetch (GET /api/remote-browse — ssh_exec by alias
    // through the execRemote funnel), starting at the machine's remote root.
    // Clicking a name enters the directory; the per-row "select" button (or the
    // footer's "use current") writes the ABSOLUTE path into remote_dir — the old
    // free-typed text input is retired. Mirrors the add-report dialog's shape.
    function RemoteDirBrowse({ sessionId, machineId, rootDir, onCancel, onPick }) {
      const [cwd, setCwd] = useState(null) // null = server default (the machine's remote root)
      const [listing, setListing] = useState(null)
      const [error, setError] = useState(null)
      useEffect(() => {
        let alive = true
        setError(null); setListing(null)
        const q = 'sessionId=' + encodeURIComponent(sessionId)
          + '&machineId=' + encodeURIComponent(machineId)
          + (cwd ? '&dir=' + encodeURIComponent(cwd) : '')
        fetchJson(API + '/remote-browse?' + q)
          .then((r) => { if (alive) setListing(r) })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [sessionId, machineId, cwd])
      return h('div', { className: 'hams-dialog-backdrop', onClick: (e) => { if (e.target === e.currentTarget) onCancel() } },
        h('div', { className: 'hams-dialog hams-browse-dialog' },
          h('h3', null, tr('pset.browseTitle')),
          h('div', { className: 'hams-field' },
            h('label', null, tr('dash.currentDir')),
            h('div', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
              h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.parentDir'),
                disabled: !listing?.parent, onClick: () => setCwd(listing.parent) }, '↑'),
              h('span', { className: 'hams-dim',
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                txt(listing ? listing.dir : (cwd ?? rootDir ?? '…'))))),
          h('div', { className: 'hams-field' },
            h('label', null, tr('pset.browsePickDir')),
            h('div', { className: 'hams-list' },
              error && h('div', { className: 'hams-err' }, error),
              listing && !error && h('div', null,
                (listing.dirs ?? []).map((d) => h('div', { key: 'd:' + d, className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
                  h('button', { className: 'hams-listitem', style: { flex: 1, textAlign: 'left', minWidth: 0 },
                    onClick: () => setCwd(listing.dir + '/' + d) },
                    h('span', { className: 'hams-name' }, '📁 ' + txt(d))),
                  h('button', { className: 'hams-btn hams-btn-sm', title: tr('pset.pickThisDir'),
                    onClick: () => onPick(listing.dir + '/' + d) }, tr('pset.pickDir')))),
                listing.truncated && h('div', { className: 'hams-dim', style: { padding: '4px 8px' } }, tr('chk.truncated')),
                !(listing.dirs ?? []).length && h('div', { className: 'hams-dim', style: { padding: '4px 8px' } }, tr('dash.emptyDir'))))),
          h('div', { className: 'hams-row', style: { justifyContent: 'space-between' } },
            h('button', { className: 'hams-btn hams-btn-sm', disabled: !listing, onClick: () => onPick(listing.dir) },
              tr('pset.pickCurrentDir')),
            h('button', { className: 'hams-btn', onClick: onCancel }, tr('common.cancel')))))
    }

    // ---------- tier 3 Overview: project settings + one-click project self-check ----------
    // The settings table is ROW-per-setting with three columns: the setting's
    // name / the live value (dropdown cell, PUT on every change) / that
    // setting's self-check verdict (aggregated from the run's steps
    // server-tagged with a settingColumn). Row visibility cascades off the
    // mode/simulator choices (a local project hides the machine/scheduler/
    // remote-compute rows).
    const SETTING_COLS = [
      { id: 'run_mode', labelKey: 'pset.colMode', column: 'run_mode',
        options: [['local', 'pset.mode.local'], ['remote', 'pset.mode.remote']] },
      { id: 'machine_id', labelKey: 'pset.colMachine', column: 'machine', kind: 'machine',
        visible: (s) => s.run_mode === 'remote' },
      { id: 'remote_root', labelKey: 'pset.colRoot', column: 'remote_root', kind: 'text',
        visible: (s) => s.run_mode === 'remote' },
      { id: 'scheduler', labelKey: 'pset.colSched', column: 'scheduler',
        visible: (s) => s.run_mode === 'remote' && s.simulator === 'spectre',
        options: [['lsf', 'pset.sched.lsf'], ['direct', 'pset.sched.direct']] },
      { id: 'simulator', labelKey: 'pset.colSim', column: 'simulator',
        options: [['spectre', 'pset.sim.spectre'], ['none', 'pset.sim.none']] },
      { id: 'compute_script_local', labelKey: 'pset.colCompLocal', column: 'compute_local',
        options: [['python', 'pset.comp.python'], ['js', 'pset.comp.js']] },
      { id: 'compute_script_remote', labelKey: 'pset.colCompRemote', column: 'compute_remote',
        visible: (s) => s.run_mode === 'remote',
        options: [['python', 'pset.comp.python'], ['js', 'pset.comp.js']] },
    ]

    // Aggregate one settings column from the run's step stream: any failure →
    // bad, else any warn (e.g. the LSF→direct fallback) → warn, all-skip → skip.
    function selfcheckColumnResult(run, column) {
      if (!run) return null
      const steps = (run.steps ?? []).filter((s) => s && s.settingColumn === column && s.ms != null)
      if (!steps.length) return null
      const title = steps.map((s) => `${s.section}/${s.item}: ${s.ok === false ? 'FAIL' : s.ok === null ? 'skip' : 'ok'} ${s.result ?? ''}`).join('\n')
      const failed = steps.filter((s) => s.ok === false)
      if (failed.length) return { state: 'bad', text: failed[0].result || 'failed', title }
      if (steps.some((s) => s.warn)) return { state: 'warn', text: steps[steps.length - 1].result, title }
      if (steps.every((s) => s.ok === null)) return { state: 'skip', text: tr('selfchk.skipped'), title: steps[0].skipReason ?? title }
      return { state: 'ok', text: steps[steps.length - 1].result, title }
    }

    // The table edits STAGE into a draft (nothing hits the wire per cell);
    // while the draft differs from the saved settings every status cell shows a
    // red "unsaved" marker (the saved verdicts are stale by definition) until
    // the Confirm button commits the whole object through POST /api/tool.
    function SettingsTable({ draft, machines, run, onChange, dirty }) {
      const cols = SETTING_COLS.filter((c) => !c.visible || c.visible(draft))
      const settingCell = (c) => {
        if (c.kind === 'machine') {
          const known = machines.some((m) => m.id === draft.machine_id)
          return h('select', { className: 'hams-select', value: draft.machine_id ?? '',
            onChange: (e) => onChange('machine_id', e.target.value || null) },
            h('option', { value: '' }, tr('pset.noMachine')),
            (known ? [] : draft.machine_id
              ? [h('option', { key: 'kept', value: draft.machine_id }, txt(draft.machine_id) + ' ?')] : []),
            machines.map((m) => h('option', { key: m.id, value: m.id },
              txt(m.name || m.host) + (m.host && m.host !== m.name ? ' · ' + txt(m.host) : ''))))
        }
        if (c.kind === 'text') {
          return h('input', { className: 'hams-input', type: 'text', spellCheck: false,
            placeholder: '/home/…', title: tr('pset.rootHint'),
            value: draft[c.id] ?? '', onChange: (e) => onChange(c.id, e.target.value.trim() || null) })
        }
        return h('select', { className: 'hams-select', value: draft[c.id] ?? '',
          onChange: (e) => onChange(c.id, e.target.value) },
          c.options.map(([v, k]) => h('option', { key: v, value: v }, tr(k))))
      }
      const resultCell = (c) => {
        const agg = selfcheckColumnResult(run, c.column)
          ?? (c.column === 'run_mode' && run?.summary
            ? { state: run.summary.ok ? 'ok' : 'bad', text: tr(run.summary.ok ? 'selfchk.summaryOk' : 'selfchk.summaryFail'), title: '' }
            : null)
        if (dirty) {
          return h('td', { key: c.id, className: 'hams-bad', title: tr('pset.stagedHint') }, '● ' + tr('pset.unsaved'))
        }
        if (!agg) return h('td', { key: c.id, className: 'hams-faint' }, '—')
        const cls = agg.state === 'ok' ? 'hams-good' : agg.state === 'warn' ? 'hams-warn' : agg.state === 'skip' ? 'hams-faint' : 'hams-bad'
        const icon = agg.state === 'ok' ? '✅' : agg.state === 'warn' ? '⚠' : agg.state === 'skip' ? '⏭' : '✗'
        return h('td', { key: c.id, className: cls, title: agg.title || agg.text }, icon + ' ' + txt(agg.text))
      }
      return h('table', { className: 'hams-table' },
        h('thead', null, h('tr', null, [tr('pset.colName'), tr('pset.colValue'), tr('chk.colStatus')]
          .map((c) => h('th', { key: c }, c)))),
        h('tbody', null, cols.map((c) => h('tr', { key: c.id },
          h('td', { key: 'name' }, tr(c.labelKey)),
          h('td', { key: 'value' }, settingCell(c)),
          resultCell(c)))))
    }


    // Step-detail table under the settings table: local/remote section headers +
    // the classic Item/Result/Elapsed/Status rows (skipped steps show ⏭ with the
    // skip reason as the tooltip).
    function SelfcheckSteps({ run }) {
      if (!run || !(run.steps ?? []).length) {
        return h('div', { className: 'hams-dim' }, tr('selfchk.noneYet'))
      }
      const rows = []
      let lastSection = null
      for (const s of run.steps) {
        if (s.section !== lastSection) {
          lastSection = s.section
          rows.push(h('tr', { key: 'sec:' + rows.length },
            h('td', { colSpan: 4, className: 'hams-faint', style: { fontWeight: 600 } },
              tr(s.section === 'remote' ? 'selfchk.scopeRemote' : 'selfchk.scopeLocal',
                { machine: run.scope?.machine?.name ?? run.scope?.machine?.host ?? '' }))))
        }
        const icon = s.ok === true ? '✅' : s.ok === false ? '✗' : '⏭'
        const cls = s.ok === true ? 'hams-good' : s.ok === false ? 'hams-bad' : 'hams-faint'
        rows.push(h('tr', { key: rows.length, className: s.ok === false ? 'hams-rowbad' : '' },
          h('td', { title: s.skipReason ?? '' }, txt(s.item),
            s.warn ? h('span', { className: 'hams-warn' }, ' ⚠ ' + txt(s.warn)) : null),
          h('td', { title: s.detail || '' },
            txt(s.result || (s.skipReason ? tr('selfchk.skipped') + ' — ' + s.skipReason : '-')),
            s.ok !== false && s.detail ? h(ClampText, { text: s.detail }) : null),
          h('td', null, s.ms != null ? s.ms + ' ms' : ''),
          h('td', { className: cls }, icon)))
      }
      return h('table', { className: 'hams-table' },
        h('thead', null, h('tr', null, [tr('chk.colItem'), tr('chk.colResult'), tr('chk.colElapsed'), tr('chk.colStatus')]
          .map((c) => h('th', { key: c }, c)))),
        h('tbody', null, rows))
    }

    // Module memory for the overview tab's project-level surfaces: the host
    // remounts the whole right pane on every session switch, so the last
    // project's data lives here and a remount for the SAME project renders
    // straight from the snapshot (silent revalidate, no blank flash) while a
    // different project simply misses and refetches clean.
    const overviewMemory = { path: null, project: null, checksInfo: null }
    const selfcheckMemory = { path: null, settings: null, draft: null, run: null, envRun: null }

    function ProjectSelfcheck({ sessionId, info, projectPath }) {
      const [settings, setSettings] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.settings : null))
      const [draft, setDraft] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.draft : null))
      const [settingsError, setSettingsError] = useState(null)
      const [run, setRun] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.run : null))
      const [startError, setStartError] = useState(null)
      const [envRun, setEnvRun] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.envRun : null))
      const [saveState, setSaveState] = useState(null) // {status:'running'|'done'|'failed', path?, error?}
      const [browseOpen, setBrowseOpen] = useState(false)
      const [checkAllPending, setCheckAllPending] = useState(false) // auto-save once the check-all run lands
      const machines = info?.machines ?? []

      // Same-project remount (session switch inside one workspace): adopt the
      // module snapshot instead of clearing — the table never flashes blank and
      // a running self-check keeps polling by runId. Different/first project:
      // full reset, same as before.
      useEffect(() => {
        let alive = true
        const adopt = !!projectPath && selfcheckMemory.path === projectPath
        if (!adopt) { setSettings(null); setDraft(null); setSettingsError(null); setRun(null); setStartError(null); setEnvRun(null) }
        if (!sessionId) return
        fetchJson(API + '/project-settings?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return
            setSettings((prev) => (JSON.stringify(prev) === JSON.stringify(r.settings) ? prev : r.settings))
            setDraft((prev) => (prev == null || JSON.stringify(prev) === JSON.stringify(r.settings) ? r.settings : prev))
          })
          .catch((e) => { if (alive && !adopt) setSettingsError(String(e.message ?? e)) })
        // No restore fetch here: a global "latest run" surface would bleed
        // verdicts across projects. The table only fills from a run THIS
        // sidebar started (POST then poll by runId) — or the module snapshot.
        return () => { alive = false }
      }, [sessionId, projectPath])

      // write the snapshot back for the next same-project remount
      useEffect(() => {
        if (!projectPath) return
        selfcheckMemory.path = projectPath
        selfcheckMemory.settings = settings
        selfcheckMemory.draft = draft
        selfcheckMemory.run = run
        selfcheckMemory.envRun = envRun
      }, [projectPath, settings, draft, run, envRun])

      const runId = run?.id ?? null
      const runStatus = run?.status ?? null
      useEffect(() => {
        if (runStatus !== 'running') return
        let alive = true
        const refetch = () => {
          callToolRoute({ sessionId, action: 'status', run_id: runId })
            .then((r) => { if (alive && r?.run?.id === runId) setRun(r.run) })
            .catch(() => { /* keep the last snapshot */ })
        }
        const timer = setInterval(() => { if (!document.hidden) refetch() }, 3_000)
        const onVisible = () => { if (!document.hidden) refetch() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [runId, runStatus])

      // staged edits: nothing leaves the browser until Confirm (or one of the
      // action buttons, which also commit pending edits so UI/config/AGENTS.md
      // can never diverge)
      const updateSetting = (key, value) => {
        setDraft((prev) => {
          const next = { ...prev, [key]: value }
          // The machine column only renders in remote mode, so a remote switch
          // with machine_id unset would fail confirmation — auto-pick the first
          // machine on the way in.
          if (key === 'run_mode' && value === 'remote' && !next.machine_id && machines.length) {
            next.machine_id = machines[0].id
          }
          return next
        })
        setSettingsError(null)
      }

      const dirty = !!draft && !!settings && JSON.stringify(draft) !== JSON.stringify(settings)
      // pending edits ride along on every action (strict UI = config = AGENTS.md)
      const pendingSettings = () => (dirty ? draft : undefined)

      const commitOk = (r) => {
        if (r && dirty) setSettings({ ...draft })
      }

      const startRun = async () => {
        setStartError(null)
        const settingsArg = pendingSettings()
        try {
          const r = await callToolRoute({ sessionId, action: 'run', lang: effectiveLang(), settings: settingsArg })
          commitOk(r)
          setRun({ id: r.run_id, status: 'running', steps: [], diagnoses: [], scope: null })
        } catch (e) {
          setStartError(tr('selfchk.startFailed', { msg: String(e.message ?? e) }))
          setCheckAllPending(false)
        }
      }

      // "list local environment" — the only read-only button (Node/Python rows
      // carry their absolute executable paths); the values enter AGENTS.md via
      // the save buttons, not via this listing.
      const runLocalEnv = async () => {
        setEnvRun({ status: 'running', results: null })
        try {
          const r = await callToolRoute({ sessionId, action: 'env' })
          setEnvRun({ status: 'done', results: r.checks })
        } catch (e) {
          setEnvRun({ status: 'failed', error: String(e.message ?? e) })
        }
      }

      // save-to-AGENTS.md AND the table's Confirm button: writes any pending
      // settings first, then rewrites the marked AGENTS.md block from measured
      // values (a first-fill prompt from the .harnessams-creation template is
      // removed with the rewrite).
      const saveAgents = async () => {
        setSaveState({ status: 'running' })
        try {
          const r = await callToolRoute({ sessionId, action: 'save_agentsmd', settings: pendingSettings() })
          commitOk(r)
          setSaveState({ status: 'done', path: r.path })
        } catch (e) {
          setSaveState({ status: 'failed', error: String(e.message ?? e) })
          setSettingsError(tr('pset.saveFailed', { msg: String(e.message ?? e) }))
        }
      }

      // "check all & save": once THIS button's self-check run lands, write the
      // measured values once (the flag keeps ordinary one-click runs save-free;
      // the finalize-side auto-sync already refreshed AGENTS.md anyway).
      useEffect(() => {
        if (!checkAllPending || run?.status !== 'done') return
        setCheckAllPending(false)
        void saveAgents()
      }, [checkAllPending, run?.status])

      const remote = draft?.run_mode === 'remote'
      const machine = machines.find((m) => m.id === draft?.machine_id) ?? null
      const root = String(draft?.remote_root ?? '').replace(/\/+$/, '')
      const dirPreview = String(draft?.remote_dir ?? '').startsWith('/')
        ? draft.remote_dir
        : (root ? root + '/' + (draft?.remote_dir ?? '') : '$ROOT/' + (draft?.remote_dir ?? ''))
      const running = run?.status === 'running'
      const envRunning = envRun?.status === 'running'
      const saving = saveState?.status === 'running'

      return h('div', { style: { marginTop: '10px' } },
        h('div', { className: 'hams-dim' }, h('b', null, tr('pset.title')), ' · ', tr('selfchk.title')),
        settingsError && h('div', { className: 'hams-err' }, txt(settingsError)),
        !draft && !settingsError && h('div', { className: 'hams-dim' }, tr('common.loading')),
        draft && h('div', null,
          // working directory: always visible — "local" read-only, or the bound
          // remote directory picked through the dsh-ssh directory browser (the
          // free-typed text input is retired; the full-path preview stays)
          h('div', { className: 'hams-row', style: { flexWrap: 'nowrap' } },
            h('b', { style: { flexShrink: 0 } }, tr('pset.dirLabel')),
            remote
              ? h('span', { className: 'hams-dim', title: dirPreview,
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                txt(draft.remote_dir || '—'))
              : h('span', { className: 'hams-dim' }, 'local · ' + tr('pset.dirLocalHint')),
            remote && h('button', { className: 'hams-btn hams-btn-sm', style: { flexShrink: 0 },
              disabled: !machine || !root, title: root ? tr('pset.browseTitle') : tr('pset.rootMissing'),
              onClick: () => setBrowseOpen(true) }, tr('pset.browse'))),
          remote && h('div', { className: 'hams-dim', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 0 4px' } },
            '→ ', txt(dirPreview), ' · ', tr('pset.dirRemoteRel')),
          h(SettingsTable, { draft, machines, run, onChange: updateSetting, dirty }),
          // confirm row: staged edits land in workspace_config.json (and AGENTS.md
          // re-syncs) only here — red "unsaved" cells mark the pending state
          h('div', { className: 'hams-row' },
            h('button', { className: 'hams-btn hams-btn-sm', disabled: saving || running || !sessionId, onClick: () => void saveAgents() },
              saving ? tr('pset.confirming') : tr('pset.confirmBtn')),
            dirty && h('span', { className: 'hams-bad' }, tr('pset.stagedHint'))),
          // the button row: [save to AGENTS.md] [one-click self-check] [list
          // local environment] [check all & save] — the project-settings block
          // is the Overview's single entry since the health-check panel retired
          h('div', { className: 'hams-row' },
            h('button', { className: 'hams-btn hams-btn-sm', disabled: running || saving || !sessionId, onClick: () => void saveAgents() },
              saving ? tr('agents.saving') : tr('agents.saveBtn')),
            h('button', { className: 'hams-btn hams-btn-sm', disabled: running || saving || !sessionId, onClick: startRun },
              running && !checkAllPending ? tr('selfchk.running') : tr('selfchk.run')),
            h('button', { className: 'hams-btn hams-btn-sm', disabled: envRunning || !sessionId, onClick: () => void runLocalEnv() },
              envRunning ? tr('chk.running') : tr('chk.btn.local')),
            h('button', { className: 'hams-btn hams-btn-sm', disabled: running || saving || !sessionId,
              onClick: () => { setCheckAllPending(true); void startRun() } },
              running && checkAllPending ? tr('agents.checkAllRunning') : tr('agents.checkAll')),
            h('span', { className: 'hams-dim' }, tr('selfchk.desc'))),
          startError && h('div', { className: 'hams-err' }, txt(startError)),
          saveState?.status === 'done' && h('div', { className: 'hams-dim' }, tr('agents.saved', { path: saveState.path ?? '' })),
          saveState?.status === 'failed' && h('div', { className: 'hams-err' }, txt(tr('agents.saveFailed', { msg: saveState.error ?? '' }))),
          envRun?.status === 'failed' && h('div', { className: 'hams-err' }, txt(envRun.error)),
          envRun?.status === 'done' && h(LocalEnvResults, { run: envRun }),
          browseOpen && remote && machine && root && h(RemoteDirBrowse, {
            sessionId, machineId: machine.id, rootDir: root,
            onCancel: () => setBrowseOpen(false),
            onPick: (dir) => { setBrowseOpen(false); if (dir && dir !== draft.remote_dir) updateSetting('remote_dir', dir) },
          }),
          h(SelfcheckSteps, { run }),
          run?.summary && h('div', { className: 'hams-row' },
            h('span', { className: run.summary.ok ? 'hams-good' : 'hams-bad', style: { fontWeight: 600 } },
              tr(run.summary.ok ? (run.summary.fallback ? 'selfchk.summaryFallback' : 'selfchk.summaryOk') : 'selfchk.summaryFail'))),
          (run?.diagnoses ?? []).map((d, i) => h('div', { key: i, className: d.status === 'done' ? 'hams-dim' : 'hams-err' },
            d.status === 'done' ? tr('selfchk.diagDone', { id: d.sessionId ?? '' }) : tr('selfchk.diagFail', { err: d.error ?? '' })))))
    }

    // ---------- tier 3: project overview (first-level view inside the task tab) ----------
    // Project-level surfaces only (the settings/self-check block is the single
    // entry since the health-check panel retired): nothing here depends on a
    // task, so switching sessions or strip entries INSIDE one project must not
    // refresh the view — the body initializes from overviewMemory and only a
    // real project change clears and refetches. Rendered by TaskSidebarBody as
    // the strip's default 'overview' entry.
    function ProjectOverviewView(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const [project, setProject] = useState(() => overviewMemory.project ?? undefined)
      const [reason, setReason] = useState(null)
      const [checksInfo, setChecksInfo] = useState(() => (overviewMemory.path ? overviewMemory.checksInfo : null))
      const projectPath = project?.path ?? null

      useEffect(() => {
        let alive = true
        if (!sessionId) { setProject(null); setReason(tr('tasks.noSession')); return }
        fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return
            if (!r?.project || r.project.path !== overviewMemory.path) {
              // different (or first) project: drop the cached surfaces so the
              // checks effect below refetches for the new workspace
              overviewMemory.path = r?.project?.path ?? null
              overviewMemory.project = null
              overviewMemory.checksInfo = null
              setChecksInfo(null)
            }
            setProject(r.project ?? null)
            setReason(r.project ? null : r.reason ?? null)
          })
          .catch((e) => { if (alive) { setProject(null); setReason(String(e.message ?? e)) } })
        return () => { alive = false }
      }, [sessionId])

      // Machine list for the settings table's dropdown (GET /api/checks — the
      // local-env rows run through /api/checks/run inside ProjectSelfcheck).
      // No upfront clear: a same-project remount keeps showing the cached copy
      // while the silent revalidate lands (JSON-compare swap).
      useEffect(() => {
        let alive = true
        if (!projectPath || !sessionId) return
        fetchJson(API + '/checks?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => { if (alive) setChecksInfo((prev) => (JSON.stringify(prev) === JSON.stringify(r) ? prev : r)) })
          .catch(() => { /* keep the cached copy */ })
        return () => { alive = false }
      }, [projectPath, sessionId])

      // remember the last rendered surfaces for the next same-project remount
      useEffect(() => {
        if (!projectPath) return
        overviewMemory.path = projectPath
        overviewMemory.project = project
        overviewMemory.checksInfo = checksInfo
      }, [projectPath, project, checksInfo])

      // Single scroll context: the parent TaskSidebarBody's .hams-body is the
      // ONLY scroll container — this view is plain flowing content (flex:none
      // so the column layout never squeezes it), which is what gives the
      // overview its vertical scrollbar however tall the content grows.
      return h('div', { style: { flex: 'none', fontSize: 'var(--dsh-content-font-size, 14px)' } },
        project === undefined && h('div', { className: 'hams-dim' }, tr('tasks.loadingProject')),
        project === null && h('div', { className: 'hams-dim' }, tr('tasks.noProject'), h('br'), null, txt(reason ?? '')),
        project && h('div', { className: 'hams-dim' },
          tr('tasks.projectLabel'), h('b', null, txt(project.title || project.path)), h('br'), null, txt(project.path)),
        project && sessionId && h(ProjectSelfcheck, { sessionId, info: checksInfo, projectPath }),
      )
    }

    function TaskSidebarBody(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const [project, setProject] = useState(undefined) // undefined=loading, null=none
      const [reason, setReason] = useState(null)
      // NOTE: the initial state must READ the map without INSERTING — a forked
      // session's first-seen copy (below) depends on the map NOT containing the
      // session until the server's fork verdict arrives. sessionConfigOf() is
      // reserved for the adopt paths.
      const [config, setConfig] = useState(() => cloneSessionConfig(sessionConfigState.get(sessionId) ?? emptySessionConfig()))
      const [view, setView] = useState(readTaskView)
      const [error, setError] = useState(null)

      const projectPath = project?.path ?? null

      // Sidebar-follows-switch bookkeeping (see SessionHeaderButton): the host
      // keeps this body mounted even while the sidebar is collapsed (hidden), so
      // visibility — not mount state — is what "the sidebar is open" means. Probe
      // the root element's box every 500 ms and stamp sidebarOpenState while it
      // is actually on screen. The collapsed pane is slid OFF-VIEWPORT with
      // visibility:hidden (verified 2026-11-18 on 0.2.2-rc.3: rect.x=1921 while
      // offsetWidth stays 863) — box offsets alone false-positive, so the probe
      // requires a viewport intersection AND non-hidden visibility.
      const rootRef = useRef(null)
      useEffect(() => {
        const probe = () => {
          const el = rootRef.current
          if (!el || !el.isConnected) return
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth
            && cs.visibility !== 'hidden' && cs.display !== 'none') {
            sidebarOpenState.lastSeenVisibleAt = Date.now()
          }
        }
        probe()
        const timer = setInterval(probe, 500)
        return () => clearInterval(timer)
      }, [])

      // Per-session config: reload on session switch. A FIRST-SEEN session asks
      // the server for its fork verdict (computed only while the entry is
      // missing): fork => deep-copy the previously active session's CURRENT
      // config (branch-point-independent by design, D-008); otherwise start
      // empty. Either way the entry is persisted right away — the write doubles
      // as the tombstone that stops fork re-detection. After the adopt, this
      // session becomes the "previously active" for the next first-seen one.
      useEffect(() => {
        let alive = true
        if (!sessionId) { setConfig(emptySessionConfig()); return }
        const adoptWith = (fork, sessionsMap) => {
          const first = !sessionConfigState.has(sessionId)
          const source = first ? forkCopySource(sessionsMap, sessionId) : null
          setConfig(cloneSessionConfig(sessionConfigOf(sessionId, fork, source)))
          if (first) putSessionConfig(sessionId)
          lastActiveSessionId.id = sessionId
        }
        if (sessionConfigState.has(sessionId)) { adoptWith(false); return () => { alive = false } }
        fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId))
          .then((d) => {
            if (!alive) return
            hydratedProjects.add(projectPath)
            const sessions = d?.sessions ?? {}
            for (const [sid, st] of Object.entries(sessions)) {
              if (st && typeof st === 'object' && !sessionConfigState.has(sid)) {
                sessionConfigState.set(sid, cloneSessionConfig(st))
              }
            }
            adoptWith(!!d?.fork, sessions)
          })
          .catch(() => { if (alive) adoptWith(false) }) // offline: empty start (fail-open like the server)
        return () => { alive = false }
      }, [sessionId, projectPath])
      // event-handler mutator: apply fn to a copy, keep the module map truthful
      // and merge-PUT the session's entry to sessions.json
      const mutateConfig = (fn) => {
        const next = cloneSessionConfig(config)
        fn(next)
        if (sessionId) sessionConfigState.set(sessionId, next)
        setConfig(next)
        putSessionConfig(sessionId)
      }

      useEffect(() => {
        let alive = true
        let timer = null
        setError(null)
        if (!sessionId) { setProject(null); setReason(tr('tasks.noSession')); return }
        setProject(undefined)
        let attempts = 0
        const load = () => {
          fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
            .then((r) => {
              if (!alive) return
              // a brand-new session enters the workspace registry only after its
              // first turn — retry briefly (bounded, silent) so "new session"
              // still resolves once the mapping lands (reason string is ours:
              // server/project.js sessionProject)
              if (!r?.project && attempts++ < 6 && String(r?.reason ?? '').includes('not accounted')) {
                timer = setTimeout(load, 5000)
                return
              }
              setProject(r.project ?? null)
              setReason(r.project ? null : r.reason ?? null)
              if (r?.project) lastProjectInfo.initialized = !!r.project.initialized
            })
            .catch((e) => {
              if (!alive) return
              if (attempts++ < 6) { timer = setTimeout(load, 5000); return }
              setProject(null); setReason(String(e.message ?? e))
            })
        }
        load()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [sessionId])

      // The Dashboard sub-view stays live while visible (auto-refresh):
      // sim_analysis(report=true) appends to the calling session's entry behind
      // the sidebar's back, so poll the store every 10 s while the sub-view is
      // open and the tab visible; persist-in-flight ticks are skipped so a
      // just-applied optimistic update is never flashed over by a stale entry,
      // and the config state is only touched when the server copy differs.
      useEffect(() => {
        if (view !== 'dashboard' || !projectPath || !sessionId) return
        let alive = true
        const refetch = () => {
          if (!alive || persistingRef.current) return
          fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId))
            .then((d) => {
              if (!alive) return
              const fresh = cloneSessionConfig(d?.sessions?.[sessionId])
              setConfig((prev) => (JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh))
              sessionConfigState.set(sessionId, fresh)
            })
            .catch(() => { /* keep the current entry */ })
        }
        const timer = setInterval(() => { if (!document.hidden) refetch() }, 10_000)
        const onVisible = () => { if (!document.hidden) refetch() }
        document.addEventListener('visibilitychange', onVisible)
        refetch()
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [view, projectPath, sessionId])

      // The check buttons and the diagnosis handoff live in the project overview
      // view (ProjectOverviewView); the session body itself needs no checks fetch.

      // persistConfig(mutator) re-bases the change on the LATEST server entry
      // before the single-session PUT: the store has a second writer
      // (sim_analysis's report registration writes this session's entry behind
      // the sidebar's back), so sending the mount-time snapshot would clobber
      // injected reports — the rebase shrinks the clobber window to
      // milliseconds. Returns the server-confirmed entry, or null on failure
      // (the optimistic update stays, error shows inline).
      const persistingRef = useRef(false)
      const persistConfig = async (mutator) => {
        persistingRef.current = true
        try {
          const latest = await fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId)).catch(() => null)
          const base = latest?.sessions?.[sessionId] ?? config
          const next = mutator(cloneSessionConfig(base))
          setConfig(next)
          sessionConfigState.set(sessionId, next)
          const r = await fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId),
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, state: next }) })
          const saved = cloneSessionConfig(r?.sessions?.[sessionId] ?? next)
          setConfig(saved)
          sessionConfigState.set(sessionId, saved)
          return saved
        } catch (e) {
          setError(String(e.message ?? e))
          return null
        } finally {
          persistingRef.current = false
        }
      }
      // sub-view mutator (dashboard reports / check params): applies fn to this
      // session's entry through the rebased persist channel.
      const updateConfig = (fn) => persistConfig(fn)

      return h('div', { ref: rootRef, style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, fontSize: 'var(--dsh-content-font-size, 14px)' } },
        // first-level strip (modeled after dsh-ssh-ops' server tabs): exactly
        // two entries — the project overview pseudo-capsule (the tab's default
        // display, not deletable) and THIS session's own capsule (full session
        // id in the tooltip); the task concept is retired, no creation button
        h('div', { className: 'hams-tabstrip' },
          h('div', {
            className: 'hams-tasktab' + (config.display === 'overview' ? ' active' : ''),
            title: tr('tasks.projectOverview'),
            onClick: () => mutateConfig((s) => { s.display = 'overview' }),
          }, h('span', { className: 'hams-tabname' }, tr('tasks.projectOverview'))),
          h('div', {
            className: 'hams-tasktab' + (config.display === 'session' ? ' active cur' : ''),
            title: sessionId ?? '',
            onClick: () => mutateConfig((s) => { s.display = 'session' }),
          }, h('span', { className: 'hams-tabname' }, tr('tasks.sessionTab'))),
        ),
        h('div', { className: 'hams-body' },
          error && h('div', { className: 'hams-err' }, error),
          project === undefined && h('div', { className: 'hams-dim' }, tr('tasks.loadingProject')),
          project === null && h('div', { className: 'hams-dim' }, tr('tasks.noProject'), h('br'), null, txt(reason ?? '')),
          project && config.display === 'overview' && h(ProjectOverviewView, { sessionId }),
          // the session branch GROWS instead of clipping (flex 1 0 auto): short
          // content still fills the pane (dashboard iframe), long content
          // lengthens the single .hams-body scroll region below
          project && config.display === 'session' && h('div', { style: { marginTop: '8px', flex: '1 0 auto', display: 'flex', flexDirection: 'column' } },
            // lowest level: this session's sub navigation (dashboard / check params)
            h('div', { className: 'hams-subtabs', role: 'tablist' },
              TASK_VIEWS.map((v) => h('button', {
                key: v.id,
                className: 'hams-subtab' + (view === v.id ? ' active' : ''),
                role: 'tab',
                'aria-selected': view === v.id,
                onClick: () => { rememberTaskView(v.id); setView(v.id) },
              }, tr(v.labelKey)))),
            view === 'dashboard' && h(SessionDashboard, { sessionId, config, updateConfig }),
            view === 'check' && h(CheckParams, { sessionId, updateConfig }))),
      )
    }

    // Sidebar embed pass for the report iframe (same-origin by construction —
    // the report is served from /harnessams/dash/): tighten the report's own
    // page paddings and scale its content by the DSH font-size ratio, so a
    // generated report tracks the user's font setting inside the narrow
    // sidebar instead of showing its authored fixed layout. Best effort — a
    // cross-origin or odd document just renders unmodified; the ↗ open-in-tab
    // link bypasses this entirely (full fidelity).
    function embedReportFrame(frame) {
      try {
        const doc = frame?.contentDocument
        if (!doc || !doc.body || doc.documentElement?.dataset?.hamsEmbed) return
        doc.documentElement.dataset.hamsEmbed = '1'
        const style = doc.createElement('style')
        style.textContent = 'body { padding: 10px 12px !important; margin: 0 !important; }'
        ;(doc.head ?? doc.documentElement).appendChild(style)
        const base = parseFloat(getComputedStyle(document.body).fontSize) || 14
        const ratio = base / 14
        if (ratio > 1.02 || ratio < 0.98) doc.body.style.zoom = String(ratio)
      } catch { /* not same-origin / not ready: render as-is */ }
    }

    // Dashboard sub-view: the task's registered local HTML reports. The report
    // list + current selection live in the task store (reports[] /
    // dashboard_selected); files are served read-only from
    // /harnessams/dash/<taskId>/<reportId>/… with the report's own directory as
    // root, so the document's relative references (data/*.js, images) keep
    // working inside the iframe. Refresh remounts the iframe via the key/nonce
    // (a plain location.reload is unreliable across same-origin documents).
    // Auto-refresh: the sub-view polls the store (parent
    // effect) and this component polls the current report's /api/report-stat —
    // a regenerated document (mtime/size change) reloads through the nonce,
    // so an externally re-run sim_analysis shows up without a manual ↻.
    function SessionDashboard({ sessionId, config, updateConfig }) {
      const [nonce, setNonce] = useState(0)
      const [dialogOpen, setDialogOpen] = useState(false)
      const reports = config.reports ?? []
      const selectedId = reports.some((r) => r.id === config.dashboard_selected)
        ? config.dashboard_selected
        : (reports[0]?.id ?? null)
      const current = reports.find((r) => r.id === selectedId) ?? null

      // Report-document freshness poll: 10 s while visible, paused when the
      // tab is hidden (visibilitychange catches up on return). The first sample
      // after a mount/report switch only records the baseline — a freshly
      // loaded document is never reloaded.
      const statRef = useRef(null)
      useEffect(() => {
        statRef.current = null
        if (!current) return
        let alive = true
        const check = () => {
          if (!alive || document.hidden) return
          fetchJson(API + '/report-stat?sessionId=' + encodeURIComponent(sessionId)
            + '&reportId=' + encodeURIComponent(current.id))
            .then((r) => {
              if (!alive) return
              const token = r.mtime_ms + ':' + r.size
              if (statRef.current != null && statRef.current !== token) setNonce((n) => n + 1)
              statRef.current = token
            })
            .catch(() => { /* report removed / server busy: keep the current render */ })
        }
        const timer = setInterval(check, 10_000)
        const onVisible = () => { if (!document.hidden) check() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [current?.id, sessionId])

      const addReport = (absPath, name) => {
        // same-path dedupe (the server merges by resolved path on its next
        // write; adding twice would leave the client id dangling and the
        // selection would snap back to the first report)
        const dup = (config?.reports ?? []).find((r) => r && r.path === absPath)
        if (dup) {
          updateConfig((c) => ({ ...c, dashboard_selected: dup.id }))
          return
        }
        // Client-generated id (same shape the server assigns) so adding +
        // selecting the new report is one persist round-trip.
        const id = 'r-' + Math.random().toString(36).slice(2, 10)
        const base = absPath.split(/[\\/]/).pop() || absPath
        updateConfig((c) => ({
          ...c,
          reports: [...(c.reports ?? []), { id, name: name || base, path: absPath }],
          dashboard_selected: id,
        }))
      }
      const removeCurrent = () => updateConfig((c) => {
        const rest = (c.reports ?? []).filter((r) => r.id !== selectedId)
        return { ...c, reports: rest, dashboard_selected: rest[0]?.id ?? null }
      })
      const dashUrl = current ? '/harnessams/dash/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(current.id) + '/' : null

      return h('div', { className: 'hams-dashview' },
        h('div', { className: 'hams-row hams-dashtoolbar' },
          h('select', {
              className: 'hams-select',
              value: selectedId ?? '',
              disabled: !reports.length,
              title: current ? current.path : tr('dash.noReports'),
              onChange: (e) => updateConfig((c) => ({ ...c, dashboard_selected: e.target.value })),
            },
            reports.length
              ? reports.map((r) => h('option', { key: r.id, value: r.id }, txt(r.name)))
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
              onLoad: (e) => embedReportFrame(e.target),
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
                txt(listing ? listing.path : '…')))),
          h('div', { className: 'hams-field' },
            h('label', null, tr('dash.pickFile')),
            h('div', { className: 'hams-list' },
              error && h('div', { className: 'hams-err' }, error),
              listing && !error && h('div', null,
                listing.dirs.map((d) => h('button', { key: 'd:' + d, className: 'hams-listitem',
                  onClick: () => setCwd(listing.path + '/' + d) },
                  h('span', { className: 'hams-name' }, '📁 ' + txt(d)))),
                listing.htmls.map((f) => h('button', { key: 'f:' + f.name, className: 'hams-listitem',
                  onClick: () => onAdd(listing.path + '/' + f.name, f.name) },
                  h('span', { className: 'hams-name' }, '📄 ' + txt(f.name)),
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

    // Check-parameters sub-view (session panel): editable table of the
    // assembly-layer check thresholds/switches stored in THIS session's
    // sessions.json entry (per-session since D-008). The initial table is the
    // session's confirmed copy, or the project-file∪built-in fallback while
    // unconfirmed (the source line under the title says which is in effect).
    // The six R/C/L numbers are strings while drafting; the confirm button
    // validates locally, then saves through the rebased single-session persist
    // channel and the server re-validates. While a draft differs from the
    // loaded value the cell keeps the old value visible in gray parentheses so
    // the pre-confirm state is always readable.
    function CheckParams({ sessionId, updateConfig }) {
      const [params, setParams] = useState(null) // loaded copy (null = loading)
      const [hasOwn, setHasOwn] = useState(false) // session confirmed its own table
      const [draft, setDraft] = useState(null) // working copy; numbers as strings
      const [error, setError] = useState(null)
      const [saveError, setSaveError] = useState(null)
      const [saving, setSaving] = useState(false)

      const toDraft = (p) => ({
        rcl: { r: p.rcl.r.map(String), c: p.rcl.c.map(String), l: p.rcl.l.map(String) },
        unit_check: p.unit_check,
        bias_check: p.bias_check,
        strict_includes: p.strict_includes,
      })
      const toNumeric = (d) => ({
        rcl: {
          r: [Number(d.rcl.r[0]), Number(d.rcl.r[1])],
          c: [Number(d.rcl.c[0]), Number(d.rcl.c[1])],
          l: [Number(d.rcl.l[0]), Number(d.rcl.l[1])],
        },
        unit_check: d.unit_check,
        bias_check: d.bias_check,
        strict_includes: d.strict_includes,
      })

      useEffect(() => {
        let alive = true
        setParams(null); setDraft(null); setHasOwn(false); setError(null); setSaveError(null)
        if (!sessionId) return
        fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return
            const own = r?.sessions?.[sessionId]?.check_params
            const effective = own ?? r?.fallback_params
            if (effective) {
              setHasOwn(!!own)
              setParams(effective)
              setDraft(toDraft(effective))
            }
          })
          .catch((e) => { if (alive) setError(tr('check.loadFailed', { msg: String(e.message ?? e) })) })
        return () => { alive = false }
      }, [sessionId])

      const dirty = !!params && !!draft && JSON.stringify(toNumeric(draft)) !== JSON.stringify(params)

      const confirm = async () => {
        setSaveError(null)
        for (const k of ['r', 'c', 'l']) {
          const lo = Number(draft.rcl[k][0])
          const hi = Number(draft.rcl[k][1])
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || lo >= hi) {
            setSaveError(tr('check.badPair', { p: tr('check.rcl' + k.toUpperCase()) }))
            return
          }
        }
        const next = toNumeric(draft)
        setSaving(true)
        try {
          const saved = await updateConfig((c) => ({ ...c, check_params: next }))
          const confirmed = saved?.check_params ?? next
          setHasOwn(true)
          setParams(confirmed)
          setDraft(toDraft(confirmed))
        } catch (e) {
          setSaveError(tr('check.saveFailed', { msg: String(e.message ?? e) }))
        } finally {
          setSaving(false)
        }
      }

      const rclRow = (k, labelKey, noteKey) => {
        const saved = params?.rcl?.[k]
        const changed = !!saved && (draft.rcl[k][0] !== String(saved[0]) || draft.rcl[k][1] !== String(saved[1]))
        return h('tr', null,
          h('td', null, tr(labelKey)),
          h('td', null,
            h('div', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
              h('input', { className: 'hams-input', style: { width: '80px' }, value: draft.rcl[k][0],
                onChange: (e) => setDraft({ ...draft, rcl: { ...draft.rcl, [k]: [e.target.value, draft.rcl[k][1]] } }),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm() } } }),
              h('span', { className: 'hams-dim' }, '…'),
              h('input', { className: 'hams-input', style: { width: '80px' }, value: draft.rcl[k][1],
                onChange: (e) => setDraft({ ...draft, rcl: { ...draft.rcl, [k]: [draft.rcl[k][0], e.target.value] } }),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm() } } })),
            changed && h('span', { className: 'hams-dim' },
              tr('check.oldValue', { v: String(saved[0]) + ' … ' + String(saved[1]) }))),
          h('td', { className: 'hams-dim' }, tr(noteKey)))
      }

      const switchRow = (key, labelKey, noteKey) => {
        const saved = params ? params[key] : null
        const changed = !!params && draft[key] !== saved
        return h('tr', null,
          h('td', null, tr(labelKey)),
          h('td', null,
            h('select', { className: 'hams-select', value: draft[key] ? '1' : '0',
              onChange: (e) => setDraft({ ...draft, [key]: e.target.value === '1' }) },
              h('option', { value: '1' }, tr('check.on')),
              h('option', { value: '0' }, tr('check.off'))),
            ' ',
            changed && h('span', { className: 'hams-dim' },
              tr('check.oldValue', { v: tr(saved ? 'check.on' : 'check.off') }))),
          h('td', { className: 'hams-dim' }, tr(noteKey)))
      }

      if (!sessionId) return h('div', { className: 'hams-dash' }, tr('tasks.noSession'))
      return h('div', { className: 'hams-dash' },
        h('b', null, tr('check.title')),
        h('div', { className: 'hams-dim' }, tr('check.desc')),
        params && h('div', { className: 'hams-dim' }, tr(hasOwn ? 'check.sourceOwn' : 'check.sourceFallback')),
        error && h('div', { className: 'hams-err' }, txt(error)),
        saveError && h('div', { className: 'hams-err' }, txt(saveError)),
        !params && !error && h('div', { className: 'hams-dim' }, tr('common.loading')),
        params && draft && h('table', { className: 'hams-table' },
          h('thead', null, h('tr', null, [tr('check.colParam'), tr('check.colValue'), tr('check.colNote')]
            .map((c) => h('th', { key: c }, c)))),
          h('tbody', null,
            rclRow('r', 'check.rclR', 'check.noteR'),
            rclRow('c', 'check.rclC', 'check.noteC'),
            rclRow('l', 'check.rclL', 'check.noteL'),
            switchRow('unit_check', 'check.unitCheck', 'check.noteUnit'),
            switchRow('bias_check', 'check.biasCheck', 'check.noteBias'),
            switchRow('strict_includes', 'check.strictIncludes', 'check.noteStrict'))),
        params && draft && h('div', { className: 'hams-row' },
          h('button', { className: 'hams-btn hams-btn-sm', disabled: !dirty || saving, onClick: () => { void confirm() } },
            saving ? tr('common.loading') : tr('check.confirm')),
          h('button', { className: 'hams-btn hams-btn-sm', disabled: !dirty || saving, onClick: () => setDraft(toDraft(params)) },
            tr('common.cancel'))))
    }

    // Sidebar follows session switches when it was open. DSH keeps one right-
    // sidebar layout PER SESSION (localStorage dsh.sidebar-right.v1.<sessionId>,
    // host README): a fresh session starts collapsed, and a reload restores each
    // session's own layout — so page loads need no help. Only a mid-page session
    // switch collapses an open sidebar. Mounted state alone cannot tell open
    // from collapsed (the host keeps the body mounted while hidden), so the
    // task body probes its own visibility and stamps the last time it was
    // actually seen; the header button below re-opens the tab on a sessionId
    // change iff the sidebar was visible recently (within the probe cadence
    // plus the switch teardown, 1.5 s) — or applies the project's default-open
    // policy when the session's sidebar was never touched (2026-11-18).
    let openSidebarTab = null
    const sidebarOpenState = { lastSeenVisibleAt: 0 }

    function SessionHeaderButton(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      useEffect(() => {
        if (!sessionId || !openSidebarTab) return
        let cancelled = false
        let retryTimer = null
        // Default-open lives HERE, not in the tab body: a session whose sidebar
        // was never opened does not mount tab bodies at all (verified 2026-11-18:
        // .hams-tabstrip absent from the DOM for a fresh blank session), so the
        // always-mounted conversation-header button is the only reliable trigger.
        // The host tears the right pane down and up around a switch; a short
        // delay keeps the reopen from landing on the intermediate state.
        const t = setTimeout(() => {
          if (cancelled || !openSidebarTab) return
          if (Date.now() - sidebarOpenState.lastSeenVisibleAt <= 1500) { // was open — keep following
            openSidebarTab()
            return
          }
          // Default-open (user decision 2026-11-18): a session whose project
          // already has a .harnessams store gets the sidebar opened on first
          // sight — new sessions, cross-project switches, and returning to the
          // start window all land here. Gated on the user never having touched
          // that session's sidebar (empty layout tabs) and once per page
          // lifetime: an explicit close always wins over the default. A blank
          // session enters the workspace registry only after its first turn, so
          // the mapping gets a bounded silent retry window.
          if (autoOpenedFor.has(sessionId) || !sessionSidebarUntouched(sessionId)) return
          let attempts = 0
          const check = () => {
            if (cancelled || !openSidebarTab) return
            fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
              .then((r) => {
                if (cancelled) return
                if (!r?.project && attempts++ < 24 && String(r?.reason ?? '').includes('not accounted')) {
                  retryTimer = setTimeout(check, 5000)
                  return
                }
                // re-gate right before opening: the user may have touched the
                // sidebar while the retries were pending
                if (r.project?.initialized && !autoOpenedFor.has(sessionId) && sessionSidebarUntouched(sessionId)) {
                  autoOpenedFor.add(sessionId)
                  openSidebarTab()
                }
              })
              .catch(() => {
                if (!cancelled && attempts++ < 24) retryTimer = setTimeout(check, 5000)
              })
          }
          check()
        }, 350)
        return () => { cancelled = true; clearTimeout(t); if (retryTimer) clearTimeout(retryTimer) }
      }, [sessionId])
      return h('button', {
        className: 'hams-btn hams-btn-sm hams-headerbtn',
        title: tr('tasks.headerOpen'),
        onClick: () => { if (openSidebarTab) openSidebarTab() },
      }, 'HarnessAMS')
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
      // tier 3: right-sidebar task tab — the body keyed to its tab id receives
      // the active sessionId via props (verified: switching sessions updates the
      // prop). One tab: the first-level strip inside it carries the project
      // overview (project-scoped, survives same-project session switches via
      // overviewMemory) plus the per-task sub-views.
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
      // One-click reopen: DSH keeps the right-sidebar layout per session, so a
      // mid-page session switch collapses an open sidebar — the conversation
      // header keeps a direct entry point and re-opens it when it was open.
      ctx.inject(['sidebarRight'], (inner) => {
        const right = inner.get('sidebarRight')
        openSidebarTab = () => {
          try { right.openTab(TAB_KIND) } catch { try { right.openTab(TAB_ID) } catch { /* tab service unavailable */ } }
        }
        inner.effect(() => () => { if (openSidebarTab) openSidebarTab = null }, 'harnessams header button handler')
        slots.inject('conversation.session.header.actions', () =>
          slots.register({ name: 'conversation.session.header.actions', id: 'dsh-harnessams-open', order: 20 }, SessionHeaderButton))
      })
      // NOTE (2026-11-18): fork-parent lookup was attempted through the client
      // 'sessions' service (catalog snapshot byId[].parentId) — the instance a
      // plugin ctx sees is an UNCONNECTED one whose list snapshot stays empty
      // (verified live: ids=0 forever), and the server-side sessionController
      // facade exposes no list face either. Inheritance therefore follows the
      // last ACTIVE selection instead (see TaskSidebarBody): a first-seen
      // session continues whatever the previously active session had selected,
      // which covers fork-then-switch and new-session continuation alike.
      // Blank-session default-open (round 2): neither the tab body nor the
      // conversation-header actions mount for a blank session, so the header
      // button above cannot fire there. But the host MINTS the per-session
      // layout key the moment a session is created/first activated — a NEW key
      // in localStorage IS the "a never-seen session just went active" signal
      // (switches to already-keyed sessions never mint). Poll for new keys
      // (the storage event does not fire on the same page) and run the same
      // default-open policy; while the new session is still unaccounted in the
      // registry, the last known project's initialized flag answers for it (a
      // new session is created under the CURRENT workspace).
      const knownLayoutKeys = new Set()
      try { for (const k of Object.keys(localStorage)) if (k.startsWith('dsh.sidebar-right.v1.')) knownLayoutKeys.add(k) } catch { /* private mode */ }
      setInterval(() => {
        let keys
        try { keys = Object.keys(localStorage).filter((k) => k.startsWith('dsh.sidebar-right.v1.')) } catch { return }
        for (const k of keys) {
          if (knownLayoutKeys.has(k)) continue
          knownLayoutKeys.add(k)
          const sid = k.slice('dsh.sidebar-right.v1.'.length)
          if (!sid || autoOpenedFor.has(sid)) continue
          autoOpenedFor.add(sid)
          let attempts = 0
          const check = () => {
            if (!openSidebarTab) return
            fetchJson(API + '/project?sessionId=' + encodeURIComponent(sid))
              .then((r) => {
                if (r?.project?.initialized) { openSidebarTab(); return }
                if (!r?.project && attempts++ < 24 && String(r?.reason ?? '').includes('not accounted')) {
                  if (lastProjectInfo.initialized) { openSidebarTab(); return }
                  setTimeout(check, 5000)
                }
              })
              .catch(() => { if (attempts++ < 24) setTimeout(check, 5000) })
          }
          check()
        }
      }, 1000)
      // Session tool cards: keyed by wire tool name, exact match (a typo never
      // renders), so all eight names must be listed verbatim — guarded by the
      // entry test against the registered tool-name set.
      slots.inject('tool.call.toolview', function* () {
        for (const key of SIM_CARD_TOOLS) {
          yield slots.register({ name: 'tool.call.toolview', key }, SimToolCard)
        }
      })
    }

    exports.name = name
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
