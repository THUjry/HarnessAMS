// Self-check workflow text for the AGENTS.md project-config block (2026-11-21).
// One branch per FEASIBLE settings combination: cluster_env x run_mode x
// scheduler x simulator (scheduler only applies to remote spectre; the compute
// languages are interpolated, they never fork a branch — cluster_env forks only
// the remote-branch WORDING, except local/spectre which is in-cluster only).
// English + ASCII by the block's language ruling, one bullet per line.
// syncAgentsMd renders the branch matching the saved settings on every values
// sync (the save button and the self-check finalize both land there), so the
// block always documents how THIS workspace validates itself and which tools
// run in which order. The first-fill template (no settings yet) renders
// nothing. golden ~= simulator=none: the bundled golden dataset replaces live
// spectre. envStatement (D-002, the working-environment dichotomy) rides every
// values build directly above the workflow section — it is the line the model
// reads first ("This is an in-cluster / out-of-cluster project").

const LEAD = '- Session face: `harnessams_selfcheck` action "run" starts the check and returns run_id; poll action "status" with that run_id until done (the UI polls every 3 s; agents poll, never blind-sleep); action "stop" cancels a running check (evidence kept, never enters last_selfcheck_*).'

const FINALIZE = '- Finalize: verdicts are read from disk artifacts (sweep_progress.json / psf_index.json); a clean run\'s artifacts are deleted (selfcheck_run.json persists); failed steps spawn a READ-ONLY diagnosis session quoting them verbatim; this block re-syncs on every finish.'

function section(heading, chain, extra) {
  const lines = ['### Self-check workflow (' + heading + ')', '', LEAD, ...chain]
  if (extra) lines.push(...extra)
  lines.push(FINALIZE)
  return lines.join('\n')
}

// The working-environment statement (D-002): one paragraph naming the
// environment and the scheduler semantics it implies. Rendered on values
// builds only (the first-fill template has no settings).
export function envStatement(settings) {
  const s = settings ?? {}
  if (s.cluster_env === 'in-cluster') {
    return 'This is an in-cluster project: the DSH host itself is a cluster node on the shared cluster '
      + 'filesystem. scheduler="local" runs on this host; scheduler="ssh" runs the sweep on another node over '
      + 'ssh (files never cross ssh); scheduler="lsf" submits bsub on this host.'
  }
  return 'This is an out-of-cluster project: the DSH host sits outside the cluster and every remote operation '
    + 'crosses dsh-ssh (upload/exec/download). scheduler="local" is unavailable; scheduler="ssh" runs the sweep '
    + 'on the ssh node (a second hop goes through the dsh-ssh proxy config); scheduler="lsf" submits bsub '
    + 'through the ssh node.'
}

