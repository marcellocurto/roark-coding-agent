---
title: Quickstart
summary: Install Roark and use it on your first issue.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-08-19T07:58:25Z
---

## Prerequisites

Install and authenticate the tools Roark uses:

```bash
bun --version
gh auth status
git status --short
```

You need:

- a GitHub checkout for the target repository
- a clean control checkout
- `gh` authenticated as a user or bot with issue, pull request, and branch push permissions
- a verification command that can run non-interactively
- any required ignored local files available in the control checkout

Roark uses `gh` for GitHub operations and runs shell commands in local workspaces. Read [Security and secrets](security-and-secrets.md) before using it on a public repository or shared machine.

## Install Roark

From the Roark source checkout:

```bash
bun install
bun install -g "$PWD"
roark --help
```

For persistent servers, pin the checkout to a tag or commit before installing globally.

## Initialize the target repository

Run `roark init` from the target repository checkout:

```bash
cd /path/to/target-repo
roark init
```

This writes:

```text
.roark/config.json
.roark/.gitignore
```

Open `.roark/config.json` and confirm:

- `repo` is the expected `owner/repo`
- `baseBranch` matches the repository default branch
- `verify` is a command you trust
- lifecycle hooks are non-interactive
- ignored local file paths are configured through `workspace.copyToWorktree` only when needed

See [Configuration](configuration.md) for the full config reference.

## Add the ready label

Roark's autorun mode is label-gated. The default ready label is `ready-for-agent`.

For a first dry run, make sure the target issue has the ready label and none of the skip labels:

```bash
gh issue edit 123 --repo owner/repo --add-label ready-for-agent
```

Roark creates required lifecycle labels during normal autorun when they are missing. A dry run reports missing required labels without creating them.

See [Labels](labels.md) and [Label semantics](label-semantics.md).

## Preview autorun

Before letting Roark claim work, preview selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

The command should list an eligible issue without assigning it, creating a branch, or changing a workspace.

If nothing is selected, use [Troubleshooting](troubleshooting.md#no-eligible-issues).

## Run one issue without publishing

For a controlled first run, use `do` with one issue:

```bash
roark do 123 --repo owner/repo
```

Roark:

1. fetch the issue
2. triage it
3. plan the implementation
4. run the implementation agent
5. run independent review agents
6. apply fix passes when needed
7. write readiness output

`do` is useful for local validation. Use `auto` when you want claiming, labels, publishing, and scheduler-friendly behavior.

## Run autorun

After the dry run and `do` command succeed, run one autorun attempt:

```bash
roark auto --repo owner/repo --limit 1
```

Roark opens the pull request only after readiness and verification pass. It then posts two reviews, one for correctness and one for maintainability.

If either review fails, or the pull request changes before review finishes, Roark leaves the pull request open and saves the local review files. On any failure, Roark keeps the managed workspace and run files for inspection.

Roark never merges the pull request, closes the issue, or marks the pull request ready for review.

## Inspect the run

Issue run artifacts are written under:

```text
.roark/runs/issue/<issue-number>/attempts/<attempt-number>/
```

Open these files first:

- `summary.json` for the artifact index and final status
- `verification.md` for the verification command result
- `readiness.md` for the publish decision; use `readiness.json` for exact field values
- `implementation-log.md` for the implementation report
- `review-a-<n>.md` and `review-b-<n>.md` for reviewer findings

See [Artifacts](artifacts.md) for the complete layout.

## Resume a failed attempt

If an autorun attempt stops before publishing:

```bash
roark continue 123 --repo owner/repo --attempt 1
```

If `--attempt` is omitted, Roark uses the latest recorded attempt.

`continue` keeps valid artifacts, rebuilds missing or invalid outputs, reruns both gates, and publishes if they pass. See [Recovery](recovery.md).
