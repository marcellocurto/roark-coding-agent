---
title: Docs maintenance
summary: Keep the docs in sync with Roark's CLI and behavior.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-07-25T07:06:45Z
---

## Update checklist

When behavior changes, check whether these pages need edits:

- page frontmatter: set `lastUpdated` to the actual UTC edit time
- [CLI reference](cli-reference.md) for command and option changes
- [Usage](usage.md) for common workflow changes
- [Configuration](configuration.md) for config key changes
- [Artifacts](artifacts.md) for artifact file changes
- [Label semantics](label-semantics.md) for label behavior changes
- [Troubleshooting](troubleshooting.md) for new failure modes
- [Operations runbook](operations-runbook.md) for scheduler or host changes
- [Architecture](architecture.md) for contributor-facing module changes
- `docs/docs.json` for navigation changes

## CLI drift check

Compare docs against runtime help:

```bash
bun run roark.ts --help
```

The command list and options in [CLI reference](cli-reference.md) should match that output.

## Link check

List Markdown links:

```bash
rg -n '\[[^]]+\]\(([^)]+)\)' README.md docs
```

For local links, confirm the target file exists and anchors still make sense after heading changes.

## Navigation check

Every user-facing page should be reachable from at least one of:

- root `README.md`
- [Roark documentation](README.md)
- `docs/docs.json`

## Writing

State what the command does, show the command, and document its constraints. Skip generic introductions, repeated recaps, and boilerplate "Next steps" sections.
