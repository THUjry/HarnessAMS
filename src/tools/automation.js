// config_automation + run_automation + local_exec — the automation tool trio
// (phase-2 automation feature; back end in core/automation.js). The split of faces:
//   config_automation — the CONFIGURATION face (add/update/delete automation
//     tasks in the project's automation.json): the natural way a user asks an
//     agent to set an automation up ("create an automation that deletes
//     ~/tmp/*"), and the only write face of the subsystem.
//   run_automation — the agent/debug RUN face: runs one automation by its
//     index key and returns the full result. The DEFAULT trigger is manual —
//     the sidebar list's run button (which goes through POST
//     /api/automation/run, no agent involved); this tool exists so the agent
//     can trigger/verify a run when asked. Its only parameter is the key.
//   local_exec — the local channel's HOST COMMAND face: one shell command on
//     this host through the official ctx.shell seam (cwd = the task's
//     project). It exists because the local channel only sees host-scope
//     registered tools — pwsh/write are agent-scope and invisible to it — so
//     host-side commands need a tool of the channel's own. Automation-
//     internal by a caller gate (a model's direct call is rejected); the
//     always-on red lines (raw ssh, PDK strings) watch its command; file
//     writes are out of the automation contract (the agent's own sandboxed
//     tools or manual work own that).
// Session anchoring follows the D-003 precedent (exec.agent.id ≡ sessionId,
// a delegated subagent resolves to its topmost user-visible ancestor via
// src/subagent.js); resolveProjectTool (core/project.js) is the one project
// anchor — run_automation deliberately takes NO project argument (the key
// alone identifies the automation within the calling session's workspace).
// local_exec anchors the other way round: NO session (the automation channel
// has none) — the local runner injects the project path.
// (covered by tests/automation.test.mjs)
import { resolveProjectTool } from '../core/project.js'
import { effectiveSessionId } from '../subagent.js'
import { addAutomation, updateAutomation, deleteAutomation, runAutomation, capOutput } from '../core/automation.js'
import { execLocal } from '../channel/localchannel.js'
import { decideSafety } from '../core/safetyrules.js'

// local_exec's deadline ladder: the default and the cap. The cap sits under
// the local channel's 120 s callTool budget (core/automation.js
// COMMAND_TIMEOUT_MS) so the shell seam's own kill settles as a value instead
// of the outer race cutting the call off mid-flight.
const LOCAL_EXEC_TIMEOUT_SEC = 60
const LOCAL_EXEC_TIMEOUT_MAX = 110

