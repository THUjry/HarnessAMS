// workflowTable (server/selfcheckWorkflow.js) — the recommended-workflow table
// rendered into the AGENTS.md project-config block on values builds. The
// 2026-11-24 rework replaced the five prose self-check branches with ONE
// table; the 2026-11-25 D-021 dedup slimmed it to purpose rows: five rows
// (Write/Submit/Monitor/Analyze/Report), columns Step | Tool | Model fills,
// each cell stating the step's purpose and a minimal fill hint, with the
// PARAMETER SEMANTICS AND CONTRACTS living in the tool descriptions (the
// netlist contract in spectre_pre_check's, the scheduler matrix / lsf_node /
// overwrite / no_pre_check in batch_submit's, the poll cadence ladder and the
// analyze recipe in batch_poll's, the report schema in gen_sweep_report's).
// The Write row opens with the design-folder organization (D-021: one folder
// per design, the project root holds only .harnessams, AGENTS.md, and design
// folders). The only remaining cluster_env fork is the Analyze row's Tool
// cell. ASCII-only by the block's language ruling; one line per table row.
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
  // tools named per row
  assert.ok(t.includes('| spectre_pre_check |'))
  assert.ok(t.includes('| batch_submit |'))
  assert.ok(t.includes('| batch_poll |'))
  assert.ok(t.includes('| gen_sweep_report |'))
})

test('workflowTable: the Write row opens with the design-folder organization (D-021)', () => {
  const t = workflowTable(S())
  const write = t.split('\n').find((l) => l.startsWith('| Write |'))
  assert.match(write, /create the design folder first \(<project>\/<design>, e\.g\. Pi12dB/)
  assert.match(write, /the project root holds only \.harnessams, AGENTS\.md, and design folders/)
  assert.match(write, /then the run dir directly under it: template\*\.scs \+ sweep_config\.json/)
  // D-021 dedup: the netlist authoring contract lives in the tool description,
  // the row only points at it (no value-form rules, no temperature default)
  assert.match(write, /per the netlist contract \(the spectre_pre_check description/)
  // batch_submit runs the gate itself — a separate validation call is optional
  assert.match(write, /batch_submit runs the same gate before staging/)
})

test('workflowTable: the Submit row is a purpose pointer, parameter semantics stay in batch_submit description', () => {
  const t = workflowTable(S())
  const submit = t.split('\n').find((l) => l.startsWith('| Submit |'))
  assert.match(submit, /omit machine_id \/ remote_root \/ remote_python \(they resolve from this config\)/)
  assert.match(submit, /scheduler per cluster_env, lsf_node, overwrite, no_pre_check\) are documented in the batch_submit description/)
  // the table never repeats a yaml value
  const PIN = '/opt/tools/python3/bin/python3'
  const pinned = workflowTable(S({ run_mode: 'remote', remote_python: PIN }))
  assert.ok(!pinned.includes(PIN), 'the table never repeats a pin value')
})

test('workflowTable: the Monitor row points at the cadence, does not carry it', () => {
  const t = workflowTable(S())
  const monitor = t.split('\n').find((l) => l.startsWith('| Monitor |'))
  assert.match(monitor, /bounded wait_sec/)
  assert.match(monitor, /never blind-sleep/)
  assert.match(monitor, /cadence and progress-card refresh rules live in the batch_poll description/)
  assert.match(monitor, /terminal states auto-fetch the light results/)
})

test('workflowTable: the Analyze row keeps the one cluster_env fork (Tool cell) and points at the recipe', () => {
  const outC = workflowTable(S())
  const inC = workflowTable(S({ cluster_env: 'in-cluster' }))
  const outRow = outC.split('\n').find((l) => l.startsWith('| Analyze |'))
  const inRow = inC.split('\n').find((l) => l.startsWith('| Analyze |'))
  assert.match(outRow, /\| ssh_exec \+ ssh_download \|/, 'out-of-cluster analyze over ssh')
  assert.match(inRow, /\| python \(direct\) \|/, 'in-cluster analyze runs python directly')
  // the recipe (parser paths, interpreter rule, never-bare-python) moved to
  // the batch_poll description; the row points at the remote_python row only
  assert.match(outRow, /write compact JSON into <design>\/SimResults\//)
  assert.match(outRow, /the full recipe: staged parser paths, the interpreter per the remote_python row/)
})

test('workflowTable: the Report row points at the schema and names the design layout', () => {
  const t = workflowTable(S())
  const report = t.split('\n').find((l) => l.startsWith('| Report |'))
  assert.match(report, /spec = path to the report spec JSON, placed in <design>\/SimResults\//)
  assert.match(report, /schema and output layout live in the gen_sweep_report description/)
  assert.match(report, /conclusions land in the session dashboard/)
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
