---
title: Artifacts
summary: Where Roark stores run data and what each file contains.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:06:45Z
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

Not every file exists for every run. For example, fix logs exist only when fix passes run.

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

This records attempts for an issue and is used by `roark continue` when no explicit attempt is supplied.

## PR run layout

```text
.roark/runs/
└── pr/
    └── <pr-number>/
        ├── review-<n>/
        └── revision-<n>/
```

Each `review-<n>` directory stores the pinned base and head, PR context, optional linked-issue context, verification output, metadata, and the two reviews in `review-a.md` and `review-b.md`. Those Markdown files become the PR comments after redaction and the addition of hidden ownership markers. Rerunning the command creates another numbered directory and another pair of comments.

Each `revision-<n>` directory stores the fetched feedback, revision plan, execution logs, reviews, verification output, and run metadata. Structured results use JSON, with matching Markdown files for reading. Full verification output uses `verification-full.md` and `verification-before-fix-<n>-full.md`.

Roark makes workflow decisions from the validated JSON files, not from the Markdown copies. The same rule applies to PR and follow-up issue content: the structured data is the source, and Roark renders the public Markdown from it.

## Git behavior

Issue run artifacts are useful for inspection and recovery. Publishing flows generally avoid including issue run artifacts in the PR commit.

PR revision workflows keep revision artifacts local and exclude `.roark` control-plane state from successful revision commits.

## Retention and deletion

Artifacts are local files. If the control checkout is removed, artifact history is removed with it. If a managed workspace is removed, uncommitted recoverable work may be lost even if artifacts remain.

Because these paths are meaningful only in the control checkout, Roark does not include local run or artifact paths in public GitHub comments, pull request bodies, or generated issues.

For scheduled operation, back up or retain `.roark/runs` according to your repository's audit needs.