export function automationTools(ctx) {
  return [
    {
      name: 'config_automation',
      description: 'Manage the CURRENT DSH workspace\'s automation tasks (the list the sidebar\'s '
        + '"Project overview -> Automation" sub-tab shows). '
        + 'Actions: "add" registers a new automation and returns its generated key (the task\'s '
        + 'permanent address); "update" changes a task by key (only the fields you pass: name, '
        + 'description, commands); "delete" removes the task entry by key — its command files are '
        + 'KEPT (shared library). '
        + 'Commands are ordered references into the SHARED library of plain .txt files stored '
        + 'flat under <workspace>/.harnessams/automation/ — one file may back several tasks, '
        + 'content is stored verbatim. mode picks the channel: remote (default) runs the files '
        + 'as shell scripts on the project\'s machine_id, local runs each line as a tool call '
        + '"toolName {json-args}" on this host. '
        + 'This tool never RUNS anything — runs are manual (the sidebar run button) or through '
        + 'run_automation. Purpose, workflow and the execution contract: the bundled automation '
        + 'skill.',
      parameters: {
        action: { type: 'string', required: true, enum: ['add', 'update', 'delete'],
          description: 'add=register a new automation | update=change one by key | delete=remove the task entry by key' },
        key: { type: 'string', description: 'Automation key (action=update/delete; the add result returns it)' },
        name: { type: 'string', description: 'Task name shown in the list (required for add, optional rename on update)' },
        description: { type: 'string', description: 'Free-form task description shown in the row\'s detail view' },
        commands: { type: 'array',
          items: { type: 'object', properties: {
            file: { type: 'string', required: true, description: 'The command file name (one printable-ASCII .txt segment under .harnessams/automation/)' },
            content: { type: 'string', description: 'The command text (verbatim storage); omit to reference an existing shared file' },
          } },
          description: 'Ordered command list ({ file, content? } items — the run order; content present creates/overwrites the file, absent = reuse an existing one)' },
        mode: { type: 'string', enum: ['remote', 'local'],
          description: 'Execution channel: remote (default) = the files are shell scripts run sequentially via ssh on the project\'s machine_id; local = each non-comment line is a tool call "toolName {json-args}" executed on this host without ssh (host-side commands: local_exec)' },
        project: { type: 'string', description: 'Optional explicit workspace path (default: the calling session\'s workspace)' },
      },
      async execute(args, exec) {
        const sessionId = effectiveSessionId(ctx, exec?.agent) ?? 'noagent'
        const p = resolveProjectTool(ctx.workspaceRegistry, sessionId, args.project)
        if (p.error) return { ok: false, error: p.error }
        if (args.action === 'add') {
          return addAutomation(p.project.path, {
            sessionId,
            name: args.name,
            description: args.description,
            commands: args.commands,
            mode: args.mode,
          })
        }
        if (args.action === 'update') {
          return updateAutomation(p.project.path, {
            key: args.key,
            name: args.name,
            description: args.description,
            commands: args.commands,
            mode: args.mode,
          })
        }
        if (args.action === 'delete') return deleteAutomation(p.project.path, { key: args.key })
        return { ok: false, error: `unknown action: ${args.action} (add | update | delete)` }
      },
    },
    {
      name: 'run_automation',
      description: 'Run ONE automation task of the CURRENT DSH workspace by its index key and return the '
        + 'full result (per-command ok/exit code/stdout/stderr — tool calls for local tasks, '
        + 'overall done/failed/aborted; an abort leaves the affected call\'s outcome uncertain, '
        + 'reported as such). '
        + 'The DEFAULT trigger of an automation is manual — the sidebar list\'s run button, which '
        + 'never involves an agent; this tool is the debug/verification face for the agent. '
        + 'Automations are created/edited with config_automation; the key comes from its add '
        + 'result or the sidebar list. '
        + 'The execution contract: the bundled automation skill.',
      parameters: {
        key: { type: 'string', required: true, description: 'The automation\'s index key (creating session id + yymmddhhmmss stamp, returned by config_automation add)' },
      },
      async execute(args, exec) {
        const sessionId = effectiveSessionId(ctx, exec?.agent)
        const p = resolveProjectTool(ctx.workspaceRegistry, sessionId, undefined)
        if (p.error) return { ok: false, error: p.error }
        return runAutomation(ctx, { project: p.project, key: args.key, signal: exec?.signal ?? null })
      },
    },
    {
      name: 'local_exec',
      description: 'Run ONE shell command on this host from a local-mode automation task: the '
        + 'host\'s default shell, the task\'s project as working directory, a deadline and '
        + 'output caps (exit code, stdout, stderr come back structured). '
        + 'Automation-internal: only a task line can call it — a direct call from a '
        + 'conversation is rejected; use the host\'s own pwsh/write tools there. The always-on '
        + 'safety gate denies raw ssh and PDK strings in the command. File writes are out of '
        + 'the automation contract — produce files manually or through the agent\'s own tools.',
      parameters: {
        command: { type: 'string', required: true, description: 'One shell command line (host default shell; runs with the project as working directory)' },
        timeout_sec: { type: 'integer', description: 'Deadline in seconds (1..110; default 60)' },
        project: { type: 'string', description: 'The project path (the working directory; the automation local channel injects it)' },
      },
      async execute(args, exec) {
        // Caller gate — the automation local channel only. callTool mints its
        // batch call ids with the hams-sim- prefix (channel/remote.js), while a
        // model's direct call carries the pipeline's own callId; an embed or
        // test stub that carries neither a callId nor an agent passes (a
        // degraded host cannot reach this tool anyway).
        const callId = exec?.callId
        const fromAutomation = typeof callId === 'string' && callId.startsWith('hams-sim-')
        const degradedEmbed = callId == null && !exec?.agent
        if (!fromAutomation && !degradedEmbed) {
          return {
            ok: false,
            error: 'local_exec is automation-internal: it only runs as a command line of a local-mode '
              + 'automation task (the sidebar run button or run_automation). For host file/shell work '
              + 'in a conversation, use the host\'s own pwsh/write tools.',
          }
        }
        // belt-and-braces red lines: the pre-execute waterfall already watches
        // local_exec.command (safetyrules.js RULES); this re-check covers embeds
        // without ctx.on
        const deny = decideSafety({ name: 'local_exec', arguments: args })
        if (deny) return { ok: false, error: deny.reason }
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (!command) return { ok: false, error: 'command is required (one shell command line)' }
        const project = typeof args.project === 'string' ? args.project.trim() : ''
        if (!project) {
          return {
            ok: false,
            error: 'project is required (the automation local channel injects the running task\'s '
              + 'project path into tools that declare a project parameter)',
          }
        }
        let timeoutSec = LOCAL_EXEC_TIMEOUT_SEC
        if (args.timeout_sec !== undefined && args.timeout_sec !== null) {
          const n = Number(args.timeout_sec)
          if (!Number.isInteger(n) || n < 1 || n > LOCAL_EXEC_TIMEOUT_MAX) {
            return { ok: false, error: `timeout_sec must be an integer 1..${LOCAL_EXEC_TIMEOUT_MAX}` }
          }
          timeoutSec = n
        }
        const t0 = Date.now()
        // the official host shell seam (the same primitive the batch channel's
        // direct scheduler rides): cross-platform shell choice, onExpiry kill,
        // abort kills the process — never a hand-rolled spawn
        const r = await execLocal(ctx, command, { timeoutMs: timeoutSec * 1000, workdir: project, signal: exec?.signal })
        const duration_ms = Date.now() - t0
        const stdout = capOutput(r.stdout)
        const stderr = capOutput(r.stderr)
        const summary = `exit ${r.exitCode ?? 'none'}${r.timedOut ? ' (deadline)' : ''}${r.aborted ? ' (aborted)' : ''} · ${duration_ms} ms`
        return {
          ok: !!r.ok,
          ...(r.isError ? { error: capOutput(r.text) } : {}),
          exitCode: r.exitCode ?? null,
          timedOut: !!r.timedOut,
          aborted: !!r.aborted,
          stdout,
          stderr,
          duration_ms,
          // value.text is the line's human payload in run results (resultText)
          text: capOutput([summary, stdout, stderr ? '[stderr]\n' + stderr : ''].filter(Boolean).join('\n')),
        }
      },
    },
  ]
}
