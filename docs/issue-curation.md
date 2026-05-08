---
title: Issue curation
summary: How Roark turns reviewer findings into approved GitHub follow-up issues.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-08T07:00:00Z
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
| `external-blocker` | Work blocked by outside information, access, dependency resolution, or human decision |
| `follow-up` | Valid non-blocking work to handle separately |

See [Label semantics](label-semantics.md).

## Artifacts

Issue curation writes:

```text
.roark/runs/issue/<n>/attempts/<k>/issue-curation-plan.json
.roark/runs/issue/<n>/attempts/<k>/issue-creation-results.json
```

Review the plan before publishing.

## Skill Resolution

The publishing path resolves the Roark-owned `github-issue-create` skill.

Resolution order:

1. repo-local override: `.roark/skills/github-issue-create/`
2. bundled Roark package skill: `skills/github-issue-create/`

Global or machine-local Pi skills are not used as fallbacks. See [Workflow skills](workflow-skills.md).

## Approval Flow

1. Run the issue workflow.
2. Inspect reviewer findings and generated plan.
3. Edit source context or rerun curation if the plan is wrong.
4. Run `create-issues` without `--yes` to preview.
5. Run `create-issues --yes` only when the plan is approved.
6. Triage generated issues in GitHub.

## Next Steps

- Use [Workflow skills](workflow-skills.md) for skill override behavior.
- Use [Artifacts](artifacts.md) to locate curation files.
- Use [CLI reference](cli-reference.md) for command options.
