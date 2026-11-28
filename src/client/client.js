// HarnessAMS client half — the three-tier UI:
//   tier 1: global console page ("HarnessAMS" entry in the left sidebar -> full panel):
//           first-run guide (centered entry until seen, then a persistent guide button;
//           five sections chaining the scattered hints into one read), machines (the
//           dsh-ssh host registry with each alias's configured remote root), digital
//           assets (vendored .js packages with licenses + the served package
//           copy);
//   tier 2: project = DSH workspace (a local folder) — every SESSION is a work
//           unit (the task concept was retired 2026-11-19, decisions.md D-003):
//           each session carries its own dashboard reports and confirmed check
//           params in <workspace>/.harnessams/sessions.json;
//   tier 3: right-sidebar tab — the first-level strip is exactly two entries,
//           the project overview (project-scoped so same-project session switches
//           never refresh it) and THIS session's own panel with its Dashboard
//           (local HTML reports: browse-to-add / dropdown / reload; gen_sweep_report
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
    const { useState, useEffect, useMemo, useRef, useCallback } = React

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
        'common.close': '关闭',
        'console.title': 'HarnessAMS 控制台',
        'console.infoFailed': 'info 读取失败：{msg}',
        'console.config': '项目配置＝各工作区自己的 .harnessams/workspace_config.json',
        'console.coreTitle': '核心配置',
        'console.envScope': '作用于项目：{project}',
        'console.noActiveSession': '暂无活动会话——打开任意会话后可在此切换工作环境。',
        'guide.btn': '使用引导',
        'guide.caption': '第一次使用 HarnessAMS？从工作方式、提交作业到报告查看，一条引导走完。',
        'guide.title': '开始使用 HarnessAMS',
        'guide.back': '返回',
        'guide.done': '开始使用',
        'guide.s1t': '工作方式：本地还是远程',
        'guide.s1': '本地 — spectre 本地闭环（SmartAnaSim 网表预检＋手搓 run 目录＋batch_submit 本机后台扫批＋脚本解析＋报告；需本机自备 Spectre）。远程 — 机器（主机别名与凭据）在 dsh-ssh 插件里配置管理；远端根路径是各项目自己的设置（项目总览设置表「远端根路径」行）。',
        'guide.s2t': '提交作业方式',
        'guide.s2': '统一走 batch_submit，调度语义随工作环境（控制台页「核心配置」开关）：集群内 — local 本机后台运行、ssh 到其他节点运行、lsf 本机直接 bsub（共享文件系统，文件不经 ssh）；集群外 — local 不可用、ssh 在 ssh 节点运行（第二跳走 dsh-ssh 代理配置）、lsf 先经 dsh-ssh 到集群再 bsub。进度与取回用 batch_poll（完成时自动拉回 sweep_progress.json 与 errlog.txt）。',
        'guide.s2slurm': 'slurm —— 暂不支持。',
        'guide.s3t': '工作区位置',
        'guide.s3': '配置＝各工作区自己的 .harnessams/workspace_config.json 单文件（运行设置含远端根路径、脚本目录、plotly、回收站）。远程 — 路径即远端真实路径（dsh-ssh 按别名直达，无本地镜像）。',
        'guide.s4t': '仿真插件套件',
        'guide.s4': '套件合计 16 个工具：SmartAnaSim 7（spectre_pre_check 网表预检＋snp_guide/读取/提取三件＋gen_vsch_import/export 两件＋post_check 按需数据完整性诊断，sNp 读取/提取经 snp_guide 按需激活；另随包 smart-spectre 配置技能与可直跑的 worker/解析/诊断脚本）＋HarnessAMS 9（batch_submit 三模式提交（内置网表预检）、batch_poll 轮询/取回、gen_sweep_report 报告、register_report 挂载已有报告、safe_trash 回收站（含清空）、harnessams_selfcheck 自检、config_automation/run_automation 自动化任务的增改删与触发、local_exec 本地任务行宿主命令（仅自动化通道内可用））。除 sNp 读取/提取外默认全注册；使用引导仅由 HarnessAMS 提供。',
        'guide.s5t': '日常入口速查',
        'guide.s5': 'HarnessAMS 侧栏「项目总览」— 两个子页：「项目配置与总览」＝项目设置表＋项目自检为主入口：保存到AGENTS.md（项目配置表一键落盘）/ 一键自检 / 列出本机环境（node/python 版本＋绝对路径）/ 全部检查并保存，工作目录经 dsh-ssh 远程目录浏览选取；「自动化」＝自动化任务列表（config_automation 工具增/改/删、run_automation 为 agent 调试触发面；行内「运行」＝手工触发：远程任务在项目 machine_id 上顺序执行命令 .txt、本地任务逐行调工具不套 ssh 壳（本机命令用 local_exec 工具），运行结果显示在「状态」列、点击状态文字弹出详情；行尾「删除」移除任务条目、命令 .txt 保留在共享库；新项目默认带一条「清空垃圾桶」示例）；「会话」— 当前会话自己的工作区：「仪表盘」报告面板（gen_sweep_report 生成报告即自动登记进本会话，也可浏览添加已有报告；「打开」经系统默认浏览器以本地文件打开——plotly 与数据走本地相对路径可离线渲染；分支会话首见自动复制上一活跃会话的整份配置）、「参数检查」本会话的检查参数编辑（未确认按项目缺省∪内置缺省生效）；交互 shell 用 dsh-ssh 自带的 SSH 终端面板。',
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
        'assets.notices': '第三方声明',
        'assets.colPkg': '包',
        'assets.colLicense': '协议',
        'assets.colPkgCopy': '随包副本',
        'tasks.noSession': '无活动会话',
        'tasks.loadingProject': '正在加载项目…',
        'tasks.noProject': '此会话没有对应项目。',
        'tasks.projectOverview': '项目总览',
        'tasks.sessionTab': '会话',
        'tasks.projectLabel': '项目：',
        'tasks.viewCheck': '参数检查',
        'tasks.viewDashboard': '仪表盘',
        'tasks.viewConfig': '项目配置与总览',
        'tasks.viewAutomation': '自动化',
        'auto.colName': '任务名称',
        'auto.colCreated': '创建时间',
        'auto.colUpdated': '更新时间',
        'auto.sortHint': '点击按此列排序/切换方向',
        'auto.empty': '尚无自动化任务——用 config_automation 工具添加（配置可直接让 agent 做）。',
        'auto.noDesc': '（无描述）',
        'auto.filesLabel': '命令文件（按执行顺序）：',
        'auto.noFiles': '（未引用命令文件）',
        'auto.run': '运行',
        'auto.stop': '中止',
        'auto.runFailed': '运行失败：{msg}',
        'auto.noMachine': '未配置 machine_id——运行前先在「项目配置与总览」的设置表选 dsh-ssh 主机别名。',
        'auto.storeSkipped': 'automation.json 有 {n} 处不合规内容被跳过',
        'auto.resultTitle': '自动化运行结果：{name}',
        'auto.resultDone': '全部命令成功',
        'auto.resultFailed': '存在失败命令',
        'auto.resultAborted': '已中止（受影响调用的结果不确定）',
        'auto.resultTime': '{start} → {end}',
        'auto.exitCode': '退出码 {code}',
        'auto.duration': '{ms} ms',
        'auto.timedOut': '超时',
        'auto.delete': '删除',
        'auto.delTitle': '删除自动化任务',
        'auto.delBody': '确定删除任务「{name}」？',
        'auto.delKeepsFiles': '命令 .txt 文件不会被删除——它们是共享命令库，可能仍被其他任务引用。',
        'auto.delFailed': '删除失败：{msg}',
        'auto.modeLocal': '本地执行：每行一个工具调用（不套 ssh 壳）',
        'auto.modeRemote': '远程执行：命令文件按序在 machine_id 上跑 shell',
        'auto.oversize': '{n} 行（超 50）——建议把重内容先上传到服务器、再以路径引用',
        'auto.localRun': '本地执行',
        'auto.colStatus': '状态',
        'auto.stEmpty': '空',
        'auto.stRunning': '运行中',
        'auto.stDone': '成功',
        'auto.stFailed': '失败',
        'auto.stAborted': '中止',
        'auto.stHint': '点击查看运行详情',
        'auto.stRunningExt': '其他触发方运行中（如模型 run_automation），结束后可再次运行',
        'auto.relNow': '刚刚',
        'auto.relMin': '{n} 分钟前',
        'auto.relHour': '{n} 小时前',
        'auto.relDay': '{n} 天 {m} 小时前',
        'auto.relDayOnly': '{n} 天前',
        'auto.detailFailed': '加载运行详情失败：{msg}',
        'tasks.storeSkipped': 'sessions.json 有 {n} 处不合规内容被跳过',
        'dash.noReports': '（暂无报告）',
        'dash.addTitle': '添加 HTML 报告',
        'dash.refresh': '刷新报告（强制重载）',
        'dash.remove': '移除当前报告（只解除登记，不删除文件）',
        'dash.add': '添加',
        'dash.refreshShort': '刷新',
        'dash.removeShort': '移除',
        'dash.openSys': '打开',
        'dash.openSysTitle': '在系统默认浏览器中打开报告（本地文件，可离线渲染）',
        'dash.openFailed': '打开失败：{err}',
        'dash.empty': '尚未添加报告 — 浏览本地磁盘加入已有的 HTML 报告。',
        'dash.addFirst': '+ 添加报告',
        'dash.currentDir': '当前目录',
        'dash.parentDir': '上一级',
        'dash.pickFile': '选择 HTML 文件（点击即添加）',
        'dash.emptyDir': '（此目录没有子目录或 HTML 文件）',
        'dash.manualLabel': '或输入报告的绝对路径',
        'dash.manualPlaceholder': '/path/to/report.html',
        'dash.addBadExt': '报告路径必须以 .html 或 .htm 结尾',
        'dash.add': '添加',
        'tasks.headerOpen': '打开 HarnessAMS 侧栏（项目总览与会话面板）',
        'tasks.guideDesc': '项目总览、会话面板、检查与使用引导',
        'check.title': '网表预检参数（本会话）',
        'check.desc': '本会话的检查阈值与开关；确认后随会话保存（sessions.json），spectre_pre_check 与 batch_submit 内置预检读取。',
        'check.sourceOwn': '已确认 — 本会话参数生效中',
        'check.sourceFallback': '未确认 — 按项目缺省（check_params.json）∪内置缺省生效',
        'check.colParam': '参数',
        'check.colValue': '值',
        'check.colNote': '说明',
        'check.rclR': '理想电阻范围 (R)',
        'check.rclC': '理想电容范围 (C)',
        'check.rclL': '理想电感范围 (L)',
        'check.noteR': '数值支持科学计数法与普通小数；下限 < 上限；r=0 视为合法短路',
        'check.noteC': '数值支持科学计数法与普通小数；下限 < 上限',
        'check.noteL': '数值支持科学计数法与普通小数；下限 < 上限',
        'check.multNf': 'nf 指数范围',
        'check.multM': 'm 并联倍数范围',
        'check.noteMult': '正整数；下限 < 上限',
        'check.nfWarn': 'nf 警告阈',
        'check.noteNfWarn': 'nf 达到/超过此值报 warning（不拦截）；正整数',
        'check.unitCheck': '单位检查',
        'check.noteUnit': '几何长度 u/n 后缀与裸数拦截',
        'check.on': '开',
        'check.off': '关',
        'check.oldValue': '（旧值：{v}）',
        'check.confirm': '确认',
        'check.unconfirmedHint': '本会话未确认参数表——预检按缺省表把关；确认后本会话即刻生效',
        'check.loadFailed': '读取检查参数失败：{msg}',
        'check.saveFailed': '保存失败：{msg}',
        'check.badPair': '“{p}”须为正数且下限 < 上限',
        'check.badMultPair': '“{p}”须为正整数且下限 < 上限',
        'check.badNfWarn': '“{p}”须为正整数',
        'pset.title': '项目设置',
        'pset.rootLabel': '远程根路径',
        'pset.selfchkDirLabel': '自检目录',
        'pset.dirLocalHint': '本地模式：自检产物写入本地 .harnessams/selfcheck/ 目录',
        'pset.dirRemoteRel': '相对路径按远端根路径解析',
        'pset.browse': '浏览',
        'pset.browseTitle': '浏览远程根路径',
        'pset.browsePickDir': '目录（点名称进入，或点「选择」使用该目录）',
        'pset.pickDir': '选择',
        'pset.pickThisDir': '使用该目录',
        'pset.pickCurrentDir': '用当前目录',
        'pset.refresh': '刷新',
        'pset.newFolder': '新建文件夹',
        'pset.newFolderName': '文件夹名',
        'pset.newFolderOk': '创建',
        'pset.nameRule': '名称仅接受 ASCII 可打印字符：不能含「/」、不能以「.」开头、不超过 64 字符',
        'pset.ageFmt': '{d}天{h}小时前',
        'pset.colName': '项目名',
        'pset.colValue': '当前值',
        'pset.colMode': '工作模式',
        'pset.colMachine': '远程节点（本次验证用）',
        'pset.unsaved': '不一致',
        'pset.confirmBtn': '确认',
        'pset.confirming': '写入中…',
        'pset.stagedHint': '表格有未确认修改（状态列红色）；「确认」写入 workspace_config.json 并同步 AGENTS.md',
        'pset.envTitle': '工作环境',
        'pset.envIn': '集群内',
        'pset.envOut': '集群外',
        'pset.envHint': '本机是否身处集群共享文件系统；切换需确认',
        'envc.title': '切换工作环境',
        'envc.bodyIn': '切换到「集群内」：本机即集群节点（共享文件系统）——local 本机运行、ssh 到其他节点运行、lsf 本机直接 bsub；文件不再经 ssh 传输。',
        'envc.bodyOut': '切换到「集群外」：远程操作经 dsh-ssh——local 不可用、ssh 在 ssh 节点运行（第二跳走 dsh-ssh 代理配置）、lsf 先 ssh 到集群再 bsub；文件经 ssh 上传/取回。',
        'envc.ok': '确认切换',
        'pset.colSched': '调度器',
        'pset.colSim': '仿真器',
        'pset.colCompLocal': '本地计算',
        'pset.colCompRemote': '远端计算',
        'pset.colFigs': '报告出图',
        'pset.figsWarn': '开启后每次生成报告都会把每张图导出为 PNG 存入 Figs/；持续保存图片会造成较大磁盘占用',
        'pset.maxPoints': '单次扫描最大点数',
        'pset.maxPointsHint': 'batch_submit 拒绝点数超过该值的扫描；留空＝默认 100。超限的大网格应拆成多批（自动 Sim 命名）',
        'pset.mode.local': '本地',
        'pset.mode.remote': '远程',
        'pset.sched.lsf': 'LSF 队列',
        'pset.sched.ssh': 'SSH 运行',
        'pset.sim.spectre': 'spectre',
        'pset.sim.none': 'none（免仿真）',
        'pset.comp.python': 'python',
        'pset.comp.js': 'js（node）',
        'pset.noMachine': '（选择机器）',
        'pset.saveFailed': '保存失败：{msg}',
        'selfchk.desc': '按当前设置全链路验证机器、连接、环境、权限与计算（RC 理想元件 3×3；仿真器 none 用随包 golden 数据免仿真；核验为逐点误差 ≤1%）',
        'selfchk.run': '一键自检',
        'selfchk.running': '自检运行中…',
        'selfchk.stop': '停止自检',
        'selfchk.stopping': '停止中…',
        'selfchk.stopped': '已停止',
        'selfchk.stopFailed': '停止失败：{msg}',
        'selfchk.startFailed': '启动失败：{msg}',
        'selfchk.scopeLocal': '本地链路',
        'selfchk.scopeRemote': '远程链路（{machine}）',
        'selfchk.noneYet': '尚未运行自检。',
        'selfchk.stale': '超过{min}分钟未自检',
        'selfchk.lastRun': '上次自检 {time}',
        'selfchk.skipped': '跳过',
        'selfchk.summaryOk': '自检通过',
        'selfchk.summaryFallback': '通过（经 SSH 运行回退）',
        'selfchk.summaryFail': '自检失败',
        'selfchk.diagDone': '已创建诊断会话 {id} — 请到左侧会话树查看。',
        'selfchk.diagFail': '创建诊断会话失败：{err}',
        'guide.s6t': '仿真进度卡片',
        'guide.s6': '会话里的 batch_poll 调用渲染为专属进度卡片：调用瞬间即显示 0/N 首帧，运行中自动刷新（远程批直读远端进度，本机扫批读本地进度文件；wait_sec 阻塞等待期间全程刷新），并汇总已完成几批、多少个仿真、待完成多少；其余工具调用回退为原始 JSON 显示。不需要时可在控制台页「显示设置」关闭（默认开启）。',
        'set.title': '显示设置',
        'set.toolview': '会话内仿真进度卡片',
        'set.toolviewHint': '关闭后这些工具调用回退为原始 JSON 显示。浏览器本地偏好，对本机所有会话生效。',
        'set.freshTitle': '自检新鲜窗口（分钟）',
        'set.freshHint': '刷新后窗口内的上次自检结果仍显示对勾，超出窗口显示超时提示。插件全局设置（本页可改）。',
        'set.freshErr': '需为 1..1440 的分钟数',
        'card.title.batch_poll': '批量进度',
        'card.preparing': '等待参数…',
        'card.waitProgress': '等待首个进度文件（启动后约 30 秒出现）…',
        'card.remoteUnreachable': '远端暂不可达，保留上次进度…',
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
        'card.label.jobState': '队列状态',
        'card.label.remote': '远端',
        'card.label.remoteDir': '远端目录',
        'card.label.runDir': '运行目录',
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
        'common.close': 'Close',
        'console.title': 'HarnessAMS Console',
        'console.infoFailed': 'info failed: {msg}',
        'console.config': 'Project config = each workspace\'s own .harnessams/workspace_config.json',
        'console.coreTitle': 'Core configuration',
        'console.envScope': 'Applies to project: {project}',
        'console.noActiveSession': 'No active session — open any session to switch the working environment here.',
        'guide.btn': 'Guide',
        'guide.caption': 'First time here? One guided pass over working modes, job submission and reports.',
        'guide.title': 'Get started with HarnessAMS',
        'guide.back': 'Back',
        'guide.done': 'Get started',
        'guide.s1t': 'Working mode: local or remote',
        'guide.s1': 'Local — the spectre loop runs on this machine (SmartAnaSim netlist pre-check + a hand-written run directory + batch_submit local background sweeps + script parsing + report; Spectre must be installed locally). Remote — hosts (aliases and credentials) are configured and managed in the dsh-ssh plugin; each remote root is a per-project setting (the “Remote root” row of the project overview settings table).',
        'guide.s2t': 'Job submission',
        'guide.s2': 'Everything goes through batch_submit, with scheduler semantics set by the working environment (the console page\'s Core-configuration switch): in-cluster — local runs in the background on this host, ssh runs on another node, lsf submits bsub locally (shared filesystem; files never cross ssh); out-of-cluster — local is unavailable, ssh runs on the ssh node (a second hop goes through the dsh-ssh proxy config), lsf submits through dsh-ssh. Monitor and retrieve with batch_poll (a finished batch pulls sweep_progress.json and errlog.txt back automatically).',
        'guide.s2slurm': 'slurm — not supported yet.',
        'guide.s3t': 'Workspace location',
        'guide.s3': 'Config = each workspace\'s own single file .harnessams/workspace_config.json (run settings incl. the remote root, script dir, plotly, trash). Remote — paths are the real remote paths (dsh-ssh goes by alias, no local mirror).',
        'guide.s4t': 'Simulation plugin suites',
        'guide.s4': 'The suite registers 16 tools in total: SmartAnaSim 7 (spectre_pre_check netlist pre-check, the snp_guide/read/extract trio, the gen_vsch_import/export pair and the on-demand post_check data-integrity diagnostic — the two sNp read/extract tools activate on demand via snp_guide; the package also ships the smart-spectre configuration skill and directly runnable worker/parser/diagnostic scripts) and HarnessAMS 9 (batch_submit with its three schedulers and the built-in netlist pre-check, batch_poll monitoring/retrieval, gen_sweep_report, register_report for mounting an existing report, safe_trash incl. the empty purge-all, the harnessams_selfcheck self-check, the automation trio config_automation/run_automation/local_exec over the shared command library and task store — local_exec being the local channel\'s host-command tool, automation-internal). All except the sNp read/extract pair are registered by default — guidance is provided by HarnessAMS only.',
        'guide.s5t': 'Where things live',
        'guide.s5': 'HarnessAMS sidebar “Project overview” — two sub-tabs: “Config & overview” — the project-settings table plus project self-check as the single entry: save to AGENTS.md (one-click project-config table), one-click self-check, list local environment (node/python versions + absolute paths), check all & save; the working directory is picked through the dsh-ssh remote directory browser; and “Automation” — the automation task list (the config_automation tool is the CRUD face, run_automation the agent/debug trigger; the row\'s Run button is the manual trigger — remote tasks execute the referenced .txt sequentially on the project\'s machine_id, local tasks make one tool call per line with no ssh wrapper (host-side commands via the local_exec tool), the run outcome lands in the status column — click the status text for the details dialog; the row\'s trailing Delete removes the entry and keeps the shared .txt files; a fresh project ships one “empty project trash” demo); “Session” — the current session\'s own workspace: “Dashboard”, the report panel (gen_sweep_report registers generated reports into the calling session automatically; existing reports can be browsed in; “Open” launches the report file with the system default browser — plotly and data resolve from relative local paths, offline-capable; a forked session starts from a copy of the previously active session\'s whole config) and “Checks”, the session\'s own check parameters (unconfirmed keys fall back to project defaults ∪ built-in defaults); for an interactive shell use dsh-ssh\'s own SSH terminal panel.',
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
        'assets.notices': 'third-party notices',
        'assets.colPkg': 'Package',
        'assets.colLicense': 'License',
        'assets.colPkgCopy': 'Package copy',
        'tasks.noSession': 'no active session',
        'tasks.loadingProject': 'Loading project…',
        'tasks.noProject': 'No project for this session.',
        'tasks.projectOverview': 'Project overview',
        'tasks.sessionTab': 'Session',
        'tasks.projectLabel': 'Project: ',
        'tasks.viewCheck': 'Checks',
        'tasks.viewDashboard': 'Dashboard',
        'tasks.viewConfig': 'Config & overview',
        'tasks.viewAutomation': 'Automation',
        'auto.colName': 'Task name',
        'auto.colCreated': 'Created',
        'auto.colUpdated': 'Updated',
        'auto.sortHint': 'Click to sort by this column / flip direction',
        'auto.empty': 'No automation yet — add one with the config_automation tool (the configuration can be delegated to the agent).',
        'auto.noDesc': '(no description)',
        'auto.filesLabel': 'Command files (in run order):',
        'auto.noFiles': '(no command files referenced)',
        'auto.run': 'Run',
        'auto.stop': 'Abort',
        'auto.runFailed': 'run failed: {msg}',
        'auto.noMachine': 'machine_id is not configured — pick a dsh-ssh host alias in the Config & overview settings table before running.',
        'auto.storeSkipped': '{n} invalid entries skipped in automation.json',
        'auto.resultTitle': 'Automation result: {name}',
        'auto.resultDone': 'all commands passed',
        'auto.resultFailed': 'some commands failed',
        'auto.resultAborted': 'aborted (the affected call\'s outcome is uncertain)',
        'auto.resultTime': '{start} -> {end}',
        'auto.exitCode': 'exit {code}',
        'auto.duration': '{ms} ms',
        'auto.timedOut': 'timed out',
        'auto.delete': 'Delete',
        'auto.delTitle': 'Delete automation task',
        'auto.delBody': 'Delete the task "{name}"?',
        'auto.delKeepsFiles': 'The command .txt files are NOT deleted — they are the shared library and may still back other tasks.',
        'auto.delFailed': 'delete failed: {msg}',
        'auto.modeLocal': 'Local: one tool call per line (no ssh wrapper)',
        'auto.modeRemote': 'Remote: the command files run as shell on machine_id',
        'auto.oversize': '{n} lines (> 50) — prefer uploading heavy content to the server and referencing it by path',
        'auto.localRun': 'local run',
        'auto.colStatus': 'Status',
        'auto.stEmpty': 'empty',
        'auto.stRunning': 'running',
        'auto.stDone': 'succeeded',
        'auto.stFailed': 'failed',
        'auto.stAborted': 'aborted',
        'auto.stHint': 'Click for run details',
        'auto.stRunningExt': 'Running from another trigger (e.g. the model\'s run_automation); run again after it settles',
        'auto.relNow': 'just now',
        'auto.relMin': '{n} min ago',
        'auto.relHour': '{n} h ago',
        'auto.relDay': '{n}d {m}h ago',
        'auto.relDayOnly': '{n}d ago',
        'auto.detailFailed': 'failed to load run details: {msg}',
        'tasks.storeSkipped': '{n} invalid entries skipped in sessions.json',
        'dash.noReports': '(no reports)',
        'dash.addTitle': 'Add an HTML report',
        'dash.refresh': 'Reload the report (hard reload)',
        'dash.remove': 'Remove the current report (unregisters it; the file is kept)',
        'dash.add': 'Add',
        'dash.refreshShort': 'Refresh',
        'dash.removeShort': 'Remove',
        'dash.openSys': 'Open',
        'dash.openSysTitle': 'Open the report with the system default browser (local file, renders offline)',
        'dash.openFailed': 'Open failed: {err}',
        'dash.empty': 'No report added yet — browse the local disk to add an existing HTML report.',
        'dash.addFirst': '+ Add report',
        'dash.currentDir': 'Current directory',
        'dash.parentDir': 'Parent directory',
        'dash.pickFile': 'Pick an HTML file (click to add it)',
        'dash.emptyDir': '(no subdirectories or HTML files here)',
        'dash.manualLabel': 'Or type the report’s absolute path',
        'dash.manualPlaceholder': '/path/to/report.html',
        'dash.addBadExt': 'the report path must end in .html or .htm',
        'dash.add': 'Add',
        'tasks.headerOpen': 'Open the HarnessAMS sidebar (project overview and session panel)',
        'tasks.guideDesc': 'Project overview, session panel, checks and a guide',
        'check.title': 'Netlist pre-check parameters (this session)',
        'check.desc': 'This session\'s check thresholds and switches; confirming saves them with the session (sessions.json), and spectre_pre_check / the batch_submit built-in pre-check read them.',
        'check.sourceOwn': 'Confirmed — this session\'s table is in effect',
        'check.sourceFallback': 'Not confirmed — project defaults (check_params.json) ∪ built-in defaults are in effect',
        'check.colParam': 'Parameter',
        'check.colValue': 'Value',
        'check.colNote': 'Note',
        'check.rclR': 'Ideal resistor range (R)',
        'check.rclC': 'Ideal capacitor range (C)',
        'check.rclL': 'Ideal inductor range (L)',
        'check.noteR': 'scientific notation and plain decimals both parse; min < max; r=0 reads as the legal short',
        'check.noteC': 'scientific notation and plain decimals both parse; min < max',
        'check.noteL': 'scientific notation and plain decimals both parse; min < max',
        'check.multNf': 'nf finger-count range',
        'check.multM': 'm multiplier range',
        'check.noteMult': 'positive integers; min < max',
        'check.nfWarn': 'nf warning threshold',
        'check.noteNfWarn': 'nf at or above this value warns (never blocks); a positive integer',
        'check.unitCheck': 'Unit checks',
        'check.noteUnit': 'geometry length u/n suffixes and bare-number rejection',
        'check.on': 'On',
        'check.off': 'Off',
        'check.oldValue': ' (old: {v})',
        'check.confirm': 'Confirm',
        'check.unconfirmedHint': 'This session has not confirmed its table — the pre-check runs on the defaults; confirming takes effect for this session immediately',
        'check.loadFailed': 'Failed to load check parameters: {msg}',
        'check.saveFailed': 'Failed to save: {msg}',
        'check.badMultPair': '"{p}" must be two positive integers, min < max',
        'check.badNfWarn': '"{p}" must be a positive integer',
        'check.badPair': '"{p}" must be positive numbers with min < max',
        'pset.title': 'Project settings',
        'pset.rootLabel': 'Remote root',
        'pset.selfchkDirLabel': 'Self-check directory',
        'pset.dirLocalHint': 'local mode: self-check artifacts go under the local .harnessams/selfcheck/ directory',
        'pset.dirRemoteRel': 'relative paths resolve under the remote root',
        'pset.browse': 'Browse',
        'pset.browseTitle': 'Browse the remote root',
        'pset.browsePickDir': 'Directories (click a name to enter, or "Select" to use it)',
        'pset.pickDir': 'Select',
        'pset.pickThisDir': 'Use this directory',
        'pset.pickCurrentDir': 'Use current directory',
        'pset.refresh': 'Refresh',
        'pset.newFolder': 'New folder',
        'pset.newFolderName': 'Folder name',
        'pset.newFolderOk': 'Create',
        'pset.nameRule': 'Name accepts printable ASCII only: no "/", no leading ".", at most 64 chars',
        'pset.ageFmt': '{d}d {h}h ago',
        'pset.colName': 'Item',
        'pset.colValue': 'Value',
        'pset.colMode': 'Mode',
        'pset.colMachine': 'Remote node (this run)',
        'pset.unsaved': 'out of sync',
        'pset.confirmBtn': 'Confirm',
        'pset.confirming': 'Writing…',
        'pset.stagedHint': 'The table has unconfirmed edits (red status cells); "Confirm" writes workspace_config.json and syncs AGENTS.md',
        'pset.envTitle': 'Working environment',
        'pset.envIn': 'in-cluster',
        'pset.envOut': 'out-of-cluster',
        'pset.envHint': 'whether this host sits on the cluster\'s shared filesystem; switching asks first',
        'envc.title': 'Switch working environment',
        'envc.bodyIn': 'Switch to in-cluster: this host is itself a cluster node on the shared filesystem — local runs here, ssh runs on another node, lsf submits bsub locally; files never cross ssh.',
        'envc.bodyOut': 'Switch to out-of-cluster: remote work goes through dsh-ssh — local is unavailable, ssh runs on the ssh node (a second hop goes through the dsh-ssh proxy config), lsf submits through the cluster\'s ssh node; files upload/fetch over ssh.',
        'envc.ok': 'Switch',
        'pset.colSched': 'Scheduler',
        'pset.colSim': 'Simulator',
        'pset.colCompLocal': 'Local compute',
        'pset.colCompRemote': 'Remote compute',
        'pset.colFigs': 'Report figures',
        'pset.figsWarn': 'When on, every generated report exports one PNG per chart into Figs/; continuously saving images causes significant disk usage',
        'pset.maxPoints': 'Max points per scan',
        'pset.maxPointsHint': 'batch_submit rejects scans above this point count; blank = default 100. Split an oversized grid into multiple batches (auto Sim naming)',
        'pset.mode.local': 'local',
        'pset.mode.remote': 'remote',
        'pset.sched.lsf': 'LSF queue',
        'pset.sched.ssh': 'ssh run',
        'pset.sim.spectre': 'spectre',
        'pset.sim.none': 'none (no simulation)',
        'pset.comp.python': 'python',
        'pset.comp.js': 'js (node)',
        'pset.noMachine': '(pick a machine)',
        'pset.saveFailed': 'save failed: {msg}',
        'selfchk.desc': 'Walks the full pipeline under the current settings to verify machine, connection, environment, permissions and compute (ideal RC 3×3; simulator "none" replays bundled golden data without simulation; pointwise tolerance 1%).',
        'selfchk.run': 'Run self-check',
        'selfchk.running': 'Self-check running…',
        'selfchk.stop': 'Stop self-check',
        'selfchk.stopping': 'Stopping…',
        'selfchk.stopped': 'stopped',
        'selfchk.stopFailed': 'failed to stop: {msg}',
        'selfchk.startFailed': 'failed to start: {msg}',
        'selfchk.scopeLocal': 'Local pipeline',
        'selfchk.scopeRemote': 'Remote pipeline ({machine})',
        'selfchk.noneYet': 'No self-check yet.',
        'selfchk.stale': 'not self-checked for > {min} min',
        'selfchk.lastRun': 'last self-check {time}',
        'selfchk.skipped': 'skipped',
        'selfchk.summaryOk': 'self-check passed',
        'selfchk.summaryFallback': 'passed (remote fell back to the ssh run)',
        'selfchk.summaryFail': 'self-check failed',
        'selfchk.diagDone': 'Diagnosis session {id} created — see the session tree.',
        'selfchk.diagFail': 'Failed to create a diagnosis session: {err}',
        'guide.s6t': 'Simulation progress cards',
        'guide.s6': 'batch_poll calls in a conversation render as dedicated progress cards: a 0/N first frame '
          + 'appears the moment the call starts, live refresh while it runs (remote batches read the remote '
          + 'progress, local scheduler="local" sweeps the local progress file; a wait_sec blocking poll refreshes '
          + 'throughout) plus the cross-batch aggregate; every other tool call falls back to the raw JSON view. '
          + 'Toggle it off in the console page display settings (on by default).',
        'set.title': 'Display settings',
        'set.toolview': 'Simulation progress cards in conversations',
        'set.toolviewHint': 'When off, these tool calls fall back to the raw JSON view. Browser-local preference, '
          + 'applies to every session on this machine.',
        'set.freshTitle': 'Self-check freshness window (minutes)',
        'set.freshHint': 'after a reload, a last verdict within the window keeps its check mark; past the window the '
          + 'table flags the timeout. Plugin-global (edited here).',
        'set.freshErr': 'must be 1..1440 minutes',
        'card.title.batch_poll': 'Batch progress',
        'card.preparing': 'Waiting for arguments…',
        'card.waitProgress': 'Waiting for the first progress file (appears ~30 s after start)…',
        'card.remoteUnreachable': 'remote unreachable — showing last known progress…',
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
        'card.label.jobState': 'queue state',
        'card.label.remote': 'remote',
        'card.label.remoteDir': 'Remote dir',
        'card.label.runDir': 'Run dir',
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

    // The browse dialog's refresh glyph (square icon button, spec §8 fixed
    // 16px box): feather's rotate-cw geometry scaled 24→16 and nudged 0.4px
    // in so the 1.5px stroke never clips at the viewBox edge.
    function IconRefresh() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13.26 10A6 6 0 1 1 11.85 3.76L14.93 6.67', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M14.93 2.67V6.67H10.93', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
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
/* fixed-width value inputs (check table) must stay inside their cell too:
   a wrapping flex row still overflows when one item alone is wider than the
   column (narrow panes) — the select rule's twin, same rationale */
