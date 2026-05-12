---
title: PR revisions
summary: How `roark revise-pr` responds to feedback on an existing pull request.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-12T00:00:00Z
---

```bash
roark revise-pr 123 --repo owner/repo
```

## Flow

1. Fetch PR metadata, unresolved review threads, and relevant PR comments with GitHub GraphQL.
2. Exclude prior Roark revision summary comments from planner input.
3. Prepare an isolated managed clone workspace and check out the existing PR head branch there. The caller/control checkout stays on its current branch.
4. Allocate canonical artifacts under `.roark/runs/pr/<pr-number>/revision-<n>/` in the control checkout and mirror them into the revision workspace for agent prompts and commits.
5. Plan feedback handling in the revision workspace.
6. Apply only feedback classified as `must-fix-current` in the revision workspace.
7. Run one revision reviewer and optional fix/review passes in the revision workspace.
8. Run verification in the revision workspace.
9. On success, create one revision commit from the revision workspace, force-add only that revision's `.roark/runs/pr/...` artifacts, push to the PR head branch, and post one summary comment from the control checkout.

## Feedback classifications

- `must-fix-current`: required fix for the current PR.
- `already-addressed`: feedback already satisfied.
- `needs-human`: requires maintainer decision or unavailable context.
- `non-blocking`: valid follow-up, not required for this PR.
- `invalid/stale`: no longer applicable.

## Safety boundaries

Roark refuses closed PRs, fork PR heads in v1, base/shared branch heads, and dirty control working trees unless `--yes` is passed. PR checkout, agent edits, review, verification, commit, and push happen in an isolated managed clone workspace under the configured workspace root. `needs-human`, no-op, and verification-failure outcomes do not commit or push.

Revision workspaces reuse the managed workspace configuration (`workspace.root`, `workspace.cloneRemote`, `workspace.copyToWorktree`) and lifecycle hooks. Clean workspaces may be reused; dirty revision workspaces are rejected so local edits are not overwritten.

## Useful commands

Run with an explicit verification command:

```bash
roark revise-pr 123 --repo owner/repo --verify "bun run check"
```

Skip the terminal summary comment:

```bash
roark revise-pr 123 --repo owner/repo --no-comment
```

## Next steps

- Use [Troubleshooting](troubleshooting.md#pr-revision-makes-no-commit) for no-op revisions.
- Use [Artifacts](artifacts.md#pr-revision-layout) to inspect revision outputs.
- Use [CLI reference](cli-reference.md#pr-revision-options) for options.
