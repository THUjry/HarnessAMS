// Unit tests for the host-half server modules (tier 2 mapping, task store,
// nodes.yaml roundtrip, asset status). Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseNodesYaml, validateNodes, writeNodes, readNodes } from '../src/server/workspace.js'
import { sessionProject, readTasks, writeTasks, tasksPath } from '../src/server/project.js'
import { assetsStatus } from '../src/server/assets.js'

test('nodes: parse -> validate -> write -> re-read roundtrip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-nodes-'))
  try {
    const yaml = [
      '# comment that will be lost on rewrite',
      'nodes:',
      '  - HOST: login',
      '    HOSTNAME: 192.0.2.9',
      '    PORT: 22',
      '    WORKSPACE: /home/user/sim',
      '    reserved: false',
    ].join('\n')
    const file = path.join(dir, 'nodes.yaml')
    await writeFile(file, yaml, 'utf8')
    const parsed = parseNodesYaml(await readFile(file, 'utf8'))
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].HOST, 'login')

    const v = validateNodes([{ HOST: 'login', HOSTNAME: '192.0.2.9', PORT: 22, WORKSPACE: '/home/user/sim', reserved: 'false' }])
    assert.ok(!v.error, v.error)
    writeNodes(file, v.nodes)
    const again = readNodes(dir).nodes
    assert.equal(again.length, 1)
    assert.equal(again[0].HOST, 'login')
    assert.equal(again[0].PORT, '22') // numbers normalize to strings
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('nodes: validation rejects bad input', () => {
  assert.ok(validateNodes([]).nodes)
  assert.ok(validateNodes([{ HOST: '' }]).error)
  assert.ok(validateNodes([{ HOST: 'a' }, { HOST: 'a' }]).error) // duplicate
  assert.ok(validateNodes([{ HOST: 'a; rm -rf' }]).error) // charset
  assert.ok(validateNodes([{ HOST: 'a', PORT: 'abc' }]).error)
  assert.ok(validateNodes([{ HOST: 'a', reserved: 'maybe' }]).error)
  assert.ok(validateNodes('nope').error)
})

test('project: sessionProject maps over the workspace registry', () => {
  const registry = {
    list: () => [
      { id: 'w1', path: 'D:/p1', title: 'P1', sessionIds: ['s1', 's2'] },
      { id: 'w2', path: 'D:/p2', title: 'P2', sessionIds: ['s3'] },
    ],
  }
  assert.deepEqual(sessionProject(registry, 's2').project, { id: 'w1', path: 'D:/p1', title: 'P1' })
  assert.equal(sessionProject(registry, 's404').project, null)
  assert.ok(sessionProject(registry, 's404').reason)
  assert.ok(sessionProject(null, 's1').reason) // service missing -> degrade, not throw
  assert.ok(sessionProject(registry, null).reason) // missing sessionId
})

test('tasks: read-missing is empty, write->read roundtrip, validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hams-tasks-'))
  try {
    assert.deepEqual((await readTasks(dir)).tasks, [])

    const r = await writeTasks(dir, [{ name: 'OTA migration', description: 'all flavors' }])
    assert.ok(!r.error, r.error)
    assert.match(r.tasks[0].id, /^task-/)
    const read1 = await readTasks(dir)
    assert.equal(read1.tasks.length, 1)
    assert.equal(read1.tasks[0].name, 'OTA migration')
    const firstId = read1.tasks[0].id
    const firstCreated = read1.tasks[0].created_at

    // rewrite keeps server-assigned identity and created_at
    const r2 = await writeTasks(dir, [{ id: firstId, name: 'OTA migration', description: 'updated' }, { name: 'new one' }])
    assert.ok(!r2.error, r2.error)
    const read2 = await readTasks(dir)
    assert.equal(read2.tasks.length, 2)
    assert.equal(read2.tasks[0].id, firstId)
    assert.equal(read2.tasks[0].created_at, firstCreated)
    assert.equal(read2.tasks[0].description, 'updated')

    assert.ok((await writeTasks(dir, [{ name: '' }])).error)
    assert.ok((await writeTasks(dir, 'nope')).error)
    assert.ok(path.basename(tasksPath(dir)), 'tasks.json')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('assets: plotly status reflects the shipped file', async () => {
  const st = assetsStatus()
  assert.equal(typeof st.plotly.available, 'boolean')
  assert.equal(st.plotly.url, '/harnessams/assets/plotly.min.js')
  // in the repo checkout the file must be present and large
  assert.ok(st.plotly.available, 'plotly.min.js missing from src/assets')
  assert.ok(st.plotly.bytes > 4_000_000)
})
