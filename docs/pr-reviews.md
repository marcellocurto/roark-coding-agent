---
title: PR reviews
summary: Fresh inspection-only review of an existing pull request.
dateCreated: 2026-07-12T00:00:00Z
lastUpdated: 2026-07-12T00:00:00Z
---

```bash
roark review-pr 123 --repo owner/repo
```

`review-pr` reviews the complete contribution of any open or draft PR independently of existing comments. It supports same-repository and fork PRs, runs correctness and maintainability reviewers independently, and never edits, commits, pushes, or invokes `revise-pr`.

## Flow

1. Fetch PR requirements, comments, threads, and immutable base/head commit IDs.
2. Fetch the base branch and GitHub pull head ref into a managed workspace.
3. Detach at the pinned head and inspect exactly merge-base-to-head.
4. Resolve verification from `--verify` or trusted repository config and run it once. On a host workspace, inferred package scripts are reported as suggestions rather than executed automatically.
5. Run independent correctness and maintainability reviews with editing tools disabled.
6. Persist `review-<n>` artifacts and derive `no-blocking-findings`, `changes-requested`, or `blocked` without a summary agent.
7. Recheck the PR head and post or update one marked actionable comment if the result is still current.

Use `--no-comment` for a fully local review. Changes to PR state, base, or head prevent current publication while preserving the stale generation. Comment publishing failures also preserve completed artifacts and return an operational error.

Run `roark revise-pr 123` separately when you explicitly want Roark to implement existing feedback and push a revision.
