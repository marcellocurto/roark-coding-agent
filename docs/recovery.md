---
title: Recovery
summary: How to inspect and continue failed or stopped Roark attempts.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Continue an attempt

```bash
roark continue 123 --repo owner/repo --attempt 1
```

If `--attempt` is omitted, Roark uses the latest attempt recorded in:

```text
.roark/runs/issue/<number>/attempts.json
```

## What continue does

`continue` reuses valid existing artifacts, regenerates missing or malformed phase outputs, rewrites readiness, reruns verification, and publishes only if readiness and verification both pass.

If an attempt stopped as `failed-verification` while fix budget remains, `continue` plans the next fix pass, refinement, numbered Review A/B cycle, readiness, and publish gate instead of just rerunning the failed command.

## Dirty workspaces

A failed attempt may leave uncommitted edits in the managed workspace. `continue` is allowed to recover that selected failed attempt. A fresh `auto` run refuses dirty existing issue workspaces and tells you to use `continue` or clean/remove the workspace.

## What cannot be recovered

Uncommitted failed work is recoverable only while the persistent issue workspace still exists. If the workspace is deleted, Roark can recreate it from the local or remote issue branch, but deleted uncommitted edits are gone.

## Useful files

- `.roark/runs/issue/<n>/attempts/<k>/attempt.json`
- `.roark/runs/issue/<n>/attempts/<k>/summary.json`
- `.roark/runs/issue/<n>/attempts/<k>/verification.md`
- `.roark/runs/issue/<n>/attempts/<k>/verification-before-fix-<pass>.md`
- `.roark/runs/issue/<n>/attempts/<k>/readiness.md`

See [Artifacts](artifacts.md) for the full layout.

## Recovery checklist

1. Open `summary.json`.
2. Open `readiness.md` and `verification.md`.
3. Inspect the managed workspace if uncommitted edits matter.
4. Fix host setup, config, hook, ignored-file, or code issues.
5. Run `roark continue`.

## Next steps

- Use [Troubleshooting](troubleshooting.md) for symptom-specific recovery.
- Use [Managed workspaces](managed-workspaces.md) before deleting workspaces.
- Use [Operations runbook](operations-runbook.md) for scheduled-run failure response.
