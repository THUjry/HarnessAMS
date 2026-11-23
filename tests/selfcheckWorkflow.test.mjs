// Self-check workflow section for the AGENTS.md config block
// (server/selfcheckWorkflow.js): one branch per feasible settings combination
// (cluster_env x local/remote x lsf/ssh x spectre/none — still 5 branches; the
// working environment forks the remote wording), plus the envStatement
// working-environment line (D-002). Rendered by syncAgentsMd on every values
// sync. Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { envStatement, workflowSection } from '../src/server/selfcheckWorkflow.js'

const S = (over = {}) => ({
  cluster_env: 'out-of-cluster', run_mode: 'local', scheduler: 'lsf', simulator: 'spectre',
  compute_script_local: 'python', compute_script_remote: 'python', ...over,
})

test('envStatement: names the environment and its scheduler semantics', () => {
  const inC = envStatement(S({ cluster_env: 'in-cluster' }))
  assert.match(inC, /This is an in-cluster project/)
  assert.match(inC, /scheduler="local" runs on this host/)
  assert.match(inC, /scheduler="ssh" runs the sweep on another node over ssh/)
  assert.match(inC, /scheduler="lsf" submits bsub on this host/)
  const outC = envStatement(S())
  assert.match(outC, /This is an out-of-cluster project/)
  assert.match(outC, /scheduler="local" is unavailable/)
  assert.match(outC, /every remote operation crosses dsh-ssh/)
  assert.match(outC, /scheduler="lsf" submits bsub through the ssh node/)
  // unknown settings normalize to out-of-cluster (the conservative channel)
  assert.match(envStatement({}), /out-of-cluster/)
  assert.match(envStatement(undefined), /out-of-cluster/)
})

test('workflow: local spectre branch — session face + local chain, no remote channel', () => {
  const t = workflowSection(S({ cluster_env: 'in-cluster' }))
  assert.ok(t.includes('### Self-check workflow (local / spectre)'))
  assert.ok(t.includes('harnessams_selfcheck'), 'session-face lead present')
  assert.ok(t.includes('batch_submit local LPF (9 pts'))
  assert.ok(t.includes('spectre_psf_parse.py run directly'))
  assert.ok(t.includes('pointwise verify (python'), 'compute language interpolated')
  assert.ok(t.includes('Requires cluster_env=in-cluster'), 'the in-cluster requirement is stated')
  assert.ok(!t.includes('ssh_'), 'local mode never touches the remote channel')
  assert.ok(t.includes('Finalize:'), 'finalize bullet present')
})

test('workflow: local golden branch (simulator=none)', () => {
  const t = workflowSection(S({ simulator: 'none' }))
  assert.ok(t.includes('### Self-check workflow (local / golden)'))
  assert.ok(t.includes('golden dataset load'))
  assert.ok(t.includes('spectre_psf_parse.py run directly'))
  assert.ok(!t.includes('batch_submit'), 'no live sweeps in the golden replay')
})

test('workflow: remote LSF out-of-cluster — batch chain + ssh fallback', () => {
  const t = workflowSection(S({ run_mode: 'remote' }))
  assert.ok(t.includes('### Self-check workflow (remote / LSF / spectre (out-of-cluster))'))
  assert.ok(t.includes('batch_submit (LSF'))
  assert.ok(t.includes('batch_poll'))
  assert.ok(t.includes('ssh_exec'))
  assert.ok(t.includes('ssh_download of the point metas + psf CSVs'))
  assert.ok(t.includes('ok-via-fallback'))
  assert.ok(t.includes('retries once with scheduler=ssh'))
})

test('workflow: remote LSF in-cluster — local bsub chain, no ssh in the chain text', () => {
  const t = workflowSection(S({ cluster_env: 'in-cluster', run_mode: 'remote' }))
  assert.ok(t.includes('### Self-check workflow (remote / LSF / spectre (in-cluster))'))
  assert.ok(t.includes('bsub runs on this host'))
  assert.ok(t.includes('local staging into the shared run dir as a local copy'))
  assert.ok(t.includes('local cross-check (python)'))
  assert.ok(!t.includes('ssh_exec'), 'the in-cluster LSF chain never mentions ssh exec')
})

test('workflow: remote LSF in-cluster without machine_id — no fallback possible', () => {
  const t = workflowSection(S({ cluster_env: 'in-cluster', run_mode: 'remote', machine_id: null }))
  assert.ok(t.includes('a scheduler=ssh retry needs machine_id'))
  assert.ok(!t.includes('retries once with scheduler=ssh'))
  // with a machine configured the ordinary fallback text returns
  const withMachine = workflowSection(S({ cluster_env: 'in-cluster', run_mode: 'remote', machine_id: 'node1' }))
  assert.ok(withMachine.includes('retries once with scheduler=ssh'))
})

test('workflow: remote ssh branch — no fallback bullet', () => {
  const t = workflowSection(S({ run_mode: 'remote', scheduler: 'ssh' }))
  assert.ok(t.includes('### Self-check workflow (remote / ssh / spectre (out-of-cluster))'))
  assert.ok(t.includes('batch_submit (ssh'))
  assert.ok(t.includes('No fallback'))
  assert.ok(!t.includes('ok-via-fallback'), 'ssh primary has no fallback to forgive it')
})

test('workflow: remote ssh in-cluster — run over ssh, staging as a local copy', () => {
  const t = workflowSection(S({ cluster_env: 'in-cluster', run_mode: 'remote', scheduler: 'ssh', machine_id: 'node2' }))
  assert.ok(t.includes('### Self-check workflow (remote / ssh / spectre (in-cluster))'))
  assert.ok(t.includes('executed on the target node over ssh'))
  assert.ok(t.includes('local staging as a local copy into the shared run dir'))
})

test('workflow: remote golden branches — ssh out-of-cluster, local copies in-cluster', () => {
  const out = workflowSection(S({ run_mode: 'remote', simulator: 'none' }))
  assert.ok(out.includes('### Self-check workflow (remote / golden (out-of-cluster))'))
  assert.ok(out.includes('ssh_upload'))
  assert.ok(out.includes('ssh_download'))
  assert.ok(!out.includes('batch_submit'), 'the golden chain never submits batches')
  assert.ok(out.includes('unused in this mode'))

  const inc = workflowSection(S({ cluster_env: 'in-cluster', run_mode: 'remote', simulator: 'none' }))
  assert.ok(inc.includes('### Self-check workflow (remote / golden (in-cluster))'))
  assert.ok(inc.includes('golden staging as local copies'))
  assert.ok(inc.includes('parse+verify on this host through the ctx.shell seam'))
  assert.ok(!inc.includes('ssh_upload'))
})

test('workflow: unknown/empty settings normalize to the defaults branch; text stays ASCII', () => {
  assert.ok(workflowSection({}).includes('### Self-check workflow (local / spectre)'))
  assert.ok(workflowSection(undefined).includes('### Self-check workflow (local / spectre)'))
  assert.ok(workflowSection(S({ compute_script_local: 'js' })).includes('pointwise verify (js'))
  // the block is English/ASCII by ruling — no typographic arrows or dashes
  const t = workflowSection(S({ run_mode: 'remote' }))
  for (const ch of ['→', '·', '×', '—', '–']) assert.ok(!t.includes(ch), 'ASCII-only output, found: ' + ch)
  for (const ch of ['→', '·', '×', '—', '–']) assert.ok(!envStatement(S()).includes(ch), 'ASCII-only env statement')
})
