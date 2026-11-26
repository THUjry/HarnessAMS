// Recommended-workflow table for the AGENTS.md project-config block (2026-11-24
// rework; slimmed 2026-11-25 D-021; pointers dropped 2026-11-26). The block
// carries NO prose any more: the yaml (config + self-check results + the
// python facts) plus this one .md table — the workflow the model should
// follow in-session, each row naming the tool and ONLY the action with a
// minimal fill hint. Parameter semantics, contracts and cadence rules are
// NOT repeated here and not even pointed at (2026-11-26 ruling): the tool
// descriptions are already in the model's context, so a "documented in the
// batch_submit description" clause is pure noise; the same goes for the
// values the yaml states (workspace root, remote root, machine, the
// toolchain pins, the numpy tri-states) — repeating them here is how the
// 2026-11-24 incident started (a config value misread as an executable).
// One branch fork remains: the Analyze row's Tool cell follows cluster_env
// (python direct on the shared filesystem in-cluster, ssh_exec +
// ssh_download out-of-cluster). Project organization (D-021): every design
// lives in its own folder under the project root (root = .harnessams +
// AGENTS.md + design folders only); the design folder holds the run dirs,
// RawResults/, SimResults/, Figs/ and the report. English + ASCII by the
// block's language ruling; one line per table row.

// The five rows. Cells are md-table-safe (no pipes).
export function workflowTable(settings) {
  const s = settings ?? {}
  const inCluster = s.cluster_env === 'in-cluster'
  const analyzeTool = inCluster ? 'python (direct)' : 'ssh_exec + ssh_download'
  const rows = [
    ['Write', 'write', 'create the design folder (<project>/<design>, e.g. Pi12dB; the project root holds only .harnessams, AGENTS.md, and design folders) and the run dir directly under it: template*.scs + sweep_config.json'],
    ['Submit', 'batch_submit', 'run_dir + worker + worker_args; omit machine_id / remote_root / remote_python (they resolve from this config)'],
    ['Monitor', 'batch_poll', 'run_dir + bounded wait_sec; terminal states auto-fetch the light results'],
    ['Analyze', analyzeTool, 'run the parsers on the host that holds the data and write compact JSON into <design>/SimResults/'],
    ['Report', 'gen_sweep_report', 'spec = path to the report spec JSON, placed in <design>/SimResults/'],
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
