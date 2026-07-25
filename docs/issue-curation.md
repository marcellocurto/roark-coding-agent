---
title: Issue curation
summary: Turn review findings into GitHub issues.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-07-25T07:06:45Z
---

Use issue curation when a review finds real work that does not belong in the current PR.

## Commands

Create or refresh the curation plan:

```bash
roark curate-issues 123 --repo owner/repo
```

Publish approved issues:

```bash
roark create-issues 123 --repo owner/repo --yes
```

Without `--yes`, `create-issues` is a dry run.

## What belongs in a follow-up issue

Good candidates:

- real bugs discovered during review
- non-blocking cleanup that should not delay the current PR
- external blockers that need owner input
- scope that belongs in a separate vertical slice

Poor candidates:

- duplicate findings
- speculative improvements
- work already handled by the current issue
- vague tasks without acceptance criteria
- tasks that only split implementation layers without user-visible value

## Labels

Generated issues use:

| Label | Meaning |
| --- | --- |
| `needs-triage` | Newly generated issue awaiting maintainer triage |
| `review:external-blocker` | Generated from outside information, access, dependency, or decision blocker findings |
| `review:follow-up` | Valid non-blocking work discovered during review |
| `review:suggestion` | Optional improvement work discovered during review |

`needs-human` is added only when a concrete decision, clarification, or approval is required; it is not applied to every generated issue.

See [Label semantics](label-semantics.md).

## Artifacts

Issue curation writes:

```text
.roark/runs/issue/<n>/attempts/<k>/issue-curation-plan.json
.roark/runs/issue/<n>/attempts/<k>/issue-drafts.json
.roark/runs/issue/<n>/attempts/<k>/issue-drafts.md
.roark/runs/issue/<n>/attempts/<k>/issue-creation-results.json
```

Review the plan before publishing.

## Publishing

The curation plan decides which findings may become issues. It is not the issue body.

With `create-issues --yes`, Roark asks an issue-authoring agent to draft each approved item. The agent can draft content but cannot publish issues or choose their labels.

Roark adds the source finding, applies labels from the plan, checks GitHub for an issue with the same normalized title, and creates the issue with `gh`. Results go in `issue-creation-results.json`. It does not infer GitHub issue relationships from prose.

## Approve and publish

1. Run the issue workflow.
2. Inspect reviewer findings and generated plan.
3. Edit source context or rerun curation if the plan is wrong.
4. Run `create-issues` without `--yes` to preview approved plan items.
5. Run `create-issues --yes` only when the plan is approved.
6. Triage generated issues in GitHub.
