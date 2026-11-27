// In-flight poll frame store contract: set/get/delete under the tool call id,
// tick overwrite, insertion-order prune, and the test reset seam.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  setPollFrame, getPollFrame, deletePollFrame, resetPollFramesForTest,
} from '../src/core/pollframes.js'

test('pollframes: set, read and delete a frame under its call id', () => {
  resetPollFramesForTest()
  try {
    setPollFrame('c1', 'D:/proj/sweep/Round1/top', { state: 'running', completed: 1 })
    const hit = getPollFrame('c1')
    assert.ok(hit, 'a stored frame reads back under its call id')
    assert.equal(hit.runDir, 'D:/proj/sweep/Round1/top')
    assert.equal(hit.frame.state, 'running')
    assert.equal(hit.frame.completed, 1)
    assert.ok(hit.ts > 0)
    deletePollFrame('c1')
    assert.equal(getPollFrame('c1'), null, 'a deleted frame is gone')
    deletePollFrame('c1') // deleting an absent id is a no-op
  } finally {
    resetPollFramesForTest()
  }
})

test('pollframes: a later tick overwrites the same call id', () => {
  resetPollFramesForTest()
  try {
    setPollFrame('c1', 'D:/proj/run', { state: 'submitted', completed: 0 })
    setPollFrame('c1', 'D:/proj/run', { state: 'running', completed: 2 })
    const hit = getPollFrame('c1')
    assert.equal(hit.frame.state, 'running')
    assert.equal(hit.frame.completed, 2)
  } finally {
    resetPollFramesForTest()
  }
})

test('pollframes: the cap prunes the oldest entries in insertion order', () => {
  resetPollFramesForTest()
  try {
    for (let i = 0; i < 69; i++) setPollFrame('c' + i, 'D:/proj/run' + i, { state: 'running' })
    assert.equal(getPollFrame('c0'), null, 'the first inserted entry is pruned first')
    assert.equal(getPollFrame('c4'), null)
    assert.ok(getPollFrame('c5'), 'entries within the cap survive')
    assert.ok(getPollFrame('c68'))
  } finally {
    resetPollFramesForTest()
  }
})
