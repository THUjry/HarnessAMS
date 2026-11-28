---
name: automation
description: >
  The workspace automation task list: one-click repeatable chores without
  an agent, the two .harnessams artifacts (task store + shared .txt
  command library), the workflow (config_automation CRUD, the sidebar
  Run button, run_automation the agent run face) and the execution
  contract (remote = ssh_exec on the project's machine_id, 120 s per
  command; local = one host-scope tool call per line, host commands via
  local_exec). Trigger on creating, editing, running or debugging an
  automation task.
---

# automation - the workspace task list (HarnessAMS suite)

## Purpose

An automation is a named, ordered list of plain-text commands a DSH workspace keeps under `<workspace>/.harnessams/`: small repeatable remote chores (cleanup, environment probes, report post-processing) that run with one click or one tool call and need no agent at run time. The DEFAULT trigger is manual: the sidebar "Project overview -> Automation" sub-tab's per-row Run button (it goes through POST /api/automation/run and never involves an agent). `run_automation` is the agent's trigger/verify face for a run the user asks about; `config_automation` is the only write face of the subsystem.

## The two artifacts

- `.harnessams/automation.json` - the task store. Entries are `{ key, name, description, created_at, updated_at, created_by_session, files }`, where `files` is the ORDERED list of command-file names (the run order). Read is lenient (an invalid entry is skipped with a surfaced warning; the next write self-heals it off disk), write is strict, unknown fields ride through.
- `.harnessams/automation/` - the SHARED command library: flat plain `.txt` files, deliberately decoupled from tasks. The file name is one printable-ASCII segment ending in `.txt` (no path separators, no subdirectories; the name is both the reference key and the file name). Content is stored verbatim, any language, zero parsing. One file may back several tasks (cross-task reuse); a task's `files` list is just references. Editing a shared file changes every referencing task's next run, because a run reads each command file FROM DISK at run time; a file nobody references anymore is an ordinary file, removable through safe_trash.

The automation key is minted at creation: the creating session's id (a delegated subagent resolves to its topmost user-visible ancestor) plus a yymmddhhmmss local stamp; a same-second collision gets a numeric suffix. The key is the task's permanent address: the add result returns it, the sidebar list shows it.

## Workflow

1. **Create** - `config_automation { action: "add", name, description, commands: [{ file, content? }] }`: a `content` item creates/overwrites the shared file (identical content is a no-op), a content-absent item is a pure reference and the file must already exist. Command files are laid down BEFORE the entry registers, so a failed write leaves no half-registered task. The result returns the generated key.
2. **Run** - the sidebar Run button (manual, agent-free) or `run_automation { key }` (the agent/debug face). Both land in the same stateless runner.
3. **Edit / delete** - `config_automation { action: "update", key, ... }` changes only the fields you pass (name, description, commands); `action: "delete"` removes the entry by key but KEEPS its command files: they are the shared library and may back other tasks.

## The execution contract (supported features)

Stateless on disk: no in-memory registry, no run records in automation.json (each task's LAST run, status and full result, is held in the plugin process's memory for the sidebar list; a host restart clears it, a page reload does not). Each run reads the entry, then reads each command file from disk at run time (CRLF folds to LF so a stray Windows editor cannot break the remote sh -c; storage itself stays verbatim). Commands execute SEQUENTIALLY, one at a time; a failure does not stop the rest: every command reports independently and the overall status just fails.

The task's `mode` picks the channel:

- **remote** (the default): each command file runs as a shell script through the ssh_exec funnel on the project's `machine_id` (the settings table's dsh-ssh host alias; configure it in the project settings before running), 120 s per command (exit 137 is the deadline, not a failure). stdout/stderr are capped at 20000 characters each in the result.
- **local**: each non-comment line of the file is ONE tool call, `toolName {json-args}`, dispatched through the registered tool face on this host with no ssh wrapper; only host-scope (globally) registered tools work (the agent-scope `pwsh`/`write` are invisible to the channel, while dsh-ssh's `ssh_exec` is host-scope and works). A tool declaring a `project` parameter gets the running task's project path injected (a value the line's json provides wins). A bad line (unknown tool, invalid json, a failed call) fails that line independently; its result row carries `tool` / `line` / `text` instead of the remote `exitCode` / `stdout` / `stderr`. Host-side shell commands go through the channel's own tool, `local_exec {"command":"...","timeout_sec":...}`: cwd = the task's project, 1..110 s, capped output, automation-internal (a direct model call is rejected), the command watched by the always-on red lines, and it never writes files (produce files manually or through the agent instead).

An abort races every call (the remote channel kills best-effort): an aborted remote command may orphan and an aborted local call's effect is uncertain; the result reports the state as UNCERTAIN, never as a clean failure.

The result payload: per-command `ok` / `exitCode` / `stdout` / `stderr` for remote tasks or the per-line `tool` / `line` / `text` rows for local ones (plus `timed_out` / `aborted` / `error` where they apply), the overall `status` (done / failed / aborted), `machine`, `started_at` / `finished_at`, and the store's warnings if any. Post-run behavior is a reserved seam beyond the run memory: the payload is the extension point; today only the sidebar list acts on it (the status column and the click-for-details dialog read the in-memory last run through `GET /api/automation/result`; runs no longer auto-open the dialog).

**Command files over 50 lines warn.** The config result, the run result and the sidebar list all flag an oversized command file, and the warning points at this skill. The reason is ssh bandwidth: heavy content (long rule lists, waived-DRC inventories, big path manifests) should be uploaded to the server first and referenced by path from the script, so the command file stays small and the channel carries paths, not payloads.

**A fresh project ships one demo task.** `POST /api/project-init` seeds one local task (Empty project trash: it empties the project's trash through safe_trash's `empty` action) when the project has no automation.json; delete it freely, a deleted task never resurrects. The sidebar list's per-row Delete (behind a confirm dialog) removes an entry the same way `config_automation` delete does: the entry goes, the shared `.txt` files stay.

Limits: name at most 80 chars; description at most 2000 chars; at most 64 commands per task; each command file's content at most 100000 chars; the file name at most 84 chars and matching the printable-ASCII `.txt` shape.
