---
title: PR revisions
summary: How `roark revise-pr` responds to feedback on an existing pull request.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# PR revisions

Use `revise-pr` after a draft PR already exists and you want Roark to respond to PR-scoped feedback.

```bash
roark revise-pr 123 --repo owner/repo
```

## Flow

1. Fetch PR metadata, unresolved review threads, and relevant PR comments with GitHub GraphQL.
2. Exclude prior Roark revision summary comments from planner input.
3. Check out the existing PR head branch.
4. Allocate artifacts under `.roark/runs/pr/<pr-number>/revision-<n>/`.
5. Plan feedback handling.
6. Apply only feedback classified as `must-fix-current`.
7. Run one revision reviewer and optional fix/review passes.
8. Run verification.
9. On success, create one revision commit, push, and post one summary comment.

## Feedback classifications

- `must-fix-current`: required fix for the current PR.
- `already-addressed`: feedback already satisfied.
- `needs-human`: requires maintainer decision or unavailable context.
- `non-blocking`: valid follow-up, not required for this PR.
- `invalid/stale`: no longer applicable.

## Safety boundaries

Roark refuses closed PRs, fork PR heads in v1, base/shared branch heads, and dirty working trees unless `--yes` is passed. `needs-human`, no-op, and verification-failure outcomes do not commit or push.
