---
name: automation
description: >
  The workspace automation task list: purpose (one-click repeatable remote
  chores without an agent), the two .harnessams artifacts (automation.json
  task store + automation/ shared .txt command library), the workflow
  (config_automation add/update/delete, the manual sidebar Run button,
  run_automation as the agent run/verify face) and the execution contract
  (sequential ssh_exec on the project's machine_id, 120 s per command).
  Trigger on creating, editing, running or debugging an automation task.
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

Stateless: no in-memory registry, no run records. Each run reads the entry, then reads each command file from disk at run time (CRLF folds to LF so a stray Windows editor cannot break the remote sh -c; storage itself stays verbatim). Commands execute SEQUENTIALLY through the ssh_exec funnel on the project's `machine_id` (the settings table's dsh-ssh host alias; configure it in the project settings before running), one command at a time, 120 s per command (exit 137 is the deadline, not a failure). A failure does not stop the rest: every command reports independently and the overall status just fails. stdout/stderr are capped at 20000 characters each in the result. An abort races the ssh call (KILL + channel close, best-effort): an aborted remote command may orphan, and the result reports the remote state as UNCERTAIN, never as a clean failure.

The result payload: per-command `ok` / `exitCode` / `stdout` / `stderr` (plus `timed_out` / `aborted` / `error` where they apply), the overall `status` (done / failed / aborted), `machine`, `started_at` / `finished_at`, and the store's warnings if any. Post-run behavior is a reserved seam: the payload is the extension point, nothing acts on it beyond the caller's echo yet.

Limits: name at most 80 chars; description at most 2000 chars; at most 64 commands per task; each command file's content at most 100000 chars; the file name at most 84 chars and matching the printable-ASCII `.txt` shape.
