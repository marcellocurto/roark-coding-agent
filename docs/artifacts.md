---
title: Artifacts
summary: Where Roark stores run data and what each file contains.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:13:47Z
---

Roark writes artifacts so you can:

- understand why a run stopped
- inspect agent decisions
- recover failed attempts
- debug verification failures
- audit PR reviews, PR revisions, and issue curation

## Issue attempt layout

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

Runs write only the files they need. Fix logs, for example, appear only after a fix pass.

## Start here

| Question | Start with |
| --- | --- |
| What happened overall? | `summary.json` |
| Why did publishing stop? | `readiness.md` for the human view, `readiness.json` for the gate state, then `verification.md` |
| What command failed? | `verification.md` |
| What did the agent change? | `implementation-log.md`, then the Git diff in the managed workspace |
| What did reviewers find? | `review-a-<n>.md` and `review-b-<n>.md`; use the matching JSON files for exact field values |
| Can this be continued? | `attempt.json`, `attempts.json`, managed workspace state |
| What follow-up issues were planned? | `issue-curation-plan.json` |
| What follow-up issue content was accepted? | `issue-drafts.md`; use `issue-drafts.json` for exact field values |
| What follow-up issues were created? | `issue-creation-results.json` |
| What PR content was submitted and published? | `pr-draft.md`; use `pr-draft.json` for exact field values |

## Issue files

| File | Purpose |
| --- | --- |
| `issue.md` | Fetched issue context. |
| `triage.json`, `triage.md` | Triage result as structured data and readable Markdown. |
| `implementation-plan-draft.json`, `implementation-plan-draft.md` | Draft plan as structured data and readable Markdown. |
| `implementation-plan.json`, `implementation-plan.md` | Final plan as structured data and readable Markdown. |
| `implementation-log.json`, `implementation-log.md` | Implementation report as structured data and readable Markdown. |
| `refinement-log-<n>.json`, `refinement-log-<n>.md` | Report from code-refinement pass `n`. |
| `review-a-<n>.json`, `review-b-<n>.json` and matching `.md` files | The two reviews. JSON records evidence, limitations, finding IDs, handling, and external blockers. |
| `fix-log-<n>.json`, `fix-log-<n>.md` | Report from fix pass `n`, including the review findings it addressed. |
| `readiness.json`, `readiness.md` | The publish-gate decision and its readable form. |
| `verification.md` | Latest verification command, exit code, stdout tail, and stderr tail. |
| `verification-full.md` | Complete stdout and stderr from the latest verification command. |
| `verification-before-fix-<n>.md` | Archived failed verification output tail that triggered fix pass `n`. |
| `verification-before-fix-<n>-full.md` | Complete stdout and stderr for the archived failed verification. |
| `pr-draft.json`, `pr-draft.md` | PR data and the body published to GitHub. Roark rebuilds the body when it adds follow-up issue links. |
| `issue-drafts.json`, `issue-drafts.md` | Follow-up issue data and the bodies published to GitHub. |
| `attempt.json` | Branch, workspace, and lifecycle metadata. |
| `summary.json` | Artifact index and run summary. |
| `events.jsonl` | Observable phase events. |

## Attempt index

```text
.roark/runs/issue/<issue-number>/attempts.json
```

`roark continue` reads this index when no attempt number is given.

## PR run layout

```text
.roark/runs/
└── pr/
    └── <pr-number>/
        ├── review-<n>/
        └── revision-<n>/
```

Each `review-<n>` directory contains the pinned base and head, PR context, verification output, metadata, and `review-a.md` and `review-b.md`. Linked-issue context is included when available.

Roark redacts the two reviews, adds hidden ownership markers, and posts them as PR comments. A rerun creates a new numbered directory and two new comments.

Each `revision-<n>` directory contains the fetched feedback, plan, execution logs, reviews, verification output, and run metadata. JSON holds the structured results; matching Markdown files make them easier to read.

Roark reads workflow state from validated JSON, not from the Markdown copies. It also renders PR and follow-up issue bodies from JSON.

## Git behavior

Roark normally keeps issue run artifacts out of PR commits.

PR revision artifacts stay local. Successful revision commits exclude `.roark`.

## Retention and deletion

Artifacts live in the control checkout and disappear with it. Deleting a managed workspace also deletes any uncommitted work inside it.

Roark removes local artifact paths from GitHub comments, PR bodies, and generated issues.

For scheduled operation, back up or retain `.roark/runs` according to your repository's audit needs.
