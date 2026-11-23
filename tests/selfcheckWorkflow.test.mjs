// Self-check workflow section for the AGENTS.md config block
// (server/selfcheckWorkflow.js): one branch per feasible settings combination
// (local/remote x lsf/direct x spectre/none — 5 branches), rendered by
// syncAgentsMd on every values sync. Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowSection } from '../src/server/selfcheckWorkflow.js'

const S = (over = {}) => ({
  run_mode: 'local', scheduler: 'lsf', simulator: 'spectre',
  compute_script_local: 'python', compute_script_remote: 'python', ...over,
})

test('workflow: local spectre branch — session face + local chain, no remote channel', () => {
  const t = workflowSection(S())
  assert.ok(t.includes('### Self-check workflow (local / spectre)'))
  assert.ok(t.includes('harnessams_selfcheck'), 'session-face lead present')
  assert.ok(t.includes('batch_submit local LPF (9 pts'))
  assert.ok(t.includes('spectre_psf_parse.py run directly'))
  assert.ok(t.includes('pointwise verify (python'), 'compute language interpolated')
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

test('workflow: remote LSF branch — batch chain + immediate-diagnosis fallback', () => {
  const t = workflowSection(S({ run_mode: 'remote' }))
  assert.ok(t.includes('### Self-check workflow (remote / LSF / spectre)'))
  assert.ok(t.includes('batch_submit (LSF'))
  assert.ok(t.includes('batch_poll'))
  assert.ok(t.includes('ssh_exec'))
  assert.ok(t.includes('ssh_download of the point metas + psf CSVs'))
  assert.ok(t.includes('ok-via-fallback'))
  assert.ok(t.includes('retries once with scheduler=direct'))
})

test('workflow: remote direct branch — no fallback bullet', () => {
  const t = workflowSection(S({ run_mode: 'remote', scheduler: 'direct' }))
  assert.ok(t.includes('### Self-check workflow (remote / direct / spectre)'))
  assert.ok(t.includes('batch_submit (direct'))
  assert.ok(t.includes('No fallback'))
  assert.ok(!t.includes('ok-via-fallback'), 'direct primary has no fallback to forgive it')
})

test('workflow: remote golden branch — ssh upload/download, scheduler unused', () => {
  const t = workflowSection(S({ run_mode: 'remote', simulator: 'none' }))
  assert.ok(t.includes('### Self-check workflow (remote / golden)'))
  assert.ok(t.includes('ssh_upload'))
  assert.ok(t.includes('ssh_download'))
  assert.ok(!t.includes('batch_submit'), 'the golden chain never submits batches')
  assert.ok(t.includes('unused in this mode'))
})

test('workflow: unknown/empty settings normalize to the defaults branch; text stays ASCII', () => {
  assert.ok(workflowSection({}).includes('### Self-check workflow (local / spectre)'))
  assert.ok(workflowSection(undefined).includes('### Self-check workflow (local / spectre)'))
  assert.ok(workflowSection(S({ compute_script_local: 'js' })).includes('pointwise verify (js'))
  // the block is English/ASCII by ruling — no typographic arrows or dashes
  const t = workflowSection(S({ run_mode: 'remote' }))
  for (const ch of ['→', '·', '×', '—', '–']) assert.ok(!t.includes(ch), 'ASCII-only output, found: ' + ch)
})
