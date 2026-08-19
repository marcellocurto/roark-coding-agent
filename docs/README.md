---
title: Roark documentation
summary: Install, configure, run, and operate Roark.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-08-19T07:58:25Z
---

## Quick start

```bash
roark init
roark auto --repo owner/repo --limit 1 --dry-run
roark do 123 --repo owner/repo
```

For the full first-run path, read [Quickstart](quickstart.md).

## Start here

| Page | Use it for |
| --- | --- |
| [Quickstart](quickstart.md) | Install Roark, initialize a target repository, run one issue, inspect the result, and recover. |
| [Concepts](concepts.md) | Learn how control checkouts, managed workspaces, attempts, gates, and artifacts fit together. |
| [Usage](usage.md) | Choose the command that matches the work you want Roark to perform. |
| [Glossary](glossary.md) | Look up a Roark term. |

## Workflows

| Page | Use it for |
| --- | --- |
| [Autorun](autorun.md) | Select labeled issues and publish pull requests. |
| [Recovery](recovery.md) | Inspect and continue a stopped or failed attempt. |
| [PR reviews](pr-reviews.md) | Inspect an existing pull request without changing it. |
| [PR revisions](pr-revisions.md) | Apply existing feedback to a pull request. |
| [Issue curation](issue-curation.md) | Turn reviewer findings into approved follow-up GitHub issues. |
| [Verification](verification.md) | Configure and diagnose the readiness and verification gates. |

## Operations

| Page | Use it for |
| --- | --- |
| [Operations runbook](operations-runbook.md) | Set up a host, assign permissions, monitor runs, recover work, and upgrade Roark. |
| [Scheduling](scheduling.md) | Run Roark through cron, launchd, or GitHub Actions. |
| [Managed workspaces](managed-workspaces.md) | Configure clone workspaces and copy ignored local files. |
| [Security and secrets](security-and-secrets.md) | Protect secrets and treat GitHub content as untrusted input. |
| [Troubleshooting](troubleshooting.md) | Diagnose a failed command or missing result. |

## Reference

| Page | Use it for |
| --- | --- |
| [CLI reference](cli-reference.md) | Look up a command or option. |
| [Configuration](configuration.md) | Look up `.roark/config.json` keys, defaults, and precedence. |
| [Labels](labels.md) and [Label semantics](label-semantics.md) | Look up GitHub label roles and lifecycle transitions. |
| [Artifacts](artifacts.md) | Find a file under `.roark/runs` and understand what it records. |
| [Lifecycle hooks](lifecycle-hooks.md) | Run setup commands such as dependency installation. |

## Development

| Page | Use it for |
| --- | --- |
| [Architecture](architecture.md) | Find the module responsible for a command or workflow step. |
| [Versioning](versioning.md) | Apply the SemVer policy and run the release checklist. |
| [Docs maintenance](docs-maintenance.md) | Keep the documentation aligned with CLI behavior. |
