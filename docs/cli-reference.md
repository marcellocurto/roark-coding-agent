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
| `roark init` | Scaffold repo-local `.roark` configuration and workflow policy. |
| `roark auto [issue]` | Discover and claim eligible issues, or target one issue, then run the full workflow. |
| `roark do <issue>` | Run the full issue workflow without autorun discovery. |
| `roark continue <issue>` | Continue a prior autorun attempt and publish if gates pass. |
| `roark status [issue]` | Print persisted run observability status. Use `--all` for all known issues. |
| `roark revise-pr <number>` | Revise an existing open PR from PR feedback. |
| `roark curate-issues <issue>` | Write a deterministic issue creation plan from reviewer findings. |
| `roark create-issues <issue>` | Create approved GitHub issues from the curation plan. Dry-run unless `--yes`. |

## Workspace Commands

| Command | Purpose |
| --- | --- |
| `roark workspace list` | List managed clone workspaces. |
| `roark workspace remove --issue <n>` | Remove one managed workspace. Dirty workspaces require `--force`. |
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
| `roark final-review <issue>` | Run only the final review agent. |
| `roark readiness <issue>` | Write deterministic PR readiness markdown. |

Phase commands are most useful for debugging. For normal work, prefer `do`, `auto`, or `continue`.

## Common Options

| Option | Applies to | Purpose |
| --- | --- | --- |
| `--repo <owner/repo>` | GitHub-backed commands | Repository for `gh` issue and PR commands. |
| `--cwd <path>` | Most commands | Repository working directory. Defaults to current directory. |
| `--out <path>` | Workflow commands | Runs directory. Defaults to `.roark/runs`. |
| `--model <provider/id>` | Agent-backed phases | Optional Pi model override, for example `anthropic/claude-sonnet-4-5`. |
| `--thinking <level>` | Agent-backed phases | Thinking level override: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `--max-fix-passes <n>` | `auto`, `do`, `continue` | Maximum automatic fix/review cycles. Defaults to `3`. |
| `--fix-pass <n>` | `fix`, `final-review` | Pass number for standalone fix/final-review. |
| `--attempt <n>` | issue, `continue`, `status` | Use a specific autorun attempt directory. |
| `--all` | `status` | Summarize all known issue runs. |
| `--force` | phase, implementation, fix, PR revision | Re-run phases or continue past supported dirty-tree preflights. |
| `--yes` | supported mutation paths | Continue past supported prompts or approve `create-issues` mutations. |
| `-v`, `--version` | top-level only | Print the installed Roark version. |
| `-h`, `--help` | all commands | Show help. |

## Autorun Options

| Option | Purpose |
| --- | --- |
| `--label <label>` | Auto eligibility label. Defaults to `afk`. |
| `--skip-label <label>` | Auto skip label. Repeatable. Lifecycle labels are still appended. |
| `--skip-labels <labels>` | Auto skip labels as a comma-separated list. Lifecycle labels are still appended. |
| `--limit <n>` | Maximum number of eligible auto issues to claim. Defaults to `1`. |
| `--in-progress-label <label>` | Auto claim label and terminal continue cleanup label. Defaults to `roark-in-progress`. |
| `--assignee <login>` | GitHub user to assign when claiming. Defaults to the authenticated `gh` user. |
| `--no-assign` | Claim without assigning a user. |
| `--dry-run` | Print selected issues without claiming, switching branches, or running agents. |
| `--base-branch <branch>` | Auto issue branch base branch. Defaults to `main`. |
| `--verify <cmd>` | Verification command to run before publishing. Runs through `sh -c`. |
| `--failure-label <label>` | Label applied when readiness or verification fails. Defaults to `roark-failed`. |
| `--success-label <label>` | Label applied when a PR is opened. Defaults to `roark-pr-opened`. |
| `--remote <name>` | Git remote for pushing issue or PR branches. Defaults to `origin`. |

## PR Revision Options

| Option | Purpose |
| --- | --- |
| `--verify <cmd>` | Verification command before pushing the revision. |
| `--no-comment` | Do not post the terminal PR summary comment. |
| `--force` | Continue past supported dirty git preflight. |

## Workspace Options

| Option | Purpose |
| --- | --- |
| `--issue <n>` | Select a managed issue workspace for removal. |
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
