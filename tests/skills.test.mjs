// Bundled-skill registration tests (2026-11-21 wave): frontmatter parsing,
// the catalog shape (name + description + directory resourceBase — only the
// catalog lines are model-facing; bodies load on demand), and fail-open on a
// missing ctx.skills or a broken SKILL.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundledSkills, readSkillManifest, registerSkills } from '../src/skills.js'

test('skills: the packaged skills register with catalog metadata and a directory resourceBase', () => {
  const reg = []
  const names = registerSkills({ skills: { register: (s) => reg.push(s) } })
  assert.deepEqual(names, ['batch-sweep', 'cluster-setup', 'dca-cascade-analysis', 'dca-cell-design'])
  assert.equal(reg.length, 4)
  for (const s of reg) {
    assert.match(s.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) // the kebab-case grammar
    assert.ok(s.description.length > 20 && s.description.length <= 500,
      `description length ${s.description.length}`)
    assert.equal(s.source, 'bundled')
    assert.equal(s.resourceBase.kind, 'directory')
    assert.ok(fs.existsSync(path.join(s.resourceBase.path, 'SKILL.md')))
    assert.ok(!s.content.startsWith('---'), 'frontmatter is stripped from the body')
    assert.ok(s.content.length > 1000, 'body is substantial')
  }
})

test('skills: cluster-setup is harvest, verify, pin: read-only, through ssh_exec, no path to guess', () => {
  const s = bundledSkills().find((x) => x.name === 'cluster-setup')
  assert.ok(s && !s.error, s?.error ?? 'cluster-setup missing')
  const { description, content } = s.manifest
  assert.match(description, /harvest/i)
  // the three stages, in order
  const i1 = content.indexOf('Stage 1')
  const i2 = content.indexOf('Stage 2')
  const i3 = content.indexOf('Stage 3')
  assert.ok(0 <= i1 && i1 < i2 && i2 < i3, 'harvest, verify, pin: in that order')
  // stage 1 keeps the whole startup chain including the alias line (a lead to
  // harvest, not something to delete); stage 2 probes with command -v; stage 3
  // pins through the self-check's partial settings write
  for (const needle of ['~/.bashrc', '~/.bash_profile', '/etc/profile.d', 'alias python3=',
    'command -v spectre', 'remote_python', 'remote_spectre_cmd', 'ssh_exec', 'never raw shell ssh',
    'harnessams_selfcheck { action: "run", settings: { remote_python:',
    // the host is not visible to a model: take it from the user or ask
    'ask which configured host',
    // a spectre candidate has a version probe of its own
    '<spectre candidate> -V']) {
    assert.ok(content.includes(needle), `cluster-setup lost "${needle}"`)
  }
  // probes go through ssh_exec: no raw shell ssh, no host placeholder to guess
  assert.ok(!/ssh <[a-z]+>/.test(content), 'no raw shell ssh probe')
  assert.ok(!/absolute path, always/.test(content), 'the old always-absolute stance is gone')
  assert.ok(!content.includes('module list'), 'the interactive-only module list probe is gone')
  assert.ok(/^[\x00-\x7F]*$/.test(content), 'ASCII-only skill body')
})

test('skills: the resources referenced by each skill body all exist', () => {
  const byName = Object.fromEntries(bundledSkills().map((s) => [s.name, s]))
  const cell = byName['dca-cell-design']
  assert.ok(cell && !cell.error, cell?.error ?? 'dca-cell-design missing')
  for (const rel of [
    'sky130_examples/sky130proc/template_ST.scs', 'sky130_examples/sky130proc/template_T.scs',
    'sky130_examples/sky130proc/template_Pi.scs', 'sky130_examples/sky130proc/sky130_fd_pr__nfet_01v8_lvt.scs',
    'sky130_examples/sky130proc/nfet_switch.json', 'sky130_examples/sky130proc/nfet_ron_coff.csv',
    'sky130_examples/sky130proc/nfet_lvt_ron_coff.csv',
    'sky130_examples/Example.md',
    'sky130_examples/ST1/design.json', 'sky130_examples/ST1/sp_ref.sp', 'sky130_examples/ST1/sp_att.sp',
    'sky130_examples/T4/design.json', 'sky130_examples/T4/sp_ref.sp', 'sky130_examples/T4/sp_att.sp',
    'sky130_examples/Pi8/design.json', 'sky130_examples/Pi8/sp_ref.sp', 'sky130_examples/Pi8/sp_att.sp',
    'scripts/calc_simplet.py', 'scripts/calc_t_type.py', 'scripts/calc_pi.py',
    'scripts/gen_lvt_cards.py',
  ]) {
    assert.ok(fs.existsSync(path.join(cell.dir, rel)), `missing resource ${rel}`)
  }
  const cascade = byName['dca-cascade-analysis']
  assert.ok(cascade && !cascade.error, cascade?.error ?? 'dca-cascade-analysis missing')
  for (const rel of [
    'scripts/gen_cascade_report.py',
    'example/cell_st1.scs', 'example/cell_t2.scs', 'example/cell_t4.scs',
    'example/cell_pi8.scs', 'example/cascade.scs',
    'example/Analysis/data/Round1.js', 'example/Analysis/Cascade4bit_report.html',
  ]) {
    assert.ok(fs.existsSync(path.join(cascade.dir, rel)), `missing resource ${rel}`)
  }
})

