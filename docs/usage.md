---
title: Usage
summary: Day-to-day Roark commands and when to use each workflow.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Choose a Workflow

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

## Manual Issue Run

Use `do` when you want the complete issue workflow without scheduler-style discovery.

```bash
roark do 123 --repo owner/repo
```

This is the best first workflow for a new repository because it makes the target issue explicit.

## Autorun Discovery

Use `auto` without an issue when Roark should discover eligible issues by label:

```bash
roark auto --repo owner/repo --limit 1
```

Keep `--limit 1` unless you intentionally want multiple issues per process. Roark is one-shot, so repeated execution should be handled by cron, launchd, GitHub Actions, or another scheduler.

## Autorun Targeted Issue

Use `auto <issue>` when you want autorun behavior for one known issue:

```bash
roark auto 123 --repo owner/repo
```

This bypasses discovery but still uses the autorun publishing and lifecycle path.

## Dry Run

Use `--dry-run` before scheduled runs or label changes:

```bash
roark auto --repo owner/repo --limit 3 --dry-run
```

Dry run reports what would be selected. It does not claim issues, create branches, or run agents.

## Status

Use `status` to inspect persisted run state:

```bash
roark status 123 --repo owner/repo
roark status --all --repo owner/repo
```

Status reads artifacts. It is useful when a scheduler has run Roark in the background.

## Continue

Use `continue` after readiness or verification fails:

```bash
roark continue 123 --repo owner/repo --attempt 1
```

Continue should run from the same control checkout when possible. It depends on local artifacts and the persistent managed workspace.

## PR Reviews and Revisions

Use `review-pr` for a fresh review of any open or draft PR, including a fork PR. It inspects the complete pinned PR contribution, runs independent correctness and maintainability reviewers, and posts or updates one actionable PR comment. It never edits, commits, or pushes:

```bash
roark review-pr 456 --repo owner/repo
```

Use `--no-comment` to keep the complete review local. Verification runs only from `--verify` or trusted `.roark/config.json` configuration. On an unrestricted host, Roark may suggest an inferred package command but does not execute contributor-controlled PR code without that explicit authorization.

Use `revise-pr` when a PR exists and you want Roark to respond to PR-scoped review feedback:

```bash
roark revise-pr 456 --repo owner/repo
```

Roark classifies feedback, applies only `must-fix-current` items, verifies, pushes one revision commit, and posts one summary comment.

These commands are intentionally separate. `review-pr` produces feedback; `revise-pr` consumes existing feedback and is the mutation-authorized step. Review never starts revision automatically.

## Workspace Commands

List managed workspaces:

```bash
roark workspace list
```

Remove one issue workspace:

```bash
roark workspace remove --issue 123
```

Dirty workspaces require `--force`:

```bash
roark workspace remove --issue 123 --force
```

Prune old clean workspaces:

```bash
roark workspace prune --older-than 30d
```

Use [Managed workspaces](managed-workspaces.md) before deleting workspaces that may contain recoverable work.

## Issue Curation

Use `curate-issues` to turn reviewer findings into a deterministic issue creation plan:

```bash
roark curate-issues 123 --repo owner/repo
```

Use `create-issues` to publish the approved plan:

```bash
roark create-issues 123 --repo owner/repo --yes
```

See [Issue curation](issue-curation.md).

## Common Options

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

See [CLI reference](cli-reference.md) for the full command and option reference.

## Next Steps

- Use [Troubleshooting](troubleshooting.md) when a command stops unexpectedly.
- Use [Operations runbook](operations-runbook.md) before scheduling.
- Use [PR revisions](pr-revisions.md) for review feedback handling.
