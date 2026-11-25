// Recommended-workflow table for the AGENTS.md project-config block (2026-11-24
// rework). The block carries NO prose any more: the yaml (config + self-check
// results) plus this one .md table — the workflow the model should follow
// in-session, each row naming the tool and ONLY the parameters the model
// actually fills. Values the yaml already states (workspace root, remote root,
// machine, the toolchain pins remote_python / remote_spectre_cmd) are
// deliberately absent from the table: the tools resolve them from the project
// config, and repeating them here is how the 2026-11-24 incident started (a
// config value misread as an executable). Branch forks are minimal:
// the scheduler cell and the analyze row follow cluster_env (remote-first over
// dsh-ssh out-of-cluster, on-the-data python in-cluster). English + ASCII by
// the block's language ruling; one line per table row.

// The five rows. Cells are md-table-safe (no pipes); branch wording is baked
// in by workflowTable below.
export function workflowTable(settings) {
  const s = settings ?? {}
  const inCluster = s.cluster_env === 'in-cluster'
  const schedulerCell = inCluster
    ? 'scheduler = "lsf" (default, bsub on this host) / "ssh" (foreground, another node) / "local" (this host, background)'
    : 'scheduler = "lsf" (default, bsub through the ssh node) / "ssh" (foreground on the ssh node); "local" is unavailable out-of-cluster'
  const analyzeTool = inCluster ? 'python (direct)' : 'ssh_exec + ssh_download'
  // Remote-side parsers follow the remote_python yaml row (D-016/D-017): a
  // green self-check pins the measured absolute path automatically (and
  // remembers it per node), so a null row is the rare, temporary state of a
  // machine the plugin has not measured yet — then the bare default the
  // self-check verified applies, which differs by chain (the in-cluster local
  // chain spawns python, every remote chain python3).
  const interpreter = s.remote_python
    ? 'the interpreter named by the remote_python row of the yaml above'
    : `the interpreter named by the remote_python row of the yaml above, which is null here (not yet measured): use bare ${inCluster && s.run_mode === 'local' ? 'python' : 'python3'}, the unpinned default the self-check verified`
  const analyzeCell = inCluster
    ? `run the parsers on the host that holds the data (shared filesystem) with ${interpreter}: <workspace_root>/.harnessams/scripts/spectre/spectre_psf_parse.py --work-dir <run dir> --format csv; the snp tools for S-parameters; write compact JSON into <project>/SimResults/`
    : `remote-first: the parsers are already staged under <remote_root>/.harnessams/scripts, ssh_exec them with ${interpreter}; never bare python, it is 2.x on many hosts; ssh_download only the compact JSON into <project>/SimResults/`
  const rows = [
    ['Write', 'spectre_pre_check', 'hand-write the run dir first: template*.scs (simulator lang=spectre; @@PARAM@@ placeholders ONLY on the parameters statement, the circuit references parameters by name; follow the dca-cell-design / smart-spectre template rules and the sky130proc examples) + sweep_config.json (parameters dict of lists, sweep_mode, netlist_template); then validate with run_dir = that run dir and fix what it reports (batch_submit runs the same check again)'],
    ['Submit', 'batch_submit', 'run_dir; worker = "spectre/spectre_sweep_worker.py"; worker_args = ["--config", "sweep_config.json", "--max-parallel", "8"]; ' + schedulerCell + '; lsf_node only to pin or spread bsub hosts. Omit machine_id / remote_root / remote_python: they resolve from this config (the pinned spectre reaches the bundled worker by itself, so do not pass --spectre-cmd; the batch output dir auto-names under remote_root); overwrite: true only to re-run a finished dir; no_pre_check: true only to waive an already-reviewed pre-check failure'],
    ['Monitor', 'batch_poll', 'run_dir; wait_sec (<= 600). Poll, never blind-sleep: re-check after each bounded wait, back off 10 s -> 20 s -> 40 s with the ETA from completed over total; while a progress card is up, refresh it at least every 5 s; terminal states auto-fetch the light results'],
    ['Analyze', analyzeTool, analyzeCell],
    ['Report', 'gen_sweep_report', 'spec = path to the report spec JSON (rounds with points and curves; conclusions land in the session dashboard)'],
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
