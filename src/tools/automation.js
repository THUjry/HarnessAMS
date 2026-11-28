// config_automation + run_automation — the automation tool pair (phase-2
// automation feature; back end in core/automation.js). The split of faces:
//   config_automation — the CONFIGURATION face (add/update/delete automation
//     tasks in the project's automation.json): the natural way a user asks an
//     agent to set an automation up ("create an automation that deletes
//     ~/tmp/*"), and the only write face of the subsystem.
//   run_automation — the agent/debug RUN face: runs one automation by its
//     index key and returns the full result. The DEFAULT trigger is manual —
//     the sidebar list's run button (which goes through POST
//     /api/automation/run, no agent involved); this tool exists so the agent
//     can trigger/verify a run when asked. Its only parameter is the key.
// Session anchoring follows the D-003 precedent (exec.agent.id ≡ sessionId,
// a delegated subagent resolves to its topmost user-visible ancestor via
// src/subagent.js); resolveProjectTool (core/project.js) is the one project
// anchor — run_automation deliberately takes NO project argument (the key
// alone identifies the automation within the calling session's workspace).
// (covered by tests/automation.test.mjs)
import { resolveProjectTool } from '../core/project.js'
import { effectiveSessionId } from '../subagent.js'
import { addAutomation, updateAutomation, deleteAutomation, runAutomation } from '../core/automation.js'

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
          description: 'Execution channel: remote (default) = the files are shell scripts run sequentially via ssh on the project\'s machine_id; local = each non-comment line is a tool call "toolName {json-args}" executed on this host without ssh' },
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
  ]
}
