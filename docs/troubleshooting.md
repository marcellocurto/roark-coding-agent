---
title: Troubleshooting
summary: Common Roark failures, symptoms, and recovery steps.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-07-13T00:00:00Z
---

## No Eligible Issues

Symptoms:

- `roark auto --dry-run` prints no selected issues.
- Scheduled autorun exits without claiming work.

Check:

```bash
gh issue view 123 --repo owner/repo --json labels,state,assignees
```

Common causes:

- issue is closed
- missing ready label, default `ready-for-agent`
- issue has a skip label
- custom `--label`, `--skip-label`, or `--skip-labels` does not match the repository label policy

Read [Label semantics](label-semantics.md).

## Missing Required Labels

Symptoms:

- dry run reports missing labels
- autorun stops before claiming work

Normal autorun can create required lifecycle labels. Dry run reports missing labels without creating them.

Use a non-dry autorun when you are ready for Roark to create missing required labels, or create labels manually with `gh label create`.

## GitHub Authentication Fails

Symptoms:

- `gh auth status` fails
- scheduled jobs work manually but fail under cron or launchd
- GitHub API calls return permission errors

Check as the same user that runs Roark:

```bash
gh auth status
gh repo view owner/repo
```

For launchd, run under the user's login session so keychain credentials are available. For GitHub Actions, set `GH_TOKEN` and repository permissions.

## Verification Command Missing

Symptoms:

- `auto` or `continue` refuses to publish because no verification command is configured

Fix:

```json
{
  "verify": "bun run check"
}
```

Or pass:

```bash
roark auto --repo owner/repo --verify "bun run check"
```

See [Verification](verification.md).

## Verification Fails Because Ignored Files Are Missing

Symptoms:

- `verification.md` shows missing `.env`, `.secrets`, credentials, generated config, or other ignored files

Fix by copying path names, not secret values:

```json
{
  "workspace": {
    "copyToWorktree": [".secrets/env"]
  }
}
```

The destination must be ignored by Git. See [Managed workspaces](managed-workspaces.md) and [Security and secrets](security-and-secrets.md).

## Dirty Managed Workspace

Symptoms:

- a fresh `auto` run refuses an existing issue workspace
- command output says to use `continue` or clean/remove the workspace

Use:

```bash
roark continue 123 --repo owner/repo
```

If the work is no longer needed:

```bash
roark remove 123 --force
```

Do not remove a workspace if it may contain recoverable uncommitted work.

## Branch Already Exists

Symptoms:

- branch creation or checkout fails
- issue branch already exists locally or remotely

Roark issue branches use:

```text
roark/issue-<number>
```

Inspect:

```bash
git branch --list 'roark/issue-*'
git ls-remote --heads origin 'roark/issue-*'
```

If the branch belongs to a previous attempt, prefer `roark continue`. If it is unrelated, rename or remove it deliberately.

## Readiness Fails

Symptoms:

- `readiness.json` is missing, invalid, or has a decision status other than `ready-for-pr`
- no PR is opened

Open:

```text
.roark/runs/issue/<n>/attempts/<k>/readiness.md
```

Use that Markdown for the explanation, and inspect `readiness.json` for the exact machine decision. Then inspect the latest review and fix logs. Use `continue` after addressing local setup issues.

## PR Not Opened

Common causes:

- readiness failed
- verification failed
- push failed
- GitHub token lacks `contents:write` or pull request permissions
- branch head is not publishable

Inspect `summary.json`, `verification.md`, command output, and GitHub auth state.

## PR Revision Makes No Commit

`revise-pr` does not commit when:

- all feedback is already addressed
- all actionable feedback is classified `needs-human`, `non-blocking`, or `invalid/stale`
- verification fails
- the working tree is dirty and preflight refuses to continue

See [PR revisions](pr-revisions.md).

## Scheduler Runs Overlap

Symptoms:

- issue claiming races
- dirty workspace surprises

Use scheduler-level serialization:

- `flock` for cron
- `concurrency` for GitHub Actions
- one launchd job per control checkout

See [Scheduling](scheduling.md) and [Operations runbook](operations-runbook.md).

## macOS Exit Notification Does Not Appear

Exit notifications require a valid repository `.roark/config.json` with:

```json
{
  "notifications": { "onExit": true }
}
```

They are macOS-only and best-effort. Check **System Settings → Notifications** for the application that presents `osascript` notifications, and check the active Focus mode. macOS may suppress presentation even when delivery succeeds.

Roark waits up to two seconds for `/usr/bin/osascript`. A timeout, launch failure, or nonzero exit prints one non-fatal warning and preserves the original Roark exit code. No notification is attempted outside a Git repository, when config is missing or invalid, or on non-macOS hosts. Signals such as `SIGINT`, `SIGTERM`, and `SIGKILL`, runtime crashes, forced termination, and power loss are unsupported because they do not pass through Roark's controlled exit boundary.

## Model and Provider Failures

- `Model not found` or request-shape errors: run `bun install --frozen-lockfile` to restore the supported Pi version.
- Authentication errors: run Pi interactively and use `/login` for `openai-codex`, then retry as the same OS user.
- Unsupported thinking levels: Roark reports the requested and effective levels when Pi clamps the selection; unsupported `max` falls back to the highest supported level.
- To roll back, rerun or continue with `--model openai-codex/gpt-5.5`.

## Useful First Files

For issue attempts:

```text
.roark/runs/issue/<n>/attempts/<k>/summary.json
.roark/runs/issue/<n>/attempts/<k>/verification.md
.roark/runs/issue/<n>/attempts/<k>/readiness.json
.roark/runs/issue/<n>/attempts/<k>/readiness.md
.roark/runs/issue/<n>/attempts/<k>/events.jsonl
```

For PR revisions:

```text
.roark/runs/pr/<pr-number>/revision-<n>/
```

See [Artifacts](artifacts.md).
