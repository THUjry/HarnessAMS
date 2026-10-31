// Terminal sub-tab static contracts: the client half is a combo-loaded classic script
// (no ESM import), so the remote-terminal feature is asserted against the source text
// and the vendored assets — the same discipline as entry.test.mjs.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const src = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const assetsSrc = await readFile(new URL('../src/server/assets.js', import.meta.url), 'utf8')

test('terminal: TASK_VIEWS carries the term entry and both dictionaries match keys', () => {
  assert.ok(/id: 'term', labelKey: 'tasks\.viewTerm'/.test(src), 'TASK_VIEWS must include the term view')
  // zh and en segments must each define the full term.* key set (identical key sets)
  for (const key of ['tasks.viewTerm', 'term.noMachines', 'term.reopen', 'term.dead', 'term.closed',
    'term.startDir', 'term.noSession', 'term.search', 'term.snippets', 'term.loading',
    'term.vendorFail', 'term.unavailable', 'term.infoMissing']) {
    const hits = src.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `dictionary key ${key} must exist exactly twice (zh + en), found ${hits}`)
  }
})

test('terminal: rides dsh-remote term routes with the borrowed-session binding hint', () => {
  assert.ok(src.includes("'/dsh-remote/term'"), 'must target dsh-remote term API (no SSH layer of our own)')
  // every term route call passes the machine's live-session id as the binding hint
  assert.ok(/sessionId: m\.sessionId/.test(src), 'POST term calls must carry the binding hint')
  assert.ok(/'&sessionId=' \+ encodeURIComponent\(m\.sessionId\)/.test(src), 'GET term/output must carry the binding hint')
  // a fresh session lands in the project root via a first cd input
  assert.ok(/cd '" \+ String\(m\.remotePath\)\.replace/.test(src), 'fresh sessions must cd into remotePath')
  // no exec surface: the client never posts to a harnessams terminal-exec route
  assert.ok(!src.includes('/api/term'), 'no plugin-owned terminal-exec route may exist')
})

test('terminal: xterm pooling, polling lifecycle and UX hooks are wired', () => {
  assert.ok(src.includes("TERM_POOL"), 'xterm instances must be pooled per machine')
  assert.ok(/'\/harnessams\/assets\/' \+ f/.test(src) && src.includes("'xterm.js'"), 'vendor bundle loaded from the whitelisted asset route')
  assert.ok(src.includes("'/harnessams/assets/xterm.css'"), 'vendor stylesheet loaded from the asset route')
  assert.ok(src.includes("setInterval(tick, 150)"), 'output polling loop present')
  assert.ok(src.includes('document.hidden'), 'polling must pause while the page is hidden')
  assert.ok(src.includes('TERM_FONT_KEY'), 'font zoom must persist')
  assert.ok(src.includes('onSelectionChange'), 'copy-on-select hook present')
  assert.ok(src.includes('ResizeObserver'), 'adaptive fit hook present')
  assert.ok(src.includes('search.findNext'), 'search addon wired')
  assert.ok(src.includes('visibilitychange'), 'poll wake on visibility change')
})

test('terminal: vendored assets exist and the whitelist serves them', async () => {
  for (const f of ['xterm.js', 'xterm.css', 'xterm-addon-fit.js', 'xterm-addon-search.js']) {
    const st = await stat(new URL('../src/assets/' + f, import.meta.url))
    assert.ok(st.size > 1000, `src/assets/${f} missing or too small`)
    assert.ok(assetsSrc.includes(`'${f}'`), `assets.js whitelist must include ${f}`)
  }
  assert.ok(assetsSrc.includes("'.css'"), 'assets.js must serve css')
  const notices = await readFile(new URL('../src/assets/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
  assert.ok(notices.includes('@xterm/xterm v5.5.0'), 'THIRD_PARTY_NOTICES.md must carry the xterm entry')
})
