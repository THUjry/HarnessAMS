// In-flight poll frames keyed by tool call id (D-004): while a blocking
// batch_poll call ticks, every parsed frame is published here under the
// call's exec.callId — the host mints that id at dispatch (the dsh-tools
// pipeline) and the session card's toolview owner carries the same one, so
// /api/progress-remote can serve the card the tool's own latest frame
// straight from memory, zero exec on the read side: one poller, every reader
// of that call. An entry lives exactly as long as the call — the tool deletes
// it in a finally on settle whatever the outcome — so existence IS the
// in-flight signal: no TTL, and settled or replayed cards simply miss and
// fall back to the endpoint's own poll. The cap is only a leak guard
// (insertion-order prune, the progressRemote.js remoteCache idiom).
// Pure module state, no ctx coupling — tools/ and server/ import it directly
// (the core/progress_files.js precedent).
// (covered by tests/pollframes.test.mjs — the store contract; the write and
// read sides by tests/batch.test.mjs and tests/progress.test.mjs)
const STORE_MAX = 64
const frames = new Map() // callId -> { ts, runDir, frame }

export function setPollFrame(callId, runDir, frame) {
  frames.set(String(callId), { ts: Date.now(), runDir, frame })
  if (frames.size > STORE_MAX) {
    // Insertion-order prune: drop the oldest entry (first Map key).
    frames.delete(frames.keys().next().value)
  }
}

export function getPollFrame(callId) {
  return frames.get(String(callId)) ?? null
}

export function deletePollFrame(callId) {
  frames.delete(String(callId))
}

// Test seam: the store is module state; tests reset it between cases.
export function resetPollFramesForTest() {
  frames.clear()
}
