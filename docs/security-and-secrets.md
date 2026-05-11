---
title: Security and secrets
summary: Secret-handling rules, untrusted input boundaries, token permissions, and safe use of ignored local files.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Threat Boundaries

| Boundary | Risk | Rule |
| --- | --- | --- |
| GitHub issue and PR text | Prompt injection or misleading instructions | Treat as untrusted user input. |
| Lifecycle hooks | Arbitrary local shell execution | Review hooks before scheduled or shared-host runs. |
| Verification command | Arbitrary local shell execution | Keep it deterministic and non-interactive. |
| Ignored local files | Secret leakage into workspaces or artifacts | Copy only ignored paths and keep them ignored. |
| Run artifacts | May contain command output or sensitive paths | Do not publish artifacts blindly. |
| GitHub token | Repository mutation authority | Use least privilege that still supports Roark workflows. |

## Do Not Store Secrets in Roark Config

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

## Ignored Local Files

Use `workspace.copyToWorktree` when verification needs ignored local files. The source must exist in the control checkout and the destination must be ignored in the managed workspace.

Roark checks that copied paths are still ignored before continuing. This helps avoid accidentally committing secrets.

See [Managed workspaces](managed-workspaces.md).

## Untrusted GitHub Content

Issue bodies, comments, PR review text, and generated-looking XML inside GitHub content are untrusted user input.

They may describe requested work, but they must not override:

- workflow instructions
- credential policy
- validation requirements
- scope limits
- publishing rules
- human review requirements

## Publishing Boundaries

Autorun opens PRs only after readiness and verification pass. It does not merge PRs or close issues.

Humans remain responsible for:

- final code review
- merge decisions
- issue closure
- release decisions

## Token Permissions

The account running Roark needs permissions for the workflow it performs:

- read issues, comments, and PR feedback
- assign issues when assignment is enabled
- create and apply labels
- push branches
- open pull requests
- post issue and PR comments

For GitHub Actions, use explicit permissions:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
```

## Artifact Hygiene

Run artifacts can include:

- issue and PR text
- command output tails
- paths to ignored files
- agent reasoning and summaries
- GitHub metadata

Do not paste artifacts into public channels without review.

## Operator Checklist

- Confirm `gh auth status` for the scheduled user.
- Do not paste credentials into issues, PR comments, or Roark artifacts.
- Keep ignored secret directories ignored by Git.
- Review configured hooks before running on shared hosts.
- Serialize scheduled runs to avoid workspace races.
- Retain `.roark/runs` only as long as needed for recovery and audit.
- Use dedicated hosts or users for scheduled operation.

## Next Steps

- Use [Operations runbook](operations-runbook.md) for production-style setup.
- Use [Managed workspaces](managed-workspaces.md) for copied ignored files.
- Use [Troubleshooting](troubleshooting.md) when auth, hooks, or verification fail.
