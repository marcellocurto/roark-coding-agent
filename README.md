# roark-coding-agent

Roark is a CLI for running coding agents against GitHub issues and pull requests.

It can:

- work on one issue in your current checkout with `roark do`
- claim a ready issue, work in an isolated checkout, and open a pull request with `roark auto`
- review an existing pull request without changing it with `roark review-pr`
- apply existing review feedback with `roark revise-pr`

Roark writes each run to `.roark/runs`. Autorun opens a pull request only when `readiness.json` reports `ready-for-pr` and the repository's verification command passes. Roark does not merge pull requests or close issues.

Roark runs once and exits. Use cron, `launchd`, or GitHub Actions to run it on a schedule.

## Install

You need:

- Bun
- Git
- an authenticated GitHub CLI
- permission to read issues, manage labels, push branches, and open pull requests

```bash
git clone https://github.com/marcellocurto/roark-coding-agent.git
cd roark-coding-agent
bun install
bun install -g "$PWD"
roark --help
roark --version
```

For servers, pin a tag or commit before installing globally.

## Try it on one issue

Run this from the repository you want to change:

```bash
cd /path/to/target-repo
roark init
roark do 123 --repo owner/repo
```

`roark do` edits the current checkout. It does not assign the issue, push a branch, or open a pull request.

Before using autorun, preview the next eligible issue:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

The [Quickstart](docs/quickstart.md) covers repository setup, labels, verification, autorun, and recovery.

## Commands

Run `roark` without arguments to open an interactive menu.

| Command | What it does |
| --- | --- |
| `roark init` | Create `.roark/config.json` in the current repository. |
| `roark do 123 --repo owner/repo` | Work on issue 123 in the current checkout without publishing. |
| `roark auto --repo owner/repo` | Claim and run the next eligible issue. |
| `roark auto 123 --repo owner/repo` | Run a specific issue with autorun's labels and publishing behavior. |
| `roark auto --repo owner/repo --dry-run` | Show eligible issues without claiming or running them. |
| `roark continue 123 --repo owner/repo` | Resume a stopped autorun attempt. |
| `roark review-pr 456 --repo owner/repo` | Post separate correctness and maintainability reviews on a PR. |
| `roark revise-pr 456 --repo owner/repo` | Apply required PR feedback, verify the changes, and push one revision commit. |
| `roark status 123 --repo owner/repo` | Show the saved status for an issue run. |
| `roark remove` | List and remove managed workspaces. |
| `roark --help` | List all commands and options. |

See [Usage](docs/usage.md) and the [CLI reference](docs/cli-reference.md) for flags and detailed behavior.

## Autorun

When you run `roark auto`, Roark:

1. selects an issue using repository labels
2. claims it and creates an issue branch in a managed checkout
3. plans and implements the change
4. runs correctness and maintainability reviews
5. fixes review or verification failures while attempts remain
6. opens a pull request after readiness and verification pass
7. posts a read-only review of the new pull request

If a run stops before publishing, inspect `.roark/runs` and resume it with:

```bash
roark continue 123 --repo owner/repo
```

Roark is not a scheduler. See [Scheduling](docs/scheduling.md) to run autorun repeatedly.

## Security

Issue text, PR feedback, and checked-out code are untrusted input. Lifecycle hooks and verification commands run shell commands on the host. They may execute code from the repository or pull request.

Review `.roark/config.json` before running Roark, especially on a shared machine or against an unfamiliar pull request. Do not put secret values in the config or publish `.roark/runs` without checking their contents.

Read [Security and secrets](docs/security-and-secrets.md) before using Roark on a shared host or an unfamiliar repository.

## Documentation

- [Quickstart](docs/quickstart.md): set up a repository and run the first issue
- [Configuration](docs/configuration.md): configure verification, labels, hooks, and workspaces
- [Managed workspaces](docs/managed-workspaces.md): understand where Roark checks out and edits code
- [Artifacts](docs/artifacts.md): inspect run results and recovery state
- [Troubleshooting](docs/troubleshooting.md): diagnose failed or stopped runs
- [Documentation index](docs/README.md): browse all documentation

## Development

```bash
bun install
bun run roark.ts --help
bun run check
```
