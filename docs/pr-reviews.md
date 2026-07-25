---
title: PR reviews
summary: Review an existing PR without changing it.
dateCreated: 2026-07-12T00:00:00Z
lastUpdated: 2026-07-25T07:06:45Z
---

```bash
roark review-pr 123 --repo owner/repo
```

`review-pr` runs separate correctness and maintainability reviews against the full PR diff. It does not edit files, commit, push, or invoke `revise-pr`.

## Flow

1. Fetch the PR, its comments and review threads, and the base and head commit IDs.
2. Prepare a managed workspace at the pinned PR head.
3. Run the configured verification command once.
4. Run the correctness and maintainability reviews with editing disabled.
5. Save both reviews as Markdown.
6. Check that the PR head has not changed, then post the reviews as two comments.

Use `--no-comment` to keep the review local. If the PR state, base, or head changes during the run, Roark keeps the local result but does not post it. If posting fails, the local result remains and the command returns an error. A rerun creates a new pair of comments instead of replacing previous reviews.

Run `roark revise-pr 123` separately to implement existing feedback and push a revision.
