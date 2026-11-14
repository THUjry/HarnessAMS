// HarnessAMS client half — the three-tier UI:
//   tier 1: global console page ("HarnessAMS" entry in the left sidebar -> full panel):
//           first-run guide (centered entry until seen, then a persistent guide button;
//           five sections chaining the scattered hints into one read), machines (the
//           dsh-ssh host registry with each alias's configured remote root), digital
//           assets (vendored .js packages with licenses + package/workspace copy
//           locations), disk usage;
//   tier 2: project = DSH workspace (a local folder) — no per-session data; every
//           session of a workspace shares one task list;
//   tier 3: right-sidebar task tab — the first-level strip
//           opens on the project overview (health-check buttons + settings +
//           one-click self-check, project-scoped so same-project session switches
//           never refresh it), then one capsule per task with "new task" to create;
//           the Dashboard sub-view shows the task-registered local HTML reports
//           (browse-to-add / dropdown / reload).
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
        'common.none': '（无）',
        'common.sectionFailed': '此区块加载失败：',
        'console.title': 'HarnessAMS 控制台',
        'console.infoFailed': 'info 读取失败：{msg}',
        'console.workspace': '工作区：{path}',
        'console.noWorkspace': '未找到 harnessams-workspace — 服务器检查需要 harnessams.json',
        'guide.btn': '使用引导',
        'guide.caption': '第一次使用 HarnessAMS？从工作方式、提交作业到报告查看，一条引导走完。',
        'guide.title': '开始使用 HarnessAMS',
        'guide.back': '返回',
        'guide.done': '开始使用',
        'guide.s1t': '工作方式：本地还是远程',
        'guide.s1': '本地 — spectre 本地闭环（装配 → 检查 → 仿真 → 解析 → 报告；需本机自备 Spectre）。远程 — 机器（主机别名与凭据）在 dsh-ssh 插件里配置；本页「机器」卡展示各别名，远端根路径配在 harnessams.json 的 remote_machines 段。',
        'guide.s2t': '提交作业方式',
        'guide.s2': '直接提交 — 仿真在本机前台运行（spectre 本地扫掠）。batch — 经 dsh-ssh 提交 LSF 队列（batch_submit / batch_poll / batch_fetch，按机器别名直发）。',
        'guide.s2slurm': 'slurm —— 暂不支持。',
        'guide.s3t': '工作区位置',
        'guide.s3': '本地 — harnessams.json 是唯一路径来源（workspace_root、PDK、回收站、脚本目录、remote_machines 远端根路径）。远程 — 路径即远端真实路径（dsh-ssh 按别名直达，无本地镜像）。',
        'guide.s4t': '仿真插件套件',
        'guide.s4': 'SmartAnaSim 单包安装即注册全部 11 个工具：spectre（装配 / 扫掠 / 解析，本地）、sNp（Touchstone·psfascii 读取与器件提取）、batch（通用 LSF 提交 / 轮询 / 取回）、共享（分析 / 进度 / 回收站）。工具默认全部注册，无需逐个开启；使用引导仅由 HarnessAMS 提供。',
        'guide.s5t': '日常入口速查',
        'guide.s5': 'HarnessAMS 任务侧栏「项目总览」— 本机环境检查 + 各机器四项检查（按 dsh-ssh 别名直发）+ 项目设置表与一键项目自检；「new task」建新任务，任务内「仪表盘」— HTML 报告查看器（sim_analysis 生成报告即自动登记，也可浏览添加已有报告）、「参数检查」— 项目级检查参数编辑；交互 shell 用 dsh-ssh 自带的 SSH 终端面板。',
        'hosts.title': '机器',
        'hosts.ok': 'dsh-ssh：{n} 台主机',
        'hosts.missing': 'dsh-ssh 不可用',
        'hosts.colAlias': '别名',
        'hosts.colHost': '主机',
        'hosts.colAuth': '认证',
        'hosts.colRoot': '远端根路径',
        'hosts.rootNone': '未配置',
        'hosts.rootHint': '在 harnessams.json 的 remote_machines 段为该别名配置远端根路径',
        'hosts.empty': 'dsh-ssh 中还没有主机 — 请先在 dsh-ssh 面板里添加。',
        'hosts.hint': '主机与凭据在 dsh-ssh 插件里管理；此处只读展示别名与远端根路径（remote_machines）。',
        'chk.title': '健康检查',
        'chk.remoteArea': '远端根路径：{path}',
        'chk.needRemoteRoot': '主机都未配置远端根路径——在 harnessams.json 的 remote_machines 段配置后即可在此检查。',
        'chk.unconfiguredList': '未配置：{list}',
        'chk.running': '检查中…',
        'chk.colItem': '检查项',
        'chk.colResult': '结果',
        'chk.colElapsed': '耗时',
        'chk.colStatus': '状态',
        'chk.analyze': '起会话分析',
        'chk.analyzing': '正在创建分析会话…',
        'chk.analyzeDone': '已创建分析会话，请到左侧会话树查看。',
        'chk.analyzeAuto': '检查发现问题，已自动创建分析会话，请到左侧会话树查看。',
        'chk.analyzeFail': '创建分析会话失败：',
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
        'assets.notices': '第三方声明',
        'assets.colPkg': '包',
        'assets.colLicense': '协议',
        'assets.colPkgCopy': '随包副本',
        'assets.colRoute': '服务路由',
        'assets.colWsCopies': '工作区副本',
        'assets.noCopies': '（工作区无副本）',
        'disk.title': '磁盘占用（本地工作区）',
        'disk.refresh': '刷新占用',
        'disk.colDir': '目录',
        'disk.colSize': '大小',
        'disk.colFiles': '文件数',
        'disk.empty': '（工作区为空或未配置）',
        'tasks.noSession': '无活动会话',
        'tasks.loadingProject': '正在加载项目…',
        'tasks.noProject': '此会话没有对应项目。',
        'tasks.projectOverview': '项目总览',
        'tasks.projectLabel': '项目：',
        'tasks.viewCheck': '参数检查',
        'tasks.viewDashboard': '仪表盘',
        'tasks.viewSim': '仿真设置',
        'tasks.deleteAria': '删除 {name}',
        'tasks.newTask': '新建任务',
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
        'tasks.simTitle': '仿真设置',
        'tasks.simPlaceholder': '占位 — 本任务的 SmartAnaSim 配置将在后续里程碑落地。',
        'tasks.headerOpen': '打开 HarnessAMS 任务侧栏（项目总览与任务）',
        'tasks.guideDesc': '项目总览、任务、检查与使用引导',
        'check.title': '装配层检查参数',
        'check.desc': '装配脚本的检查阈值与开关；确认后写入 check_params.json，下次装配生效。',
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
        'pset.dirLocalHint': '本地模式：自检产物写入本地工作区 selfcheck/ 目录',
        'pset.dirRemoteRel': '相对路径按 $ROOT/ 解析',
        'pset.colMode': '工作模式',
        'pset.colMachine': '远程机器',
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
        'card.agg.title': '项目批次',
        'card.agg.line': '已完成 {done}/{batches} 批 · 仿真 {comp}/{total} · 待完成 {pending}',
        'card.agg.unplanned': '（另有 {n} 批未计划）',
        'card.agg.round': '批次',
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
        'guide.btn': 'Guide',
        'guide.caption': 'First time here? One guided pass over working modes, job submission and reports.',
        'guide.title': 'Get started with HarnessAMS',
        'guide.back': 'Back',
        'guide.done': 'Get started',
        'guide.s1t': 'Working mode: local or remote',
        'guide.s1': 'Local — the spectre loop runs on this machine (assemble → check → simulate → parse → report; Spectre must be installed locally). Remote — hosts (aliases and credentials) are configured in the dsh-ssh plugin; this page\'s “Machines” card lists the aliases, and each remote root is configured in harnessams.json\'s remote_machines section.',
        'guide.s2t': 'Job submission',
        'guide.s2': 'Direct — the simulation runs on this machine in the foreground (local spectre sweeps). batch — submit to an LSF queue over dsh-ssh (batch_submit / batch_poll / batch_fetch, sent straight to the machine alias).',
        'guide.s2slurm': 'slurm — not supported yet.',
        'guide.s3t': 'Workspace location',
        'guide.s3': 'Local — harnessams.json is the single source of paths (workspace_root, PDK, trash, script dirs, remote_machines roots). Remote — paths are the real remote paths (dsh-ssh goes by alias, no local mirror).',
        'guide.s4t': 'Simulation plugin suites',
        'guide.s4': 'SmartAnaSim registers all 11 tools on install: spectre (assemble / sweep / parse, local), sNp (Touchstone · psfascii read + device extraction), batch (generic LSF submit / poll / fetch), shared (analysis / progress / trash). Tools are all registered by default — guidance is provided by HarnessAMS only.',
        'guide.s5t': 'Where things live',
        'guide.s5': 'HarnessAMS task sidebar “Project overview” — local environment checks plus four checks per machine (sent straight to the dsh-ssh alias), plus the project-settings table and the one-click project self-check; “new task” creates a task, and inside a task “Dashboard” — HTML report viewer (sim_analysis registers generated reports automatically; existing reports can be browsed in) and “Checks” — project-level check-parameter editing; for an interactive shell use dsh-ssh\'s own SSH terminal panel.',
        'hosts.title': 'Machines',
        'hosts.ok': 'dsh-ssh: {n} host(s)',
        'hosts.missing': 'dsh-ssh not available',
        'hosts.colAlias': 'alias',
        'hosts.colHost': 'host',
        'hosts.colAuth': 'auth',
        'hosts.colRoot': 'remote root',
        'hosts.rootNone': 'not configured',
        'hosts.rootHint': 'set this alias\'s remote root in harnessams.json\'s remote_machines section',
        'hosts.empty': 'no hosts configured in dsh-ssh yet — add one in its panel.',
        'hosts.hint': 'Hosts and credentials are managed by the dsh-ssh plugin; this card is a read-only view of aliases and remote roots (remote_machines).',
        'chk.title': 'Health check',
        'chk.remoteArea': 'Remote root: {path}',
        'chk.needRemoteRoot': 'no host has a remote root configured — set remote_machines in harnessams.json to check them here.',
        'chk.unconfiguredList': 'unconfigured: {list}',
        'chk.running': 'Running…',
        'chk.colItem': 'Item',
        'chk.colResult': 'Result',
        'chk.colElapsed': 'Elapsed',
        'chk.colStatus': 'Status',
        'chk.analyze': 'Analyze in new session',
        'chk.analyzing': 'Creating the analysis session…',
        'chk.analyzeDone': 'Analysis session created — see it in the session tree.',
        'chk.analyzeAuto': 'Problems found — an analysis session was created automatically (see the session tree).',
        'chk.analyzeFail': 'Failed to create the analysis session: ',
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
        'assets.notices': 'third-party notices',
        'assets.colPkg': 'Package',
        'assets.colLicense': 'License',
        'assets.colPkgCopy': 'Package copy',
        'assets.colRoute': 'Served at',
        'assets.colWsCopies': 'Workspace copies',
        'assets.noCopies': '(no workspace copies)',
        'disk.title': 'Disk usage (local workspace)',
        'disk.refresh': 'Refresh usage',
        'disk.colDir': 'Directory',
        'disk.colSize': 'Size',
        'disk.colFiles': 'Files',
        'disk.empty': '(workspace empty or not configured)',
        'tasks.noSession': 'no active session',
        'tasks.loadingProject': 'Loading project…',
        'tasks.noProject': 'No project for this session.',
        'tasks.projectOverview': 'Project overview',
        'tasks.projectLabel': 'Project: ',
        'tasks.viewCheck': 'Checks',
        'tasks.viewDashboard': 'Dashboard',
        'tasks.viewSim': 'Sim settings',
        'tasks.deleteAria': 'Delete {name}',
        'tasks.newTask': 'New task',
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
        'tasks.simTitle': 'Simulation settings',
        'tasks.simPlaceholder': 'Placeholder — SmartAnaSim configuration for this task lands here in later milestones.',
        'tasks.headerOpen': 'Open the HarnessAMS sidebar (project overview and tasks)',
        'tasks.guideDesc': 'Project overview, tasks, checks and a guide',
        'check.title': 'Assembly check parameters',
        'check.desc': 'Thresholds and switches for the assembly-layer checks; confirming writes check_params.json and takes effect on the next assembly.',
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
        'pset.dirLocalHint': 'local mode: self-check artifacts go under the local workspace\'s selfcheck/ directory',
        'pset.dirRemoteRel': 'relative paths resolve under $ROOT/',
        'pset.colMode': 'Mode',
        'pset.colMachine': 'Machine',
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
        'card.agg.title': 'Project batches',
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
.hams-tasktab .hams-tabname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hams-tasktab .hams-x { opacity: .55; cursor: pointer; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); line-height: 1; }
.hams-tasktab .hams-x:hover { opacity: 1; color: #e05252; }
.hams-addbtn { border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); background: none;
  color: inherit; border-radius: 6px; padding: 2px 9px; cursor: pointer; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); }
