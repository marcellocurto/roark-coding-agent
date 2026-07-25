---
title: Autorun
summary: How `roark auto` selects issues and opens pull requests.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:06:45Z
---

```bash
roark auto --repo owner/repo --limit 1
```

## Flow

1. List open GitHub issues.
2. Select issues with the ready label and no skip labels.
3. Claim one issue by assigning the actor, applying the in-progress label, and posting a claim comment.
4. Prepare the managed workspace and issue branch.
5. Fetch issue context and dependency metadata.
6. Run triage, planning, implementation, review, fix passes, and readiness.
7. Apply the readiness gate.
8. Run the verification gate.
9. If verification fails and `maxFixPasses` has budget, repair through a fix pass, code refinement, numbered Review A/B, and readiness, then rerun verification.
10. On success, commit code changes and push the branch.
11. Draft the PR from the run artifacts, changed-file list, and verification result. Save it as `pr-draft.json` and `pr-draft.md`, then open the PR with `gh`.
12. Publish any follow-up issues and add their links to the PR body.
13. Run `review-pr` against the opened PR and post the correctness and maintainability reviews.
14. If the run cannot be repaired within the fix budget, leave the work uncommitted and post recovery information.

The automatic review happens after publication. If it fails or the PR changes while it is running, the PR stays open and the review artifacts remain local. Retry with `roark review-pr <number>`.

## Running safely

Start with `--limit 1`. Each invocation runs once; use cron, launchd, GitHub Actions, or another scheduler for repeated runs.

## Selection labels

The default ready label is `ready-for-agent`. The default skip set includes intake, paused, terminal, and lifecycle states such as `needs-triage`, `needs-human`, `agent-in-progress`, `agent-failed`, and `agent-pr-opened`.

See [Label semantics](label-semantics.md) for the full label reference.

## What autorun does not do

Autorun does not merge PRs or close issues.

## Commands

Preview selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

Target one issue through the autorun path:

```bash
roark auto 123 --repo owner/repo
```

Inspect status after a background run:

```bash
roark status 123 --repo owner/repo
```
