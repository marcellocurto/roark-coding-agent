---
title: Artifacts
summary: Layout and purpose of Roark run, attempt, phase, and PR revision artifacts.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# Artifacts

Roark writes durable reasoning and run state under `.roark/runs`.

## Issue attempts

```text
.roark/runs/issue/<issue-number>/attempts/<attempt-number>/
```

Common files:

- `issue.md`: fetched issue context.
- `triage.md`: proceed/block/reject/needs-human decision.
- `implementation-plan.md`: implementation plan.
- `implementation-log.md`: implementation result.
- `review-a.md`, `review-b.md`: independent reviews.
- `fix-log-<n>.md`: fix pass output.
- `final-review-<n>.md`: review after a fix pass.
- `readiness.md`: final readiness gate artifact.
- `verification.md`: verification command result.
- `attempt.json`: branch, workspace, and lifecycle metadata.
- `summary.json`: artifact index and run summary.
- `events.jsonl`: observable phase events.

## Attempt index

```text
.roark/runs/issue/<issue-number>/attempts.json
```

This records attempts for an issue and is used by `roark continue` when no explicit attempt is supplied.

## PR revisions

```text
.roark/runs/pr/<pr-number>/revision-<n>/
```

PR revision artifacts include fetched feedback, revision plan, revision log, review, verification, and metadata when applicable.

## Git behavior

Run artifacts are useful for inspection and recovery. Publishing flows generally avoid including issue run artifacts in the draft PR commit, while PR revision workflows commit revision artifacts with the successful revision.
