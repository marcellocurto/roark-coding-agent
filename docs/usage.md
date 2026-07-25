---
title: Usage
summary: Choose the right Roark command for a task.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-07-25T07:06:45Z
---

## Choose a command

| Goal | Command |
| --- | --- |
| Scaffold repository config | `roark init` |
| Run one issue locally | `roark do 123 --repo owner/repo` |
| Preview eligible autorun issues | `roark auto --repo owner/repo --dry-run` |
| Claim and run eligible issues | `roark auto --repo owner/repo --limit 1` |
| Target one issue through autorun | `roark auto 123 --repo owner/repo` |
| Continue a failed attempt | `roark continue 123 --repo owner/repo` |
| Review an existing PR without changing it | `roark review-pr 456 --repo owner/repo` |
| Address existing PR feedback | `roark revise-pr 456 --repo owner/repo` |
| Inspect run status | `roark status 123 --repo owner/repo` |
| Manage workspaces | `roark workspace list` |
| Create follow-up issues from findings | `roark create-issues 123 --repo owner/repo --yes` |

## Run one issue locally

`do` runs one issue without label-based discovery:

```bash
roark do 123 --repo owner/repo
```

Start here when trying Roark in a new repository.

## Discover issues with autorun

`auto` without an issue discovers eligible issues by label:

```bash
roark auto --repo owner/repo --limit 1
```

Start with `--limit 1`. Use cron, launchd, GitHub Actions, or another scheduler for repeated runs.

## Target an issue with autorun

Pass an issue number to skip discovery while keeping autorun's publishing and label behavior:

```bash
roark auto 123 --repo owner/repo
```

## Dry run

Use `--dry-run` before scheduled runs or label changes:

```bash
roark auto --repo owner/repo --limit 3 --dry-run
```

Dry run reports what would be selected. It does not claim issues, create branches, or run agents.

## Status

`status` reads the saved run artifacts:

```bash
roark status 123 --repo owner/repo
roark status --all --repo owner/repo
```

## Continue

Use `continue` after readiness or verification fails:

```bash
roark continue 123 --repo owner/repo --attempt 1
```

Continue should run from the same control checkout when possible. It depends on local artifacts and the persistent managed workspace.

## Review and revise PRs

`review-pr` verifies and reviews the full diff of an open or draft PR. It posts separate correctness and maintainability comments and does not edit, commit, or push:

```bash
roark review-pr 456 --repo owner/repo
```

Use `--no-comment` to keep the reviews local. Verification uses `--verify`, then `.roark/config.json`, then the built-in `bun run typecheck` default.

`revise-pr` applies existing PR feedback:

```bash
roark revise-pr 456 --repo owner/repo
```

Roark classifies feedback, applies only `must-fix-current` items, verifies, pushes one revision commit, and posts one summary comment.

`review-pr` only produces feedback. `revise-pr` is the command that changes code.

## Workspace commands

List managed workspaces:

```bash
roark workspace list
```

List and interactively select one or more workspaces to remove:

```bash
roark remove
```

Remove issue workspace 123 directly:

```bash
roark remove 123
```

Dirty workspaces require `--force`:

```bash
roark remove 123 --force
```

Use `roark remove --pr 456` for a PR workspace.

Prune old clean workspaces:

```bash
roark workspace prune --older-than 30d
```

Use [Managed workspaces](managed-workspaces.md) before deleting workspaces that may contain recoverable work.

## Issue curation

`curate-issues` turns reviewer findings into an issue creation plan:

```bash
roark curate-issues 123 --repo owner/repo
```

Use `create-issues` to publish the approved plan:

```bash
roark create-issues 123 --repo owner/repo --yes
```

See [Issue curation](issue-curation.md).

## Long-running commands

Normal output shows the target, current phase, elapsed time, verification status, and artifact path. Add `--verbose` to show completed agent responses and detailed tool statistics.

In an interactive terminal, Roark updates the window title as the phase changes. Disable this with `--no-title`. Redirected output contains no title or ANSI sequences; warnings remain on stderr.

## Common options

| Option | Use |
| --- | --- |
| `--repo owner/repo` | Select GitHub repository |
| `--cwd path` | Use a specific control checkout |
| `--out path` | Use a custom runs directory |
| `--verify "cmd"` | Override verification command |
| `--model provider/id` | Override Pi model |
| `--thinking level` | Override thinking level |
| `--attempt n` | Select an attempt |
| `--force` | Regenerate phase artifacts |
| `--yes` | Approve supported prompts or mutations |
| `--verbose` | Show completed agent responses and detailed tool statistics |
| `--no-title` | Disable interactive terminal-title updates |

See [CLI reference](cli-reference.md) for the full command and option reference.
