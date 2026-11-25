// Recommended-workflow table for the AGENTS.md project-config block (2026-11-24
// rework; slimmed 2026-11-25 D-021). The block carries NO prose any more: the
// yaml (config + self-check results + the python facts) plus this one .md
// table — the workflow the model should follow in-session, each row naming
// the tool and ONLY the step's purpose with a minimal fill hint. Per the
// 2026-11-25 dedup ruling, PARAMETER SEMANTICS AND CONTRACTS live in the TOOL
// DESCRIPTIONS (the netlist authoring contract in spectre_pre_check's, the
// scheduler matrix / lsf_node / overwrite / no_pre_check in batch_submit's,
// the poll cadence ladder and the analyze recipe in batch_poll's, the report
// schema in gen_sweep_report's): the table stays a lean pointer list, and the
// values the yaml already states (workspace root, remote root, machine, the
// toolchain pins, the numpy tri-states) are deliberately absent — repeating
// them here is how the 2026-11-24 incident started (a config value misread as
// an executable). One branch fork remains: the Analyze row's Tool cell
// follows cluster_env (python direct on the shared filesystem in-cluster,
// ssh_exec + ssh_download out-of-cluster). Project organization (D-021):
// every design lives in its own folder under the project root (root =
// .harnessams + AGENTS.md + design folders only); the design folder holds
// the run dirs, RawResults/, SimResults/, Figs/ and the report HTML. English
// + ASCII by the block's language ruling; one line per table row.

// The five rows. Cells are md-table-safe (no pipes).
export function workflowTable(settings) {
  const s = settings ?? {}
  const inCluster = s.cluster_env === 'in-cluster'
  const analyzeTool = inCluster ? 'python (direct)' : 'ssh_exec + ssh_download'
  const rows = [
    ['Write', 'spectre_pre_check', 'create the design folder first (<project>/<design>, e.g. Pi12dB; the project root holds only .harnessams, AGENTS.md, and design folders), then the run dir directly under it: template*.scs + sweep_config.json per the netlist contract (the spectre_pre_check description + the smart-spectre / dca-cell-design skills); batch_submit runs the same gate before staging, so a separate validation call is optional'],
    ['Submit', 'batch_submit', 'run_dir + worker + worker_args; omit machine_id / remote_root / remote_python (they resolve from this config); the remaining parameter semantics (scheduler per cluster_env, lsf_node, overwrite, no_pre_check) are documented in the batch_submit description'],
    ['Monitor', 'batch_poll', 'run_dir + bounded wait_sec; poll, never blind-sleep (the backoff cadence and progress-card refresh rules live in the batch_poll description); terminal states auto-fetch the light results'],
    ['Analyze', analyzeTool, 'run the parsers on the host that holds the data and write compact JSON into <design>/SimResults/ (the full recipe: staged parser paths, the interpreter per the remote_python row, what to ssh_download back; it lives in the batch_poll description)'],
    ['Report', 'gen_sweep_report', 'spec = path to the report spec JSON, placed in <design>/SimResults/ (the schema and output layout live in the gen_sweep_report description; conclusions land in the session dashboard)'],
  ]
  const head = ['Step', 'Tool', 'Model fills']
  return [
    '### Recommended workflow',
    '',
    '| ' + head.join(' | ') + ' |',
    '| ' + head.map(() => '---').join(' | ') + ' |',
    ...rows.map((r) => '| ' + r.map((c) => String(c).replace(/\|/g, '/')).join(' | ') + ' |'),
  ].join('\n')
}