// The 2026-11-24 reorganization moved nfet_switch.json down into sky130proc/
// and every calculator silently kept the old default — a model hit the
// FileNotFoundError at run time (2026-11-25 session). This guard resolves each
// DEFAULT_DATA_DIR the way the script would and asserts the data file exists.
test('skills: the calculators\' default data dir resolves at sky130proc', () => {
  const byName = Object.fromEntries(bundledSkills().map((s) => [s.name, s]))
  const cell = byName['dca-cell-design']
  assert.ok(cell && !cell.error, cell?.error ?? 'dca-cell-design missing')
  for (const script of ['calc_pi.py', 'calc_t_type.py', 'calc_simplet.py']) {
    const src = fs.readFileSync(path.join(cell.dir, 'scripts', script), 'utf8')
    const i = src.indexOf('DEFAULT_DATA_DIR')
    assert.ok(i >= 0, `${script} lost its DEFAULT_DATA_DIR definition`)
    // bound the slice by paren depth from normpath( — the expression nests
    // (abspath(__file__)), so a plain indexOf('))') would cut it open
    const open = src.indexOf('os.path.normpath(', i)
    assert.ok(open > i, `${script}: DEFAULT_DATA_DIR is not an os.path.normpath call`)
    let depth = 0, j = open + 'os.path.normpath('.length - 1
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') { depth--; if (depth === 0) { j++; break } }
    }
    const block = src.slice(i, j)
    assert.ok(block.includes("os.path.dirname(os.path.abspath(__file__))"),
      `${script}: the first join segment must anchor at the script dir`)
    assert.ok(/'sky130proc'/.test(block),
      `${script}: the default must resolve inside sky130_examples/sky130proc/`)
    // the quoted join segments resolve relative to the script dir, exactly the
    // way os.path.join would ('..','sky130_examples','sky130proc')
    const rel = [...block.matchAll(/'([^']*)'/g)].map((x) => x[1]).join('/')
    const dataDir = path.resolve(path.join(cell.dir, 'scripts'), rel)
    assert.ok(fs.existsSync(path.join(dataDir, 'nfet_switch.json')),
      `${script}: DEFAULT_DATA_DIR has no nfet_switch.json (${dataDir})`)
  }
})

