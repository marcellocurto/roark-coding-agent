---
title: Artifacts
summary: Layout, purpose, and inspection path for Roark run, attempt, phase, curation, PR review, and PR revision artifacts.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-14T00:00:00Z
---

Artifacts are useful for:

- understanding why a run stopped
- inspecting agent decisions
- recovering failed attempts
- debugging verification failures
- auditing PR reviews, PR revisions, and issue curation

## Issue Attempt Layout

```text
.roark/runs/
└── issue/
    └── <issue-number>/
        ├── attempts.json
        └── attempts/
            └── <attempt-number>/
                ├── issue.md
                ├── triage.json
                ├── triage.md
                ├── implementation-plan-draft.json
                ├── implementation-plan-draft.md
                ├── implementation-plan.json
                ├── implementation-plan.md
                ├── implementation-log.json
                ├── implementation-log.md
                ├── refinement-log-0.json
                ├── refinement-log-0.md
                ├── review-a-0.json
                ├── review-a-0.md
                ├── review-b-0.json
                ├── review-b-0.md
                ├── fix-log-1.json
                ├── fix-log-1.md
                ├── readiness.json
                ├── readiness.md
                ├── verification.md
                ├── verification-full.md
                ├── verification-before-fix-1.md
                ├── verification-before-fix-1-full.md
                ├── pr-draft.json
                ├── pr-draft.md
                ├── attempt.json
                ├── summary.json
                ├── events.jsonl
                ├── issue-curation-plan.json
                ├── issue-drafts.json
                ├── issue-drafts.md
                └── issue-creation-results.json
```

Not every file exists for every run. For example, fix logs exist only when fix passes run.

## Files to Open First

| Question | Start with |
| --- | --- |
| What happened overall? | `summary.json` |
| Why did publishing stop? | `readiness.md` for the human view, `readiness.json` for the gate state, then `verification.md` |
| What command failed? | `verification.md` |
| What did the agent change? | `implementation-log.md` for the human view, `implementation-log.json` for structured data, then Git diff in the managed workspace |
| What did reviewers find? | `review-a-<n>.json` and `review-b-<n>.json` for authority; matching `.md` files for deterministic human views |
| Can this be continued? | `attempt.json`, `attempts.json`, managed workspace state |
| What follow-up issues were planned? | `issue-curation-plan.json` |
| What follow-up issue content was accepted? | `issue-drafts.json` for the source and `issue-drafts.md` for the rendered bodies |
| What follow-up issues were created? | `issue-creation-results.json` |
| What PR content was submitted and published? | `pr-draft.json` for the accepted source and `pr-draft.md` for the exact rendered body |

## Common Issue Files

| File | Purpose |
| --- | --- |
| `issue.md` | Fetched issue context. |
| `triage.json`, `triage.md` | Schema-validated triage source and its deterministic human rendering. |
| `implementation-plan-draft.json`, `implementation-plan-draft.md` | Schema-validated draft plan and its deterministic human rendering. |
| `implementation-plan.json`, `implementation-plan.md` | Schema-validated final plan and its deterministic human rendering. |
| `implementation-log.json`, `implementation-log.md` | Schema-validated implementation report and its deterministic human rendering. |
| `refinement-log-<n>.json`, `refinement-log-<n>.md` | Schema-validated code-refinement report and its deterministic human rendering. |
| `review-a-<n>.json`, `review-b-<n>.json` and matching `.md` files | Independent, bounded, schema-validated reviews and their escaped deterministic human renderings. JSON records inspected evidence, completeness/limitations, semantic finding IDs, handling, and external constraints. |
| `fix-log-<n>.json`, `fix-log-<n>.md` | Schema-validated fix report and its deterministic human rendering. Fix reports identify addressed review findings by workflow ID. |
| `readiness.json`, `readiness.md` | Validated readiness decision used by the publish gate and its deterministic human rendering. |
| `verification.md` | Latest verification command, exit code, stdout tail, and stderr tail. |
| `verification-full.md` | Complete stdout and stderr from the latest verification command. |
| `verification-before-fix-<n>.md` | Archived failed verification output tail that triggered fix pass `n`. |
| `verification-before-fix-<n>-full.md` | Complete stdout and stderr for the archived failed verification. |
| `pr-draft.json`, `pr-draft.md` | Schema-validated PR authoring result and the deterministic GitHub body rendered from it. Follow-up issue links rerender the Markdown from the JSON source. |
| `issue-drafts.json`, `issue-drafts.md` | Schema-validated reviewer-generated issue drafts and their deterministic GitHub bodies. |
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
        ├── review-<n>/
        └── revision-<n>/
```

PR review generations include pinned comparison metadata, PR and optional linked-issue context, verification, independent `review-a.json` and `review-b.json` source artifacts, deterministic Markdown renderings, a deterministic summary, and metadata. Every rerun is preserved under `review-<n>` even though the public marked comment is updated in place.

PR revision artifacts include fetched feedback, a schema-validated `revision-plan.json` source artifact with a deterministic `revision-plan.md` rendering, schema-validated `revision-log*.json` execution results with deterministic Markdown companions, schema-validated `revision-review*.json` source artifacts with deterministic Markdown companions, bounded verification files and complete `verification-full.md` and `verification-before-fix-<n>-full.md` companions, and metadata when applicable.

Triage, implementation planning, implementation, code refinement, fixes, review, PR revision planning, PR revision execution, PR authoring, and reviewer-generated issue authoring complete through schema-validated submission tools. Roark derives workflow state and public content from structured objects and renders Markdown companions from accepted data. Free-form or rendered Markdown is not parsed as workflow state or publishing authority.

## Git Behavior

Issue run artifacts are useful for inspection and recovery. Publishing flows generally avoid including issue run artifacts in the PR commit.

PR revision workflows keep revision artifacts local and exclude `.roark` control-plane state from successful revision commits.

## Artifact Durability

Artifacts are local files. If the control checkout is removed, artifact history is removed with it. If a managed workspace is removed, uncommitted recoverable work may be lost even if artifacts remain.

For scheduled operation, back up or retain `.roark/runs` according to your repository's audit needs.

## Next Steps

- Use [Recovery](recovery.md) to continue a failed attempt.
- Use [Troubleshooting](troubleshooting.md) to map symptoms to artifact files.
- Use [Architecture](architecture.md) for contributor-level artifact contracts.
