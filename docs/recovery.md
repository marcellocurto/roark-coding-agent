---
title: Recovery
summary: Inspect and resume a stopped run.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:13:47Z
---

## Continue an attempt

```bash
roark continue 123 --repo owner/repo --attempt 1
```

If `--attempt` is omitted, Roark uses the latest attempt recorded in:

```text
.roark/runs/issue/<number>/attempts.json
```

## What `continue` does

`continue` keeps valid artifacts, rebuilds missing or malformed outputs, reruns readiness and verification, and publishes if both pass.

If verification failed and fix budget remains, `continue` starts the next fix and review pass before running verification again.

## Dirty workspaces

A failed attempt may leave uncommitted edits in its workspace. `continue` resumes that work. A new `auto` run refuses the dirty workspace.

## Limits

Uncommitted work is recoverable only while the issue workspace exists. Roark can recreate a deleted workspace from the issue branch, but it cannot restore deleted uncommitted edits.

## Files to inspect

- `.roark/runs/issue/<n>/attempts/<k>/attempt.json`
- `.roark/runs/issue/<n>/attempts/<k>/summary.json`
- `.roark/runs/issue/<n>/attempts/<k>/verification.md`
- `.roark/runs/issue/<n>/attempts/<k>/verification-before-fix-<pass>.md`
- `.roark/runs/issue/<n>/attempts/<k>/readiness.json`
- `.roark/runs/issue/<n>/attempts/<k>/readiness.md`

See [Artifacts](artifacts.md) for the full layout.

## Recovery checklist

1. Open `summary.json`.
2. Open `readiness.md` and `verification.md`; use `readiness.json` for exact gate values.
3. Inspect the managed workspace if uncommitted edits matter.
4. Fix host setup, config, hook, ignored-file, or code issues.
5. Run `roark continue`.
