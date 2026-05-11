---
title: Roark documentation
summary: Start page and navigation map for Roark user, operator, reference, and contributor documentation.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Quick Start

```bash
roark init
roark auto --repo owner/repo --limit 1 --dry-run
roark do 123 --repo owner/repo
```

For the full first-run path, read [Quickstart](quickstart.md).

## Start Here

- [Quickstart](quickstart.md) - install, initialize a target repository, run one issue, inspect results, and recover.
- [Concepts](concepts.md) - control checkout, managed workspace, attempt, readiness gate, verification gate, and artifacts.
- [Usage](usage.md) - choose between `do`, `auto`, `continue`, `revise-pr`, workspace commands, and issue curation.
- [Glossary](glossary.md) - short definitions for common Roark terms.

## Workflows

- [Autorun](autorun.md) - label-gated one-shot automation and PR publishing.
- [Recovery](recovery.md) - inspect and continue stopped or failed attempts.
- [PR revisions](pr-revisions.md) - respond to feedback on an existing pull request.
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
- [Workflow skills](workflow-skills.md) - bundled and repo-local skill resolution.
- [Docs maintenance](docs-maintenance.md) - checks to keep docs aligned with CLI behavior.

## By role

### Repository user

Read [Quickstart](quickstart.md), [Concepts](concepts.md), [Configuration](configuration.md), [Managed workspaces](managed-workspaces.md), and [Verification](verification.md).

### Operator

Read [Operations runbook](operations-runbook.md), [Autorun](autorun.md), [Recovery](recovery.md), [Scheduling](scheduling.md), [Security and secrets](security-and-secrets.md), and [Troubleshooting](troubleshooting.md).

### Contributor

Read [Architecture](architecture.md), [Artifacts](artifacts.md), [CLI reference](cli-reference.md), [PR revisions](pr-revisions.md), [Labels](labels.md), [Workflow skills](workflow-skills.md), and [Docs maintenance](docs-maintenance.md).

## Navigation Metadata

`docs/docs.json` contains the same top-level navigation groups for future docs-site generation or link checks.
