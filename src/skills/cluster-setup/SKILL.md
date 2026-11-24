---
name: cluster-setup
description: >
  First-use cluster pre-flight for batch sweeps: how the login shell
  startup chain (/etc/profile.d modules, ~/.bashrc, SSH_SOURCE_BASHRC)
  delivers the EDA toolchain to non-interactive remote commands, why
  remote_python must be an absolute path (bare python3 may be
  tool-vendored), the module-as-function gotcha, and the shared-NFS-home
  assumption. Trigger when configuring a cluster, when a remote command
  cannot find spectre or module, or when choosing the worker interpreter.
---

# cluster-setup — the remote login environment, checked once per cluster

All three batch schedulers (local, ssh, lsf) end up running a command on a cluster node: a worker over ssh, a bsub job, or a local spawn on the host. This skill is the once-per-cluster check that those commands land in a working EDA environment, and the diagnosis path when they don't. Run it before the first sweep on a new cluster or a new dsh-ssh alias; the submission flow itself lives in the `batch-sweep` skill.

## What runs when you ssh

Two different shell startup chains decide everything:

- An **interactive login shell** (a human typing `ssh node`) runs `/etc/profile` -> `/etc/profile.d/*.sh` -> `~/.bash_profile` -> `~/.bashrc`. On RHEL/Rocky-style clusters `/etc/profile.d/modules.sh` defines the `module` function (Environment Modules; Lmod clusters have their own profile.d entry), and the scheduler's profile script prepends its `bin/` (bsub) to PATH.
- A **non-interactive ssh command** (`ssh node "..."` — every exec the plugin issues) skips `/etc/profile` entirely. Mainstream distros build bash with `SSH_SOURCE_BASHRC`, so `~/.bashrc` still runs: an EDA environment assembled there reaches every remote command and every worker, with nothing extra to source.

Verified on the reference cluster, in a bare non-interactive exec (sanitized paths): `module` resolved as a shell function and `spectre` was on PATH — and a bare `python3` resolved to the interpreter vendored inside the calibre module (3.8, not the cluster's 3.12), because the cluster publishes its real python only as `alias python3=...` and aliases never expand in non-interactive shells.

## Pre-flight: four probes, once per cluster

    ssh <node> 'command -v spectre'             # toolchain reaches non-interactive commands?
    ssh <node> 'command -v python3'             # what a bare python3 would be
    ssh <node> 'bash -lc "module list"'         # the interactive-login module set
    ssh <node> 'bash -lc "type -a python3"'     # every python the login PATH sees

Reading the results:

- **spectre found** by the bare probe — the environment reaches non-interactive commands; ssh and lsf submits will work as-is.
- **spectre missing bare, found under `bash -lc`** — the module loads live only in `~/.bash_profile` (or behind an interactive guard), so remote commands get a bare PATH. Fix at the source: move the exports and `module load` lines into `~/.bashrc`, unconditionally.
- **python3 inside an EDA install** (e.g. `/.../calibre.../bin/python3`) — a tool-vendored interpreter, usually older than the cluster's real one; pick the absolute path for `remote_python` instead.

## remote_python: absolute path, always

`batch_submit`'s `remote_python` names the interpreter that runs the worker on the target node. The default is a bare `python3` — safe only where nothing shadows it. EDA clusters frequently publish their real python as an alias (to coexist with tool pythons), and since aliases never expand non-interactively the bare name hits whichever tool python comes first on PATH. Pass the absolute path the probes found, e.g. `remote_python: "/opt/GNU/python3.12/bin/python3"`, and use the same absolute form when `ssh_exec`-ing analyzers over remote result data.

## `module` is a shell function, not a binary

`module` is defined by the login chain (profile.d), so it exists inside a remote command only if the chain that command ran defines it — directly in `~/.bashrc`, or via an explicit `source /etc/profile` there (the trick the reference cluster uses to make module work everywhere). To run module-dependent setup in one command, wrap it in a login shell:

    ssh <node> 'bash -lc "module load <mod> && <cmd>"'

Inside worker scripts, don't call `module` at all: rely on the inherited environment or export the variables you need.

## Shared NFS home

Login and compute nodes normally mount one NFS home, so every node reads the same `~/.bashrc`: one pre-flight covers the whole cluster and module versions cannot drift between the submit node and the execution nodes. Probe per node only when homes are node-local (rare — ask the admin). bsub jobs inherit the submitting shell's environment, and submitting through the ssh node inherits that node's `~/.bashrc` chain.

## Reference-cluster ~/.bashrc skeleton (sanitized)

    # ~/.bashrc on the reference cluster (sanitized)
    [ -f /etc/bashrc ] && . /etc/bashrc
    # unconditional: non-interactive ssh commands stop here, not at /etc/profile
    export MODULEPATH=/opt/env/module/cadence:/opt/env/module/synopsys:/opt/env/module/GNU
    module purge
    module load calibre_2024.4
    # re-runs /etc/profile.d — makes `module` self-contained for non-interactive shells
    source /etc/profile
    module load IC618            # virtuoso + spectre family
    module load SPECTRE21.1
    # the cluster's real python — an ALIAS: invisible to remote jobs
    alias python3=/opt/GNU/python3.12/bin/python3

The skeleton shows both halves of the contract: why everything works remotely (unconditional exports and module loads inside `~/.bashrc`) and why `remote_python` must spell the alias target out in full.
