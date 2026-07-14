---
title: Quickstart
summary: First-run path from installation to a successful Roark issue workflow.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-08T07:00:00Z
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

Roark uses GitHub CLI for repository operations and runs shell commands in local workspaces. Review [Security and secrets](security-and-secrets.md) before running on public or shared repositories.

## Install Roark

From the Roark source checkout:

```bash
bun install
bun install -g "$PWD"
roark --help
```

For persistent servers, pin the checkout to a tag or commit before installing globally.

## Initialize a Target Repository

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

## Confirm Labels

Roark's autorun mode is label-gated. The default ready label is `afk`.

For a first dry run, make sure the target issue has the ready label and none of the skip labels:

```bash
gh issue edit 123 --repo owner/repo --add-label afk
```

Roark creates required lifecycle labels during normal autorun when they are missing. A dry run reports missing required labels without creating them.

See [Labels](labels.md) and [Label semantics](label-semantics.md).

## Preview Autorun Selection

Before letting Roark claim work, preview selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

Expected result:

- Roark lists an eligible issue.
- No issue is assigned.
- No branch is created.
- No workspace is changed.

If nothing is selected, use [Troubleshooting](troubleshooting.md#no-eligible-issues).

## Run One Issue Manually

For a controlled first run, use `do` with one issue:

```bash
roark do 123 --repo owner/repo
```

Roark will:

1. fetch the issue
2. triage it
3. plan the implementation
4. run the implementation agent
5. run independent review agents
6. apply fix passes when needed
7. write readiness output

`do` is useful for local validation. Use `auto` when you want claiming, labels, publishing, and scheduler-friendly behavior.

## Run One Autorun Attempt

When the dry run and manual run are understood, run a single autorun attempt:

```bash
roark auto --repo owner/repo --limit 1
```

On success, Roark opens a pull request only after readiness and verification pass.

On failure, Roark leaves the managed workspace and artifacts for inspection. It does not merge, close issues, or mark PRs ready for review.

## Inspect Results

Issue run artifacts are written under:

```text
.roark/runs/issue/<issue-number>/attempts/<attempt-number>/
```

Open these files first:

- `summary.json` for the artifact index and final status
- `verification.md` for the verification command result
- `readiness.md` for the publish gate decision
- `implementation-log.md` for implementation details
- `review-a-<n>.json` and `review-b-<n>.json` for schema-validated reviewer findings

See [Artifacts](artifacts.md) for the complete layout.

## Recover a Failed Attempt

If an autorun attempt stops before publishing:

```bash
roark continue 123 --repo owner/repo --attempt 1
```

If `--attempt` is omitted, Roark uses the latest recorded attempt.

Continue reuses valid existing artifacts, regenerates missing or invalid phase outputs, reruns readiness and verification, and publishes only when both gates pass. See [Recovery](recovery.md).

## Next Steps

- Read [Concepts](concepts.md) for the mental model.
- Read [Usage](usage.md) for day-to-day commands.
- Read [Managed workspaces](managed-workspaces.md) before enabling scheduled runs.
- Read [Operations runbook](operations-runbook.md) before cron, launchd, or GitHub Actions.
