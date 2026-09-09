---
title: Artifacts
summary: Where Roark stores run data and what each file contains.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-09-09T07:06:16Z
---

Roark saves plans, reports, and logs for each run. These files are called artifacts. You can use them to:

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

Not every run creates every file. If Roark uses a plan from your issue, it saves the checked plan without creating a draft. Fix logs appear only when Roark tries to fix a problem found during review or checks.

## Start here

| Question                                     | Start with                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| What happened overall?                       | `summary.json`                                                                                 |
| Why did publishing stop?                     | `readiness.md` for the human view, `readiness.json` for the gate state, then `verification.md` |
| What command failed?                         | `verification.md`                                                                              |
| What did the agent change?                   | `implementation-log.md`, then the Git diff in the managed workspace                            |
| What did reviewers find?                     | `review-a-<n>.md` and `review-b-<n>.md`; use the matching JSON files for exact field values    |
| Can this be continued?                       | `attempt.json`, `attempts.json`, managed workspace state                                       |
| What follow-up issues were planned?          | `issue-curation-plan.json`                                                                     |
| What follow-up issue content was accepted?   | `issue-drafts.md`; use `issue-drafts.json` for exact field values                              |
| What follow-up issues were created?          | `issue-creation-results.json`                                                                  |
| What PR content was submitted and published? | `pr-draft.md`; use `pr-draft.json` for exact field values                                      |

## Issue files

| File                                                              | Purpose                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `issue.md`                                                        | Fetched issue context.                                                                                |
| `triage.json`, `triage.md`                                        | Triage result as structured data and readable Markdown.                                               |
| `implementation-plan-draft.json`, `implementation-plan-draft.md`  | Draft plan as structured data and readable Markdown.                                                  |
| `implementation-plan.json`, `implementation-plan.md`              | Final plan as structured data and readable Markdown.                                                  |
| `implementation-log.json`, `implementation-log.md`                | Implementation report as structured data and readable Markdown.                                       |
| `refinement-log-<n>.json`, `refinement-log-<n>.md`                | Report from code-refinement pass `n`.                                                                 |
| `review-a-<n>.json`, `review-b-<n>.json` and matching `.md` files | The two reviews. JSON records evidence, limitations, finding IDs, handling, and external blockers.    |
| `fix-log-<n>.json`, `fix-log-<n>.md`                              | Report from fix pass `n`, including the review findings it addressed.                                 |
| `readiness.json`, `readiness.md`                                  | The publish-gate decision and its readable form.                                                      |
| `verification.md`                                                 | Latest verification command, exit code, stdout tail, and stderr tail.                                 |
| `verification-full.md`                                            | Complete stdout and stderr from the latest verification command.                                      |
| `verification-before-fix-<n>.md`                                  | Archived failed verification output tail that triggered fix pass `n`.                                 |
| `verification-before-fix-<n>-full.md`                             | Complete stdout and stderr for the archived failed verification.                                      |
| `pr-draft.json`, `pr-draft.md`                                    | PR data and the body published to GitHub. Roark rebuilds the body when it adds follow-up issue links. |
| `issue-drafts.json`, `issue-drafts.md`                            | Follow-up issue data and the bodies published to GitHub.                                              |
| `attempt.json`                                                    | Branch, workspace, and lifecycle metadata.                                                            |
| `summary.json`                                                    | Artifact index and run summary.                                                                       |
| `events.jsonl`                                                    | Observable phase events.                                                                              |

## Where the plan came from

Start with `triage.md` and `implementation-plan.md` for a readable explanation. The matching JSON files contain the same details in a format Roark can process.

In `triage.json`, `planAction` tells you how Roark prepared the plan:

| Value   | Meaning                                             |
| ------- | --------------------------------------------------- |
| `draft` | Write a plan because the issue still needs one.     |
| `adopt` | Use the plan already in the issue.                  |
| `adapt` | Use the existing plan with small technical updates. |

`planSource` identifies the issue section or comment that contains the existing plan.

The plan records these details:

| Field               | What it tells you                                                    |
| ------------------- | -------------------------------------------------------------------- |
| `source`            | Where the plan came from.                                            |
| `adaptations`       | What Roark changed in the plan and why.                              |
| `assumptions`       | Small implementation choices Roark made and what supports them.      |
| `blockingQuestions` | Questions that need an answer before work can continue.              |
| `externalBlockers`  | Things outside the current work that must be resolved first.         |
| `resolvedQuestions` | Earlier questions, their answers, and where those answers came from. |

## Why a run stopped

The plan records questions that remain unresolved after investigation, along with dependencies or access problems that prevent work from continuing. It explains what is needed to resolve them. Roark uses `blockingQuestions` and `externalBlockers` to decide whether to stop; a note in the risks section alone does not stop the run.

Change reports use the same fields when an unresolved question or blocker prevents further work during coding. The report describes the work already done so you can review it.

`execution-stop.json` identifies the report that stopped coding. `continuation-state.json` records whether new feedback is being checked, whether work is still blocked, and which saved results must be replaced. An interrupted update is completed before another agent starts.

Each continuation saves the earlier reports under `continuations/<n>/`. The latest issue discussion, saved questions, and current diff are recorded in `continuation-input.json`. The decision and sources for resolved questions are recorded in `continuation-review.json` and its Markdown copy. Edited comments are fetched with their IDs, URLs, authors, and edit times.

Continuing keeps the original review baseline and code already written. Restarting also creates a backup of workspace changes, then restores that baseline. See [Recovery](recovery.md) for commands and backup details.

In `readiness.json`, `executionBlocked` records an active coding stop. A blocked continuation also prevents publication.

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
