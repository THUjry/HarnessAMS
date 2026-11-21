// Bundled-skill registration tests (2026-11-21 wave): frontmatter parsing,
// the catalog shape (name + description + directory resourceBase — only the
// catalog lines are model-facing; bodies load on demand), and fail-open on a
// missing ctx.skills or a broken SKILL.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundledSkills, readSkillManifest, registerSkills } from '../src/skills.js'

test('skills: the packaged skills register with catalog metadata and a directory resourceBase', () => {
  const reg = []
  const names = registerSkills({ skills: { register: (s) => reg.push(s) } })
  assert.deepEqual(names, ['dca-design', 'smart-spectre'])
  assert.equal(reg.length, 2)
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

test('skills: the dca-design resources referenced by its body all exist', () => {
  const skill = bundledSkills().find((x) => x.name === 'dca-design')
  assert.ok(skill && !skill.error, skill?.error ?? 'dca-design missing')
  // the concrete resources the workflow and templates section point at
  for (const rel of [
    'templates/template_ST.scs', 'templates/template_T.scs', 'templates/template_Pi.scs',
    'scripts/calc_simplet.py', 'scripts/calc_t_type.py', 'scripts/calc_pi.py',
    'data/sky130/nfet_switch.json', 'data/sky130/resistors.json',
    'data/sky130/mimcap.json', 'data/sky130/pi8db_reference.json',
  ]) {
    assert.ok(fs.existsSync(path.join(skill.dir, rel)), `missing resource ${rel}`)
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
