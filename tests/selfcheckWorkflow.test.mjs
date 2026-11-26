// workflowTable (server/selfcheckWorkflow.js) — the recommended-workflow table
// rendered into the AGENTS.md project-config block on values builds. The
// 2026-11-24 rework replaced the five prose self-check branches with ONE
// table; the 2026-11-25 D-021 dedup slimmed it to purpose rows; the
// 2026-11-26 ruling dropped the POINTER CLAUSES too ("documented in the
// batch_submit description" & co.): the tool descriptions are already in the
// model's context, so each row is now the action + a minimal fill hint and
// nothing else. Five rows (Write/Submit/Monitor/Analyze/Report), columns
// Step | Tool | Model fills. The Write row is the write action itself (the
// hand-authored netlist), not a pre-check call. The only remaining
// cluster_env fork is the Analyze row's Tool cell. ASCII-only by the block's
// language ruling; one line per table row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowTable } from '../src/server/selfcheckWorkflow.js'

const S = (over = {}) => ({
  cluster_env: 'out-of-cluster', run_mode: 'local', scheduler: 'lsf', simulator: 'spectre',
  compute_script_local: 'python', compute_script_remote: 'python',
  machine_id: null, remote_root: null, selfcheck_remote_dir: '.harnessams/selfcheck',
  ...over,
})

test('workflowTable: five rows, three columns, header shape', () => {
  const t = workflowTable(S())
  assert.ok(t.includes('### Recommended workflow'), 'heading')
  assert.ok(t.includes('| Step | Tool | Model fills |'), 'header row')
  assert.ok(t.includes('| --- | --- | --- |'), 'separator row')
  for (const step of ['Write', 'Submit', 'Monitor', 'Analyze', 'Report']) {
    assert.ok(t.includes(`| ${step} |`), `row ${step}`)
  }
  // tools named per row; the Write row's tool is the write action itself
  assert.ok(t.includes('| write |'))
  assert.ok(t.includes('| batch_submit |'))
  assert.ok(t.includes('| batch_poll |'))
  assert.ok(t.includes('| gen_sweep_report |'))
})

test('workflowTable: the Write row is the hand-written netlist itself, no contract pointers', () => {
  const t = workflowTable(S())
  const write = t.split('\n').find((l) => l.startsWith('| Write |'))
  assert.match(write, /create the design folder \(<project>\/<design>, e\.g\. Pi12dB/)
  assert.match(write, /the project root holds only \.harnessams, AGENTS\.md, and design folders/)
  assert.match(write, /template\*\.scs \+ sweep_config\.json/)
  // 2026-11-26: guidance the model context already carries is NOT repeated —
  // no netlist-contract pointer, no pre-check redundancy clause
  assert.ok(!write.includes('per the netlist contract'), 'no contract pointer')
  assert.ok(!write.includes('batch_submit runs the same gate'), 'no pre-check redundancy clause')
})

test('workflowTable: the Submit row is the action + fill hint only (no description pointers)', () => {
  const t = workflowTable(S())
  const submit = t.split('\n').find((l) => l.startsWith('| Submit |'))
  assert.match(submit, /omit machine_id \/ remote_root \/ remote_python \(they resolve from this config\)/)
  // the 2026-11-26 deletion: the verbose pointer sentence is gone
  assert.ok(!submit.includes('documented in the batch_submit description'), 'pointer sentence dropped')
  // the table never repeats a yaml value
  const PIN = '/opt/tools/python3/bin/python3'
  const pinned = workflowTable(S({ run_mode: 'remote', remote_python: PIN }))
  assert.ok(!pinned.includes(PIN), 'the table never repeats a pin value')
})

test('workflowTable: the Monitor row carries the action, not the cadence', () => {
  const t = workflowTable(S())
  const monitor = t.split('\n').find((l) => l.startsWith('| Monitor |'))
  assert.match(monitor, /bounded wait_sec/)
  assert.match(monitor, /terminal states auto-fetch the light results/)
  assert.ok(!monitor.includes('cadence'), 'no cadence pointer')
  assert.ok(!monitor.includes('blind-sleep'), 'no cadence rule restated')
})

test('workflowTable: the Analyze row keeps the one cluster_env fork (Tool cell), no recipe pointer', () => {
  const outC = workflowTable(S())
  const inC = workflowTable(S({ cluster_env: 'in-cluster' }))
  const outRow = outC.split('\n').find((l) => l.startsWith('| Analyze |'))
  const inRow = inC.split('\n').find((l) => l.startsWith('| Analyze |'))
  assert.match(outRow, /\| ssh_exec \+ ssh_download \|/, 'out-of-cluster analyze over ssh')
  assert.match(inRow, /\| python \(direct\) \|/, 'in-cluster analyze runs python directly')
  assert.match(outRow, /write compact JSON into <design>\/SimResults\//)
  assert.ok(!outRow.includes('full recipe'), 'no recipe pointer')
})

test('workflowTable: the Report row is the spec pointer only', () => {
  const t = workflowTable(S())
  const report = t.split('\n').find((l) => l.startsWith('| Report |'))
  assert.match(report, /spec = path to the report spec JSON, placed in <design>\/SimResults\//)
  assert.ok(!report.includes('gen_sweep_report description'), 'no schema pointer')
  assert.ok(!report.includes('dashboard'), 'no dashboard note')
})

test('workflowTable: unknown/partial settings normalize to the defaults', () => {
  assert.ok(workflowTable({}).includes('| Analyze | ssh_exec + ssh_download |'))
  assert.ok(workflowTable(undefined).includes('| Report |'))
})

test('workflowTable: ASCII-only (no CJK/fullwidth, no arrows)', () => {
  const t = workflowTable(S({ cluster_env: 'in-cluster' })) + workflowTable(S())
  for (const ch of ['→', '·', '×', '—', '–']) assert.ok(!t.includes(ch), `ASCII-only table, found ${ch}`)
  // pipes only as table delimiters: every row has exactly three cells
  for (const line of t.split('\n')) {
    if (!line.startsWith('|')) continue
    assert.equal(line.split('|').length, 5, 'exactly three cells: ' + line.slice(0, 60))
  }
})
