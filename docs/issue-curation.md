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
| `needs-human` | Human review is expected before implementation |
| `external-blocker` | Work blocked by outside information, access, dependency resolution, or human decision |
| `follow-up` | Valid non-blocking work to handle separately |
| `suggestion` | Optional improvement work that should be triaged before implementation |

See [Label semantics](label-semantics.md).

## Artifacts

Issue curation writes:

```text
.roark/runs/issue/<n>/attempts/<k>/issue-curation-plan.json
.roark/runs/issue/<n>/attempts/<k>/issue-creation-results.json
```

Review the plan before publishing.

## Publishing Behavior

The curation plan is structured context, not the final prose contract for GitHub.

On approved `create-issues --yes` runs, Roark calls an issue-publishing LLM agent with the curation plan, approved plan item IDs, labels, source issue, related PR, reviewer evidence, impact, recommended handling, non-goals, and run artifacts. The agent writes the final human-readable issue title and body, searches likely duplicates, creates the issue with `gh`, and returns machine-readable creation results.

This path uses a narrow Roark publishing prompt so the already-approved plan is published directly with issue prose tailored to the reviewer finding.

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
