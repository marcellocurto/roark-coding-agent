---
title: Verification
summary: How Roark chooses and runs verification commands, and how readiness and verification gates differ.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# Verification

Roark publishes only when both readiness and verification pass.

## Configure verification

Use `--verify`:

```bash
roark auto --repo owner/repo --verify "bun run check"
```

Or set top-level `verify` in `.roark/config.json`:

```json
{
  "verify": "bun run check"
}
```

For `auto` and `continue`, Roark requires a verification command. It uses CLI flag, then config, then inference from `package.json` or `Makefile`.

## Readiness gate

The workflow's `readiness.md` must declare status exactly:

```text
ready-for-pr
```

Anything else fails the readiness gate.

## Verification gate

Roark runs the verification command through `sh -c` in the issue workspace. Exit code `0` passes. Any non-zero exit code fails.

The command, exit code, stdout tail, and stderr tail are written to:

```text
.roark/runs/issue/<n>/attempts/<k>/verification.md
```

## Common examples

```json
{ "verify": "bun run typecheck" }
```

```json
{ "verify": "bun run check" }
```

If verification needs ignored local files, configure `workspace.copyToWorktree`. See [Managed workspaces](managed-workspaces.md).
