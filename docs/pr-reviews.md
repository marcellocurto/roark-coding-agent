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
6. Persist each reviewer's final Markdown without converting it into a structured review or summary.
7. Recheck the PR head and post Review A and Review B directly as two new comments if the result is still current.

Use `--no-comment` for a fully local review. Changes to PR state, base, or head prevent current publication while preserving the stale generation. Comment publishing failures also preserve completed review text and return an operational error. Reruns create a fresh pair of reviewer comments; Roark does not synthesize or update an aggregate review comment.

Run `roark revise-pr 123` separately when you explicitly want Roark to implement existing feedback and push a revision.
