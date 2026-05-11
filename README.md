# roark-coding-agent

Roark is a small CLI workflow runner around the Pi coding-agent SDK. It turns GitHub issues into isolated agent runs, review artifacts, verification gates, and pull requests.

## What Roark does

- Runs an issue workflow: fetch, triage, plan, implement, review, fix, and readiness.
- Supports label-gated one-shot automation with `roark auto`.
- Uses managed clone workspaces so agent work is isolated from the control checkout.
- Publishes PRs only after readiness and verification pass.
- Recovers failed attempts with `roark continue`.
- Revises existing PRs from PR-scoped feedback with `roark revise-pr`.
- Writes durable run artifacts under `.roark/runs`.

Roark does **not** merge PRs, close issues, or run as a daemon. Humans remain responsible for final review and merge decisions.

## Install

Prerequisites:

- Bun
- Git
- GitHub CLI authenticated with `gh auth status`
- push and pull request permissions for the target repository

```bash
git clone https://github.com/marcellocurto/roark-coding-agent.git
cd roark-coding-agent
bun install
bun install -g "$PWD"
roark --help
```

For servers, pin a tag or commit before installing globally.

## Quick start

For the complete first-run path, see [Quickstart](docs/quickstart.md).

Initialize Roark config in a target repository:

```bash
roark init
```

Run one issue manually:

```bash
roark do https://github.com/owner/repo/issues/123
# or, from a checkout
roark do 123 --repo owner/repo
```

Preview autorun selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

Run one label-gated autorun attempt:

```bash
roark auto --repo owner/repo --limit 1
```

Recover a failed attempt:

```bash
roark continue 123 --repo owner/repo --attempt 1
```

Revise an existing PR from review feedback:

```bash
roark revise-pr 123 --repo owner/repo
```

## Choose your path

- First successful run: [Quickstart](docs/quickstart.md)
- Command selection: [Usage](docs/usage.md)
- Mental model: [Concepts](docs/concepts.md)
- Scheduled operation: [Operations runbook](docs/operations-runbook.md)
- Failed run recovery: [Troubleshooting](docs/troubleshooting.md)

## Local development

```bash
bun run roark.ts --help
bun run roark.ts do 123 --repo owner/repo
bun test
bun run typecheck
```

## Documentation

Start with the [docs index](docs/README.md).

Common topics:

- [Quickstart](docs/quickstart.md) - first-run path.
- [Concepts](docs/concepts.md) - workflow mental model.
- [Usage](docs/usage.md) - common commands and when to use them.
- [Configuration](docs/configuration.md) — `.roark/config.json`, defaults, and precedence.
- [Managed workspaces](docs/managed-workspaces.md) — clone workspaces and `workspace.copyToWorktree` for ignored local files such as `.secrets/env`.
- [Autorun](docs/autorun.md) — label-gated automation and PR publishing.
- [Recovery](docs/recovery.md) — failed attempts and `roark continue`.
- [PR revisions](docs/pr-revisions.md) — responding to feedback on an existing PR.
- [Issue curation](docs/issue-curation.md) — creating follow-up issues from reviewer findings.
- [Verification](docs/verification.md) — readiness and verification gates.
- [Troubleshooting](docs/troubleshooting.md) — common failure symptoms and recovery.
- [Operations runbook](docs/operations-runbook.md) — scheduled or shared-host operation.
- [Lifecycle hooks](docs/lifecycle-hooks.md) — setup commands such as dependency installation.
- [Artifacts](docs/artifacts.md) — `.roark/runs` layout and phase outputs.
- [CLI reference](docs/cli-reference.md) — commands and options.
- [Scheduling](docs/scheduling.md) — cron, launchd, and GitHub Actions examples.
- [Security and secrets](docs/security-and-secrets.md) — secret handling and untrusted input boundaries.
- [Labels](docs/labels.md) — GitHub label roles and defaults.
- [Workflow skills](docs/workflow-skills.md) — bundled and repo-local skill behavior.
- [Architecture](docs/architecture.md) — contributor-level internals.
- [Glossary](docs/glossary.md) — term definitions.

## Inspiration

- [symphony](https://github.com/openai/symphony)
- [OpenAI Symphony announcement](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [OpenAI harness engineering](https://openai.com/index/harness-engineering/)
- [sandcastle](https://github.com/mattpocock/sandcastle)
