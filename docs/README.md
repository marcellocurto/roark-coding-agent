---
title: Roark documentation
summary: Install, configure, run, and operate Roark.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:06:45Z
---

## Quick start

```bash
roark init
roark auto --repo owner/repo --limit 1 --dry-run
roark do 123 --repo owner/repo
```

For the full first-run path, read [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, initialize a target repository, run one issue, inspect results, and recover.
- [Concepts](concepts.md) - control checkout, managed workspace, attempt, readiness gate, verification gate, and artifacts.
- [Usage](usage.md) - choose between `do`, `auto`, `continue`, `review-pr`, `revise-pr`, workspace commands, and issue curation.
- [Glossary](glossary.md) - short definitions for common Roark terms.

## Workflows

- [Autorun](autorun.md) - label-gated one-shot automation and PR publishing.
- [Recovery](recovery.md) - inspect and continue stopped or failed attempts.
- [PR reviews](pr-reviews.md) - inspect an existing pull request without changing it.
- [PR revisions](pr-revisions.md) - respond to existing feedback on a pull request.
- [Issue curation](issue-curation.md) - turn reviewer findings into approved follow-up GitHub issues.
- [Verification](verification.md) - readiness and verification gates.

## Operations

- [Operations runbook](operations-runbook.md) - host setup, permissions, monitoring, recovery, cleanup, and upgrades.
- [Scheduling](scheduling.md) - cron, launchd, and GitHub Actions examples.
- [Managed workspaces](managed-workspaces.md) - clone workspaces and `workspace.copyToWorktree`.
- [Security and secrets](security-and-secrets.md) - secret handling and untrusted input boundaries.
- [Troubleshooting](troubleshooting.md) - common failure symptoms and recovery steps.

## Reference

- [CLI reference](cli-reference.md) - commands and options.
- [Configuration](configuration.md) - `.roark/config.json`, defaults, and precedence.
- [Labels](labels.md) and [Label semantics](label-semantics.md) - GitHub label roles and lifecycle transitions.
- [Artifacts](artifacts.md) - `.roark/runs` layout and phase outputs.
- [Lifecycle hooks](lifecycle-hooks.md) - setup commands such as dependency installation.

## Development

- [Architecture](architecture.md) - contributor-level module and workflow overview.
- [Versioning](versioning.md) - SemVer policy, changelog expectations, and release checklist.
- [Docs maintenance](docs-maintenance.md) - checks to keep docs aligned with CLI behavior.
