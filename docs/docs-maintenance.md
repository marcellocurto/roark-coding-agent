---
title: Docs maintenance
summary: How to keep Roark documentation aligned with CLI behavior and repository structure.
dateCreated: 2026-05-08T07:00:00Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Update Checklist

When behavior changes, check whether these pages need edits:

- [CLI reference](cli-reference.md) for command and option changes
- [Usage](usage.md) for common workflow changes
- [Configuration](configuration.md) for config key changes
- [Artifacts](artifacts.md) for artifact file changes
- [Label semantics](label-semantics.md) for label behavior changes
- [Troubleshooting](troubleshooting.md) for new failure modes
- [Operations runbook](operations-runbook.md) for scheduler or host changes
- [Architecture](architecture.md) for contributor-facing module changes
- `docs/docs.json` for navigation changes

## CLI Drift Check

Compare docs against runtime help:

```bash
bun run roark.ts --help
```

The command list and options in [CLI reference](cli-reference.md) should match that output.

## Link Check

List Markdown links:

```bash
rg -n '\[[^]]+\]\(([^)]+)\)' README.md docs
```

For local links, confirm the target file exists and anchors still make sense after heading changes.

## Navigation Check

Every user-facing page should be reachable from at least one of:

- root `README.md`
- [Roark documentation](README.md)
- `docs/docs.json`

Pages that are intentionally obscure should say why in their nearest parent page.

## Page Shape

Prefer this structure:

1. what the page is for
2. minimal command or example
3. concepts or reference details
4. failure and safety notes when relevant
5. next steps

## Next Steps

- Use [Architecture](architecture.md) before changing workflow internals.
- Use [CLI reference](cli-reference.md) before changing command help.
- Use [Troubleshooting](troubleshooting.md) before adding new failure behavior.
