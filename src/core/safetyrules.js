// Basic execution-safety gate: a tools/pre-execute waterfall listener with
// always-on deny rules over three red lines. Fixed red lines, deliberately
// NOT config-gated and with no escape hatch — the tiered remoteExecGate
// (D-007) is a separate, still-unimplemented design for the remote command
// surface. Every rule follows the pre-execute method: the deny reason
// reaches the model as the tool result (why it is denied + what to do
// instead), and anything the rules do not match falls through to next()
// untouched.
//   1. raw shell ssh: a standalone `ssh` token anywhere on the command line
//      of bash, pwsh or local_exec — raw shell ssh bypasses the dsh-ssh
//      channel (credential handling, logging, connection reuse); the dsh-ssh
//      tools are the only sanctioned remote route.
//   2. PDK reads: a `read` file_path containing "PDK" (case-insensitive).
//   3. PDK moves: an `ssh_download` remotePath/localPath, or a `local_exec`
//      command (the local host shell — the one local surface that could
//      reach PDK content), containing "PDK".
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
// The automation local channel's local_exec calls pass here as well — its
// command is watched exactly like bash/pwsh, so a task line cannot carry
// raw ssh or PDK strings either.
// (covered by tests/safetyrules.test.mjs)

const SSH_TOKEN = /(^|[^A-Za-z0-9_.-])ssh(\s|["']|$)/
const PDK_TOKEN = /pdk/i

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

// One row per watched field: a rule names the tool, the argument field it
// watches, the pattern a red-line value must carry, and the deny reason.
// ssh_download watches two fields and local_exec carries two patterns on its
// one field, so each gets two rows. Adding a red line is adding a row —
// decideSafety is the single generic loop that reads it.
const RULES = [
  { tool: 'bash',         field: 'command',    pattern: SSH_TOKEN, reason: SSH_DENY_REASON },
  { tool: 'pwsh',         field: 'command',    pattern: SSH_TOKEN, reason: SSH_DENY_REASON },
  { tool: 'local_exec',   field: 'command',    pattern: SSH_TOKEN, reason: SSH_DENY_REASON },
  { tool: 'read',         field: 'file_path',  pattern: PDK_TOKEN, reason: PDK_DENY_REASON },
  { tool: 'ssh_download', field: 'remotePath', pattern: PDK_TOKEN, reason: PDK_DENY_REASON },
  { tool: 'ssh_download', field: 'localPath',  pattern: PDK_TOKEN, reason: PDK_DENY_REASON },
  { tool: 'local_exec',   field: 'command',    pattern: PDK_TOKEN, reason: PDK_DENY_REASON },
]

// Pure decision for one pending tool call: { kind: 'deny', reason } when a
// red line matches, null otherwise. exec.arguments can be undefined (a
// missing or failed argument snapshot) — that is a no-match, never a throw.
export function decideSafety(exec) {
  const args = exec?.arguments
  if (args === undefined || args === null || typeof args !== 'object') return null
  for (const { tool, field, pattern, reason } of RULES) {
    if (exec.name !== tool) continue
    const value = args[field]
    if (typeof value === 'string' && pattern.test(value)) {
      return { kind: 'deny', reason }
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
