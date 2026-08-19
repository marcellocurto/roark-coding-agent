---
title: PR revisions
summary: Apply review feedback to an existing PR.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-08-19T07:58:25Z
---

```bash
roark revise-pr 123 --repo owner/repo
```

## Flow

1. Fetch PR metadata, unresolved review threads, and relevant PR comments with GitHub GraphQL.
2. Exclude prior Roark revision summary comments from planner input.
3. Check out the PR head branch in an isolated managed workspace. The control checkout stays on its current branch.
4. Create a numbered run directory at `.roark/runs/pr/<pr-number>/revision-<n>/`.
5. Collect the PR description, comments, review threads, and linked issues. Give each feedback item a stable ID and decide how to handle it.
6. Apply only items classified as `must-fix-current`. The execution report must account for every planned item once.
7. Run one revision reviewer and optional fix/review passes in the revision workspace.
8. Run verification in the revision workspace.
9. On success, create one commit without `.roark` artifacts, push it to the PR branch, and post a summary comment. Internal plans, logs, reviews, and local paths stay local.

## Feedback classifications

- `must-fix-current`: required fix for the current PR.
- `already-addressed`: feedback already satisfied.
- `needs-human`: requires maintainer decision or unavailable context.
- `non-blocking`: valid follow-up, not required for this PR.
- `invalid-stale`: no longer applicable.

## Limits

Roark stops before making changes when the pull request is closed, its head belongs to a fork, or its head is the base branch or another shared branch. A dirty control checkout also stops the command unless you pass `--yes`.

Roark makes all edits in the managed workspace. It does not commit or push when the result is `needs-human`, the feedback requires no changes, or verification fails.

Revision workspaces use the configured workspace settings and lifecycle hooks. Roark may reuse a clean workspace but rejects a dirty one.

## Commands

Run with an explicit verification command:

```bash
roark revise-pr 123 --repo owner/repo --verify "bun run check"
```

Skip the terminal summary comment:

```bash
roark revise-pr 123 --repo owner/repo --no-comment
```
