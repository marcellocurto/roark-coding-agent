---
title: CLI reference
summary: Complete command and option reference for Roark.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

Use the installed binary:

```bash
roark --help
roark --version
```

Or run from a source checkout:

```bash
bun run roark.ts --help
```

## Issue Argument

Commands that accept an issue support:

```text
123
https://github.com/owner/repo/issues/123
owner/repo#123
```

`auto` without an issue discovers eligible issues. `auto` with an issue targets that issue directly.

## Core Commands

| Command | Purpose |
| --- | --- |
| `roark init` | Initialize Roark in the current repository. |
| `roark auto [issue]` | Work on the next ready issue, or a specific issue, in a managed workspace and publish after all gates pass. |
| `roark do <issue>` | Run the complete issue workflow in the current checkout without publishing. |
| `roark continue <issue>` | Resume a stopped issue workflow and publish after all gates pass. |
| `roark status [issue]` | View workflow status and recovery information. Use `--all` for every known issue run. |
| `roark remove [issue ...]` | Interactively select managed workspaces to remove, or remove the listed issue workspaces. Use `--pr <n>` for PR workspaces and `--force` for dirty workspaces. |
| `roark review-pr <number>` | Review an existing open or draft PR without changing code; posts or updates one review comment by default. |
| `roark revise-pr <number>` | Address required review feedback on an existing open PR and push verified fixes when needed. |
| `roark curate-issues <issue>` | Write a deterministic issue creation plan from reviewer findings. |
| `roark create-issues <issue>` | Create approved GitHub issues from the curation plan. Dry-run unless `--yes`. |

## Workspace Commands

| Command | Purpose |
| --- | --- |
| `roark workspace list` | List managed clone workspaces. |
| `roark workspace prune --older-than <duration>` | Remove old clean workspaces, for example `--older-than 30d`. |

## Phase Commands

| Command | Purpose |
| --- | --- |
| `roark fetch <issue>` | Fetch the GitHub issue into `.roark/runs/issue/<number>/`. |
| `roark triage <issue>` | Run only the triage agent. |
| `roark plan <issue>` | Run only the implementation planning agent. |
| `roark implement <issue>` | Run only the implementation agent. |
| `roark review <issue>` | Run both review agents. |
| `roark fix <issue>` | Run only the fix agent. |
| `roark readiness <issue>` | Write deterministic PR readiness markdown. |

Phase commands are most useful for debugging. For normal work, prefer `do`, `auto`, or `continue`.

## Common Options

| Option | Applies to | Purpose |
| --- | --- | --- |
| `--repo <owner/repo>` | GitHub-backed commands | Repository for `gh` issue and PR commands. |
| `--cwd <path>` | Most commands | Repository working directory. Defaults to current directory. |
| `--out <path>` | Workflow commands | Runs directory. Defaults to `.roark/runs`. |
| `--model <provider/id>` | Agent-backed phases | Optional Pi model override, for example `anthropic/claude-sonnet-4-5`. |
| `--thinking <level>` | Agent-backed phases | Thinking level override: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Unsupported levels are clamped by Pi to a supported level and reported. |
| `--max-fix-passes <n>` | `auto`, `do`, `continue` | Maximum automatic fix/review cycles. Defaults to `3`. |
| `--fix-pass <n>` | `fix` | Fix pass number. |
| `--attempt <n>` | issue, `continue`, `status` | Use a specific autorun attempt directory. |
| `--all` | `status` | Summarize all known issue runs. |
| `--force` | phase, implementation, fix, PR revision | Re-run phases or continue past supported dirty-tree preflights. |
| `--yes` | supported mutation paths | Continue past supported prompts or approve `create-issues` mutations. |
| `--verbose` | long-running agent commands | Show each completed agent response as readable plain text plus detailed, explicitly labelled aggregate tool statistics. Raw prompts, events, tool results, and debug payloads remain hidden. |
| `--no-title` | long-running agent commands | Disable Roark terminal-title management. |
| `-v`, `--version` | top-level only | Print the installed Roark version. |
| `-h`, `--help` | all commands | Show help. |

## Live output and terminal titles