// The five feasible branches; unknown/partial settings normalize to the
// settings.js defaults (out-of-cluster / local / lsf / spectre), so every input
// renders one of them and no combination can fall through.
export function workflowSection(settings) {
  const s = settings ?? {}
  const mode = s.run_mode === 'remote' ? 'remote' : 'local'
  const sim = s.simulator === 'none' ? 'none' : 'spectre'
  const sched = s.scheduler === 'ssh' ? 'ssh' : 'lsf'
  const env = s.cluster_env === 'in-cluster' ? 'in-cluster' : 'out-of-cluster'
  const local = s.compute_script_local === 'js' ? 'js' : 'python'

  if (mode === 'local' && sim === 'spectre') {
    return section('local / spectre', [
      '- Chain: tool registration check (spectre_assemble + batch_submit + batch_poll) -> settings validation -> spectre_assemble (RC testbench via gen_selfcheck_rc.py, LPF+HPF) -> batch_submit local LPF (9 pts, background worker) -> batch_submit local HPF (9 pts) -> batch_poll (local files) -> spectre_psf_parse.py run directly (LPF+HPF) -> pointwise verify (' + local + ', 1% vs analytic RC).',
      '- Requires cluster_env=in-cluster: the host itself runs spectre (out-of-cluster local spectre is rejected at settings validation).',
    ])
  }
  if (mode === 'local') { // simulator=none: golden replay
    return section('local / golden', [
      '- Chain: parser script check (spectre_psf_parse.py under sim_scripts_dir) -> settings validation -> golden dataset load (9 pts x LPF+HPF, pre-measured psf) -> spectre_psf_parse.py run directly -> pointwise verify (' + local + ').',
    ])
  }
  if (sim === 'none') { // remote golden: the scheduler never enters this chain
    return section('remote / golden (' + env + ')', [
      env === 'in-cluster'
        ? '- Chain: parser script check (sim_scripts_dir) -> settings validation -> golden dataset load -> golden staging as local copies into the shared run dir (point trees + both verify flavors + the standalone spectre_psf_parse.py) -> parse+verify on this host through the ctx.shell seam (result via the [selfcheck] marker line) -> local cross-check (' + local + '). The scheduler setting is unused in this mode.'
        : '- Chain: parser script check (sim_scripts_dir) -> settings validation -> golden dataset load -> golden upload via ssh_upload (point trees + both verify flavors + the standalone spectre_psf_parse.py) -> ssh_exec remote parse+verify -> ssh_download of the point metas + psf CSVs per topology + local cross-check (' + local + '). The scheduler setting is unused in this mode.',
    ])
  }
  if (sched === 'lsf') {
    return section('remote / LSF / spectre (' + env + ')', [
      env === 'in-cluster'
        ? '- Chain: tool registration check -> settings validation -> spectre_assemble -> local staging into the shared run dir as a local copy (template + sweep_config + both verify flavors) -> batch_submit (LSF, LPF+HPF; bsub runs on this host; per-attempt remote dir under settings.remote_root) -> batch_poll (local bjobs) -> parse+verify on this host through the ctx.shell seam ([selfcheck] marker) -> local cross-check (' + local + ').'
        : '- Chain: tool registration check -> settings validation -> spectre_assemble -> local staging (template + sweep_config + both verify flavors) -> batch_submit (LSF, LPF+HPF; per-attempt remote dir under settings.remote_root) -> batch_poll -> ssh_exec remote parse+verify per topology (result via the [selfcheck] marker line) -> ssh_download of the point metas + psf CSVs + local cross-check (' + local + ').',
    ], [
      (env === 'in-cluster' && !s.machine_id)
        ? '- LSF fallback: a failed LSF submit/poll spawns a diagnosis session IMMEDIATELY (trigger "remote-scheduler"); a scheduler=ssh retry needs machine_id, so without one there is no fallback — the primary failure fails the verdict.'
        : '- LSF fallback: a failed LSF submit/poll spawns a diagnosis session IMMEDIATELY (trigger "remote-scheduler", in parallel with the retry), then retries once with scheduler=ssh; success marks the run ok-via-fallback and the primary failure does not sink the verdict.',
    ])
  }
  return section('remote / ssh / spectre (' + env + ')', [
    env === 'in-cluster'
      ? '- Chain: tool registration check -> settings validation -> spectre_assemble -> local staging as a local copy into the shared run dir -> batch_submit (ssh; the sweep runs to completion inside the submit call, executed on the target node over ssh) -> batch_poll confirms (progress files on the shared filesystem) -> ssh_exec parse+verify on the node ([selfcheck] marker) -> results read from the shared filesystem + local cross-check (' + local + ').'
      : '- Chain: tool registration check -> settings validation -> spectre_assemble -> local staging -> batch_submit (ssh; the sweep runs to completion inside the submit call) -> batch_poll confirms -> ssh_exec remote parse+verify per topology ([selfcheck] marker) -> ssh_download of the point metas + psf CSVs + local cross-check (' + local + ').',
  ], [
    '- No fallback: with scheduler=ssh a primary submit/poll failure fails the verdict.',
  ])
}
