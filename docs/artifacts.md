---
title: Artifacts
summary: Layout, purpose, and inspection path for Roark run, attempt, phase, curation, and PR revision artifacts.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

Artifacts are useful for:

- understanding why a run stopped
- inspecting agent decisions
- recovering failed attempts
- debugging verification failures
- auditing PR revisions and issue curation

## Issue Attempt Layout

```text
.roark/runs/
└── issue/
    └── <issue-number>/
        ├── attempts.json
        └── attempts/
            └── <attempt-number>/
                ├── issue.md
                ├── triage.md
                ├── implementation-plan.md
                ├── implementation-log.md
                ├── review-a.md
                ├── review-b.md
                ├── fix-log-1.md
                ├── final-review-1.md
                ├── readiness.md
                ├── verification.md
                ├── verification-before-fix-1.md
                ├── attempt.json
                ├── summary.json
                ├── events.jsonl
                ├── issue-curation-plan.json
                └── issue-creation-results.json
```

Not every file exists for every run. For example, fix logs exist only when fix passes run.

## Files to Open First

| Question | Start with |
| --- | --- |
| What happened overall? | `summary.json` |
| Why did publishing stop? | `readiness.md`, then `verification.md` |
| What command failed? | `verification.md` |
| What did the agent change? | `implementation-log.md`, then Git diff in the managed workspace |
| What did reviewers find? | `review-a.md`, `review-b.md`, `final-review-<n>.md` |
| Can this be continued? | `attempt.json`, `attempts.json`, managed workspace state |
| What follow-up issues were planned? | `issue-curation-plan.json` |
| What follow-up issues were created? | `issue-creation-results.json` |

## Common Issue Files

| File | Purpose |
| --- | --- |
| `issue.md` | Fetched issue context. |
| `triage.md` | Proceed, block, reject, or needs-human decision. |
| `implementation-plan.md` | Plan for the implementation phase. |
| `implementation-log.md` | Implementation result. |
| `review-a.md`, `review-b.md` | Independent reviews. |
| `fix-log-<n>.md` | Fix pass output. |
| `final-review-<n>.md` | Review after a fix pass. |
| `readiness.md` | Final readiness gate artifact. |
| `verification.md` | Latest verification command, exit code, stdout tail, and stderr tail. |
| `verification-before-fix-<n>.md` | Archived failed verification output that triggered fix pass `n`. |
| `attempt.json` | Branch, workspace, and lifecycle metadata. |
| `summary.json` | Artifact index and run summary. |
| `events.jsonl` | Observable phase events. |

## Attempt Index

```text
.roark/runs/issue/<issue-number>/attempts.json
```

This records attempts for an issue and is used by `roark continue` when no explicit attempt is supplied.

## PR Revision Layout

```text
.roark/runs/
└── pr/
    └── <pr-number>/
        └── revision-<n>/
```

PR revision artifacts include fetched feedback, revision plan, revision log, review, verification, and metadata when applicable.

## Git Behavior

Issue run artifacts are useful for inspection and recovery. Publishing flows generally avoid including issue run artifacts in the draft PR commit.

PR revision workflows commit revision artifacts with the successful revision.

## Artifact Durability

Artifacts are local files. If the control checkout is removed, artifact history is removed with it. If a managed workspace is removed, uncommitted recoverable work may be lost even if artifacts remain.

For scheduled operation, back up or retain `.roark/runs` according to your repository's audit needs.

## Next Steps

- Use [Recovery](recovery.md) to continue a failed attempt.
- Use [Troubleshooting](troubleshooting.md) to map symptoms to artifact files.
- Use [Architecture](architecture.md) for contributor-level artifact contracts.