.hams-body { padding: 8px 10px; overflow: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; }
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
  margin-bottom: 6px; flex: none; }
.hams-subtab { padding: 3px 10px; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); cursor: pointer; color: inherit; background: none;
  border: none; border-bottom: 2px solid transparent; opacity: .7; }
.hams-subtab.active { opacity: 1; border-bottom-color: currentColor; font-weight: 600; }
.hams-dash { margin-top: 12px; border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 8px; padding: 14px; opacity: .75; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
/* tier 3 Dashboard: report viewer (toolbar + iframe) and the add-report browser */
.hams-dashview { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; min-height: 0; flex: 1; }
.hams-dashtoolbar { margin: 0; flex-wrap: nowrap; }
.hams-dashtoolbar .hams-select { flex: 1 1 120px; min-width: 60px; max-width: 100%; }
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
  padding: 8px 12px; margin: 4px 0; font-size: var(--dsh-content-font-size, 14px); max-width: 680px; }
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

    function esc(s) { return String(s ?? '') }

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
            : info ? (info.workspace
              ? tr('console.workspace', { path: info.workspace.root }) + (info.tiers?.project === 'workspaceRegistry mapped' ? '' : ' — ' + info.tiers?.project)
              : tr('console.noWorkspace'))
            : tr('common.loading')),
        h(Boundary, null, h(MachinesSection, null)),
        h(Boundary, null, h(AssetsSection, null)),
        h(Boundary, null, h(DiskSection, null)),
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
        const fetchOne = () => Promise.all([
          progUrl ? fetchJson(progUrl).catch(() => null) : Promise.resolve(null),
          aggUrl ? fetchJson(aggUrl).catch(() => null) : Promise.resolve(null),
        ]).then(([p, a]) => {
          if (!alive || (!p && !a)) return
          const s = JSON.stringify([p, a])
          if (s !== last) { last = s; setData({ prog: p, agg: a }) }
        })
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
      const text = (b.content ?? []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
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
          h('td', null, esc(b.round)),
          h('td', { className: batchStatusColor(b.status) }, cardStatusText(b.status)),
          h('td', null, esc(b.total != null ? (Number(b.completed) || 0) + '/' + b.total : '—'))))))
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
        if (d.errlog_tail) els.push(h('div', { key: 'err', className: 'hams-pre hams-warn' }, esc(String(d.errlog_tail))))
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
        if (doneLine) els.push(h('div', { key: 'done', className: 'hams-dim' }, esc(doneLine)))
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
            h('span', { className: 'hams-tc-title' }, esc(toolName)),
            h('span', { className: 'hams-faint' }, esc(phase))),
          phase === 'start' && args ? h('div', { className: 'hams-pre' }, esc(JSON.stringify(args, null, 2))) : null,
          result ? h('div', { className: 'hams-pre' }, esc((result.text || '').slice(0, 4000))) : null)
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
          err.name ? ' — ' + esc(String(err.name)) : null,
          err.reason ? ' · ' + esc(String(err.reason).slice(0, 300)) : null)
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
          agg ? h('span', { className: 'hams-tc-agg' }, esc(aggLine(agg))) : null,
          h('button', { className: 'hams-btn hams-btn-sm', style: { marginLeft: 'auto' }, onClick: d.toggle }, tr('card.label.details'))),
        body,
        d.expanded ? h('div', { className: 'hams-tc-details' },
          agg && (agg.batches || []).length ? aggTable(agg) : null,
          h('div', { className: 'hams-pre' }, esc(rawTextOf(props, result)))) : null)
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

    // Machines (tier 1): the dsh-ssh host registry read through /api/machines,
    // with each alias's configured remote root (harnessams.json remote_machines).
    // Host credentials and connections live in dsh-ssh itself — here we only show
    // what is configured; an alias without a remote root renders the
    // add-remote_machines hint instead of a root path.
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
          h('thead', null, h('tr', null, [tr('hosts.colAlias'), tr('hosts.colHost'), tr('hosts.colAuth'), tr('hosts.colRoot')].map((c) => h('th', null, c)))),
          h('tbody', null, machines.machines.map((m) => h('tr', { key: m.id },
            h('td', null, esc(m.name || m.host)),
            h('td', null, esc((m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22))),
            h('td', null, esc(m.auth ?? '') + (m.auth === 'key' && !m.keyReady ? ' ⚠' : '')),
            h('td', null,
              m.configured ? esc(m.remoteRoot ?? '')
                : h('span', { className: 'hams-warn', title: tr('hosts.rootHint') }, tr('hosts.rootNone'))))))),
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
            [tr('assets.colPkg'), tr('assets.colLicense'), tr('assets.colPkgCopy'), tr('assets.colRoute'), tr('assets.colWsCopies')].map((c) => h('th', null, c)))),
          h('tbody', null, assets.packages.map((p) => h('tr', { key: p.file },
            h('td', null, esc(p.file), h('div', { className: 'hams-dim' }, p.label)),
            h('td', null, p.license),
            h('td', null,
              p.pkg
                ? [esc(p.pkg.path), h('div', { className: 'hams-dim' }, fmtBytes(p.pkg.bytes))]
                : h('span', { className: 'hams-warn' }, tr('assets.plotlyMissing'))),
            h('td', null, h('a', { className: 'hams-link', href: p.url, target: '_blank' }, tr('assets.openAsset'))),
            h('td', null,
              !p.copies?.length
                ? h('span', { className: 'hams-dim' }, tr('assets.noCopies'))
                : p.copies.map((c) => h('div', { key: c.path, title: c.path }, esc(c.path), ' — ', fmtBytes(c.bytes))))))),
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

    // Lowest navigation level inside a task: dashboard / check parameters / sim
    // settings (sim settings is a placeholder until its milestone lands). The
    // remote-terminal sub-view was removed with the dsh-remote retirement — the
    // user's interactive shell is @linxin666/dsh-ssh's own terminal panel. Above
    // this sits the first-level strip (project overview + task capsules), and
    // above that the tab itself — see ProjectOverviewView.
    const TASK_VIEWS = [
      { id: 'dashboard', labelKey: 'tasks.viewDashboard' },
      { id: 'check', labelKey: 'tasks.viewCheck' },
      { id: 'sim', labelKey: 'tasks.viewSim' },
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

    // First-level strip selection inside the task tab: 'overview' (the project
    // overview pseudo-capsule, the default display) or a task id. Same survive-a-
    // remount treatment as the sub-view above; a stale task id falls back to
    // 'overview' when the list arrives (TaskSidebarBody sanitizes after fetch).
    const STRIP_SEL_KEY = 'hams-task-strip-sel'
    let stripSelMemory = null
    function readStripSel() {
      if (stripSelMemory) return stripSelMemory
      try {
        const v = localStorage.getItem(STRIP_SEL_KEY)
        if (v) { stripSelMemory = v; return v }
      } catch { /* private mode */ }
      return 'overview'
    }
    function rememberStripSel(v) {
      stripSelMemory = v
      try { localStorage.setItem(STRIP_SEL_KEY, v) } catch { /* private mode */ }
    }

    // Overview health-check panel (LOCAL projects): one local-environment button plus
    // one block per machine that has a remote project — its four check buttons run
    // through that remote project's live session (borrowed server-side). Every button
    // runs independently; results replace whatever showed below.
    const REMOTE_CHECK_IDS = ['load', 'jobs', 'batches', 'scripts']
    // Auto handoff policy: remote check failures start a
    // diagnosis session without a click; local failures only offer the button. A
    // constant until the behavior gets its settings card — flip to false for
    // button-only behavior.
    const AUTO_ANALYZE_REMOTE = true
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
    function CheckResults({ run, machines }) {
      if (!run.machineId) {
        return h('div', null,
          h('table', { className: 'hams-table' },
            h('thead', null, h('tr', null, [tr('chk.colItem'), tr('chk.colResult'), tr('chk.colElapsed'), tr('chk.colStatus')].map((c) => h('th', { key: c }, c)))),
            h('tbody', null, (run.results ?? []).map((x, i) => h('tr', { key: i, className: x.ok ? '' : 'hams-rowbad' },
              h('td', { title: x.cmd ?? '' }, esc(x.item)),
              h('td', null,
                esc(x.result || x.detail || '-'),
                x.warn ? h('span', { className: 'hams-warn' }, ' ⚠ ' + esc(x.warn)) : null,
                x.ok && x.detail ? h('div', { className: 'hams-pre' }, esc(x.detail)) : null),
              h('td', null, x.ms + ' ms'),
              h('td', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'))))),
          run.channel && h('div', { className: 'hams-dim' }, esc(run.channel)))
      }
      const m = machines.find((x) => x.id === run.machineId)
      return h('div', null,
        (run.results ?? []).map((x, i) => h('div', { key: i, style: { margin: '6px 0' } },
          h('div', { className: 'hams-row' },
            h('b', null, esc(x.item)),
            h('span', { className: 'hams-dim' }, x.ms + ' ms'),
            h('span', { className: x.ok ? 'hams-good' : 'hams-bad' }, x.ok ? '✅' : '✗'),
            x.warn ? h('span', { className: 'hams-warn' }, '⚠ ' + esc(x.warn)) : null),
          !x.ok && x.detail ? h('div', { className: 'hams-pre' }, esc(x.detail)) : null,
          x.rows && x.rows.length ? h(CheckResultTable, { check: run.check, x })
            : h('div', { className: 'hams-dim' }, esc(x.result || x.detail || '-')),
          x.truncated ? h('div', { className: 'hams-dim' }, tr('chk.truncated')) : null,
          run.check === 'batches' && x.rows && x.rows.length && m
            ? h('div', { className: 'hams-dim' }, tr('chk.rootLegend', { path: m.remotePath })) : null)),
        run.channel && h('div', { className: 'hams-dim' }, esc(run.channel)))
    }

    // One machine block: identity line + remote root + the four remote check
    // buttons (ssh_exec by alias — no live-session requirement anymore).
    function MachineCheckBlock({ m, run, running, onRun }) {
      const machineRun = run && run.machineId === m.id ? run : null
      const hostLine = (m.username ? m.username + '@' : '') + (m.host ?? '') + ':' + (m.port ?? 22)
      return h('div', { style: { margin: '10px 0 2px' } },
        h('div', { style: { fontSize: 'calc(12.5px + var(--dsh-content-font-delta, 0px))', lineHeight: 1.6 } },
          h('div', null,
            h('b', null, esc(m.name || m.host)), ' ', esc(hostLine),
            m.auth ? ' · ' + esc(m.auth) + (m.auth === 'key' && !m.keyReady ? ' ⚠' : '') : ''),
          h('div', null, tr('chk.remoteArea', { path: m.remotePath || '—' }))),
        h('div', { className: 'hams-row' },
          REMOTE_CHECK_IDS.map((id) => h('button', {
            key: id,
            className: 'hams-btn hams-btn-sm',
            disabled: running,
            title: tr('chk.btn.' + id),
            onClick: () => onRun(m.id, id),
          }, running && machineRun && machineRun.id === m.id + ':' + id ? tr('chk.running') : tr('chk.btn.' + id)))))
    }

    function CheckPanel({ info, run, onRun, analyze, onAnalyze }) {
      const running = run?.status === 'running'
      const machines = info?.machines ?? []
      // The failed-entries handoff replaced the old copy-to-clipboard diagnose
      // button: one run-level button bundles every failed entry of the current
      // run into a newly created DSH session (analyzeRun in TaskSidebarBody).
      const hasFailed = run?.status === 'done' && (run.results ?? []).some((x) => x && x.ok === false)
      const analyzing = analyze?.status === 'running'
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
          && h('div', { className: 'hams-dim' },
            tr(info.machinesTotal ? 'chk.needRemoteRoot' : 'hosts.empty'),
            info.machinesTotal && (info.machinesUnconfigured ?? []).length
              ? ' (' + tr('chk.unconfiguredList', { list: info.machinesUnconfigured.join(', ') }) + ')' : ''),
        machines.map((m) => h(MachineCheckBlock, { key: m.id, m, run, running, onRun })),
        run?.status === 'failed' && h('div', { className: 'hams-err' }, run.error),
        run?.status === 'done' && h(CheckResults, { run, machines }),
        hasFailed && h('div', { className: 'hams-row' },
          h('button', {
            className: 'hams-btn hams-btn-sm',
            disabled: analyzing,
            title: tr('chk.analyze'),
            onClick: () => onAnalyze(run, false),
          }, analyzing ? tr('chk.analyzing') : tr('chk.analyze')),
          analyze?.status === 'done' && h('span', { className: 'hams-dim' }, analyze.auto ? tr('chk.analyzeAuto') : tr('chk.analyzeDone')),
          analyze?.status === 'failed' && h('span', { className: 'hams-err' }, tr('chk.analyzeFail') + esc(analyze.error ?? ''))),
        !run && h('div', { className: 'hams-dim' }, tr('chk.noneYet')),
      )
    }

    // ---------- tier 3 Overview: project settings + one-click project self-check ----------
    // The settings table is COLUMN-per-setting with two rows: row 1 = the live
    // setting (dropdown cells, PUT on every change), row 2 = that setting's
    // self-check verdict (aggregated from the run's steps server-tagged with a
    // settingColumn). Column visibility cascades off the mode/simulator choices
    // (a local project hides the machine/scheduler/remote-compute columns).
    const SETTING_COLS = [
      { id: 'run_mode', labelKey: 'pset.colMode', column: 'run_mode',
        options: [['local', 'pset.mode.local'], ['remote', 'pset.mode.remote']] },
      { id: 'machine_id', labelKey: 'pset.colMachine', column: 'machine', kind: 'machine',
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

    function SettingsTable({ settings, machines, run, onChange }) {
      const cols = SETTING_COLS.filter((c) => !c.visible || c.visible(settings))
      const settingCell = (c) => {
        if (c.kind === 'machine') {
          const known = machines.some((m) => m.id === settings.machine_id)
          return h('select', { className: 'hams-select', value: settings.machine_id ?? '',
            onChange: (e) => onChange('machine_id', e.target.value || null) },
            h('option', { value: '' }, tr('pset.noMachine')),
            (known ? [] : settings.machine_id
              ? [h('option', { key: 'kept', value: settings.machine_id }, esc(settings.machine_id) + ' ?')] : []),
            machines.map((m) => h('option', { key: m.id, value: m.id },
              esc(m.name || m.host) + (m.host && m.host !== m.name ? ' · ' + esc(m.host) : ''))))
        }
        return h('select', { className: 'hams-select', value: settings[c.id] ?? '',
          onChange: (e) => onChange(c.id, e.target.value) },
          c.options.map(([v, k]) => h('option', { key: v, value: v }, tr(k))))
      }
      const resultCell = (c) => {
        const agg = selfcheckColumnResult(run, c.column)
          ?? (c.column === 'run_mode' && run?.summary
            ? { state: run.summary.ok ? 'ok' : 'bad', text: tr(run.summary.ok ? 'selfchk.summaryOk' : 'selfchk.summaryFail'), title: '' }
            : null)
        if (!agg) return h('td', { key: c.id, className: 'hams-faint' }, '—')
        const cls = agg.state === 'ok' ? 'hams-good' : agg.state === 'warn' ? 'hams-warn' : agg.state === 'skip' ? 'hams-faint' : 'hams-bad'
        const icon = agg.state === 'ok' ? '✅' : agg.state === 'warn' ? '⚠' : agg.state === 'skip' ? '⏭' : '✗'
        return h('td', { key: c.id, className: cls, title: agg.title || agg.text }, icon + ' ' + esc(agg.text))
      }
      return h('table', { className: 'hams-table' },
        h('thead', null, h('tr', null, cols.map((c) => h('th', { key: c.id }, tr(c.labelKey))))),
        h('tbody', null,
          h('tr', null, cols.map((c) => h('td', { key: c.id }, settingCell(c)))),
          h('tr', null, cols.map((c) => resultCell(c)))))
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
          h('td', { title: s.skipReason ?? '' }, esc(s.item),
            s.warn ? h('span', { className: 'hams-warn' }, ' ⚠ ' + esc(s.warn)) : null),
          h('td', { title: s.detail || '' },
            esc(s.result || (s.skipReason ? tr('selfchk.skipped') + ' — ' + s.skipReason : '-')),
            s.ok !== false && s.detail ? h('div', { className: 'hams-pre' }, esc(s.detail)) : null),
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
    const overviewMemory = { path: null, project: null, checksInfo: null, checkRun: null }
    const selfcheckMemory = { path: null, settings: null, run: null }

    function ProjectSelfcheck({ sessionId, info, projectPath }) {
      const [settings, setSettings] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.settings : null))
      const [settingsError, setSettingsError] = useState(null)
      const [dirDraft, setDirDraft] = useState(null)
      const [run, setRun] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.run : null))
      const [startError, setStartError] = useState(null)
      const machines = info?.machines ?? []

      // Same-project remount (session switch inside one workspace): adopt the
      // module snapshot instead of clearing — the table never flashes blank and
      // a running self-check keeps polling by runId. Different/first project:
      // full reset, same as before.
      useEffect(() => {
        let alive = true
        const adopt = !!projectPath && selfcheckMemory.path === projectPath
        if (!adopt) { setSettings(null); setSettingsError(null); setRun(null); setStartError(null) }
        if (!sessionId) return
        fetchJson(API + '/project-settings?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => { if (alive) setSettings((prev) => (JSON.stringify(prev) === JSON.stringify(r.settings) ? prev : r.settings)) })
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
        selfcheckMemory.run = run
      }, [projectPath, settings, run])

      const runId = run?.id ?? null
      const runStatus = run?.status ?? null
      useEffect(() => {
        if (runStatus !== 'running') return
        let alive = true
        const refetch = () => {
          fetchJson(API + '/selfcheck?id=' + encodeURIComponent(runId))
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

      const updateSetting = async (key, value) => {
        const prev = settings
        const next = { ...prev, [key]: value }
        // The machine column only renders in remote mode, so a remote switch with
        // machine_id unset would PUT-400 and roll straight back to local — the UI
        // could never reach remote. Auto-pick the first machine on the way in.
        if (key === 'run_mode' && value === 'remote' && !next.machine_id && machines.length) {
          next.machine_id = machines[0].id
        }
        setSettings(next); setSettingsError(null)
        try {
          const r = await fetchJson(API + '/project-settings?sessionId=' + encodeURIComponent(sessionId),
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
          setSettings(r.settings ?? next)
        } catch (e) {
          setSettings(prev) // revert the optimistic cell
          setSettingsError(tr('pset.saveFailed', { msg: String(e.message ?? e) }))
        }
      }

      const startRun = async () => {
        setStartError(null)
        try {
          const r = await fetchJson(API + '/selfcheck', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, lang: effectiveLang() }),
          })
          setRun({ id: r.runId, status: 'running', steps: [], diagnoses: [], scope: null })
        } catch (e) {
          setStartError(tr('selfchk.startFailed', { msg: String(e.message ?? e) }))
        }
      }

      const remote = settings?.run_mode === 'remote'
      const machine = machines.find((m) => m.id === settings?.machine_id) ?? null
      const dirValue = dirDraft ?? settings?.remote_dir ?? ''
      const dirPreview = String(settings?.remote_dir ?? '').startsWith('/')
        ? settings.remote_dir
        : (machine?.remotePath ? String(machine.remotePath).replace(/\/+$/, '') + '/' + settings?.remote_dir : '$ROOT/' + (settings?.remote_dir ?? ''))
      const running = run?.status === 'running'

      return h('div', { style: { marginTop: '10px' } },
        h('div', { className: 'hams-dim' }, h('b', null, tr('pset.title')), ' · ', tr('selfchk.title')),
        settingsError && h('div', { className: 'hams-err' }, esc(settingsError)),
        !settings && !settingsError && h('div', { className: 'hams-dim' }, tr('common.loading')),
        settings && h('div', null,
          // working directory: always visible — "local" read-only, or the bound
          // remote directory (full-path preview + manual input; the mirror browse
          // button is gone with the dsh-remote mirrors — type the path instead)
          h('div', { className: 'hams-row', style: { flexWrap: 'nowrap' } },
            h('b', { style: { flexShrink: 0 } }, tr('pset.dirLabel')),
            remote
              ? h('input', { className: 'hams-input', value: dirValue, title: dirPreview,
                  onChange: (e) => setDirDraft(e.target.value),
                  onBlur: () => { const v = (dirDraft ?? '').trim(); setDirDraft(null); if (v && v !== settings.remote_dir) void updateSetting('remote_dir', v) },
                  onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() } })
              : h('span', { className: 'hams-dim' }, 'local · ' + tr('pset.dirLocalHint'))),
          remote && h('div', { className: 'hams-dim', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 0 4px' } },
            '→ ', esc(dirPreview), ' · ', tr('pset.dirRemoteRel')),
          h(SettingsTable, { settings, machines, run, onChange: updateSetting }),
          h('div', { className: 'hams-row' },
            h('button', { className: 'hams-btn hams-btn-sm', disabled: running || !sessionId, onClick: startRun },
              running ? tr('selfchk.running') : tr('selfchk.run')),
            h('span', { className: 'hams-dim' }, tr('selfchk.desc'))),
          startError && h('div', { className: 'hams-err' }, esc(startError)),
          h(SelfcheckSteps, { run }),
          run?.summary && h('div', { className: 'hams-row' },
            h('span', { className: run.summary.ok ? 'hams-good' : 'hams-bad', style: { fontWeight: 600 } },
              tr(run.summary.ok ? (run.summary.fallback ? 'selfchk.summaryFallback' : 'selfchk.summaryOk') : 'selfchk.summaryFail'))),
          (run?.diagnoses ?? []).map((d, i) => h('div', { key: i, className: d.status === 'done' ? 'hams-dim' : 'hams-err' },
            d.status === 'done' ? tr('selfchk.diagDone', { id: d.sessionId ?? '' }) : tr('selfchk.diagFail', { err: d.error ?? '' })))))
    }

    // ---------- tier 3: project overview (first-level view inside the task tab) ----------
    // Project-level surfaces only (health checks + settings/self-check): nothing
    // here depends on a task, so switching sessions or strip entries INSIDE one
    // project must not refresh the view — the body initializes from overviewMemory
    // and only a real project change clears and refetches. Rendered by
    // TaskSidebarBody as the strip's default 'overview' entry (项目总览).
    function ProjectOverviewView(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const [project, setProject] = useState(() => overviewMemory.project ?? undefined)
      const [reason, setReason] = useState(null)
      const [checksInfo, setChecksInfo] = useState(() => (overviewMemory.path ? overviewMemory.checksInfo : null))
      const [checkRun, setCheckRun] = useState(() => (overviewMemory.path ? overviewMemory.checkRun : null))
      const [analyze, setAnalyze] = useState(null)
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
              overviewMemory.checkRun = null
              setChecksInfo(null); setCheckRun(null)
            }
            setProject(r.project ?? null)
            setReason(r.project ? null : r.reason ?? null)
          })
          .catch((e) => { if (alive) { setProject(null); setReason(String(e.message ?? e)) } })
        return () => { alive = false }
      }, [sessionId])

      // Overview check surface (local environment + per-machine remote checks).
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
        overviewMemory.checkRun = checkRun
      }, [projectPath, project, checksInfo, checkRun])

      // mid=null runs the local-environment check; otherwise mid is the machineId
      // of the machine block the button sits in (remote checks borrow that
      // machine's remote-project session server-side).
      const runCheck = async (mid, id) => {
        const key = mid ? mid + ':' + id : id
        setCheckRun({ id: key, machineId: mid ?? null, check: id, status: 'running', results: null })
        try {
          const q = 'sessionId=' + encodeURIComponent(sessionId) + '&check=' + encodeURIComponent(id)
            + (mid ? '&machineId=' + encodeURIComponent(mid) : '')
          const r = await fetchJson(API + '/checks/run?' + q)
          setCheckRun({ id: key, machineId: mid ?? null, check: id, status: 'done', results: r.results, channel: r.channel })
          // Auto handoff (path 2, user decision 2026-11-01): a REMOTE check that
          // ends with failed entries immediately starts a diagnosis session, so
          // cluster problems never need a manual copy-paste. Local check failures
          // stay button-only (auto sessions for trivial failures would just burn
          // tokens). Behavior switch is a constant for now — future: user setting.
          if (AUTO_ANALYZE_REMOTE && mid && (r.results ?? []).some((x) => x && x.ok === false)) {
            void analyzeRun({ machineId: mid, check: id, results: r.results }, true)
          }
        } catch (e) {
          setCheckRun({ id: key, machineId: mid ?? null, check: id, status: 'failed', error: String(e.message ?? e), results: null })
        }
      }

      // analyzeRun: hand a run's failed entries to a newly created diagnosis
      // session (POST /api/checks/analyze); auto=true marks the automatic
      // trigger for the result message.
      const analyzeRun = async (run, auto) => {
        const failed = (run.results ?? []).filter((x) => x && x.ok === false)
        if (!failed.length || !sessionId) return
        setAnalyze({ status: 'running', auto })
        try {
          const r = await fetchJson(API + '/checks/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              check: run.check,
              machineId: run.machineId ?? null,
              lang: effectiveLang(),
              auto: !!auto,
              failed,
            }),
          })
          setAnalyze({ status: 'done', auto, sessionId: r.sessionId, title: r.title })
        } catch (e) {
          setAnalyze({ status: 'failed', auto, error: String(e.message ?? e) })
        }
      }

      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, fontSize: 'var(--dsh-content-font-size, 14px)' } },
        h('div', { className: 'hams-body' },
          project === undefined && h('div', { className: 'hams-dim' }, tr('tasks.loadingProject')),
          project === null && h('div', { className: 'hams-dim' }, tr('tasks.noProject'), h('br'), null, esc(reason ?? '')),
          project && h('div', { className: 'hams-dim' },
            tr('tasks.projectLabel'), h('b', null, esc(project.title || project.path)), h('br'), null, esc(project.path)),
          project && checksInfo && h(CheckPanel, { info: checksInfo, run: checkRun, onRun: runCheck, analyze, onAnalyze: analyzeRun }),
          project && sessionId && h(ProjectSelfcheck, { sessionId, info: checksInfo, projectPath }),
        ))
    }

    function TaskSidebarBody(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const [project, setProject] = useState(undefined) // undefined=loading, null=none
      const [reason, setReason] = useState(null)
      const [tasks, setTasks] = useState([])
      const [stripSel, setStripSel] = useState(readStripSel) // first-level strip: 'overview' | task id
      const [view, setView] = useState(readTaskView)
      const [error, setError] = useState(null)
      const [dialogOpen, setDialogOpen] = useState(false)
      const [descDraft, setDescDraft] = useState(null)

      const projectPath = project?.path ?? null

      // Sidebar-follows-switch bookkeeping (see SessionHeaderButton): the host
      // keeps this body mounted even while the sidebar is collapsed (hidden), so
      // visibility — not mount state — is what "the sidebar is open" means. Probe
      // the root element's box every 500 ms and stamp sidebarOpenState while it
      // is actually on screen.
      const rootRef = useRef(null)
      useEffect(() => {
        const probe = () => {
          const el = rootRef.current
          if (el && el.isConnected && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
            sidebarOpenState.lastSeenVisibleAt = Date.now()
          }
        }
        probe()
        const timer = setInterval(probe, 500)
        return () => clearInterval(timer)
      }, [])

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

      // Remote projects are connection anchors — no task store, no check surface.
      useEffect(() => {
        let alive = true
        if (!projectPath || !sessionId) { setTasks([]); return }
        fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId))
          .then((d) => {
            if (!alive) return
            const fresh = d.tasks ?? []
            setTasks(fresh)
            // sanitize the strip selection: a stored task id that no longer
            // exists (deleted, or left over from another project) falls back to
            // the project overview — the tab's default display
            setStripSel((prev) => prev !== 'overview' && !fresh.some((t) => t.id === prev) ? 'overview' : prev)
          })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [projectPath, sessionId])

      // The Dashboard sub-view stays live while visible (auto-refresh):
      // sim_analysis(report=true, task=…) appends to tasks.json behind the
      // sidebar's back, so poll the store every 10 s while the sub-view is open
      // and the tab visible; persist-in-flight ticks are skipped so a just-applied
      // optimistic update is never flashed over by a stale list, and the list
      // state is only touched when the server copy actually differs.
      useEffect(() => {
        if (view !== 'dashboard' || !projectPath || !sessionId) return
        let alive = true
        const refetch = () => {
          if (!alive || persistingRef.current) return
          fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId))
            .then((d) => {
              if (!alive) return
              const fresh = d.tasks ?? []
              setTasks((prev) => (JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh))
              setStripSel((prev) => prev !== 'overview' && !fresh.some((t) => t.id === prev) ? 'overview' : prev)
            })
            .catch(() => { /* keep the current list */ })
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
      // view (ProjectOverviewView); the task body itself needs no checks fetch.

      // persist(mutator) re-bases the change on the LATEST server list before the
      // full-list PUT: the store has a second writer now (sim_report's report
      // injection writes tasks.json behind the sidebar's back), so sending the
      // mount-time snapshot would clobber injected reports — the rebase shrinks
      // the clobber window to milliseconds. Returns the server-confirmed list,
      // or null on failure (the optimistic update stays, error shows inline).
      const persistingRef = useRef(false)
      const persist = async (mutator) => {
        persistingRef.current = true
        try {
          const latest = await fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId)).catch(() => null)
          const next = mutator(latest?.tasks ?? tasks)
          setTasks(next)
          const r = await fetchJson(API + '/tasks?sessionId=' + encodeURIComponent(sessionId),
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: next }) })
          const saved = r.tasks ?? next
          setTasks(saved)
          return saved
        } catch (e) {
          setError(String(e.message ?? e))
          return null
        } finally {
          persistingRef.current = false
        }
      }

      const selected = stripSel !== 'overview' ? (tasks.find((t) => t.id === stripSel) ?? null) : null

      const createTask = async (name, description) => {
        const saved = await persist((latest) => [...latest, { name, description: description || '' }])
        if (saved && saved.length) { const id = saved[saved.length - 1].id; rememberStripSel(id); setStripSel(id) }
      }
      const removeTask = (id) => {
        const t = tasks.find((x) => x.id === id)
        if (!t) return
        if (!window.confirm(tr('tasks.deleteConfirm', { name: t.name }))) return
        if (stripSel === id) {
          const next = tasks.filter((x) => x.id !== id)[0]?.id ?? 'overview'
          rememberStripSel(next); setStripSel(next)
        }
        persist((latest) => latest.filter((x) => x.id !== id))
      }
      const saveDescription = () => {
        if (!selected || descDraft === null) return
        persist((latest) => latest.map((t) => t.id === selected.id ? { ...t, description: descDraft } : t))
        setDescDraft(null)
      }
      // Dashboard sub-view mutator: applies fn to the selected task and persists
      // the whole list (same single-writer channel as description edits).
      const updateTask = (fn) => persist((latest) => latest.map((t) => t.id === selected.id ? fn(t) : t))

      return h('div', { ref: rootRef, style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, fontSize: 'var(--dsh-content-font-size, 14px)' } },
        // first-level strip (modeled after dsh-ssh-ops' server tabs): the project
        // overview pseudo-capsule first — the tab's default display, not
        // deletable — then one capsule per task and the "new task" button; the
        // tab's whole navigation lives on this one level
        h('div', { className: 'hams-tabstrip' },
          h('div', {
            className: 'hams-tasktab' + (stripSel === 'overview' ? ' active' : ''),
            title: tr('tasks.projectOverview'),
            onClick: () => { rememberStripSel('overview'); setStripSel('overview') },
          }, h('span', { className: 'hams-tabname' }, tr('tasks.projectOverview'))),
          tasks.map((t) => h('div', {
              key: t.id,
              className: 'hams-tasktab' + (t.id === stripSel ? ' active' : ''),
              title: t.name,
              onClick: () => { rememberStripSel(t.id); setStripSel(t.id); setDescDraft(null) },
            },
            h('span', { className: 'hams-tabname' }, t.name),
            h('span', { className: 'hams-x', role: 'button', 'aria-label': tr('tasks.deleteAria', { name: t.name }),
              onClick: (e) => { e.stopPropagation(); removeTask(t.id) } }, '×'))),
          project && h('button', { className: 'hams-addbtn', title: tr('tasks.newTask'), onClick: () => setDialogOpen(true) },
            tr('tasks.newTask')),
        ),
        h('div', { className: 'hams-body' },
          error && h('div', { className: 'hams-err' }, error),
          project === undefined && h('div', { className: 'hams-dim' }, tr('tasks.loadingProject')),
          project === null && h('div', { className: 'hams-dim' }, tr('tasks.noProject'), h('br'), null, esc(reason ?? '')),
          project && stripSel === 'overview' && h(ProjectOverviewView, { sessionId }),
          selected && h('div', { style: { marginTop: '8px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
            // task-level info: name+date row and the description editor stay
            // always visible above the sub tabs (project-level info lives in the
            // project overview view)
            h('div', { className: 'hams-row' },
              h('b', null, selected.name),
              h('span', { className: 'hams-dim' }, selected.created_at ? selected.created_at.slice(0, 10) : '')),
            h('div', { className: 'hams-taskdesc' },
              h('textarea', {
                className: 'hams-textarea',
                rows: 2,
                value: descDraft ?? selected.description ?? '',
                placeholder: tr('tasks.descPlaceholder'),
                onChange: (e) => setDescDraft(e.target.value),
              }),
              descDraft !== null && h('div', { className: 'hams-row' },
                h('button', { className: 'hams-btn hams-btn-sm', onClick: saveDescription }, tr('common.save')),
                h('button', { className: 'hams-btn hams-btn-sm', onClick: () => setDescDraft(null) }, tr('common.cancel')))),
            // lowest level: per-task sub navigation (dashboard / check params / sim)
            h('div', { className: 'hams-subtabs', role: 'tablist' },
              TASK_VIEWS.map((v) => h('button', {
                key: v.id,
                className: 'hams-subtab' + (view === v.id ? ' active' : ''),
                role: 'tab',
                'aria-selected': view === v.id,
                onClick: () => { rememberTaskView(v.id); setView(v.id) },
              }, tr(v.labelKey)))),
            view === 'dashboard' && h(TaskDashboard, { task: selected, updateTask }),
            view === 'check' && h(CheckParams, { sessionId }),
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
    function TaskDashboard({ task, updateTask }) {
      const [nonce, setNonce] = useState(0)
      const [dialogOpen, setDialogOpen] = useState(false)
      const reports = task.reports ?? []
      const selectedId = reports.some((r) => r.id === task.dashboard_selected)
        ? task.dashboard_selected
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
          fetchJson(API + '/report-stat?taskId=' + encodeURIComponent(task.id)
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
      }, [current?.id, task.id])

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

    // Check-parameters sub-view (task tab): editable table of the assembly-layer
    // check thresholds/switches stored in check_params.json (project-level). The
    // six R/C/L numbers are strings while drafting; the confirm button validates,
    // PUTs the whole object, and the server re-validates. While a draft differs
    // from the saved value the cell keeps the old value visible in gray
    // parentheses so the pre-confirm state is always readable.
    function CheckParams({ sessionId }) {
      const [params, setParams] = useState(null) // saved copy (null = loading)
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
        setParams(null); setDraft(null); setError(null); setSaveError(null)
        if (!sessionId) return
        fetchJson(API + '/check-params?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => { if (alive && r?.params) { setParams(r.params); setDraft(toDraft(r.params)) } })
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
          const r = await fetchJson(API + '/check-params?sessionId=' + encodeURIComponent(sessionId),
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
          setParams(r.params ?? next)
          setDraft(toDraft(r.params ?? next))
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
        error && h('div', { className: 'hams-err' }, esc(error)),
        saveError && h('div', { className: 'hams-err' }, esc(saveError)),
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
    // plus the switch teardown, 1.5 s).
    let openSidebarTab = null
    const sidebarOpenState = { lastSeenVisibleAt: 0 }

    function SessionHeaderButton(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      useEffect(() => {
        if (!sessionId || !openSidebarTab) return
        let cancelled = false
        // the host tears the right pane down and up around a switch; a short delay
        // keeps the reopen from landing on the intermediate state
        const t = setTimeout(() => {
          if (cancelled || !openSidebarTab) return
          if (Date.now() - sidebarOpenState.lastSeenVisibleAt > 1500) return // was closed — leave it
          if (openSidebarTab) openSidebarTab()
        }, 350)
        return () => { cancelled = true; clearTimeout(t) }
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
