// workflowTable (server/selfcheckWorkflow.js) — the recommended-workflow table
// rendered into the AGENTS.md project-config block on values builds. The
// 2026-11-24 rework replaced the five prose self-check branches with ONE
// table: five rows (Assemble/Submit/Monitor/Analyze/Report), columns Step |
// Tool | Model fills, cluster_env forking only the scheduler and analyze
// cells. ASCII-only by the block's language ruling; one line per table row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowTable } from '../src/server/selfcheckWorkflow.js'

const S = (over = {}) => ({
  cluster_env: 'out-of-cluster', run_mode: 'local', scheduler: 'lsf', simulator: 'spectre',
  compute_script_local: 'python', compute_script_remote: 'python',
  machine_id: null, remote_root: null, remote_dir: '.harnessams/selfcheck',
  ...over,
})

test('workflowTable: five rows, three columns, header shape', () => {
  const t = workflowTable(S())
  assert.ok(t.includes('### Recommended workflow'), 'heading')
  assert.ok(t.includes('| Step | Tool | Model fills |'), 'header row')
  assert.ok(t.includes('| --- | --- | --- |'), 'separator row')
  for (const step of ['Assemble', 'Submit', 'Monitor', 'Analyze', 'Report']) {
    assert.ok(t.includes(`| ${step} |`), `row ${step}`)
  }
  // tools named per row
  assert.ok(t.includes('| spectre_assemble |'))
  assert.ok(t.includes('| batch_submit |'))
  assert.ok(t.includes('| batch_poll |'))
  assert.ok(t.includes('| gen_sweep_report |'))
})

test('workflowTable: params the yaml already states are deliberately absent, machine/root resolve from config', () => {
  const t = workflowTable(S())
  const submit = t.split('\n').find((l) => l.startsWith('| Submit |'))
  assert.match(submit, /Omit machine_id \/ remote_root \/ remote_dir \/ remote_python: they resolve from this config/)
  assert.ok(!submit.includes('machine_id ='), 'no machine_id fill guidance')
})

test('workflowTable: monitor row carries the polling cadence (moved out of the system prompt)', () => {
  const t = workflowTable(S())
  const monitor = t.split('\n').find((l) => l.startsWith('| Monitor |'))
  assert.match(monitor, /never blind-sleep/)
  assert.match(monitor, /10 s -> 20 s -> 40 s/)
  assert.match(monitor, /every 5 s/)
})

test('workflowTable: cluster_env forks the scheduler and analyze cells', () => {
  const outC = workflowTable(S())
  const inC = workflowTable(S({ cluster_env: 'in-cluster' }))
  assert.match(outC, /"local" is unavailable out-of-cluster/)
  assert.ok(!inC.includes('unavailable out-of-cluster'), 'in-cluster has local')
  assert.match(inC, /scheduler = "lsf" \(default, bsub on this host\)/)
  // analyze: remote-first triple out-of-cluster, direct python in-cluster
  const outRow = outC.split('\n').find((l) => l.startsWith('| Analyze |'))
  const inRow = inC.split('\n').find((l) => l.startsWith('| Analyze |'))
  // pinned or not, the interpreter is the yaml's remote_python row (D-016),
  // never a path of the table's own
  assert.match(outRow, /remote_python row/)
  assert.match(outRow, /never bare python/)
  assert.match(inRow, /python \(direct\)/)
  assert.match(inRow, /shared filesystem/)
})

test('workflowTable: toolchain pins (D-016) — submit omits remote_python, analyze follows the remote_python row', () => {
  const PIN = '/opt/tools/python3/bin/python3'
  const unpinnedOut = workflowTable(S({ run_mode: 'remote' }))
  const unpinnedIn = workflowTable(S({ run_mode: 'remote', cluster_env: 'in-cluster' }))
  const unpinnedInLocal = workflowTable(S({ run_mode: 'local', cluster_env: 'in-cluster' }))
  const pinnedOut = workflowTable(S({ run_mode: 'remote', remote_python: PIN }))
  const pinnedIn = workflowTable(S({ run_mode: 'remote', cluster_env: 'in-cluster', remote_python: PIN }))
  const submit = (t) => t.split('\n').find((l) => l.startsWith('| Submit |'))
  const analyze = (t) => t.split('\n').find((l) => l.startsWith('| Analyze |'))
  for (const t of [unpinnedOut, unpinnedIn, unpinnedInLocal, pinnedOut, pinnedIn]) {
    assert.match(submit(t), /do not pass --spectre-cmd/, 'the pinned spectre rides along by itself')
    assert.ok(!submit(t).includes(PIN) && !analyze(t).includes(PIN), 'the table never repeats a yaml value')
    assert.match(analyze(t), /remote_python row/, 'pinned or not, the cell points at the row')
  }
  // pinned: the interpreter is whatever the yaml row says
  assert.match(analyze(pinnedOut), /ssh_exec them with the interpreter named by the remote_python row of the yaml above; never bare python/)
  assert.match(analyze(pinnedIn), /with the interpreter named by the remote_python row of the yaml above: <workspace_root>\/\.harnessams\/scripts\/spectre\/spectre_psf_parse\.py/)
  // unpinned: the bare default each chain really runs under, stated as such
  assert.match(analyze(unpinnedOut), /which is null here: use bare python3, the unpinned default the self-check verified/)
  assert.match(analyze(unpinnedIn), /which is null here: use bare python3, the unpinned default the self-check verified/)
  assert.match(analyze(unpinnedInLocal), /which is null here: use bare python, the unpinned default the self-check verified/,
    'the in-cluster local chain spawns python')
})

test('workflowTable: unknown/partial settings normalize to the defaults', () => {
  assert.ok(workflowTable({}).includes('unavailable out-of-cluster'))
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
