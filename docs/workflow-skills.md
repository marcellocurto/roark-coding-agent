---
title: Workflow skills
summary: How Roark resolves bundled and repo-local skills while keeping normal workflow agents isolated from ambient Pi skill discovery.
dateCreated: 2026-05-08T06:28:17Z
lastUpdated: 2026-05-08T07:00:00Z
---

## `create-issues` publishing

The approved `create-issues --yes` publishing path resolves the Roark-owned `github-issue-create` skill and passes only that resolved skill path to the Pi runner.

Global or machine-local skills are not used as fallbacks.

## Repo-local override

Skill resolution checks the target workspace first:

```text
.roark/skills/github-issue-create/
```

If that override directory exists, Roark validates its `SKILL.md` and uses it. Missing or malformed override metadata fails clearly instead of falling back to the bundled copy.

## Bundled skill

When no repo override exists, Roark loads the bundled package skill from:

```text
skills/github-issue-create/
```

The path is resolved relative to the installed Roark package, not the process working directory.

The bundled package includes the skill's `SKILL.md`, `templates/`, `examples/`, and `references/`.

## Updating the bundled skill

When updating the bundled skill:

1. Copy the upstream skill directory deliberately.
2. Record the upstream source and commit in the update PR.
3. Run skill-resolution and create-issues tests.

## Next steps

- Use [Issue curation](issue-curation.md) for the `curate-issues` and `create-issues` workflow.
- Use [Architecture](architecture.md) for contributor-level integration points.
- Use [CLI reference](cli-reference.md) for command options.
