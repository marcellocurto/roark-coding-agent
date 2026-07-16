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

## Choose a command

Running `roark` without arguments opens an interactive menu with the same task names shown below.

| Command name | Command | Description |
| --- | --- | --- |
| Initialize Roark | `roark init` | Create the repository-local `.roark` configuration. |
| Work on next ready issue | `roark auto --repo owner/repo` | Select and claim the next eligible issue, run the workflow in a managed workspace, and open a PR after all gates pass. |
| Work on a specific issue | `roark auto 123 --repo owner/repo` | Claim a specific issue, run the workflow in a managed workspace, and open a PR after all gates pass. |
| Preview ready issues | `roark auto --repo owner/repo --dry-run` | Show eligible issues without claiming them or changing code. |
| Resume an issue workflow | `roark continue 123 --repo owner/repo` | Resume a stopped autorun attempt in its managed workspace and publish after all gates pass. |
| Run issue workflow in current checkout | `roark do 123 --repo owner/repo` | Run the complete issue workflow locally without claiming the issue, pushing a branch, or opening a PR. |
| Review an existing PR | `roark review-pr 456 --repo owner/repo` | Inspect the complete PR with independent correctness and maintainability reviewers without changing code. Posts each review directly as its own comment by default. |
| Address PR review feedback | `roark revise-pr 456 --repo owner/repo` | Classify existing PR feedback, apply required fixes in a managed workspace, verify them, and push a revision commit when needed. |
| View workflow status | `roark status 123 --repo owner/repo` | Show persisted status and recovery information for an issue workflow. Use `--all` to show every known issue run. |
| Remove managed workspaces | `roark remove` | List this repository's managed workspaces and select one or more to delete. Use `roark remove 123` for issue 123 or `--pr 456` for a PR workspace; dirty workspaces require `--force`. |
| Help and command reference | `roark --help` | Show every command and option available in the installed version. |

## How it works

For each issue, Roark:

1. Fetches the issue and verifies whether it is actionable.
2. Creates and refines an implementation plan grounded in the repository.
3. Applies the change and runs relevant validation.
4. Runs independent correctness and maintainability reviews.
5. Applies bounded repair passes when reviews or verification find problems.
6. Records phase outputs and decisions under `.roark/runs`.
7. In autorun mode, opens a pull request only after readiness and verification pass, finalizes its body, and automatically runs the read-only PR review workflow.

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
