// Basic execution-safety gate: a tools/pre-execute waterfall listener with
// three always-on deny rules. Fixed red lines, deliberately NOT config-gated
// and with no escape hatch — the tiered remoteExecGate (D-007) is a separate,
// still-unimplemented design for the remote command surface. Every rule
// follows the pre-execute method: the deny reason reaches the model as the
// tool result (why it is denied + what to do instead), and anything the
// rules do not match falls through to next() untouched.
//   1. bash/pwsh: a standalone `ssh` token anywhere on the command line —
//      raw shell ssh bypasses the dsh-ssh channel (credential handling,
//      logging, connection reuse); the dsh-ssh tools are the only
//      sanctioned remote route.
//   2. read: a file_path containing "PDK" (case-insensitive).
//   3. ssh_download: a remotePath or localPath containing "PDK".
// The PDK rules enforce the hard isolation line: the assembly layer is the
// only channel that ever touches PDK content.
// The ssh token match is deliberately broad (any standalone occurrence,
// including argument positions and quoted/nested forms like `bash -c "ssh
// …"`) so the gate cannot be routed around by re-nesting — a gate that
// fails open on the obvious evasions just turns denial into a guessing
// game. The boundary classes keep near-miss tokens out: `dsh-ssh`,
// `ssh-keygen`, `sshpass`, `ssh_exec`, `x.ssh` and `ssh.conf` do not trip.
// Self-flow: this plugin's own remote funnel calls ssh_exec/ssh_upload/
// ssh_download through ctx.tools and passes this gate too; its downloads
// are sweep results under remote_root, never PDK paths, so no self-trip.
// (covered by tests/safetyrules.test.mjs)

const SSH_TOKEN = /(^|[^A-Za-z0-9_.-])ssh(\s|["']|$)/

export const SSH_DENY_REASON =
  'HarnessAMS safety gate: raw shell ssh is denied. The dsh-ssh tools ' +
  '(ssh_exec/ssh_upload/ssh_download) through the plugin chain are the only ' +
  'sanctioned remote route — credentials, logging and connection reuse live ' +
  'there. Do not retry ssh in another form; if the dsh-ssh chain is broken, ' +
  'stop and ask the user.'

export const PDK_DENY_REASON =
  'HarnessAMS safety gate: PDK paths are denied (PDK hard isolation — the ' +
  'assembly layer is the only channel that touches PDK content). Do not read ' +
  'or download PDK files; reuse the include lines already present in existing ' +
  'simulation logs, or ask the user for the model info you need.'

function containsPdk(value) {
  return typeof value === 'string' && value.toLowerCase().includes('pdk')
}

// Pure decision for one pending tool call: { kind: 'deny', reason } when a
// red line matches, null otherwise. exec.arguments can be undefined (a
// missing or failed argument snapshot) — that is a no-match, never a throw.
export function decideSafety(exec) {
  if (!exec || typeof exec !== 'object') return null
  const args = exec.arguments
  if (args === undefined || args === null || typeof args !== 'object') return null
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (SSH_TOKEN.test(command)) return { kind: 'deny', reason: SSH_DENY_REASON }
  } else if (exec.name === 'read') {
    if (containsPdk(args.file_path)) return { kind: 'deny', reason: PDK_DENY_REASON }
  } else if (exec.name === 'ssh_download') {
    if (containsPdk(args.remotePath) || containsPdk(args.localPath)) {
      return { kind: 'deny', reason: PDK_DENY_REASON }
    }
  }
  return null
}

// Waterfall registration: a deny short-circuits before next() (the rest of
// the pre-execute chain and the tool body never run); everything else
// delegates. Sync-fast — no await before the decision, so exec.signal
// observation is moot. Belt-and-braces against embeds without ctx.on.
export function registerSafetyGate(ctx) {
  if (typeof ctx?.on !== 'function') return
  return ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = decideSafety(exec)
    if (decision) return decision
    return next()
  })
}
