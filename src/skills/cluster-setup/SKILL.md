---
name: cluster-setup
description: >
  Cluster toolchain bootstrap, run once per cluster and when a remote command
  cannot find spectre, python3 or module: harvest where the login startup
  files (/etc/profile.d, ~/.bash_profile, ~/.bashrc: module loads, PATH
  exports, alias lines) really put each key command, verify the candidates
  as absolute paths with ssh_exec, then pin remote_python /
  remote_spectre_cmd in the project settings so no job depends on PATH
  order or an alias. Also when a self-check fails on its environment leg.
---

# cluster-setup - harvest, verify, pin: the cluster toolchain as absolute paths

Every batch scheduler ends up launching a command on a cluster node under a bare name: `python3` runs the worker, `spectre` runs the simulation. A bare name resolves through PATH, and PATH is whatever the shell startup chain left behind. On an EDA cluster that is not stable: the same name can be a different program in an interactive login shell and in a non-interactive job. This skill turns each key command into one verified absolute path and pins it in the project settings. Run it before the first sweep on a new cluster, when the cluster's environment changed, and when a remote command cannot find `spectre`, `python3` or `module`. Once the pins are in place they do the work: a session passes no interpreter argument at all, and no job depends on an alias. The submission flow itself lives in the `batch-sweep` skill.

**Never guess a path and never choose an interpreter by taste.** A path enters the settings only after stages 1 and 2 measured it, and when candidates disagree the user decides.

## The moving parts (why a bare name is not enough)

- **Interactive login shell** (a human typing `ssh node`): `/etc/profile` -> `/etc/profile.d/*.sh` -> `~/.bash_profile` -> `~/.bashrc`. On RHEL/Rocky-style clusters `/etc/profile.d/modules.sh` defines the `module` function (Environment Modules; Lmod clusters ship their own profile.d entry), and every `module load <mod>` prepends that tool's absolute `bin/` directory to PATH.
- **Non-interactive command** (every exec the plugin issues, every worker): skips `/etc/profile` entirely. Whether `~/.bashrc` runs depends on how the remote shell is invoked (distros built with `SSH_SOURCE_BASHRC` run it for `ssh host cmd`): measure it in stage 2, never assume it.
- **An alias binds a command for humans only.** `alias python3=/abs/path` never expands in a non-interactive shell. It says where the user's interactive `python3` lives, and that is all it says: a lead to harvest, never a path a job can use.
- **`module` is a shell function, not a binary**: it exists in a command only if the chain that command ran defines it. Inside worker scripts do not call `module` at all; the pinned absolute paths make it unnecessary.
- bsub jobs inherit the environment of the shell that submitted them.

## Stage 1 - harvest: read the startup files (read-only)

