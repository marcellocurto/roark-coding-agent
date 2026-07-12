# roark-coding-agent

Roark turns GitHub issues into reviewed, verified pull requests using coding-agent workflows.

It is a CLI runner around the Pi coding-agent SDK. Roark plans and implements changes, runs independent reviews and repair passes, records durable artifacts, and publishes only after readiness and repository verification pass.

## Key guarantees

- Automated publishing work runs in managed clone workspaces, isolated from the control checkout.
- Independent reviewers check correctness and maintainability before publishing.
- Review findings and verification failures can trigger bounded repair passes.
- Durable artifacts under `.roark/runs` explain decisions and support recovery.
- Roark never merges pull requests or closes issues; humans retain final control.

Roark is one-shot automation, not a daemon. Use a scheduler when you want repeated autoruns.

## Install

Prerequisites:

- Bun
- Git
- GitHub CLI authenticated with `gh auth status`
- GitHub permissions to read and comment on issues, manage workflow labels, push branches, and open pull requests

```bash
git clone https://github.com/marcellocurto/roark-coding-agent.git
cd roark-coding-agent
bun install
bun install -g "$PWD"
roark --help
roark --version
```

For servers, pin a tag or commit before installing globally.

## First run

From the target repository checkout, initialize Roark and run one explicit issue locally:

```bash
cd /path/to/target-repo
roark init
roark do 123 --repo owner/repo
```

`roark do` edits the current target checkout, writes run artifacts locally, and does not claim the issue, push a branch, or open a pull request. It provides a controlled way to understand the workflow before enabling automation.

For the complete setup, dry-run, autorun, inspection, and recovery path, read the [Quickstart](docs/quickstart.md).

## Choose a workflow

| Goal | Command | Where code changes | Publishing behavior |
| --- | --- | --- | --- |
| Initialize repository configuration | `roark init` | Current checkout | None |
| Run one issue locally | `roark do 123 --repo owner/repo` | Current checkout | None |
| Preview eligible issues | `roark auto --repo owner/repo --dry-run` | No code changes | None |
| Claim, implement, and publish an issue | `roark auto --repo owner/repo --limit 1` | Managed clone | Opens a PR after gates pass |
| Resume a stopped autorun attempt | `roark continue 123 --repo owner/repo` | Managed clone | Publishes after gates pass |
| Address feedback on an existing PR | `roark revise-pr 456 --repo owner/repo` | Managed clone | Commits and pushes verified revisions |

## How it works

For each issue, Roark:

1. Fetches the issue and verifies whether it is actionable.
2. Creates and refines an implementation plan grounded in the repository.
3. Applies the change and runs relevant validation.
4. Runs independent correctness and maintainability reviews.
5. Applies bounded repair passes when reviews or verification find problems.
6. Records phase outputs and decisions under `.roark/runs`.
7. In autorun mode, opens a pull request only after readiness and verification pass.

## Safety boundaries

- GitHub issue text, PR feedback, repository files, and tool output are treated as untrusted input.
- Lifecycle hooks and verification commands execute shell commands locally; review repository configuration before running Roark.
- Autorun uses isolated managed workspaces and does not merge pull requests or close issues.
- Use the least-privileged GitHub account that can perform the required workflow.

Read [Security and secrets](docs/security-and-secrets.md) before running Roark on public repositories, shared hosts, or unattended schedules.

## Essential documentation

- [Quickstart](docs/quickstart.md) — install, initialize, run one issue, inspect results, and recover.
- [Concepts](docs/concepts.md) — control checkouts, managed workspaces, attempts, gates, and artifacts.
- [Usage](docs/usage.md) — choose between local runs, autorun, recovery, PR revision, and issue curation.
- [Configuration](docs/configuration.md) — `.roark/config.json`, verification, hooks, labels, and workspaces.
- [Operations runbook](docs/operations-runbook.md) — scheduled and shared-host operation.
- [Troubleshooting](docs/troubleshooting.md) — diagnose stopped or failed runs.
- [Documentation index](docs/README.md) — complete user, operator, reference, and contributor documentation.

## Local development

```bash
bun run roark.ts --help
bun run roark.ts do 123 --repo owner/repo
bun run check
```
