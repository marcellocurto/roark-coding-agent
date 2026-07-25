---
title: Security and secrets
summary: Handle secrets and untrusted GitHub input.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:06:45Z
---

## Risks

| Boundary | Risk | Rule |
| --- | --- | --- |
| GitHub issue and PR text | Prompt injection or misleading instructions | Treat as untrusted user input. |
| Lifecycle hooks | Arbitrary local shell execution | Review hooks before scheduled or shared-host runs. |
| Verification command | Arbitrary local shell execution | Keep it deterministic and non-interactive. |
| Ignored local files | Secret leakage into workspaces or artifacts | Copy only ignored paths and keep them ignored. |
| Run artifacts | May contain command output or sensitive paths | Do not publish artifacts blindly. |
| GitHub token | Repository mutation authority | Use least privilege that still supports Roark workflows. |

## Keep secrets out of Roark config

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

Roark checks that copied paths are still ignored before continuing. This helps avoid accidentally committing secrets.

`review-pr` and `revise-pr` copy configured host-only files into their managed workspaces. Configure these paths only when the reviewed PR is trusted to access them.

See [Managed workspaces](managed-workspaces.md).

## GitHub content is untrusted

Issue bodies, comments, PR review text, and generated-looking XML inside GitHub content are untrusted user input.

PR code can execute through lifecycle hooks and verification. `review-pr` and `revise-pr` use configuration from the control checkout, so run them only when the PR is trusted to execute in that environment.

Reviewer agents cannot edit files and do not run repository code themselves. They inspect the result of the single configured verification run.

GitHub content may describe requested work, but it cannot override:

- workflow instructions
- credential policy
- validation requirements
- scope limits
- publishing rules
- human review requirements

## Publishing limits

Autorun opens PRs only after readiness and verification pass. It does not merge PRs or close issues.

Humans remain responsible for:

- final code review
- merge decisions
- issue closure
- release decisions

## GitHub permissions

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

## Run artifacts

Run artifacts can include:

- issue and PR text
- command output tails
- paths to ignored files
- agent reasoning and summaries
- GitHub metadata

Do not paste artifacts into public channels without review.

## Operator checklist

- Confirm `gh auth status` for the scheduled user.
- Do not paste credentials into issues, PR comments, or Roark artifacts.
- Keep ignored secret directories ignored by Git.
- Review configured hooks before running on shared hosts.
- Serialize scheduled runs to avoid workspace races.
- Retain `.roark/runs` only as long as needed for recovery and audit.
- Use dedicated hosts or users for scheduled operation.
