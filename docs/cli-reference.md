---
title: CLI reference
summary: Command and option reference for common Roark workflows.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# CLI reference

## Help

```bash
roark --help
```

## Core commands

```bash
roark init
roark auto --repo owner/repo --limit 1
roark do 123 --repo owner/repo
roark continue 123 --repo owner/repo --attempt 1
roark revise-pr 123 --repo owner/repo
roark status 123 --repo owner/repo
```

## Phase commands

```bash
roark fetch 123 --repo owner/repo
roark triage 123 --repo owner/repo
roark plan 123 --repo owner/repo
roark implement 123 --repo owner/repo
roark review 123 --repo owner/repo
roark fix 123 --repo owner/repo --fix-pass 1
roark final-review 123 --repo owner/repo --fix-pass 1
roark readiness 123 --repo owner/repo
```

## Common options

- `--repo <owner/repo>`: GitHub repository.
- `--cwd <path>`: control checkout path.
- `--base-branch <branch>`: issue branch base. Defaults to `main`.
- `--verify <cmd>`: verification command.
- `--model <provider/id>`: Pi model override.
- `--thinking <level>`: thinking level override.
- `--max-fix-passes <n>`: maximum fix/review cycles.
- `--force`: regenerate existing phase artifacts.
- `--yes`: bypass supported dirty-tree preflight prompts/refusals.
- `--attempt <n>`: select a specific issue attempt.

## Autorun options

- `--label <label>`: ready label.
- `--skip-label <label>`: repeatable skip label.
- `--skip-labels <labels>`: comma-separated skip labels.
- `--limit <n>`: number of issues to claim. Defaults to `1`.
- `--dry-run`: preview selection without claiming or running.
- `--in-progress-label <label>`: claim label.
- `--failure-label <label>`: failure label.
- `--success-label <label>`: success label.
- `--remote <name>`: push remote. Defaults to `origin`.

See the root `README.md` for the most complete current option text.
