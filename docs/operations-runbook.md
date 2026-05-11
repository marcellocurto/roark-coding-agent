---
title: Operations runbook
summary: Production-style setup, scheduling, monitoring, recovery, and cleanup for Roark operators.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Host Setup

Use a dedicated machine, VM, runner, or user account. Avoid sharing a control checkout with humans.

Install:

```bash
bun --version
git --version
gh --version
roark --help
```

Authenticate:

```bash
gh auth status
gh repo view owner/repo
```

Pin Roark to a tag or commit. Upgrade deliberately.

## Repository Setup

Run from the target repository checkout:

```bash
roark init
```

Review:

- `.roark/config.json`
- `.roark/WORKFLOW.md`
- `.roark/.gitignore`
- verification command
- lifecycle hooks
- ignored local file copying
- label policy

## Token and Permission Checklist

The account running Roark needs enough permission to:

- read issues and comments
- assign issues when assignment is enabled
- create and edit labels required by Roark
- create branches
- push commits
- open pull requests
- read PR review comments for `revise-pr`
- post issue or PR comments

In GitHub Actions, set job permissions explicitly:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
```

## Scheduler Checklist

Before enabling a scheduler:

- run `roark auto --repo owner/repo --limit 1 --dry-run`
- run one manual or targeted issue
- verify artifacts are written where expected
- verify failed attempts can be continued
- configure log capture
- serialize runs
- keep `--limit 1` until the workflow is trusted

## Safe Scheduling Defaults

Recommended command shape:

```bash
roark auto --cwd /srv/roark/repos/app --repo owner/repo --limit 1
```

Use explicit `--cwd` and `--repo` in non-interactive contexts.

## Monitoring

Review:

- scheduler logs
- issue comments posted by Roark
- labels such as `roark-failed` and `roark-pr-opened`
- `.roark/runs/issue/<n>/attempts/<k>/summary.json`
- `.roark/runs/issue/<n>/attempts/<k>/verification.md`
- disk usage under `~/.roark/workspaces`

Use:

```bash
roark status --all --repo owner/repo
roark workspace list
```

## Failure Response

1. Find the issue or PR from scheduler logs or labels.
2. Open `summary.json`.
3. Open `verification.md` and `readiness.md`.
4. Inspect the managed workspace if uncommitted work matters.
5. Fix host, config, hook, secret-path, or verification issues.
6. Run:

```bash
roark continue 123 --repo owner/repo
```

Do not delete the workspace until recoverable work is no longer needed.

## Workspace Cleanup

List workspaces:

```bash
roark workspace list
```

Remove one clean workspace:

```bash
roark workspace remove --issue 123
```

Prune old clean workspaces:

```bash
roark workspace prune --older-than 30d
```

Use `--force` only when you have confirmed that dirty work is disposable.

## Upgrade Procedure

1. Stop scheduled jobs.
2. Check current Roark version or commit.
3. Update the Roark checkout deliberately.
4. Run:

```bash
bun install
bun test
bun run typecheck
roark --help
```

5. Run `roark auto --dry-run`.
6. Run one targeted issue or continue a known safe attempt.
7. Re-enable scheduled jobs.

## Rollback Procedure

1. Stop scheduled jobs.
2. Return the Roark checkout to the previous pinned tag or commit.
3. Reinstall globally if needed.
4. Verify `roark --help`.
5. Re-run `roark status --all`.
6. Continue failed attempts only after confirming artifact compatibility.

## Next Steps

- Use [Scheduling](scheduling.md) for cron, launchd, and GitHub Actions examples.
- Use [Troubleshooting](troubleshooting.md) for specific failure symptoms.
- Use [Security and secrets](security-and-secrets.md) for boundary review.
