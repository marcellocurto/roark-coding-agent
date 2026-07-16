---
title: Issue curation
summary: How Roark turns reviewer findings into approved GitHub follow-up issues.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-13T00:00:00Z
---

Use it when Roark found valid work that should not be folded into the current issue.

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

## When to Create Follow-up Issues

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

## Publishing Behavior

The curation plan is structured context, not the final prose contract for GitHub.

On approved `create-issues --yes` runs, Roark calls an issue-authoring agent with the curation plan and approved plan item IDs. The agent must call `submit_issue_drafts` with one schema-validated draft per approved item. It cannot publish, return raw JSON, or supply labels and provenance as unvalidated prose.

Roark constructs each Markdown body from the accepted draft plus authoritative plan provenance, applies the plan's labels, checks GitHub for an exact normalized-title duplicate, and creates the issue with `gh`. `issue-creation-results.json` records the actual GitHub outcomes. Native issue relationships are not inferred from prose or created unless a future structured plan explicitly models them.

## Approval Flow

1. Run the issue workflow.
2. Inspect reviewer findings and generated plan.
3. Edit source context or rerun curation if the plan is wrong.
4. Run `create-issues` without `--yes` to preview approved plan items.
5. Run `create-issues --yes` only when the plan is approved.
6. Triage generated issues in GitHub.

## Next Steps

- Use [Artifacts](artifacts.md) to locate curation files.
- Use [CLI reference](cli-reference.md) for command options.