test('skills: fail-open — no ctx.skills registers nothing; broken manifests skip individually', () => {
  assert.deepEqual(registerSkills({}), [])
  assert.deepEqual(registerSkills({ skills: {} }), [])

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hams-skills-'))
  try {
    fs.mkdirSync(path.join(dir, 'good'))
    fs.mkdirSync(path.join(dir, 'bad'))
    fs.writeFileSync(path.join(dir, 'good', 'SKILL.md'),
      '---\nname: good-skill\ndescription: a good one\n---\n# body\n')
    fs.writeFileSync(path.join(dir, 'bad', 'SKILL.md'), 'no frontmatter here\n')
    const reg = []
    const names = registerSkills({ skills: { register: (s) => reg.push(s.name) } }, dir)
    assert.deepEqual(names, ['good-skill'])
    assert.deepEqual(reg, ['good-skill'])

    const m = readSkillManifest(path.join(dir, 'good', 'SKILL.md'))
    assert.equal(m.name, 'good-skill')
    assert.equal(m.description, 'a good one')
    assert.equal(m.content, '# body\n')
    assert.match(readSkillManifest(path.join(dir, 'bad', 'SKILL.md')).error, /frontmatter/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('skills: folded (>) frontmatter descriptions join into one line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hams-skfold-'))
  try {
    fs.mkdirSync(path.join(dir, 'folded'))
    fs.writeFileSync(path.join(dir, 'folded', 'SKILL.md'),
      '---\nname: folded-skill\ndescription: >\n  Multi line\n  description text\n---\n# body\n')
    const m = readSkillManifest(path.join(dir, 'folded', 'SKILL.md'))
    assert.equal(m.description, 'Multi line description text')
    assert.equal(m.content, '# body\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('skills: gen_cascade_report smoke — synthetic 2-bit cascade in both input modes', () => {
  const gen = path.join(import.meta.dirname, '..', 'src', 'skills',
    'dca-cascade-analysis', 'scripts', 'gen_cascade_report.py')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hams-cascgen-'))
  const spText = (att) => {
    const lines = ['HEADER', '"number of ports" 2',
      '"PORT0:r" 5.0e+01', '"PORT0:num" 1', '"PORT1:r" 5.0e+01', '"PORT1:num" 2',
      'TRACE', '"freq" "sweep"', '"s11" "S-Param"', '"s21" "S-Param"',
      '"s22" "S-Param"', 'VALUE']
    for (let i = 1; i <= 5; i++) {
      const g = Math.pow(10, -att / 20)
      lines.push(`"freq" ${(i * 1e9).toExponential(15)}`)
      lines.push('"s11" (1.0e-01 1.0e-03)')
      lines.push(`"s21" (${g.toFixed(6)} 0.0)`)
      lines.push('"s22" (1.2e-01 -1.0e-03)')
    }
    lines.push('END')
    return lines.join('\n') + '\n'
  }
  const cascadeJson = JSON.stringify({
    cascade_name: 'Smoke2bit', temperature: 27,
    cells: [
      { name: 'A', folder: 'AttA', architecture: 'T-type', target_att_db: 2, control_bit: 0,
        bestPoints_params: {}, devices: [] },
      { name: 'B', folder: 'AttB', architecture: 'Pi-type', target_att_db: 4, control_bit: 1,
        bestPoints_params: {}, devices: [] },
    ],
  })
  const run = (args) => {
    const r = spawnSync('python', ['-B', gen, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, `generator failed:\n${r.stdout}\n${r.stderr}`)
    return r.stdout
  }
  try {
    // Results/RoundN mode
    const r1 = path.join(dir, 'ws', 'Results', 'Round1')
    fs.mkdirSync(r1, { recursive: true })
    for (let k = 0; k < 4; k++) {
      fs.writeFileSync(path.join(r1, `sp_${k.toString(2).padStart(2, '0')}.sp`),
        spText([0, 2, 4, 6][k]))
    }
    fs.writeFileSync(path.join(r1, 'cascade_cells.json'), cascadeJson)
    for (const cell of ['AttA', 'AttB']) {
      const top = path.join(dir, cell, 'top')
      fs.mkdirSync(top, { recursive: true })
      fs.writeFileSync(path.join(top, 'bestPoints.json'), '{"points": [{}]}')
    }
    const out1 = path.join(dir, 'out1')
    run([path.join(dir, 'ws'), '--out', out1, '--cells-base', dir])
    const js1 = fs.readFileSync(path.join(out1, 'data', 'Round1.js'), 'utf8')
    assert.match(js1, /"ref_ctrl":"00"/)
    assert.match(js1, /"traces":\[/)
    const html1 = fs.readFileSync(path.join(out1, 'Smoke2bit_report.html'), 'utf8')
    assert.match(html1, /Worst Match - max\(S11,S22\) \(dB\)/)

    // --run-dir mode (NN/netlist.scs.raw/sp.sp, NN = control word value)
    const rd = path.join(dir, 'rundir')
    for (let k = 0; k < 4; k++) {
      const raw = path.join(rd, String(k).padStart(2, '0'), 'netlist.scs.raw')
      fs.mkdirSync(raw, { recursive: true })
      fs.writeFileSync(path.join(raw, 'sp.sp'), spText([0, 2, 4, 6][k]))
    }
    fs.writeFileSync(path.join(rd, 'cascade_cells.json'), cascadeJson)
    const out2 = path.join(dir, 'out2')
    run(['--run-dir', rd, '--out', out2])
    const js2 = fs.readFileSync(path.join(out2, 'data', 'rundir.js'), 'utf8')
    // both modes see the same states; expected_db maps 01 -> 2 dB, 10 -> 4 dB
    assert.match(js2, /"ctrl":"11"/)
    const acc = JSON.parse(js2.replace(/^var ROUND_DATA = /, '').replace(/;\s*$/, '')).acc
    assert.deepEqual(acc.map((a) => a.expected), [0, 2, 4, 6])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
