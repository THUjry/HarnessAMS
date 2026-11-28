// Safety-rules gate contract: the three always-on deny red lines (a
// standalone ssh token in a bash/pwsh command; a PDK string in a read
// file_path or an ssh_download remote/local path) versus the passthrough
// for everything else, plus the waterfall registration shape — a deny
// short-circuits before next(), a non-match delegates, and a ctx without
// .on registers nothing.
// Run: bare `node --test` from the repo root.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideSafety, registerSafetyGate, SSH_DENY_REASON, PDK_DENY_REASON,
} from '../src/core/safetyrules.js'

const call = (name, args) => ({ name, arguments: args })

test('safetyrules: a standalone ssh token in a bash/pwsh command is denied in every position and nesting', () => {
  const commands = [
    'ssh op@node6',
    'ssh -n node6 hostname',
    'ls; ssh node6 hostname',
    'echo start && ssh node6 bjobs',
    'echo hi | ssh node6 hostname',
    'out=$(ssh node6 hostname)',
    'bash -c "ssh node6 hostname"',
    'echo first\nssh node6 hostname',
    '(ssh node6 hostname)',
    './ssh node6 hostname',
    'grep ssh dsh-ssh-config.txt',
    'echo use ssh tools instead',
  ]
  for (const command of commands) {
    for (const name of ['bash', 'pwsh']) {
      const d = decideSafety(call(name, { command }))
      assert.equal(d?.kind, 'deny', `expected deny for ${name}: ${JSON.stringify(command)}`)
      assert.equal(d.reason, SSH_DENY_REASON)
    }
  }
})

test('safetyrules: ssh-shaped tokens that are not the ssh binary do not trip the rule', () => {
  const commands = [
    'cat ~/.dsh/dsh-ssh.json',
    'ssh-keygen -t ed25519 -f key',
    'sshpass -p secret sshcmd --help',
    'grep -c ssh_exec sessions.jsonl',
    'cat notes.ssh today',
    'less ssh.conf',
    'dsh plugin --profile web add @linxin666/dsh-ssh@0.4.20',
  ]
  for (const command of commands) {
    for (const name of ['bash', 'pwsh']) {
      assert.equal(
        decideSafety(call(name, { command })), null,
        `expected pass for ${name}: ${JSON.stringify(command)}`,
      )
    }
  }
})

test('safetyrules: a PDK string in a read file_path is denied case-insensitively', () => {
  for (const file_path of [
    'D:/proj/OpenPDK/sky130A/models/sky130.scs',
    '/home/op/pdk/sky130A/lib/libsky130.a',
    'D:\\Documents\\Zcode\\OpenPDK\\sky130_spectre\\sky130.scs',
    'notes.PDK.md',
  ]) {
    const d = decideSafety(call('read', { file_path }))
    assert.equal(d?.kind, 'deny', `expected deny for ${file_path}`)
    assert.equal(d.reason, PDK_DENY_REASON)
  }
  assert.equal(decideSafety(call('read', { file_path: 'D:/proj/att/tb_att.scs' })), null)
})

test('safetyrules: an ssh_download is denied on a PDK remote or local path, not on a PDK-shaped alias', () => {
  const base = {
    alias: 'node6',
    remotePath: '/home/op/runs/att/sweep_progress.json',
    localPath: 'D:/proj/att/SimResults/sweep_progress.json',
  }
  assert.equal(decideSafety(call('ssh_download', base)), null)
  assert.equal(decideSafety(call('ssh_download', { ...base, remotePath: '/tools/pdk/sky130A/lib.lib' }))?.kind, 'deny')
  assert.equal(decideSafety(call('ssh_download', { ...base, localPath: 'D:/proj/PDK/dump.bin' }))?.kind, 'deny')
  assert.equal(decideSafety(call('ssh_download', { ...base, alias: 'pdk-node' })), null)
})

test('safetyrules: calls outside the three rules, and malformed call shapes, pass through', () => {
  assert.equal(decideSafety(null), null)
  assert.equal(decideSafety({ name: 'bash' }), null)
  assert.equal(decideSafety(call('bash', undefined)), null)
  assert.equal(decideSafety({ name: 'bash', arguments: 'not-an-object' }), null)
  assert.equal(decideSafety(call('bash', {})), null)
  assert.equal(decideSafety(call('write', { file_path: 'D:/proj/PDK/notes.md' })), null)
  assert.equal(decideSafety(call('ssh_exec', { alias: 'node6', command: 'cat /pdk/model.lib' })), null)
  assert.equal(decideSafety(call('ssh_upload', { alias: 'node6', localPath: 'D:/proj/PDK/x', remotePath: '/tmp/x' })), null)
})

test('safetyrules: the waterfall listener denies before next() and delegates otherwise', async () => {
  let handler = null
  const ctx = {
    on: (event, fn) => {
      assert.equal(event, 'tools/pre-execute')
      handler = fn
      return () => {}
    },
  }
  const disposer = registerSafetyGate(ctx)
  assert.equal(typeof disposer, 'function')
  assert.ok(handler)

  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }

  const denied = await handler(call('bash', { command: 'ssh node6 hostname' }), next)
  assert.equal(nextCalls, 0)
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.reason, SSH_DENY_REASON)

  const passed = await handler(call('bash', { command: 'ls -la' }), next)
  assert.equal(nextCalls, 1)
  assert.deepEqual(passed, { kind: 'allow' })

  assert.equal(registerSafetyGate({}), undefined)
})
