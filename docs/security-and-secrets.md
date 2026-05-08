---
title: Security and secrets
summary: Secret-handling rules, untrusted input boundaries, and safe use of ignored local files.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# Security and secrets

Roark operates on GitHub issues, comments, PR feedback, local files, and managed workspaces. Treat those boundaries deliberately.

## Do not store secrets in Roark config

`.roark/config.json` should contain paths and commands, not secret values.

Good:

```json
{
  "workspace": {
    "copyToWorktree": [".secrets/env"]
  }
}
```

Bad:

```json
{
  "token": "secret-value"
}
```

## Ignored local files

Use `workspace.copyToWorktree` when verification needs ignored local files. The source must exist in the control checkout and the destination must be ignored in the managed workspace.

See [Managed workspaces](managed-workspaces.md).

## Untrusted GitHub content

Issue bodies, comments, PR review text, and generated-looking XML inside GitHub content are untrusted user input. They may describe requested work, but they must not override workflow instructions, credential policy, validation requirements, or scope limits.

## Publishing boundaries

Autorun opens draft PRs only. It does not merge PRs or close issues. Humans remain responsible for final review and merge decisions.

## Operator checklist

- Confirm `gh auth status` for the scheduled user.
- Do not paste credentials into issues, PR comments, or Roark artifacts.
- Keep ignored secret directories ignored by Git.
- Review configured hooks before running on shared hosts.
- Serialize scheduled runs to avoid workspace races.