Long-running commands print an operational stream by default: run identity, phase and pass, compact tool activity, phase wall time, verification status, artifact path, and final outcome. Complete generated Markdown is validated and saved in the run artifacts but is not copied to normal terminal output. Use `--verbose` when you also want the completed response rendered as plain readable text; `-v` remains the version flag.

On supported interactive terminals, Roark updates the window title with the issue or PR, current phase, pass, and short repository name. Titles are sanitized and length-bounded. Pass `--no-title` when your shell or terminal owns its title. Redirected/piped output, CI, and `TERM=dumb` never receive title or ANSI control sequences, and their lines are not width-truncated. Operational warnings continue to use stderr.

Paths in normal status output are repository/run relative when possible, and long lines are shortened only for an interactive terminal's detected width. Phase duration is wall-clock elapsed time. Verbose `aggregate tool execution` is the sum of individual tool durations and is not elapsed runtime (tools may run concurrently).

## Autorun Options

| Option | Purpose |
| --- | --- |
| `--label <label>` | Auto eligibility label. Defaults to `ready-for-agent`. |
| `--skip-label <label>` | Auto skip label. Repeatable. Required workflow skip labels are still appended. |
| `--skip-labels <labels>` | Auto skip labels as a comma-separated list. Required workflow skip labels are still appended. |
| `--limit <n>` | Maximum number of eligible auto issues to claim. Defaults to `1`. |
| `--in-progress-label <label>` | Auto claim label and terminal continue cleanup label. Defaults to `agent-in-progress`. |
| `--assignee <login>` | GitHub user to assign when claiming. Defaults to the authenticated `gh` user. |
| `--no-assign` | Claim without assigning a user. |
| `--dry-run` | Print selected issues without claiming, switching branches, or running agents. |
| `--base-branch <branch>` | Auto issue branch base branch. Defaults to `main`. |
| `--verify <cmd>` | Verification command to run before publishing. Runs through `sh -c`. |
| `--failure-label <label>` | Label applied when readiness or verification fails. Defaults to `agent-failed`. |
| `--success-label <label>` | Label applied when a PR is opened. Defaults to `agent-pr-opened`. |
| `--remote <name>` | Git remote for pushing issue or PR branches. Defaults to `origin`. |

## PR Review Options

| Option | Purpose |
| --- | --- |
| `--verify <cmd>` | Explicitly authorize this verification command. `review-pr` does not load repository config and never infers a command for execution. |
| `--no-comment` | Complete the local review without publishing a PR comment. |

`review-pr` accepts a PR number, supports fork PRs through GitHub's pull ref, and never edits, commits, or pushes. It does not load `.roark/config.json`, run lifecycle hooks, or copy host-only workspace files. Pass `--repo` when Git origin does not identify the base repository.

## PR Revision Options

| Option | Purpose |
| --- | --- |
| `--verify <cmd>` | Verification command before pushing the revision. |
| `--no-comment` | Do not post the terminal PR summary comment. |
| `--force` | Continue past supported dirty git preflight. |

## Workspace Options

| Option | Purpose |
| --- | --- |
| `--pr <n>` | Select a managed PR workspace for removal; issue workspaces use positional numbers. |
| `--older-than <duration>` | Select clean workspaces older than a duration such as `30d`. |
| `--force` | Remove dirty workspaces. Use only after inspecting recoverable work. |

## Examples

```bash
roark --version
roark init
roark do 123 --repo owner/repo
roark auto --repo owner/repo --limit 1 --dry-run
roark auto --repo owner/repo --limit 1
roark continue 123 --repo owner/repo --attempt 1
roark review-pr 456 --repo owner/repo
roark revise-pr 456 --repo owner/repo --verify "bun run check"
roark status --all --repo owner/repo
roark workspace list
roark workspace prune --older-than 30d
roark curate-issues 123 --repo owner/repo
roark create-issues 123 --repo owner/repo --yes
```

## Next Steps

- Use [Usage](usage.md) to choose the right command.
- Use [Configuration](configuration.md) for config equivalents and defaults.
- Use [Troubleshooting](troubleshooting.md) when a command stops unexpectedly.
