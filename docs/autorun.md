---
title: Autorun
summary: End-to-end behavior of `roark auto`, including issue selection, claiming, gates, and draft PR publishing.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# Autorun

`roark auto` is a one-shot, label-gated, draft-PR-only workflow.

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
9. On success, commit code changes, push the branch, and open a draft PR.
10. On failure, leave work uncommitted and post recovery information.

## Recommended posture

Keep `--limit 1` while building trust. Roark is intentionally one-shot; use an external scheduler if you want periodic execution.

## Selection labels

The default ready label is `afk`. The default skip set includes lifecycle/status labels such as `roark-in-progress`, `roark-failed`, and `roark-pr-opened`.

See [Label semantics](label-semantics.md) for the full label reference.

## Safety boundaries

Autorun never merges PRs, never closes issues, and opens draft PRs only. A human reviewer remains responsible for marking PRs ready, reviewing them, and merging them.