Run on the host the project submits through. That is the machine of the Overview settings table, which you cannot see: take the host from what the user wrote, and when they did not name it, ask which configured host (`ssh_list` shows the candidates) before probing anything: a login node and a compute node can resolve the same command differently. Every command goes through dsh-ssh `ssh_exec`, never raw shell ssh; in-cluster, run them on this host.

    ls -1 /etc/profile /etc/profile.d/ ~/.bash_profile ~/.bashrc 2>/dev/null
    cat /etc/profile ~/.bash_profile ~/.bashrc
    grep -nE 'module (load|purge|switch)|PATH|alias (python3?|spectre|bsub|bjobs)=' /etc/profile /etc/profile.d/*.sh ~/.bash_profile ~/.bashrc

Follow every `source` or `.` line into the file it names. Collect four kinds of leads for each key command (`spectre`, `python3`, `bsub` / `bjobs`):

- `module load <mod>`: the modulefile states the absolute directories. For the modules that can supply a key command (not every module in the file) `bash -lc "module show <mod>"` prints the modulefile's path; `cat` it and read its `prepend-path PATH /abs/tools/bin` line, and note the variables the tool needs beside PATH (`LD_LIBRARY_PATH` and friends).
- `export PATH=...`: the absolute directories prepended, in order.
- `alias <cmd>=/abs/path`: where the user chose to bind that command. Record it as a CANDIDATE, the user's own answer for that command, still to be verified.
- `source` lines: follow them; the chain is as long as it is.

Where a line sits matters as much as what it says: unconditional in `~/.bashrc` reaches non-interactive commands; `~/.bash_profile`, or anything behind an "interactive only" guard, is for humans only.

Startup files are the user's. Read them, never edit them. If one of them is the reason a command is missing, report the exact line and let the user decide.

Result of stage 1, shown to the user: a table `command | where it comes from (file and line: module, export, alias or source) | candidate absolute path`.

## Stage 2 - verify: measure what a job really gets (ssh_exec)

    command -v spectre; command -v python3                      # what a non-interactive exec resolves: the job's view
    bash -lc "command -v spectre; command -v python3"           # what a login shell's PATH resolves (aliases do not expand here: stage 1 harvested them)
    ls -l <candidate>                                          # exists? a real binary, a symlink or a wrapper script
    <spectre candidate> -V                                     # its version line (prints and exits, on stderr, no license)
    <python candidate> -c "import sys; print(sys.version)"      # the worker needs Python >= 3.7
    <python candidate> -c "import numpy"                       # optional: the snp tools use it, else the staged numfallback

Reading the results:

- Both `command -v` rows print the same absolute path: that is the command's real path. Pin the path `command -v` printed, as printed; do not "improve" it with `readlink -f` (a wrapper script needs its own location).
- The rows disagree: typical on a cluster that publishes `python3` as an alias while the non-interactive PATH finds a tool-vendored python first. Both are candidates. Report each with its version (and numpy or not) and recommend the cluster's own interpreter over a tool-vendored one (a python vendored inside an EDA install leaves with that tool); the user chooses.
- A candidate that neither row resolves (an alias target, for instance) is checked by the last three probes alone: it is the path the user chose for their interactive shell.
- `spectre` is missing from the non-interactive row: its module loads sit behind an interactive guard. An absolute path only helps if spectre also finds the libraries its module sets up (`LD_LIBRARY_PATH` and friends); the self-check in stage 3 is the test that decides.

Result of stage 2: `command | absolute path | version`, plus every disagreement spelled out.

## Stage 3 - pin: write the absolute paths into the project

After the user confirms the paths:

    harnessams_selfcheck { action: "run", settings: { remote_python: "<abs path>", remote_spectre_cmd: "<abs path>" } }

The settings payload is a partial merge: only the keys named change, nothing else in the table moves (the pins have no row in that table: this call is their write face, and the AGENTS.md yaml is where they are kept). The self-check then runs the whole pipeline under exactly those two paths (assemble -> batch_submit -> batch_poll -> parse -> verify); when it passes, the pin is proven. Its finalize re-syncs AGENTS.md, whose yaml now carries `remote_python` and `remote_spectre_cmd` as the rows every later session reads.

From then on:

- `batch_submit`: omit `remote_python`. The pinned interpreter runs the worker, and for the bundled worker `spectre/spectre_sweep_worker.py` the pinned spectre is passed as `--spectre-cmd` unless `worker_args` names one.
- Remote parsers: `ssh_exec` them with the interpreter named by the `remote_python` row.
- An explicit `remote_python` argument must be an absolute path. Bare names are rejected: they resolve to whatever the startup chain left first on PATH.
- `null` in a row means not pinned: the bare default (`python3`, `spectre` on PATH) applies, which is exactly what the self-check verified for the project. Pinning is optional hardening while that default holds, and it is what protects the project when the PATH order changes.

Re-run the three stages when the cluster changes (a module default, a new tool version).

## Shared NFS home

Login and compute nodes normally mount one NFS home, so every node reads the same `~/.bashrc`: one harvest covers the whole cluster and module versions cannot drift between the submit node and the execution nodes. Verify per node only when homes are node-local (rare: ask the admin). Software trees are shared the same way, so one absolute path holds on every node.

## Reference-cluster ~/.bashrc skeleton (sanitized)

    # ~/.bashrc on the reference cluster (sanitized)
    [ -f /etc/bashrc ] && . /etc/bashrc
    # unconditional: a non-interactive command stops here, not at /etc/profile
    export MODULEPATH=/opt/env/module/cadence:/opt/env/module/synopsys:/opt/env/module/GNU
    module purge
    module load calibre_2024.4
    # re-runs /etc/profile.d: makes `module` self-contained for non-interactive shells
    source /etc/profile
    module load IC618            # virtuoso + spectre family
    module load SPECTRE21.1
    alias python3=/opt/GNU/python3.12/bin/python3

What the three stages found on this cluster (measured through the plugin's own exec channel on a compute node):

- `spectre`: stage 1, `module load SPECTRE21.1`, unconditional in `~/.bashrc`, and its modulefile prepends two absolute `bin/` directories. Stage 2, both `command -v` rows printed the same path in the module's `tools/bin` (a symlink), `-V` answered with a version line; that absolute path is the pin.
- `python3`: stage 1, no export names it, and the alias line is the user's binding (a 3.12 install). Stage 2, both `command -v` rows resolved `python3` inside the calibre module's install first (a tool-vendored 3.8, which carries numpy), and the alias target carries no numpy. Two candidates, two versions went to the user; the pin is the 3.12, the cluster's own interpreter. Without numpy the worker, the psf parser and the snp tools still run: they are standard-library only, and the snp tools fall back to the staged numfallback. The self-check passed under that pin.
- Both rows agreeing means the non-interactive exec on this cluster does pick up the `~/.bashrc` module loads. That is a measurement, not a rule: on the next cluster the rows may disagree.
- `module`: a function, available in every command because `~/.bashrc` re-runs `/etc/profile`.

The skeleton is a pointer, not a template: another cluster's files differ, and the stages, not this listing, decide what gets pinned.