.hams-table .hams-input { max-width: 100%; }
/* settings table (1:1:2 columns via <colgroup>; the verdict column is the
   double one): dropdowns fill their cell so every select matches the machine
   row's width instead of shrinking to its own content */
.hams-settable .hams-select { width: 100%; }
.hams-table th, .hams-table td { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 3px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.hams-table th { opacity: .7; font-weight: 500; }
.hams-rowbad td { background: color-mix(in srgb, #e05252 12%, transparent); }
/* state colors: light-dark() pairs — the GitHub dark-theme greens/ambers were
   near-invisible on a light card (2.5:1, live-measured 2026-11-21); the light
   halves are the matching dark-on-white shades (>=4.5:1) */
.hams-good { color: light-dark(#1a7f37, #3fb950); }
.hams-bad { color: light-dark(#cf222e, #e05252); font-weight: 600; }
.hams-warn { color: light-dark(#9a6700, #d29922); }
/* the automation status column's in-flight tone: an activity blue distinct
   from warn (amber) and bad (red); light-dark pair like the three above */
.hams-run { color: light-dark(#0969da, #4493f8); }
/* a finished status cell's clickable text: pointer + underline on hover, so
   the click affordance reads without button chrome */
.hams-statuslink { cursor: pointer; }
.hams-statuslink:hover { text-decoration: underline; }
.hams-faint { opacity: .6; }
.hams-btn { padding: 3px 12px; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); border-radius: 6px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent); color: inherit; }
.hams-btn:disabled { opacity: .45; cursor: default; }
.hams-btn-sm { padding: 0 7px; font-size: calc(12px + var(--dsh-content-font-delta, 0px)); }
/* square single-icon button (the browse dialog's refresh): a fixed-size SVG
   child plus equal 3px padding -> a 22x22 square independent of the font size
   (spec §8 tradeoff — SVG icons keep fixed width/height; two-class selector
   so the padding wins over .hams-btn-sm) */
.hams-btn.hams-iconbtn { display: inline-flex; align-items: center; justify-content: center; padding: 3px; line-height: 0; }
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
.hams-badge-good { color: light-dark(#1a7f37, #3fb950); border-color: color-mix(in srgb, currentColor 45%, transparent); }
.hams-badge-bad { color: light-dark(#9a6700, #d29922); border-color: color-mix(in srgb, currentColor 45%, transparent); }
.hams-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.hams-err { color: #e05252; padding: 8px; font-size: calc(13px + var(--dsh-content-font-delta, 0px)); }
.hams-storewarn { padding: 6px 8px; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
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
.hams-dashtoolbar .hams-select { flex: 0 1 auto; min-width: 80px; max-width: 50%; }
/* tier 3 session option (the report-figures PNG gate): one line above the dashboard */
.hams-sessionopt { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: none; margin: 0 0 2px;
  font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); }
.hams-sessionopt .hams-select { flex: none; width: auto; }
.hams-sessionopt .hams-input { flex: none; width: 6em; }
.hams-sessionopt .hams-dim { overflow-wrap: anywhere; }
.hams-btn { text-decoration: none; }
.hams-dashframe { width: 100%; flex: 1; min-height: 300px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; }
/* fixed 5.5-row viewport (the half row hints at scrollability; row = 1.4 line-height + 3px+3px
   padding) so loading/empty states keep the dialog height stable */
.hams-list { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px;
  height: calc(5.5 * ((12.5px + var(--dsh-content-font-delta, 0px)) * 1.4 + 6px)); overflow: auto;
  display: flex; flex-direction: column; }
.hams-listitem { display: flex; align-items: center; gap: 6px; text-align: left; padding: 3px 8px;
  cursor: pointer; background: none; border: none; color: inherit; line-height: 1.4;
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
.hams-tc-fill { height: 100%; border-radius: 4px; background: light-dark(#1a7f37, #3fb950); transition: width .4s ease; }
.hams-tc-fill.run { background: light-dark(#9a6700, #d29922); }
.hams-tc-fill.bad { background: light-dark(#cf222e, #e05252); }
.hams-tc-agg { margin-top: 4px; font-size: calc(12.5px + var(--dsh-content-font-delta, 0px)); opacity: .85; }
.hams-tc-details { margin-top: 6px; }
/* Console-page settings sections (2026-11-28): the DSH official settings-page
   look — rows of [title + description | control] with .5px hairlines, section
   titles, and the official 36x20 switch. Colors alias the host tokens first
   and fall back to light-dark()/color-mix() pairs (spec §C); the fallback
   literals mirror dsh-client-ui-theme's design-platform.css values. */
.hams-setsec { display: flex; flex-direction: column; margin: 14px 0 0; }
.hams-setsec + .hams-setsec { margin-top: 32px; }
.hams-setsec-title { font-size: calc(14px + var(--dsh-content-font-delta, 0px)); font-weight: 500; margin: 0; }
.hams-setrow { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 15%, transparent)); }
.hams-setrow:last-child { border-bottom: none; }
.hams-setrow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.hams-setrow-title { font-size: calc(14px + var(--dsh-content-font-delta, 0px)); font-weight: 400; line-height: 1.45; }
.hams-setrow-ctl { flex: none; display: inline-flex; align-items: center; gap: 8px; }
/* switch: fixed 36x20 control metric (the spec's fixed-size exemption covers
   controls like the SVG icons — only font sizes are formula-bound).
   corner-shape: the host styles everything as a superellipse(1.5) squircle;
   the official switch overrides it back to superellipse(1) (the classic
   circular arc — fully round ends). Without the override our pill inherits
   the 1.5 squircle and reads as a rounded rectangle next to the official one. */
.hams-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px;
  border: 0; border-radius: 999px; corner-shape: superellipse(1); cursor: pointer;
  background: var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 22%, transparent)); }
.hams-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, light-dark(rgb(15, 17, 21), rgb(249, 250, 251))); }
.hams-switch:disabled { cursor: default; opacity: .5; }
.hams-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, light-dark(rgb(65, 118, 230), rgb(122, 170, 255))); outline-offset: 2px; }
.hams-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: superellipse(1); pointer-events: none;
  background: var(--dsw-alias-switch-thumb, light-dark(rgb(255, 255, 255), rgb(173, 178, 184)));
  transition: transform .12s ease; }
.hams-switch[aria-checked="true"] .hams-switch-thumb { transform: translateX(16px);
  background: var(--dsw-alias-label-primary-foreground, light-dark(rgb(255, 255, 255), rgb(15, 17, 21))); }
/* scoped input restyle (the DSH field look) — only rows inside the settings
   sections take it; the generic .hams-input elsewhere is untouched */
.hams-setrow .hams-input { width: 6em; height: 34px; padding: 0 12px; border-radius: 12px; border-width: .5px;
  border-color: var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 25%, transparent));
  background: var(--dsw-alias-bg-layer-3, color-mix(in srgb, currentColor 4%, transparent)); }
.hams-setrow .hams-input:focus { border-color: var(--dsw-alias-state-business-primary, light-dark(rgb(65, 118, 230), rgb(122, 170, 255))); outline: none; }
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
        h(Boundary, null, h(CoreConfigSection, null)),
        h(Boundary, null, h(DisplaySettingsSection, null)),
        // Digital assets hidden for now (user ruling 2026-11-28): the section
        // stays implemented for a comeback, but the open-asset column is gone
        // from its table. The machines section is fully removed — dsh-ssh's
        // own host panel is the machine list.
        // h(Boundary, null, h(AssetsSection, null)),
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
    // (a typo never renders — the generic card stays). 2026-11-23 scope: cards
    // cover ONLY batch_poll — the single monitoring face of the batch channel
    // (a local scheduler=local submission is polled through the same run
    // directory, so the card covers local scans too); every other call,
    // batch_submit included, stays on the DSH generic card.
    // While the poll call blocks (wait_sec), the card reads /api/progress-remote
    // (the batch's own counters on the remote host, D-004) carrying the call's
    // own callId: in flight the endpoint serves the frames that very tool call
    // publishes (zero exec), settled cards fall back to the endpoint's own
    // poll after an instant local 0/N first frame from the job file — it never
    // shows a dead placeholder. Result cards add the cross-batch aggregate from
    // /api/progress-summary.
    const SIM_CARD_TOOLS = ['batch_poll']

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

    // Normalize a /api/progress-remote payload into the /api/progress prog shape
    // so every card branch renders both sources alike. A no-job-file answer is
    // already local-shaped ({remote:false}); an unreachable answer is passed
    // through untouched (the caller keeps the last frame and raises a note).
    function normRemoteProg(pr) {
      if (!pr || !pr.remote || pr.unreachable) return pr
      const total = Number(pr.total) || 0
      const completed = Number(pr.completed) || 0
      return {
        local: true, remote: true, run_dir: pr.run_dir ?? null, source: 'remote',
        status: pr.state ?? null, job_state: pr.job_state ?? null,
        total, completed,
        succeeded: Number(pr.succeeded) || 0,
        failed: Number(pr.failed) || 0,
        pending: Math.max(total - completed, 0),
        simulator: null,
        compute_node: pr.compute_node ?? null,
        updated_at: pr.updated_at ?? null,
      }
    }

    // Progress data for one card: /api/progress (single run) + /api/progress-summary
    // (cross-batch aggregate); the batch_poll card swaps the single-run source for
    // /api/progress-remote (D-004, the remote batch's live counters) at the 5 s
    // cadence the wait policy prescribes, carrying the card's own callId so an
    // in-flight call is served the tool's published frames (zero exec; a settled
    // call misses and the endpoint polls on its own). While the tool call is in
    // flight (active) poll with the visibility pause/resume discipline shared by
    // the sidebar polls; settled cards fetch once on mount (one fetch per
    // scroll-back remount is fine).
    function useSimProgress({ runDir, projectDir, sessionId, callId, active, remote, intervalMs }) {
      const [data, setData] = useState({ prog: null, agg: null, remoteErr: null })
      useEffect(() => {
        // API already ends with /api — the endpoints hang right off it. sessionId
        // is the workspace-fence key (server: sessionProject mapping + path
        // containment), provided to the card by the slot register
        // inject hook; without it the endpoints answer 400, so skip the fetch.
        if (!sessionId) return
        const enc = encodeURIComponent
        const progUrl = runDir ? API + (remote ? '/progress-remote' : '/progress') + '?runDir=' + enc(runDir) + '&sessionId=' + enc(sessionId) + (remote && callId ? '&callId=' + enc(callId) : '') : null
        // Remote mode also reads the LOCAL progress once per tick: the job-file
        // frame (0/N submitted, no ssh) lands within milliseconds and holds the
        // card until the remote truth arrives ~1–3 s later.
        const localUrl = remote && runDir ? API + '/progress?runDir=' + enc(runDir) + '&sessionId=' + enc(sessionId) : null
        const aggUrl = projectDir ? API + '/progress-summary?projectDir=' + enc(projectDir) + '&sessionId=' + enc(sessionId)
          : runDir ? API + '/progress-summary?runDir=' + enc(runDir) + '&sessionId=' + enc(sessionId) : null
        if (!progUrl && !aggUrl) return
        let alive = true
        let last = ''
        let seq = 0 // out-of-order guard: a slow older response must not clobber a newer one
        let remoteAnswered = false // once remote truth arrived, local frames stop overwriting it
        const commit = (patch) => setData((prev) => {
          const next = { prog: prev.prog, agg: prev.agg, remoteErr: null, ...patch }
          const s = JSON.stringify([next.prog, next.agg, next.remoteErr])
          if (s === last) return prev
          last = s
          return next
        })
        const on = (my, fn) => (v) => { if (alive && my === seq && v != null) fn(v) }
        const fetchOne = () => {
          const my = ++seq
          if (remote) {
            // Three independent chains: instant local frame → aggregate →
            // remote truth (remote wins once it answers; an unreachable remote
            // keeps the last frame plus a dim note — the card never goes blank
            // mid-poll, D-004).
            if (localUrl) fetchJson(localUrl).catch(() => null).then(on(my, (pl) => {
              if (remoteAnswered || pl.unreachable) return
              commit({ prog: normRemoteProg(pl) })
            }))
            if (aggUrl) fetchJson(aggUrl).catch(() => null).then(on(my, (a) => commit({ agg: a })))
            fetchJson(progUrl).catch(() => null).then(on(my, (pr) => {
              remoteAnswered = true
              if (pr.unreachable) commit({ remoteErr: String(pr.error || '').slice(0, 200) })
              else commit({ prog: normRemoteProg(pr), remoteErr: null })
            }))
            return
          }
          Promise.all([
            progUrl ? fetchJson(progUrl).catch(() => null) : Promise.resolve(null),
            aggUrl ? fetchJson(aggUrl).catch(() => null) : Promise.resolve(null),
          ]).then(on(my, ([p, a]) => {
            if (!p && !a) return
            commit({ prog: normRemoteProg(p), agg: a })
          }))
        }
        if (!active) { fetchOne(); return () => { alive = false } }
        const timer = setInterval(() => { if (!document.hidden) fetchOne() }, intervalMs || 3000)
        const onVis = () => { if (!document.hidden) fetchOne() }
        document.addEventListener('visibilitychange', onVis)
        fetchOne()
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [runDir, projectDir, sessionId, callId, active, remote, intervalMs])
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
    // (runDir, projectDir) candidates for the progress endpoints. The carded
    // tool takes run_dir as a required argument, so the start phase can fetch
    // before any result exists.
    function cardRoots(args, data) {
      const a = args || {}
      const r = data || {}
      const runDir = a.run_dir || a.work_dir || a.raw_dir || r.run_dir || null
      const projectDir = a.project_dir || (r.report_dir ? dirName(r.report_dir) : null) || null
      return { runDir: runDir || null, projectDir: projectDir || null }
    }

    function simStatusOf(toolName, phase, result, live) {
      if (phase === 'start') return 'running'
      if (phase !== 'result') return null
      const d = result && result.data
      if (!d) return null
      if (toolName === 'batch_poll') return d.state
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
      // While the tool call blocks (a local sweep, or a batch_poll holding a
      // wait): live bar from the progress source — local file or remote poll,
      // both normalized to the same shape. An unreachable remote keeps the last
      // frame plus a dim note (D-004: a visible card at every moment, never a
      // dead placeholder).
      if (phase === 'start') {
        if (live.remoteErr) els.push(h('div', { key: 'rerr', className: 'hams-dim' }, tr('card.remoteUnreachable')))
        if (p && p.total) {
          els.push(h(CardBar, { key: 'bar', p }), h(CardKv, { key: 'kv', items: [
            p.remote ? { v: tr('card.label.remote'), cls: 'hams-faint' } : null,
            { k: tr('card.label.succeeded'), v: p.succeeded },
            { k: tr('card.label.failed'), v: p.failed },
            { k: tr('card.label.pending'), v: p.pending },
            { k: tr('card.label.jobState'), v: p.job_state },
            { k: tr('card.label.node'), v: p.compute_node },
          ] }))
        } else if (!live.remoteErr) {
          els.push(h('div', { key: 'wait', className: 'hams-dim' }, tr('card.waitProgress')))
        }
        return els
      }
      const d = result && result.data
      if (!d) {
        els.push(h('div', { key: 'raw', className: 'hams-dim' }, '—'))
        return els
      }
      if (toolName === 'batch_poll') {
        if (d.ok === false && d.error) els.push(h('div', { key: 'perr', className: 'hams-bad' }, txt(String(d.error).slice(0, 400))))
        if (d.total) els.push(h(CardBar, { key: 'bar', p: { total: d.total, completed: d.completed, status: d.state } }))
        els.push(h(CardKv, { key: 'kv', items: [
          { k: tr('card.label.succeeded'), v: d.succeeded },
          { k: tr('card.label.failed'), v: d.failed },
          // A failed frame must not count its losses twice: the payload's own
          // pending wins when it carries one (the local poll frames do — a
          // startup death is failed:N/pending:0); the remote payload has none
          // and falls back to total - completed.
          { k: tr('card.label.pending'), v: d.pending ?? (d.total != null ? Math.max((Number(d.total) || 0) - (Number(d.completed) || 0), 0) : null) },
          { k: tr('card.label.jobState'), v: d.job_state },
          { k: tr('card.label.node'), v: d.compute_node },
          { k: tr('card.label.remoteDir'), v: d.remote_dir || d.run_dir },
          { k: tr('card.label.updated'), v: d.updated_at },
        ] }))
        if (Array.isArray(d.points) && d.points.length) {
          els.push(h(ClampText, {
            key: 'pts', className: 'hams-dim',
            text: d.points.map((q) => `${q.index ?? '-'} ${q.status ?? '-'} ${JSON.stringify(q.params ?? {})}`).join('\n'),
          }))
        }
        if (d.errlog_tail) els.push(h(ClampText, { key: 'err', text: String(d.errlog_tail), className: 'hams-warn' }))
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
      const roots = cardRoots(args, result ? result.data : null)
      // batch_poll is the monitoring window: the remote progress source at
      // the 5 s policy cadence, keyed to this very call (the owner's callId
      // serves the tool's own in-flight frames, zero exec; settled calls fall
      // back to the endpoint poll and the instant local 0/N first frame from
      // the job file); a local submission reads the run directory's own files
      // at the same cadence.
      const remote = toolName === 'batch_poll'
      const live = useSimProgress({ runDir: roots.runDir, projectDir: roots.projectDir,
        sessionId: props.sessionId, callId: props.callId, active: phase === 'start', remote, intervalMs: remote ? 5000 : 3000 })
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

    // ---------- tier 1: settings-style sections (DSH official settings look) ----------

    // The official-style switch: a 36x20 role=switch button with a 16px thumb
    // (see ensureCss). Controlled only — the checked state always mirrors the
    // saved value; a flip that needs confirmation opens its dialog and only
    // lands after that dialog commits.
    function SetSwitch({ checked, disabled, onChange, ariaLabel }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false',
        'aria-label': ariaLabel, className: 'hams-switch', disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('span', { className: 'hams-switch-thumb' }))
    }

    // Core configuration (console part 1): the working-environment switch
    // (cluster_env, D-001) migrated from the project overview's settings panel
    // (2026-11-28). A flip opens a confirm dialog first; the write sends ONLY
    // the environment key (D-002: a full base would clobber server-side
    // adoptions with this browser's stale copy), and save_agentsmd re-renders
    // the AGENTS.md workflow for the new environment in the same call. The
    // console page is project-less, so the switch rides the ACTIVE session's
    // project via activeSessionProbe (declared near lastActiveSessionId).
    function CoreConfigSection() {
      const [env, setEnv] = useState(null) // saved cluster_env; null = not loaded yet
      const [projectTitle, setProjectTitle] = useState(null)
      const [envDialog, setEnvDialog] = useState(null) // pending cluster_env switch awaiting its confirm dialog
      const [saveState, setSaveState] = useState(null) // {status:'running'|'failed', error?}
      const [sid, setSid] = useState(() => activeSessionProbe.id)
      const saving = saveState?.status === 'running'

      // follow the active-session probe: the console page owns no session, so
      // the switch's project follows whatever session is active elsewhere in
      // the app (a 1 s cadence module read — cheap, no requests)
      useEffect(() => {
        const timer = setInterval(() => { if (activeSessionProbe.id !== sid) setSid(activeSessionProbe.id) }, 1_000)
        return () => clearInterval(timer)
      }, [sid])

      // reconcile cluster_env + the scope line with the probe's project: full
      // refetch on a session change, 1 s JSON-compare revalidate otherwise
      // (paused while hidden or saving — the same discipline as the project
      // overview's settings poll)
      useEffect(() => {
        let alive = true
        if (!sid) { setEnv(null); setProjectTitle(null); return }
        const load = () => {
          fetchJson(API + '/project-settings?sessionId=' + encodeURIComponent(sid))
            .then((r) => { if (alive) { const v = r?.settings?.cluster_env ?? null; setEnv((prev) => (prev === v ? prev : v)) } })
            .catch(() => { /* keep the last value */ })
          fetchJson(API + '/project?sessionId=' + encodeURIComponent(sid))
            .then((r) => { if (alive) { const t = r?.project?.title || r?.project?.path || null; setProjectTitle((prev) => (prev === t ? prev : t)) } })
            .catch(() => { /* keep the last value */ })
        }
        load()
        const timer = setInterval(() => { if (!document.hidden && !saving) load() }, 1_000)
        return () => { alive = false; clearInterval(timer) }
      }, [sid, saving])

      const commitEnv = async (next) => {
        setEnvDialog(null)
        setSaveState({ status: 'running' })
        try {
          await callToolRoute({ sessionId: sid, action: 'save_agentsmd', lang: effectiveLang(), settings: { cluster_env: next } })
          setEnv(next)
          setSaveState(null)
        } catch (e) {
          setSaveState({ status: 'failed', error: String(e.message ?? e) })
        }
      }

      const inCluster = env === 'in-cluster'
      return h('section', { className: 'hams-setsec' },
        h('h2', { className: 'hams-setsec-title' }, tr('console.coreTitle')),
        !sid && h('div', { className: 'hams-dim' }, tr('console.noActiveSession')),
        sid && h('div', null,
          h('div', { className: 'hams-setrow' },
            h('div', { className: 'hams-setrow-main' },
              h('div', { className: 'hams-setrow-title' }, tr('pset.envTitle')),
              h('div', { className: 'hams-dim' }, tr('pset.envHint'))),
            h('div', { className: 'hams-setrow-ctl' },
              env != null && h('span', { className: 'hams-dim' }, tr(inCluster ? 'pset.envIn' : 'pset.envOut')),
              h(SetSwitch, { checked: inCluster, disabled: env == null || saving, ariaLabel: tr('pset.envTitle'),
                onChange: (next) => { setSaveState(null); setEnvDialog(next ? 'in-cluster' : 'out-of-cluster') } }))),
          projectTitle && h('div', { className: 'hams-dim' }, tr('console.envScope', { project: projectTitle })),
          saveState?.status === 'failed' && h('div', { className: 'hams-err' }, txt(saveState.error ?? '')),
          envDialog && h('div', { className: 'hams-dialog-backdrop', onClick: (e) => { if (e.target === e.currentTarget) setEnvDialog(null) } },
            h('div', { className: 'hams-dialog' },
              h('h3', null, tr('envc.title')),
              h('div', { className: 'hams-dim', style: { margin: '0 0 12px' } },
                txt(tr(envDialog === 'in-cluster' ? 'envc.bodyIn' : 'envc.bodyOut'))),
              h('div', { className: 'hams-row' },
                h('button', { className: 'hams-btn', disabled: saving, onClick: () => void commitEnv(envDialog) },
                  tr('envc.ok')),
                h('button', { className: 'hams-btn', onClick: () => setEnvDialog(null) }, tr('common.cancel')))))),
      )
    }

    // Console-page display settings (console part 2): the toggle backing the
    // tool cards (guide s6 points here; the preference is browser-local by
    // design — see TOOLVIEW_KEY), plus the plugin-global self-check freshness
    // window (D-003: server-truth in ~/.dsh/harnessams.json through PUT
    // /api/global-config — it decides when a restored verdict still shows its
    // check mark vs "not checked for > N min").
    function DisplaySettingsSection() {
      const [on, setOn] = useState(toolviewEnabledRead)
      const [freshMin, setFreshMin] = useState(null)
      const [freshErr, setFreshErr] = useState(null)
      useEffect(() => {
        const sync = () => setOn(toolviewEnabledRead())
        window.addEventListener(TOOLVIEW_EVENT, sync)
        return () => window.removeEventListener(TOOLVIEW_EVENT, sync)
      }, [])
      useEffect(() => {
        fetchJson(API + '/info')
          .then((r) => { if (r?.display?.selfcheck_fresh_min != null) setFreshMin(Number(r.display.selfcheck_fresh_min)) })
          .catch(() => { /* the input stays hidden — no value to edit */ })
      }, [])
      const commitFresh = (v) => {
        const m = Number(v)
        if (!Number.isFinite(m) || m < 1 || m > 1440) { setFreshErr(tr('set.freshErr')); return }
        setFreshErr(null)
        fetchJson(API + '/global-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selfcheck_fresh_min: Math.round(m) }),
        })
          .then(() => setFreshMin(Math.round(m)))
          .catch((e) => setFreshErr(String(e.message ?? e)))
      }
      return h('section', { className: 'hams-setsec' },
        h('h2', { className: 'hams-setsec-title' }, tr('set.title')),
        h('div', { className: 'hams-setrow' },
          h('div', { className: 'hams-setrow-main' },
            h('div', { className: 'hams-setrow-title' }, tr('set.toolview')),
            h('div', { className: 'hams-dim' }, tr('set.toolviewHint'))),
          h(SetSwitch, { checked: on, ariaLabel: tr('set.toolview'),
            onChange: (next) => { toolviewEnabledWrite(next); setOn(next) } })),
        freshMin != null && h('div', { className: 'hams-setrow' },
          h('div', { className: 'hams-setrow-main' },
            h('div', { className: 'hams-setrow-title' }, tr('set.freshTitle')),
            h('div', { className: 'hams-dim' }, tr('set.freshHint'))),
          h('input', { className: 'hams-input', type: 'number', min: 1, max: 1440, value: freshMin,
            onChange: (e) => setFreshMin(e.target.value === '' ? null : Number(e.target.value)),
            onBlur: (e) => { if (e.target.value !== '') commitFresh(e.target.value) } })),
        freshErr && h('div', { className: 'hams-err' }, txt(freshErr)))
    }

    // Digital assets (tier 1): which .js packages the plugin vendors (with their
    // licenses) and the served package copy. Reports are NOT listed here — they
    // live in the task dashboard. Hidden from the console page for now (user
    // ruling 2026-11-28 — dsh-ssh covers host management, the assets card is
    // commented out of ConsolePage); the open-asset column is permanently gone.
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
            [tr('assets.colPkg'), tr('assets.colLicense'), tr('assets.colPkgCopy')].map((c) => h('th', { key: c }, c)))),
          h('tbody', null, assets.packages.map((p) => h('tr', { key: p.file },
            h('td', null, txt(p.file), h('div', { className: 'hams-dim' }, p.label)),
            h('td', null, p.license),
            h('td', null,
              p.pkg
                ? [txt(p.pkg.path), h('div', { className: 'hams-dim' }, fmtBytes(p.pkg.bytes))]
                : h('span', { className: 'hams-warn' }, tr('assets.plotlyMissing')))))),
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

    // The project-overview branch of the same tab carries its own subtab pair
    // (the session branch's pattern): "Project config & overview" holds the
    // settings table + the one-click project self-check, "Automation" is a
    // placeholder for later automation features. Same remount discipline as
    // the session sub-views: module memory + localStorage keep the choice.
    const OVERVIEW_VIEWS = [
      { id: 'config', labelKey: 'tasks.viewConfig' },
      { id: 'automation', labelKey: 'tasks.viewAutomation' },
    ]
    const OVERVIEW_VIEW_KEY = 'hams-overview-view'
    const isValidOverviewView = (v) => OVERVIEW_VIEWS.some((t) => t.id === v)
    let overviewViewMemory = null
    function readOverviewView() {
      if (overviewViewMemory) return overviewViewMemory
      try {
        const v = localStorage.getItem(OVERVIEW_VIEW_KEY)
        if (isValidOverviewView(v)) { overviewViewMemory = v; return v }
      } catch { /* private mode */ }
      return 'config'
    }
    function rememberOverviewView(v) {
      overviewViewMemory = v
      try { localStorage.setItem(OVERVIEW_VIEW_KEY, v) } catch { /* private mode */ }
    }

    // First-level strip + session config state, PER SESSION (decisions.md
    // D-003, 2026-11-19): each DSH session is a work unit carrying its own
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
    const sessionConfigState = new Map() // sessionId -> { display, reports[], dashboard_selected, check_params?, report_figs? }
    const lastActiveSessionId = { id: null }
    // The console page's core-config switch rides the ACTIVE session's project
    // (it is project-less by surface). Kept SEPARATE from lastActiveSessionId:
    // that one is the fork-inheritance source and is stamped only after the
    // sidebar body adopts a session's config (adoption-order semantics, D-003)
    // — this probe may be stamped early and from anywhere without touching
    // fork behavior. Stamped by SessionHeaderButton (always mounted for the
    // active conversation) and the task-sidebar body alike.
    const activeSessionProbe = { id: null }
    const hydratedProjects = new Set() // projectPath values whose sessions.json is already in the map
    const emptySessionConfig = () => ({ display: 'overview', reports: [], dashboard_selected: null })
    function cloneSessionConfig(src) {
      if (!src || typeof src !== 'object') return emptySessionConfig()
      return {
        display: src.display === 'session' ? 'session' : 'overview',
        reports: Array.isArray(src.reports) ? src.reports.map((r) => ({ ...r })) : [],
        dashboard_selected: typeof src.dashboard_selected === 'string' ? src.dashboard_selected : null,
        // the session's report-figures option: stored only while on
        ...(src.report_figs === true ? { report_figs: true } : {}),
        // the session's scan-size ceiling (D-004): stored only while set
        ...(Number.isInteger(src.max_points_per_scan) && src.max_points_per_scan > 0
          ? { max_points_per_scan: src.max_points_per_scan }
          : {}),
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
    // D-003): the last-ACTIVE session of this page lifetime when there is one,
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
    // Merge-PUT the session's entry. Returns a promise resolving true/false
    // (persisted / gave up) with bounded retries: a FORK session may not be in
    // the host's workspace registry yet, so its first PUT can 404 transiently —
    // swallowing that silently used to leave fork-adopted reports unresolvable
    // by /dash until a manual refresh (D-008 fix). Fire-and-forget callers may
    // ignore the promise.
    function putSessionConfig(sessionId, { retries = 4 } = {}) {
      if (!sessionId) return Promise.resolve(false)
      const st = sessionConfigState.get(sessionId) ?? null
      const body = JSON.stringify({ sessionId, state: st ? cloneSessionConfig(st) : null })
      const attempt = (left) => fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then(() => true).catch(() => {
        if (left <= 0) return false // offline/gave up: the in-memory map keeps working
        return new Promise((r) => setTimeout(() => r(attempt(left - 1)), 1000))
      })
      return attempt(retries)
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
    // footer's "use current") writes the ABSOLUTE path into remote_root — the old
    // free-typed text input is retired. Mirrors the add-report dialog's shape.
    // 2026-11-26: each row shows the directory's age (mtime → "{d}d {h}h ago",
    // a dash when the plain-ls fallback produced the listing, absolute local
    // time on hover); the current-dir row ends in a square icon-only refresh
    // button (nonce → refetch, doubles as the retry after an error); and a
    // folder can be created in the listed directory (inline form prefilled
    // with a default name, printable ASCII only — POST /api/remote-browse/mkdir).
    function RemoteDirBrowse({ sessionId, machineId, rootDir, onCancel, onPick }) {
      const [cwd, setCwd] = useState(null) // null = server default (the machine's remote root)
      const [nonce, setNonce] = useState(0) // refresh: bump to refetch the current level
      const [listing, setListing] = useState(null)
      const [error, setError] = useState(null)
      const [mkOpen, setMkOpen] = useState(false) // new-folder inline form visible
      const [mkName, setMkName] = useState('')
      const [mkErr, setMkErr] = useState(null)
      const [mkBusy, setMkBusy] = useState(false)
      const aliveRef = useRef(true) // the dialog can close mid-POST (cancel/pick)
      useEffect(() => () => { aliveRef.current = false }, [])
      useEffect(() => {
        let alive = true
        setError(null); setListing(null)
        setMkOpen(false); setMkErr(null) // every (re)load starts with a closed, clean form
        const q = 'sessionId=' + encodeURIComponent(sessionId)
          + '&machineId=' + encodeURIComponent(machineId)
          + (cwd ? '&dir=' + encodeURIComponent(cwd) : '')
        fetchJson(API + '/remote-browse?' + q)
          .then((r) => { if (alive) setListing(r) })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [sessionId, machineId, cwd, nonce])
      // Same rules as the server's validateDirName (the route stays
      // authoritative — this is just instant feedback)
      const mkInvalid = (n) => !n || n.length > 64 || n.includes('/') || n.startsWith('.') || !/^[\x20-\x7E]+$/.test(n)
      const submitMk = () => {
        if (mkBusy || !listing) return
        const name = mkName.trim()
        if (mkInvalid(name)) { setMkErr(tr('pset.nameRule')); return }
        setMkErr(null); setMkBusy(true)
        fetchJson(API + '/remote-browse/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, machineId, dir: listing.dir, name }),
        }).then(() => {
          if (!aliveRef.current) return
          setMkOpen(false); setMkName(''); setNonce(nonce + 1) // refresh: the new folder appears
        }).catch((e) => {
          if (!aliveRef.current) return
          setMkErr(String(e.message ?? e)) // a server message (English), e.g. "File exists"
        }).finally(() => { if (aliveRef.current) setMkBusy(false) })
      }
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
                txt(listing ? listing.dir : (cwd ?? rootDir ?? '…'))),
              h('button', { className: 'hams-btn hams-btn-sm hams-iconbtn', style: { flexShrink: 0 },
                title: tr('pset.refresh'), disabled: listing === null && error === null,
                onClick: () => setNonce(nonce + 1) }, h(IconRefresh)))),
          h('div', { className: 'hams-field' },
            h('label', null, tr('pset.browsePickDir')),
            mkOpen
              ? h('div', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: '0 0 4px' } },
                  h('input', { className: 'hams-input', value: mkName, autoFocus: true,
                    title: tr('pset.newFolderName'), 'aria-label': tr('pset.newFolderName'),
                    style: { flex: 1, minWidth: 0 },
                    onChange: (e) => setMkName(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') submitMk() } }),
                  h('button', { className: 'hams-btn hams-btn-sm', style: { flexShrink: 0 },
                    disabled: mkBusy, onClick: submitMk }, tr('pset.newFolderOk')),
                  h('button', { className: 'hams-btn hams-btn-sm', style: { flexShrink: 0 },
                    disabled: mkBusy, onClick: () => { setMkOpen(false); setMkErr(null) } }, tr('common.cancel')))
              : h('div', { className: 'hams-row', style: { margin: '0 0 4px' } },
                  h('button', { className: 'hams-btn hams-btn-sm', disabled: !listing,
                    onClick: () => { setMkOpen(true); setMkName('new_folder'); setMkErr(null) } },
                    tr('pset.newFolder'))),
            mkErr && h('div', { className: 'hams-bad' }, txt(mkErr)),
            h('div', { className: 'hams-list' },
              error && h('div', { className: 'hams-err' }, error),
              !error && !listing && h('div', { className: 'hams-dim', style: { padding: '8px' } }, tr('common.loading')),
              listing && !error && h('div', null,
                (listing.entries ?? []).map((e) => h('div', { key: 'd:' + e.name, className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
                  h('button', { className: 'hams-listitem', style: { flex: 1, textAlign: 'left', minWidth: 0 },
                    onClick: () => setCwd(listing.dir + '/' + e.name) },
                    h('span', { className: 'hams-name' }, '📁 ' + txt(e.name)),
                    h('span', { className: 'hams-dim', style: { flexShrink: 0 },
                      title: e.mtime == null ? undefined : fmtLocalTime(new Date(e.mtime * 1000).toISOString()) },
                      e.mtime == null ? '—' : fmtAge(e.mtime))),
                  h('button', { className: 'hams-btn hams-btn-sm', title: tr('pset.pickThisDir'),
                    onClick: () => onPick(listing.dir + '/' + e.name) }, tr('pset.pickDir')))),
                listing.truncated && h('div', { className: 'hams-dim', style: { padding: '4px 8px' } }, tr('chk.truncated')),
                !(listing.entries ?? []).length && h('div', { className: 'hams-dim', style: { padding: '4px 8px' } }, tr('dash.emptyDir'))))),
          h('div', { className: 'hams-row', style: { justifyContent: 'space-between' } },
            h('button', { className: 'hams-btn hams-btn-sm', disabled: !listing, onClick: () => onPick(listing.dir) },
              tr('pset.pickCurrentDir')),
            h('button', { className: 'hams-btn', onClick: onCancel }, tr('common.cancel')))))
    }

    // The browse picker's age column: mtime (epoch seconds) → "{d}d {h}h ago"
    // (future mtimes / clock skew clamp to zero); null mtimes are the caller's
    // dash (the plain-ls fallback listing carries no times).
    function fmtAge(mtime) {
      const diff = Math.max(0, Date.now() / 1000 - mtime)
      return tr('pset.ageFmt', { d: Math.floor(diff / 86400), h: Math.floor((diff % 86400) / 3600) })
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
      // remote_root is NOT a table row anymore: it moved into the merged
      // remote-root line above the table (browse-only — no free-typed paths)
      { id: 'scheduler', labelKey: 'pset.colSched', column: 'scheduler',
        visible: (s) => s.run_mode === 'remote' && s.simulator === 'spectre',
        options: [['lsf', 'pset.sched.lsf'], ['ssh', 'pset.sched.ssh']] },
      { id: 'simulator', labelKey: 'pset.colSim', column: 'simulator',
        options: [['spectre', 'pset.sim.spectre'], ['none', 'pset.sim.none']] },
      { id: 'compute_script_local', labelKey: 'pset.colCompLocal', column: 'compute_local',
        options: [['python', 'pset.comp.python'], ['js', 'pset.comp.js']] },
      { id: 'compute_script_remote', labelKey: 'pset.colCompRemote', column: 'compute_remote',
        visible: (s) => s.run_mode === 'remote',
        options: [['python', 'pset.comp.python'], ['js', 'pset.comp.js']] },
      // NOT rows here, by ruling: the cluster toolchain pins remote_python /
      // remote_spectre_cmd (the agent writes them through harnessams_selfcheck
      // and they are kept in the AGENTS.md yaml — never typed in the table),
      // and the gen_sweep_report PNG gate (a session option, see
      // SessionOptionFigs above the dashboard).
    ]

    // Aggregate one settings column from the run's step stream: any failure →
    // bad, else any warn (e.g. the LSF→ssh fallback) → warn, all-skip → skip.
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

    // Server timestamps are ISO-8601 UTC strings; render them in the SYSTEM
    // timezone (a raw slice would show the UTC wall clock as if it were local).
    function fmtLocalTime(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (!Number.isFinite(d.getTime())) return String(iso)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    // Relative age of a server ISO stamp for the automation list columns:
    // just now / N min / N h / Nd Mh ladder, the absolute stamp riding the
    // cell's title. `nowMs` comes from the list's 60 s tick so the labels
    // stay honest between data refreshes; a future stamp (clock skew) clamps
    // to "just now", an unparseable one falls back to the raw string.
    function fmtRelative(iso, nowMs) {
      if (!iso) return ''
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return String(iso)
      const diff = nowMs - t
      if (diff < 60_000) return tr('auto.relNow')
      const min = Math.floor(diff / 60_000)
      if (min < 60) return tr('auto.relMin', { n: String(min) })
      const hours = Math.floor(min / 60)
      if (hours < 24) return tr('auto.relHour', { n: String(hours) })
      const days = Math.floor(hours / 24)
      const remH = hours % 24
      return remH ? tr('auto.relDay', { n: String(days), m: String(remH) }) : tr('auto.relDayOnly', { n: String(days) })
    }

    // Status restore from the AGENTS.md facts (D-003): when the in-memory run
    // state is gone (page reload, project switch away and back), the panel
    // falls back to the managed block's last_selfcheck_* rows — a verdict
    // finished within the freshness window keeps its check mark, past the
    // window the cells say "not self-checked for > N min", and a null overall
    // (no run ever synced) keeps the plain dash. Per-column verdict mapping:
    // remote-section columns <- last_selfcheck_remote, local-section columns <-
    // last_selfcheck_local, run_mode <- last_selfcheck_overall.
    function restoredCellResult(facts, column, nowMs) {
      if (!facts || facts.last_selfcheck_overall == null) return null
      const finished = facts.last_selfcheck_finished_at
      const finishedMs = finished ? Date.parse(finished) : NaN
      const freshMin = Number(facts.fresh_min) > 0 ? Number(facts.fresh_min) : 30
      const verdictOf = (v) => (v == null ? null
        : String(v).startsWith('ok') ? 'ok' : v === 'failed' ? 'bad' : v === 'skipped' ? 'skip' : 'bad')
      const title = `${facts.last_selfcheck_run_id ?? ''} · ${fmtLocalTime(finished)}`
      if (!Number.isFinite(finishedMs) || nowMs - finishedMs > freshMin * 60_000) {
        return { state: 'stale', text: tr('selfchk.stale', { min: String(freshMin) }), title }
      }
      const which = column === 'machine' || column === 'scheduler' || column === 'compute_remote'
        ? 'last_selfcheck_remote'
        : column === 'simulator' || column === 'compute_local' ? 'last_selfcheck_local' : 'last_selfcheck_overall'
      const verdict = verdictOf(facts[which])
      if (verdict == null) return null
      const text = which === 'last_selfcheck_remote' && facts[which] === 'ok-via-fallback'
        ? tr('selfchk.summaryFallback') : tr(verdict === 'ok' ? 'selfchk.summaryOk' : verdict === 'skip' ? 'selfchk.skipped' : 'selfchk.summaryFail')
      return { state: verdict, text, title }
    }

    // The table edits STAGE into a draft (nothing hits the wire per cell); a
    // row whose staged value differs from the SAVED settings shows a red
    // "out of sync" marker in its own status cell (per-row, not global — the
    // saved verdicts of untouched rows stay visible) until the Confirm button
    // commits the whole object through POST /api/tool.
    function SettingsTable({ draft, settings, machines, run, facts, nowMs, onChange }) {
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
        return h('select', { className: 'hams-select', value: draft[c.id] ?? '',
          onChange: (e) => onChange(c.id, e.target.value) },
          c.options.map(([v, k]) => h('option', { key: v, value: v }, tr(k))))
      }
      const resultCell = (c) => {
        const rowDirty = !!settings
          && JSON.stringify(draft[c.id] ?? null) !== JSON.stringify(settings[c.id] ?? null)
        const agg = selfcheckColumnResult(run, c.column)
          ?? (c.column === 'run_mode' && run?.summary
            ? { state: run.summary.ok ? 'ok' : 'bad', text: tr(run.summary.ok ? 'selfchk.summaryOk' : 'selfchk.summaryFail'), title: '' }
            : null)
          ?? restoredCellResult(facts, c.column, nowMs)
        if (rowDirty) {
          return h('td', { key: c.id, className: 'hams-bad', title: tr('pset.stagedHint') }, '● ' + tr('pset.unsaved'))
        }
        if (!agg) return h('td', { key: c.id, className: 'hams-faint' }, '—')
        const cls = agg.state === 'ok' ? 'hams-good' : agg.state === 'warn' || agg.state === 'stale' ? 'hams-warn' : agg.state === 'skip' ? 'hams-faint' : 'hams-bad'
        const icon = agg.state === 'ok' ? '✅' : agg.state === 'warn' ? '⚠' : agg.state === 'stale' ? '⏱' : agg.state === 'skip' ? '⏭' : '✗'
        return h('td', { key: c.id, className: cls, title: agg.title || agg.text }, icon + ' ' + txt(agg.text))
      }
      return h('table', { className: 'hams-table hams-settable' },
        h('colgroup', null,
          h('col', { key: 'name', style: { width: '25%' } }),
          h('col', { key: 'value', style: { width: '25%' } }),
          h('col', { key: 'status', style: { width: '50%' } })),
        h('thead', null, h('tr', null, [tr('pset.colName'), tr('pset.colValue'), tr('chk.colStatus')]
          .map((c) => h('th', { key: c }, c)))),
        h('tbody', null, cols.map((c) => h('tr', { key: c.id },
          h('td', { key: 'name' }, tr(c.labelKey)),
          h('td', { key: 'value' }, settingCell(c)),
          resultCell(c)))))
    }


    // Step-detail table under the settings table: local/remote section headers +
    // the classic Item/Result/Elapsed/Status rows (skipped steps show ⏭ with the
    // skip reason as the tooltip). With no in-memory run, the AGENTS.md facts
    // supply a compact "last self-check" line instead (D-003 restore display).
    function SelfcheckSteps({ run, facts, nowMs }) {
      if (!run || !(run.steps ?? []).length) {
        const restored = restoredCellResult(facts, 'run_mode', nowMs)
        if (restored) {
          const finished = String(facts?.last_selfcheck_finished_at ?? '')
          const icon = restored.state === 'stale' ? '⏱' : restored.state === 'bad' ? '✗' : '✅'
          const cls = restored.state === 'stale' ? 'hams-warn' : restored.state === 'bad' ? 'hams-bad' : 'hams-dim'
          const freshMin = String(Number(facts?.fresh_min) > 0 ? Number(facts.fresh_min) : 30)
          const text = restored.state === 'stale'
            ? tr('selfchk.stale', { min: freshMin })
            : tr('selfchk.lastRun', { time: fmtLocalTime(finished) }) + ' · ' + restored.text
          return h('div', { className: cls, title: restored.title }, icon + ' ' + txt(text))
        }
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
      const inFlight = s.ms == null && s.ok === undefined && !s.skipReason
      const icon = inFlight ? '⏳' : s.ok === true ? '✅' : s.ok === false ? '✗' : '⏭'
      const cls = inFlight ? 'hams-warn' : s.ok === true ? 'hams-good' : s.ok === false ? 'hams-bad' : 'hams-faint'
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

    // Project initialization on sidebar open (D-002, 2026-11-25): one POST per
    // project path per page load — the server backfills the workspace config,
    // lays the AGENTS.md template, reconciles json <- AGENTS.md, and heals null
    // toolchain pins from the plugin-global node memory (NO script staging and
    // NO sim_scripts_dir flip since D-002 — the package location stays the
    // scripts root). All of it idempotent server-side; the Set only keeps the
    // traffic down (a failed init is not retried).
    const projectInitFired = new Set()
    function ensureProjectInit(projectPath, sessionId) {
      if (!projectPath || projectInitFired.has(projectPath)) return
      projectInitFired.add(projectPath)
      fetchJson(API + '/project-init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => { /* best-effort; the self-check start re-stages */ })
    }

    function ProjectSelfcheck({ sessionId, info, projectPath, facts }) {
      const [settings, setSettings] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.settings : null))
      const [draft, setDraft] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.draft : null))
      const [settingsError, setSettingsError] = useState(null)
      const [run, setRun] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.run : null))
      const [startError, setStartError] = useState(null)
      const [envRun, setEnvRun] = useState(() => (projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.envRun : null))
      const [saveState, setSaveState] = useState(null) // {status:'running'|'done'|'failed', path?, error?}
      const [browseOpen, setBrowseOpen] = useState(false)
      const [checkAllPending, setCheckAllPending] = useState(false) // auto-save once the check-all run lands
      const [stopping, setStopping] = useState(false) // a stop request is in flight / awaiting the status flip
      const machines = info?.machines ?? []
      // Last server settings this panel saw: the adoption baseline — a draft
      // key still equal to it was never user-edited, so it follows the server
      const lastServerRef = useRef(projectPath && selfcheckMemory.path === projectPath ? selfcheckMemory.settings : null)
      const aliveRef = useRef(true)
      useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

      // Reconcile with workspace_config.json: external writes (the tool's
      // settings argument from chat, another session's confirm button) land
      // here. Untouched draft keys adopt the new server value; user-staged
      // keys stay and show their own "out of sync" row.
      const refetchSettings = useCallback(() => {
        if (!sessionId) return
        fetchJson(API + '/project-settings?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!aliveRef.current) return
            const prevServer = lastServerRef.current
            lastServerRef.current = r.settings
            setSettings((prev) => (JSON.stringify(prev) === JSON.stringify(r.settings) ? prev : r.settings))
            setDraft((prev) => {
              if (prev == null) return r.settings
              if (prevServer == null || JSON.stringify(prevServer) === JSON.stringify(r.settings)) return prev
              const next = { ...prev }
              for (const k of Object.keys(r.settings)) {
                if (JSON.stringify(next[k] ?? null) === JSON.stringify(prevServer[k] ?? null)) next[k] = r.settings[k]
              }
              return next
            })
          })
          .catch((e) => {
            if (aliveRef.current && lastServerRef.current == null) setSettingsError(String(e.message ?? e))
          })
      }, [sessionId])

      // Same-project remount (session switch inside one workspace): adopt the
      // module snapshot instead of clearing — the table never flashes blank and
      // a running self-check keeps polling by runId. Different/first project:
      // full reset, same as before.
      useEffect(() => {
        const adopt = !!projectPath && selfcheckMemory.path === projectPath
        if (!adopt) {
          setSettings(null); setDraft(null); setSettingsError(null); setRun(null); setStartError(null); setEnvRun(null)
          lastServerRef.current = null
        }
        if (!sessionId) return
        refetchSettings()
        // No restore fetch here: a global "latest run" surface would bleed
        // verdicts across projects. The table only fills from a run THIS
        // sidebar started (POST then poll by runId) — or the module snapshot.
      }, [sessionId, projectPath, refetchSettings])

      // 1 s settings poll: the table follows tool-side config writes within a
      // second (paused while the tab is hidden — the next visible pass catches
      // up), and every action button refetches on completion as well
      useEffect(() => {
        if (!sessionId) return
        const timer = setInterval(() => { if (!document.hidden) refetchSettings() }, 1_000)
        return () => clearInterval(timer)
      }, [sessionId, refetchSettings])

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

      // a stop request is one-shot: clear it once the status leaves 'running'
      useEffect(() => { if (runStatus !== 'running') setStopping(false) }, [runStatus])

      // restore-display clock (D-003): a page left open must still flip the
      // restored check mark to the "> N min" wording when the freshness window
      // lapses — the 30 s tick only runs while the restore display is live
      const [nowMs, setNowMs] = useState(() => Date.now())
      useEffect(() => {
        if (run != null || !facts || facts.last_selfcheck_overall == null) return
        const timer = setInterval(() => setNowMs(Date.now()), 30_000)
        return () => clearInterval(timer)
      }, [run, facts?.last_selfcheck_overall])

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
      // pending edits ride along on every action (strict UI = config = AGENTS.md).
      // D-002: send only the DIRTY KEYS, not the full draft — a full draft would
      // clobber values the server just adopted from a hand-edited AGENTS.md block
      // (or another writer changed between our last poll and this save) with the
      // stale copies this browser still holds; the server merges partial
      // payloads key by key.
      const pendingSettings = () => {
        if (!dirty || !draft || !settings) return undefined
        const diff = {}
        for (const k of Object.keys(draft)) {
          if (JSON.stringify(draft[k]) !== JSON.stringify(settings[k])) diff[k] = draft[k]
        }
        return Object.keys(diff).length ? diff : undefined
      }

      const commitOk = (r) => {
        if (r && dirty) setSettings({ ...draft })
      }

      const startRun = async () => {
        setStartError(null)
        const settingsArg = pendingSettings()
        try {
          const r = await callToolRoute({ sessionId, action: 'run', lang: effectiveLang(), settings: settingsArg })
          commitOk(r)
          refetchSettings()
          setRun({ id: r.run_id, status: 'running', steps: [], diagnoses: [], scope: null })
        } catch (e) {
          setStartError(tr('selfchk.startFailed', { msg: String(e.message ?? e) }))
          setCheckAllPending(false)
        }
      }

      // stop the running self-check (action=stop deliberately carries NO
      // settings payload — an emergency stop must not commit staged edits)
      const stopRun = async () => {
        setStopping(true)
        try {
          await callToolRoute({ sessionId, action: 'stop', run_id: runId })
        } catch (e) {
          setStartError(tr('selfchk.stopFailed', { msg: String(e.message ?? e) }))
          setStopping(false)
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
          refetchSettings()
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
      const dirPreview = String(draft?.selfcheck_remote_dir ?? '').startsWith('/')
        ? draft.selfcheck_remote_dir
        : (root ? root + '/' + (draft?.selfcheck_remote_dir ?? '') : '$ROOT/' + (draft?.selfcheck_remote_dir ?? ''))
      const running = run?.status === 'running'
      const envRunning = envRun?.status === 'running'
      const saving = saveState?.status === 'running'

      return h('div', { style: { marginTop: '10px' } },
        h('div', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: '0 0 2px' } },
          h('b', { style: { flexShrink: 0 } }, tr('pset.title'))),
        settingsError && h('div', { className: 'hams-err' }, txt(settingsError)),
        !draft && !settingsError && h('div', { className: 'hams-dim' }, tr('common.loading')),
        draft && h('div', null,
          // working environment (cluster_env, D-001): the confirm-gated switch
          // moved to the console page's Core-configuration section (2026-11-28
          // wave 9) — it rides the active session's project there; this panel
          // keeps only the project-scoped settings below.
          // remote root (the working-directory row merged in, 2026-11-21):
          // browse-only — the free-typed root input and the separate
          // working-directory concept are both retired; the dim preview shows
          // where the self-check artifacts resolve (root +
          // selfcheck_remote_dir, default .harnessams/selfcheck)
          h('div', { className: 'hams-row', style: { flexWrap: 'nowrap' } },
            h('b', { style: { flexShrink: 0 } }, tr('pset.rootLabel')),
            remote
              ? h('span', { className: 'hams-dim', title: draft.remote_root || '',
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                txt(draft.remote_root || '—'))
              : h('span', { className: 'hams-dim' }, 'local · ' + tr('pset.dirLocalHint')),
            remote && h('button', { className: 'hams-btn hams-btn-sm', style: { flexShrink: 0 },
              disabled: !machine, title: tr('pset.browseTitle'),
              onClick: () => setBrowseOpen(true) }, tr('pset.browse'))),
          remote && h('div', { className: 'hams-dim', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 0 4px' } },
            tr('pset.selfchkDirLabel') + ': ', txt(dirPreview), ' · ', tr('pset.dirRemoteRel')),
          h(SettingsTable, { draft, settings, machines, run, facts, nowMs, onChange: updateSetting }),
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
            running && h('button', { className: 'hams-btn hams-btn-sm', disabled: stopping || !sessionId,
              onClick: () => void stopRun() },
              stopping ? tr('selfchk.stopping') : tr('selfchk.stop')),
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
          browseOpen && remote && machine && h(RemoteDirBrowse, {
            sessionId, machineId: machine.id, rootDir: root || null,
            onCancel: () => setBrowseOpen(false),
            onPick: (dir) => { setBrowseOpen(false); if (dir && dir !== draft.remote_root) updateSetting('remote_root', dir) },
          }),
          h(SelfcheckSteps, { run, facts, nowMs }),
          run?.summary && h('div', { className: 'hams-row' },
            run.status === 'cancelled'
              ? h('span', { className: 'hams-warn', style: { fontWeight: 600 } }, tr('selfchk.stopped'))
              : h('span', { className: run.summary.ok ? 'hams-good' : 'hams-bad', style: { fontWeight: 600 } },
                tr(run.summary.ok ? (run.summary.fallback ? 'selfchk.summaryFallback' : 'selfchk.summaryOk') : 'selfchk.summaryFail'))),
          (run?.diagnoses ?? []).map((d, i) => h('div', { key: i, className: d.status === 'done' ? 'hams-dim' : 'hams-err' },
            d.status === 'done' ? tr('selfchk.diagDone', { id: d.sessionId ?? '' }) : tr('selfchk.diagFail', { err: d.error ?? '' })))))
    }

    // ---------- tier 3: the Automation sub-tab list ----------
    // The phase-2 automation surface: the project's automation.json tasks,
    // sortable per column, click-to-expand detail rows (description, the
    // execution mode, one .txt reference per line — the shared command
    // library, with the oversize hint when a file runs long), the left run
    // button that flips to Abort while its POST is in flight, and the right
    // delete button behind a confirm dialog (the entry goes, the shared
    // command files stay). The run is the MANUAL, agent-free trigger: POST
    // /api/automation/run executes the registered commands per the task's
    // mode — remote shell on the project's machine_id, or local tool calls
    // without the ssh wrapper. The outcome lands in the STATUS column: the
    // server keeps each task's last run in PROCESS memory (last_run rides
    // the list poll — running/succeeded/failed/aborted, "empty" before the
    // first run of this process) and NO dialog auto-opens after a run —
    // clicking a FINISHED status fetches the full payload from
    // /api/automation/result into the dialog. The two time columns are
    // RELATIVE (just now / N min / N h / Nd Mh; absolute stamp on the cell
    // title, a 60 s tick keeps the labels honest). A plain flowing table: no
    // scroll container of its own (the parent .hams-body scrolls however
    // tall the list grows), width stays inside the pane.
    const AUTOMATION_COLS = [
      { id: 'name', labelKey: 'auto.colName' },
      { id: 'created_at', labelKey: 'auto.colCreated' },
      { id: 'updated_at', labelKey: 'auto.colUpdated' },
    ]

    // The status column's icon per last_run.status (null = never ran in this
    // process -> the dim empty mark).
    const AUTO_STATUS_ICONS = { running: '⟳', done: '✓', failed: '✗', aborted: '■' }

    function AutomationList({ sessionId, projectPath }) {
      const [list, setList] = useState(null) // null = loading; { automations, warnings, machine_id }
      const [loadErr, setLoadErr] = useState(null)
      const [error, setError] = useState(null) // run/delete failure line
      const [sort, setSort] = useState({ field: 'created_at', dir: 'desc' })
      const [expanded, setExpanded] = useState(null) // key of the expanded row
      const [running, setRunning] = useState({}) // key -> true while its OWN run POST is in flight
      const [result, setResult] = useState(null) // the detail dialog's payload (fetched on a status click)
      const [now, setNow] = useState(Date.now()) // relative-time tick so "N min ago" labels stay honest
      const [confirmDel, setConfirmDel] = useState(null) // entry pending its delete confirm
      const [deleting, setDeleting] = useState(false) // a delete POST is in flight
      const runRefs = useRef({}) // key -> AbortController of the in-flight run

      const refetch = useCallback(() => {
        if (!sessionId) return Promise.resolve()
        return fetchJson(API + '/automation?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            setList((prev) => (JSON.stringify(prev) === JSON.stringify(r) ? prev : r))
            setLoadErr(null)
          })
          .catch((e) => { setLoadErr(String(e.message ?? e)) })
      }, [sessionId])

      // list poll (config edits land through the agent's config_automation —
      // an external write this view must follow): 5 s while visible, catch-up
      // on return, JSON-compare swap to avoid re-render churn
      useEffect(() => {
        if (!sessionId || !projectPath) return
        const timer = setInterval(() => { if (!document.hidden) void refetch() }, 5_000)
        const onVisible = () => { if (!document.hidden) void refetch() }
        document.addEventListener('visibilitychange', onVisible)
        void refetch()
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [sessionId, projectPath, refetch])

      // relative-time tick: the list only re-renders when the polled JSON
      // changes, so the "N min/h/d ago" labels would freeze between data
      // changes — this 60 s tick refreshes them (skipped while hidden, like
      // the poll)
      useEffect(() => {
        const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 60_000)
        return () => { clearInterval(timer) }
      }, [])

      // The run button's two lives: idle -> POST the run (optimistic running
      // row); in flight -> Abort (the fetch's AbortController — the server
      // aborts the channel best-effort and the remote command may orphan).
      // The run's outcome NEVER auto-opens the dialog: it lands in the
      // server's process-memory record and shows up as last_run on the next
      // refetch (immediately — the .then refetches).
      const startRun = (a) => {
        const ac = new AbortController()
        runRefs.current[a.key] = ac
        setRunning((prev) => ({ ...prev, [a.key]: true }))
        setError(null)
        fetchJson(API + '/automation/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, key: a.key }),
          signal: ac.signal,
        })
          .then(() => { void refetch() })
          .catch((e) => {
            // a user abort is silent (the row just returns to idle); real
            // failures show inline
            if (!ac.signal.aborted) setError(txt(tr('auto.runFailed', { msg: String(e.message ?? e) })))
          })
          .finally(() => {
            delete runRefs.current[a.key]
            setRunning((prev) => { const n = { ...prev }; delete n[a.key]; return n })
          })
      }

      // A finished status's click: fetch the run's full payload from the
      // process-memory record and open it in the detail dialog — the on-
      // demand replacement for the old post-run auto-popup.
      const openResult = (a) => {
        setError(null)
        fetchJson(API + '/automation/result?sessionId=' + encodeURIComponent(sessionId)
          + '&key=' + encodeURIComponent(a.key))
          .then((r) => setResult(r.result ?? r))
          .catch((e) => setError(txt(tr('auto.detailFailed', { msg: String(e.message ?? e) }))))
      }

      // One status cell: icon + label per the task's memory status; the
      // FINISHED states (done/failed/aborted) are the click targets for the
      // detail dialog, running/empty are plain text.
      const statusCell = (a) => {
        const st = running[a.key] || a.last_run?.status === 'running'
          ? 'running'
          : (a.last_run?.status ?? null)
        if (st === 'running') return h('span', { className: 'hams-run' }, AUTO_STATUS_ICONS.running + ' ' + tr('auto.stRunning'))
        if (st === 'done' || st === 'failed' || st === 'aborted') {
          const cls = st === 'done' ? 'hams-good' : st === 'aborted' ? 'hams-warn' : 'hams-bad'
          return h('span', {
            className: cls + ' hams-statuslink',
            title: tr('auto.stHint'),
            onClick: (e) => { e.stopPropagation(); openResult(a) },
          }, AUTO_STATUS_ICONS[st] + ' ' + tr(st === 'done' ? 'auto.stDone' : st === 'aborted' ? 'auto.stAborted' : 'auto.stFailed'))
        }
        if (st != null) return h('span', { className: 'hams-dim' }, String(st))
        return h('span', { className: 'hams-dim' }, '○ ' + tr('auto.stEmpty'))
      }

      // The delete flow: the row's delete button only OPENS the confirm
      // dialog; the confirmed POST removes the task entry (the shared command
      // files stay — the server's deleteAutomation contract) and the list
      // refetches.
      const commitDelete = () => {
        const a = confirmDel
        if (!a) return
        setDeleting(true)
        setError(null)
        fetchJson(API + '/automation/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, key: a.key }),
        })
          .then(() => { setConfirmDel(null); void refetch() })
          .catch((e) => setError(txt(tr('auto.delFailed', { msg: String(e.message ?? e) }))))
          .finally(() => setDeleting(false))
      }

      const rows = [...(list?.automations ?? [])].sort((a, b) => {
        const mul = sort.dir === 'asc' ? 1 : -1
        if (sort.field === 'name') return mul * String(a.name ?? '').localeCompare(String(b.name ?? ''))
        const av = String(a[sort.field] ?? '')
        const bv = String(b[sort.field] ?? '')
        return mul * (av < bv ? -1 : av > bv ? 1 : 0) // ISO stamps sort chronologically as strings
      })

      if (!sessionId || !projectPath) return null
      return h('div', null,
        loadErr && h('div', { className: 'hams-err' }, txt(loadErr)),
        list?.warnings?.length > 0 && h('div', { className: 'hams-warn hams-storewarn' },
          txt(tr('auto.storeSkipped', { n: list.warnings.length })),
          h(ClampText, { text: list.warnings.join('\n') })),
        list?.machine_id == null && (list?.automations ?? []).some((a) => (a.mode ?? 'remote') !== 'local')
          && h('div', { className: 'hams-dim', style: { margin: '4px 0' } }, tr('auto.noMachine')),
        error && h('div', { className: 'hams-err' }, txt(error)),
        list === null && !loadErr && h('div', { className: 'hams-dim' }, tr('common.loading')),
        list !== null && h('table', { className: 'hams-table', style: { margin: '0 0 8px' } },
          h('thead', null, h('tr', null,
            h('th', { style: { width: '58px' } }, ''),
            AUTOMATION_COLS.map((c) => h('th', {
              key: c.id,
              onClick: () => setSort((prev) => (prev.field === c.id
                ? { field: c.id, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : { field: c.id, dir: 'asc' })),
              title: tr('auto.sortHint'),
            }, tr(c.labelKey) + (sort.field === c.id ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''))),
            h('th', null, tr('auto.colStatus')),
            h('th', { style: { width: '58px' } }, ''))),
          h('tbody', null,
            rows.length === 0 && h('tr', null, h('td', { colSpan: 6, className: 'hams-dim' }, tr('auto.empty'))),
            rows.flatMap((a) => {
              const isRunning = !!running[a.key]
              // a run reported by the server but not started from THIS tab
              // (the model's run_automation, or a page reload mid-run): the
              // row shows running, the button stays disabled — there is no
              // local AbortController to stop it with
              const serverRunning = a.last_run?.status === 'running'
              return [
                h('tr', {
                  key: a.key,
                  onClick: () => setExpanded((prev) => (prev === a.key ? null : a.key)),
                },
                  h('td', null,
                    h('button', {
                      className: 'hams-btn hams-btn-sm',
                      disabled: serverRunning && !isRunning,
                      title: serverRunning && !isRunning ? tr('auto.stRunningExt') : undefined,
                      onClick: (e) => {
                        e.stopPropagation() // the row click toggles the detail; the button acts
                        if (isRunning) runRefs.current[a.key]?.abort()
                        else if (!serverRunning) startRun(a)
                      },
                    }, tr(isRunning ? 'auto.stop' : 'auto.run'))),
                  h('td', null, txt(a.name)),
                  h('td', { className: 'hams-dim', title: fmtLocalTime(a.created_at) }, fmtRelative(a.created_at, now)),
                  h('td', { className: 'hams-dim', title: fmtLocalTime(a.updated_at) }, fmtRelative(a.updated_at, now)),
                  h('td', null, statusCell(a)),
                  h('td', null,
                    h('button', {
                      className: 'hams-btn hams-btn-sm',
                      disabled: deleting,
                      title: tr('auto.delete'),
                      onClick: (e) => {
                        e.stopPropagation()
                        setConfirmDel(a)
                      },
                    }, tr('auto.delete')))),
                expanded === a.key && h('tr', { key: a.key + ':detail' },
                  h('td', { colSpan: 6 },
                    h('div', { className: 'hams-dim' }, txt(a.description || tr('auto.noDesc'))),
                    h('div', { className: 'hams-dim', style: { margin: '4px 0 0' } },
                      tr(a.mode === 'local' ? 'auto.modeLocal' : 'auto.modeRemote')),
                    h('div', { className: 'hams-dim', style: { margin: '4px 0 0' } },
                      h('span', { style: { fontWeight: 600 } }, tr('auto.filesLabel')),
                      (a.files ?? []).length === 0 && txt(tr('auto.noFiles')),
                      (a.files ?? []).map((f) => h('div', { key: f.file },
                        txt(f.file),
                        f.oversize && h('span', { className: 'hams-warn' },
                          ' ' + tr('auto.oversize', { n: f.lines }))))))),
              ]
            }))),
        result && h('div', {
          className: 'hams-dialog-backdrop',
          onClick: (e) => { if (e.target === e.currentTarget) setResult(null) },
        },
          h('div', { className: 'hams-dialog hams-browse-dialog' },
            h('h3', null, tr('auto.resultTitle', { name: result.name })),
            h('div', {
              className: result.status === 'done' ? 'hams-good' : result.status === 'aborted' ? 'hams-warn' : 'hams-bad',
              style: { fontWeight: 600 },
            }, tr(result.status === 'done' ? 'auto.resultDone'
              : result.status === 'aborted' ? 'auto.resultAborted' : 'auto.resultFailed')
              + ' — ' + txt(result.mode === 'local' ? tr('auto.localRun') : (result.machine ?? ''))),
            h('div', { className: 'hams-dim' },
              tr('auto.resultTime', { start: fmtLocalTime(result.started_at), end: fmtLocalTime(result.finished_at) })),
            h('div', { className: 'hams-field' },
              (result.results ?? []).map((r, i) => h('div', { key: (r.file ?? '') + ':' + (r.line ?? i), style: { margin: '6px 0' } },
                h('div', null,
                  h('b', null, txt(r.file)), ' ',
                  r.tool && txt('· ' + r.tool + ' '), ' ',
                  h('span', { className: r.ok ? 'hams-good' : 'hams-bad' }, r.ok ? '✓' : '✗'),
                  r.timedOut && txt(' ' + tr('auto.timedOut')),
                  r.exitCode != null && txt(' ' + tr('auto.exitCode', { code: r.exitCode })),
                  r.duration_ms != null && txt(' · ' + tr('auto.duration', { ms: r.duration_ms })),
                  r.oversize && h('span', { className: 'hams-warn' }, ' ' + tr('auto.oversize', { n: r.lines }))),
                (r.text || r.stdout || r.stderr || r.error) && h(ClampText, {
                  text: [r.error, r.text, r.stdout, r.stderr ? '[stderr]\n' + r.stderr : ''].filter(Boolean).join('\n'),
                })))),
            h('div', { className: 'hams-row', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'hams-btn', onClick: () => setResult(null) }, tr('common.close'))))),
        confirmDel && h('div', {
          className: 'hams-dialog-backdrop',
          onClick: (e) => { if (e.target === e.currentTarget && !deleting) setConfirmDel(null) },
        },
          h('div', { className: 'hams-dialog' },
            h('h3', null, tr('auto.delTitle')),
            h('div', null, txt(tr('auto.delBody', { name: confirmDel.name }))),
            h('div', { className: 'hams-dim', style: { margin: '6px 0 0' } }, tr('auto.delKeepsFiles')),
            h('div', { className: 'hams-row', style: { justifyContent: 'flex-end', margin: '10px 0 0' } },
              h('button', { className: 'hams-btn hams-bad', disabled: deleting, onClick: commitDelete },
                tr('auto.delete')),
              h('button', { className: 'hams-btn', disabled: deleting, onClick: () => setConfirmDel(null) },
                tr('common.cancel'))))),
      )
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
      const [view, setView] = useState(readOverviewView)
      const projectPath = project?.path ?? null

      useEffect(() => {
        let alive = true
        if (!sessionId) { setProject(null); setReason(tr('tasks.noSession')); return }
        fetchJson(API + '/project?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return
            // the facts ride the route as a SIBLING of project (the server's
            // contract, see index.js /api/project + the selfcheck tests) —
            // fold them onto the project object here, the cached shape the
            // restore display reads (D-003)
            const projectInfo = r?.project ? { ...r.project, selfcheck_facts: r.selfcheck_facts ?? null } : null
            if (!projectInfo || projectInfo.path !== overviewMemory.path) {
              // different (or first) project: drop the cached surfaces so the
              // checks effect below refetches for the new workspace
              overviewMemory.path = projectInfo?.path ?? null
              overviewMemory.project = null
              overviewMemory.checksInfo = null
              setChecksInfo(null)
            }
            setProject(projectInfo)
            setReason(projectInfo ? null : r.reason ?? null)
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
      // Sub navigation rides the same flowing column (the session branch's
      // subtab strip): "config & overview" keeps the settings table + project
      // self-check below the project line, "automation" is the placeholder.
      return h('div', { style: { flex: 'none', fontSize: 'var(--dsh-content-font-size, 14px)' } },
        project === undefined && h('div', { className: 'hams-dim' }, tr('tasks.loadingProject')),
        project === null && h('div', { className: 'hams-dim' }, tr('tasks.noProject'), h('br'), null, txt(reason ?? '')),
        project && h('div', { className: 'hams-dim' },
          tr('tasks.projectLabel'), h('b', null, txt(project.title || project.path)), h('br'), null, txt(project.path)),
        project && h('div', { className: 'hams-subtabs', role: 'tablist', style: { margin: '8px 0 0' } },
          OVERVIEW_VIEWS.map((v) => h('button', {
            key: v.id,
            className: 'hams-subtab' + (view === v.id ? ' active' : ''),
            role: 'tab',
            'aria-selected': view === v.id,
            onClick: () => { rememberOverviewView(v.id); setView(v.id) },
          }, tr(v.labelKey)))),
        project && view === 'config' && sessionId && h(ProjectSelfcheck, { sessionId, info: checksInfo, projectPath, facts: project.selfcheck_facts ?? null }),
        project && view === 'automation' && h(AutomationList, { sessionId, projectPath }),
      )
    }

    // D-003 store read warnings: entries sessions.json skipped as invalid —
    // surfaced by every session-config GET and rendered as one notice line
    // inside the session branch (both sub-views). Server strings, English.
    const storeWarningsOf = (d) => (Array.isArray(d?.warnings) ? d.warnings.filter((w) => typeof w === 'string' && w) : [])
    const sameWarnings = (a, b) => a.length === b.length && a.every((w, i) => w === b[i])

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
      // store-level skip notices (D-003), captured from the session-config GETs
      const [storeWarnings, setStoreWarnings] = useState([])

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
      // config (branch-point-independent by design, D-003); otherwise start
      // empty. Either way the entry is persisted right away — the write doubles
      // as the tombstone that stops fork re-detection. After the adopt, this
      // session becomes the "previously active" for the next first-seen one.
      useEffect(() => {
        let alive = true
        if (!sessionId) { setConfig(emptySessionConfig()); setStoreWarnings([]); return }
        const adoptWith = async (fork, sessionsMap) => {
          const first = !sessionConfigState.has(sessionId)
          const source = first ? forkCopySource(sessionsMap, sessionId) : null
          let adopted = cloneSessionConfig(sessionConfigOf(sessionId, fork, source))
          if (first) {
            // D-008 fork-404 fix: an adopted config that selects a report mounts
            // the dashboard iframe the moment setConfig lands — the PUT that
            // persists this session's entry must reach sessions.json BEFORE
            // that mount, or /dash/<sid>/<rid> answers the not-found error
            // until a manual refresh. A failed persist still adopts
            // (fail-open; that degraded state is exactly the old behavior).
            // Tombstone race (2026-11-26): the second writer (gen_sweep_report)
            // may have created this entry between the hydrate GET and this PUT —
            // re-check the server first; if the entry is already there, adopt IT
            // (the entry-on-disk precondition of D-008 already holds) instead of
            // tombstoning a fresh entry over the injected report.
            const again = await fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId)).catch(() => null)
            const serverEntry = again?.sessions?.[sessionId]
            if (serverEntry && typeof serverEntry === 'object') {
              adopted = cloneSessionConfig(serverEntry)
              sessionConfigState.set(sessionId, adopted)
            } else {
              await putSessionConfig(sessionId)
            }
          }
          if (!alive) return
          setConfig(adopted)
          lastActiveSessionId.id = sessionId
          activeSessionProbe.id = sessionId
        }
        if (sessionConfigState.has(sessionId)) { adoptWith(false); return () => { alive = false } }
        fetchJson(API + '/session-config?sessionId=' + encodeURIComponent(sessionId))
          .then((d) => {
            if (!alive) return
            hydratedProjects.add(projectPath)
            const ws = storeWarningsOf(d)
            setStoreWarnings((prev) => (sameWarnings(prev, ws) ? prev : ws))
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
      // event-handler mutator: optimistic local flip for instant UI; the PUT
      // rides the REBASED persist channel below (persistConfig) — this channel
      // used to PUT the closure snapshot unrebased, so a tab-pill click from a
      // sidebar whose snapshot predated a gen_sweep_report registration wiped
      // the injected report (write-channel unification, 2026-11-26). fn must
      // stay idempotent: it is applied once to the optimistic snapshot and
      // once to the fresh server base inside persistConfig (both current
      // mutators are display flips).
      const mutateConfig = (fn) => {
        const next = cloneSessionConfig(config)
        fn(next)
        if (sessionId) sessionConfigState.set(sessionId, next)
        setConfig(next)
        void persistConfig((base) => { fn(base); return base })
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
              if (r?.project) {
                lastProjectInfo.initialized = !!r.project.initialized
                // sidebar open = the project-initialization moment (D-002)
                ensureProjectInit(r.project.path, sessionId)
              }
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
      // gen_sweep_report appends to the calling session's entry behind
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
              const ws = storeWarningsOf(d)
              setStoreWarnings((prev) => (sameWarnings(prev, ws) ? prev : ws))
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
      // (gen_sweep_report's registration writes this session's entry behind
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
            // store-level read notices (D-003): invalid entries skipped while
            // reading sessions.json — one warn line on top of the session
            // branch, visible from both sub-views; the detail is server-side
            // English text folded by ClampText.
            storeWarnings.length > 0 && h('div', { className: 'hams-warn hams-storewarn' },
              txt(tr('tasks.storeSkipped', { n: storeWarnings.length })),
              h(ClampText, { text: storeWarnings.join('\n') })),
            view === 'dashboard' && h(SessionOptionFigs, { config, updateConfig }),
            view === 'dashboard' && h(SessionOptionMaxPoints, { config, updateConfig }),
            view === 'dashboard' && h(SessionDashboard, { sessionId, config, updateConfig }),
            view === 'check' && h(CheckParams, { sessionId, updateConfig }))),
      )
    }

    // The dashboard iframe embeds the report 1:1 — deliberately NO injection
    // into the embedded document. The previous body padding/zoom pass skewed
    // apparent curve weight and marker visibility, risked breaking Plotly
    // pointer hit-testing, and made the embed diverge from the standalone
    // file; the ↗ open-in-tab link and a direct file open now all render
    // identically.

    // A controlled <select> snaps back to its rendered value the moment the
    // change event ends, and persistConfig applies its mutator only after an
    // await (the rebase GET): reading e.target.value inside that mutator
    // returns the OLD value, so the choice never landed — the dashboard
    // dropdown could not switch away from the newest report. Capture the
    // value synchronously, then hand it on.
    const captureValue = (apply) => (e) => { const value = e.target.value; return apply(value) }

    // Session option, one line ABOVE the dashboard: the gen_sweep_report PNG
    // export gate. It belongs to the session, not to the project settings —
    // it rides beside the reports it applies to — is off unless this session
    // turned it on, and writes through the same rebased persist channel as
    // the dashboard edits (gen_sweep_report reads it at execute time).
    function SessionOptionFigs({ config, updateConfig }) {
      return h('div', { className: 'hams-sessionopt' },
        h('label', { className: 'hams-optlabel', title: tr('pset.figsWarn') }, tr('pset.colFigs')),
        h('select', {
            className: 'hams-select',
            value: config.report_figs === true ? '1' : '0',
            title: tr('pset.figsWarn'),
            onChange: captureValue((on) => void updateConfig((c) => ({ ...c, report_figs: on === '1' }))),
          },
          h('option', { value: '1' }, tr('check.on')),
          h('option', { value: '0' }, tr('check.off'))),
        h('span', { className: 'hams-dim' }, tr('pset.figsWarn')))
    }

    // Session option, second strip line: the scan-size ceiling batch_submit
    // enforces (D-004). Positive integer commits immediately; blank clears
    // the field back to the built-in default (100). Uncontrolled on purpose —
    // the same capture-before-await discipline as the select above (an
    // invalid draft simply never lands in the store).
    function SessionOptionMaxPoints({ config, updateConfig }) {
      return h('div', { className: 'hams-sessionopt' },
        h('label', { className: 'hams-optlabel', title: tr('pset.maxPointsHint') }, tr('pset.maxPoints')),
        h('input', {
          className: 'hams-input',
          type: 'number',
          min: '1',
          step: '1',
          defaultValue: config.max_points_per_scan ?? '',
          title: tr('pset.maxPointsHint'),
          onChange: captureValue((raw) => {
            const text = String(raw ?? '').trim()
            if (text === '') {
              void updateConfig((c) => ({ ...c, max_points_per_scan: undefined }))
              return
            }
            const n = Number(text)
            if (Number.isInteger(n) && n > 0) {
              void updateConfig((c) => ({ ...c, max_points_per_scan: n }))
            }
          }),
        }),
        h('span', { className: 'hams-dim' }, tr('pset.maxPointsHint')))
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
    // so an externally re-run gen_sweep_report shows up without a manual ↻.
    // Hybrid viewing (2026-11-26 ruling): the embedded iframe is back — the
    // report HEAD's same-origin route step (/harnessams/assets/plotly.min.js)
    // renders offline inside it, closing the gap that had retired it — and the
    // ↗ button keeps opening the report with the OS default application as a
    // local file (full-screen file:// viewing; that server path also seeds the
    // project plotly copy and declares plotly_url in workspace_config.json).

    function SessionDashboard({ sessionId, config, updateConfig }) {
      const [nonce, setNonce] = useState(0)
      const [dialogOpen, setDialogOpen] = useState(false)
      const [dialogCwd, setDialogCwd] = useState(null) // folder a system pick landed on
      const [openErr, setOpenErr] = useState(null)
      // newest first: the dropdown and every fallback pick order by added_at
      // descending, so the latest simulation's report is the default view
      // (storage order stays insertion; sort is stable for equal stamps)
      const reports = [...(config.reports ?? [])].sort((a, b) =>
        (Date.parse(b.added_at ?? '') || 0) - (Date.parse(a.added_at ?? '') || 0))
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
        // selection would snap back to the newest report)
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
      // Add flow (2026-11-26 ruling, file-first): the add button pops OUR OWN
      // native OS FILE chooser through POST /api/pick-file — the host ships no
      // file-picker service, so the plugin carries one (picker.ps1 +
      // picker.js). The picked path is a single html file with its absolute
      // path, so registering it directly satisfies the "html single file"
      // contract with no indirect one-html-per-folder judgment. ANY failure
      // (no desktop on web-SSH remote sessions, spawn failure, the 10-minute
      // timeout, a non-html pick) silently opens the self-made listing; a
      // user cancel does nothing. The folder chooser (POST
      // /api/pick-directory) stays a public route but no longer chains here —
      // the file picker replaced its folder-then-one-html detour.
      const addBusy = useRef(false)
      const openAdd = () => {
        if (addBusy.current) return
        addBusy.current = true
        fetchJson(API + '/pick-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).then((r) => {
          if (r.canceled || !r.path) return // the user dismissed the system chooser
          // belt-and-braces: the route already rejects non-html picks; this
          // keeps the client honest if that contract ever drifts
          if (!/\.html?$/i.test(String(r.path))) { setDialogCwd(null); setDialogOpen(true); return }
          const base = String(r.path).split(/[\\/]/).pop() || String(r.path)
          addReport(String(r.path), base)
        }).catch(() => {
          setDialogCwd(null); setDialogOpen(true) // silent fallback
        }).finally(() => { addBusy.current = false })
      }
      const removeCurrent = () => updateConfig((c) => {
        const rest = (c.reports ?? []).filter((r) => r.id !== selectedId)
        const newest = [...rest].sort((a, b) =>
          (Date.parse(b.added_at ?? '') || 0) - (Date.parse(a.added_at ?? '') || 0))[0]
        return { ...c, reports: rest, dashboard_selected: newest?.id ?? null }
      })
      const dashUrl = current ? '/harnessams/dash/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(current.id) + '/' : null
      // System-browser open: the report file is launched with the OS default
      // application (fenced server-side: viewable types, existing file,
      // quoting-safe characters); failures surface inline, never thrown.
      const openInSystemBrowser = () => {
        if (!current) return
        setOpenErr(null)
        fetchJson(API + '/open-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, path: current.path }),
        }).catch((e) => { setOpenErr(String(e.message ?? e)) })
      }

      return h('div', { className: 'hams-dashview' },
        h('div', { className: 'hams-row hams-dashtoolbar' },
          h('select', {
              className: 'hams-select',
              value: selectedId ?? '',
              disabled: !reports.length,
              title: current ? current.path : tr('dash.noReports'),
              onChange: captureValue((id) => updateConfig((c) => ({ ...c, dashboard_selected: id }))),
            },
            reports.length
              ? reports.map((r) => h('option', { key: r.id, value: r.id }, txt(r.name)))
              : h('option', { value: '' }, tr('dash.noReports'))),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.addTitle'), onClick: openAdd }, '\uFF0B ' + tr('dash.add')),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.refresh'), disabled: !current, onClick: () => setNonce(nonce + 1) }, '↻ ' + tr('dash.refreshShort')),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.remove'), disabled: !current, onClick: removeCurrent }, '× ' + tr('dash.removeShort')),
          h('button', { className: 'hams-btn hams-btn-sm', title: tr('dash.openSysTitle'), disabled: !current, onClick: openInSystemBrowser }, '↗ ' + tr('dash.openSys'))),
        openErr && h('div', { className: 'hams-err' }, txt(tr('dash.openFailed', { err: openErr }))),
        current && h('iframe', {
          key: current.id + ':' + nonce,
          className: 'hams-dashframe',
          title: current.name,
          src: dashUrl + '?_r=' + nonce,
        }),
        !current && h('div', { className: 'hams-dash' },
          tr('dash.empty'), ' ',
          h('button', { className: 'hams-btn hams-btn-sm', onClick: openAdd }, tr('dash.addFirst'))),
        dialogOpen && h(AddReportDialog, {
          initialCwd: dialogCwd,
          onCancel: () => { setDialogOpen(false); setDialogCwd(null) },
          onAdd: (p, n) => { setDialogOpen(false); setDialogCwd(null); addReport(p, n) },
        }),
      )
    }

    // Add-report browser: a one-level directory listing (server /api/browse —
    // subdirectories + *.html files, dot-directories hidden) starting at the
    // folder the system flow landed on (initialCwd) or the home dir; clicking
    // an HTML file registers it. The manual path field covers paths outside
    // the browsable tree and now carries its own .html/.htm format gate — the
    // store write would reject a wrong extension anyway (D-009 strict), but
    // that round-trip leaves the optimistic row in place; catching it here
    // keeps the dialog open and explains. This dialog is the FALLBACK half of
    // the 2026-11-26 system-first ruling: the add button pops the native OS
    // FILE chooser first (POST /api/pick-file) and ANY failure opens this
    // listing silently — no system affordance lives inside the dialog.
    function AddReportDialog({ initialCwd, onCancel, onAdd }) {
      const [cwd, setCwd] = useState(initialCwd ?? null) // null = server default (home dir)
      const [listing, setListing] = useState(null)
      const [error, setError] = useState(null)
      const [manual, setManual] = useState('')
      const [manualErr, setManualErr] = useState(null)
      useEffect(() => {
        let alive = true
        setError(null); setListing(null)
        fetchJson(API + '/browse' + (cwd ? '?path=' + encodeURIComponent(cwd) : ''))
          .then((r) => { if (alive) setListing(r) })
          .catch((e) => { if (alive) setError(String(e.message ?? e)) })
        return () => { alive = false }
      }, [cwd])
      const addManual = () => {
        const p = manual.trim()
        if (!p) return
        if (!/\.html?$/i.test(p)) { setManualErr(tr('dash.addBadExt')); return }
        setManualErr(null)
        onAdd(p, '')
      }
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
              !error && !listing && h('div', { className: 'hams-dim', style: { padding: '8px' } }, tr('common.loading')),
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
                onChange: (e) => { setManual(e.target.value); if (manualErr) setManualErr(null) },
                onKeyDown: (e) => { if (e.key === 'Enter') addManual() } }),
              h('button', { className: 'hams-btn', disabled: !manual.trim(), onClick: addManual }, tr('dash.add'))),
            manualErr && h('div', { className: 'hams-err' }, txt(manualErr))),
          h('div', { className: 'hams-row', style: { justifyContent: 'flex-end' } },
            h('button', { className: 'hams-btn', onClick: onCancel }, tr('common.cancel')))))
    }

    // Check-parameters sub-view (session panel): editable table of the
    // assembly-layer check thresholds/switches stored in THIS session's
    // sessions.json entry (per-session since D-003). The initial table is the
    // session's confirmed copy, or the project-file∪built-in fallback while
    // unconfirmed (the source line under the title says which is in effect).
    // Each R/C/L bound drafts as a {value, unit} pair (a unit dropdown per
    // field so the two ends may carry different units, e.g. 1 fF … 1 uF; the
    // value parses both scientific notation and plain decimals — storage stays
    // in base units); the confirm button validates locally, then saves through
    // the rebased single-session persist channel and the server re-validates.
    // While a draft differs from the loaded value the cell keeps the old value
    // visible in gray parentheses so the pre-confirm state is always readable.
    const RCL_UNITS = {
      r: [['\u03A9', 1], ['k\u03A9', 1e3], ['M\u03A9', 1e6]],
      c: [['fF', 1e-15], ['pF', 1e-12], ['nF', 1e-9], ['uF', 1e-6]],
      l: [['pH', 1e-12], ['nH', 1e-9]],
    }
    const unitMult = (k, u) => (RCL_UNITS[k].find((e) => e[0] === u) ?? RCL_UNITS[k][0])[1]
    const unitValue = (k, d) => Number(d.v) * unitMult(k, d.u)
    // largest ladder unit with value/multiplier >= 1 (else the smallest), then
    // a <=6-significant-digit decimal for the input box
    const toUnitDraft = (k, x) => {
      const lad = RCL_UNITS[k]
      let u = lad[0][0]
      for (let i = lad.length - 1; i >= 0; i--) { if (x / lad[i][1] >= 1) { u = lad[i][0]; break } }
      return { v: String(+((x / unitMult(k, u)).toPrecision(6))), u }
    }
    const fmtSavedUnit = (k, x) => { const d = toUnitDraft(k, x); return d.v + ' ' + d.u }
    function CheckParams({ sessionId, updateConfig }) {
      const [params, setParams] = useState(null) // loaded copy (null = loading)
      const [hasOwn, setHasOwn] = useState(false) // session confirmed its own table
      const [draft, setDraft] = useState(null) // working copy; numbers as strings
      const [error, setError] = useState(null)
      const [saveError, setSaveError] = useState(null)
      const [saving, setSaving] = useState(false)

      const toDraft = (p) => ({
        rcl: {
          r: p.rcl.r.map((x) => toUnitDraft('r', x)),
          c: p.rcl.c.map((x) => toUnitDraft('c', x)),
          l: p.rcl.l.map((x) => toUnitDraft('l', x)),
        },
        mult: {
          nf: p.mult.nf.map((x) => String(x)),
          m: p.mult.m.map((x) => String(x)),
        },
        nf_warn: String(p.nf_warn),
        unit_check: p.unit_check,
      })
      const toNumeric = (d) => ({
        rcl: {
          r: [unitValue('r', d.rcl.r[0]), unitValue('r', d.rcl.r[1])],
          c: [unitValue('c', d.rcl.c[0]), unitValue('c', d.rcl.c[1])],
          l: [unitValue('l', d.rcl.l[0]), unitValue('l', d.rcl.l[1])],
        },
        mult: {
          nf: d.mult.nf.map((x) => Number(x)),
          m: d.mult.m.map((x) => Number(x)),
        },
        nf_warn: Number(d.nf_warn),
        unit_check: d.unit_check,
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
          const lo = unitValue(k, draft.rcl[k][0])
          const hi = unitValue(k, draft.rcl[k][1])
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || lo >= hi) {
            setSaveError(tr('check.badPair', { p: tr('check.rcl' + k.toUpperCase()) }))
            return
          }
        }
        for (const k of ['nf', 'm']) {
          const lo = Number(draft.mult[k][0])
          const hi = Number(draft.mult[k][1])
          if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || lo >= hi) {
            setSaveError(tr('check.badMultPair', { p: tr(k === 'nf' ? 'check.multNf' : 'check.multM') }))
            return
          }
        }
        {
          const n = Number(draft.nf_warn)
          if (!Number.isInteger(n) || n <= 0) {
            setSaveError(tr('check.badNfWarn', { p: tr('check.nfWarn') }))
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

      const rclField = (k, end, patch) => h('span', { className: 'hams-row', style: { flexWrap: 'nowrap', margin: 0 } },
        h('input', { className: 'hams-input', style: { width: '72px' }, value: draft.rcl[k][end].v,
          onChange: (e) => patch({ v: e.target.value }),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm() } } }),
        h('select', { className: 'hams-select', style: { width: '58px' }, value: draft.rcl[k][end].u,
          onChange: (e) => patch({ u: e.target.value }) },
          RCL_UNITS[k].map(([u]) => h('option', { key: u, value: u }, u))))
      const rclRow = (k, labelKey, noteKey) => {
        const saved = params?.rcl?.[k]
        const changed = !!saved
          && (unitValue(k, draft.rcl[k][0]) !== saved[0] || unitValue(k, draft.rcl[k][1]) !== saved[1])
        const patchEnd = (end) => (patch) => setDraft({ ...draft, rcl: {
          ...draft.rcl, [k]: draft.rcl[k].map((d, i) => (i === end ? { ...d, ...patch } : d)) } })
        return h('tr', null,
          h('td', null, tr(labelKey)),
          h('td', null,
            // wrap (not nowrap): a fixed-layout cell cannot host the whole
            // bound pair row at pane widths, and a nowrap flex cluster pokes
            // past its column (2026-11-26) — the pairs stack instead
            h('div', { className: 'hams-row', style: { flexWrap: 'wrap', margin: 0 } },
              rclField(k, 0, patchEnd(0)),
              h('span', { className: 'hams-dim' }, '…'),
              rclField(k, 1, patchEnd(1))),
            changed && h('span', { className: 'hams-dim' },
              tr('check.oldValue', { v: fmtSavedUnit(k, saved[0]) + ' … ' + fmtSavedUnit(k, saved[1]) }))),
          h('td', { className: 'hams-dim' }, tr(noteKey)))
      }

      const multRow = (k, labelKey) => {
        const saved = params?.mult?.[k]
        const nums = draft.mult[k].map((x) => Number(x))
        const changed = !!saved && (nums[0] !== saved[0] || nums[1] !== saved[1])
        const patchEnd = (end) => (v) => setDraft({ ...draft, mult: {
          ...draft.mult, [k]: draft.mult[k].map((d, i) => (i === end ? v : d)) } })
        return h('tr', null,
          h('td', null, tr(labelKey)),
          h('td', null,
            h('div', { className: 'hams-row', style: { flexWrap: 'wrap', margin: 0 } },
              h('input', { className: 'hams-input', style: { width: '88px' }, value: draft.mult[k][0],
                onChange: (e) => patchEnd(0)(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm() } } }),
              h('span', { className: 'hams-dim' }, '…'),
              h('input', { className: 'hams-input', style: { width: '88px' }, value: draft.mult[k][1],
                onChange: (e) => patchEnd(1)(e.target.value) })),
            changed && h('span', { className: 'hams-dim' },
              tr('check.oldValue', { v: String(saved[0]) + ' … ' + String(saved[1]) }))),
          h('td', { className: 'hams-dim' }, tr('check.noteMult')))
      }

      const nfWarnRow = () => {
        const saved = params?.nf_warn
        const changed = saved !== undefined && Number(draft.nf_warn) !== saved
        return h('tr', null,
          h('td', null, tr('check.nfWarn')),
          h('td', null,
            h('input', { className: 'hams-input', style: { width: '88px' }, value: draft.nf_warn,
              onChange: (e) => setDraft({ ...draft, nf_warn: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm() } } }),
            ' ',
            changed && h('span', { className: 'hams-dim' },
              tr('check.oldValue', { v: String(saved) }))),
          h('td', { className: 'hams-dim' }, tr('check.noteNfWarn')))
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
        // an unconfirmed session runs the pre-check on the defaults — that
        // state is the red badge (the project-overview "● unsaved" pattern),
        // not the quiet gray of a confirmed table
        params && h('div', { className: hasOwn ? 'hams-dim' : 'hams-bad', title: hasOwn ? undefined : tr('check.unconfirmedHint') },
          (hasOwn ? '' : '● ') + tr(hasOwn ? 'check.sourceOwn' : 'check.sourceFallback')),
        error && h('div', { className: 'hams-err' }, txt(error)),
        saveError && h('div', { className: 'hams-err' }, txt(saveError)),
        !params && !error && h('div', { className: 'hams-dim' }, tr('common.loading')),
        params && draft && h('table', { className: 'hams-table' },
          // 26/48/26 (the value column is the wide one): fixed layout would
          // otherwise split the three columns evenly and starve the value
          // column, whose control pairs are the widest content by far
          h('colgroup', null,
            h('col', { key: 'param', style: { width: '26%' } }),
            h('col', { key: 'value', style: { width: '48%' } }),
            h('col', { key: 'note', style: { width: '26%' } })),
          h('thead', null, h('tr', null, [tr('check.colParam'), tr('check.colValue'), tr('check.colNote')]
            .map((c) => h('th', { key: c }, c)))),
          h('tbody', null,
            rclRow('r', 'check.rclR', 'check.noteR'),
            rclRow('c', 'check.rclC', 'check.noteC'),
            rclRow('l', 'check.rclL', 'check.noteL'),
            multRow('nf', 'check.multNf'),
            multRow('m', 'check.multM'),
            nfWarnRow(),
            switchRow('unit_check', 'check.unitCheck', 'check.noteUnit'))),
        params && draft && h('div', { className: 'hams-row' },
          // an UNCONFIRMED session can always confirm: with no own table the
          // draft holds the effective defaults and Confirming adopts them —
          // only an owned, unchanged table has nothing to save
          h('button', { className: 'hams-btn hams-btn-sm', disabled: (!dirty && hasOwn) || saving, onClick: () => { void confirm() } },
            saving ? tr('common.loading') : tr('check.confirm')),
          h('button', { className: 'hams-btn hams-btn-sm', disabled: !dirty || saving, onClick: () => setDraft(toDraft(params)) },
            tr('common.cancel')),
          !hasOwn && h('span', { className: 'hams-bad' }, '● ', tr('check.unconfirmedHint'))))
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
        if (!sessionId) return
        // the console page's core-config switch rides the ACTIVE session's
        // project — the always-mounted conversation-header button is the most
        // reliable active-session signal on this surface
        activeSessionProbe.id = sessionId
        if (!openSidebarTab) return
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
      // renders), so all three names must be listed verbatim — guarded by the
      // entry test against the registered tool-name set.
      slots.inject('tool.call.toolview', function* () {
        for (const key of SIM_CARD_TOOLS) {
          yield slots.register({ name: 'tool.call.toolview', key,
            // The toolview owner carries no sessionId (rc.5 host client: owner =
            // {callId, toolName, ...call, openFile, cwd, home, ...}); the
            // register-inject hook is the sanctioned way to add it (official
            // precedent: ask_user_question). The progress endpoints fence on it.
            inject: (sessionId) => ({ sessionId }) }, SimToolCard)
        }
      })
    }

    exports.name = name
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
