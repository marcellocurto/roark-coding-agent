---
title: Configuration
summary: Keys and defaults for `.roark/config.json`.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-08-19T07:58:25Z
---

## Precedence

For most options, Roark uses this order:

1. CLI flag
2. `.roark/config.json`
3. inferred value or built-in default

`model` and `thinking` are CLI-only in config v1.

Unknown keys fail fast so misspellings do not silently change behavior.

## Generated config

Run:

```bash
roark init
```

`roark init` writes:

```text
.roark/config.json
.roark/.gitignore
```

It infers:

- `repo` from Git remote when possible
- a verification command from common package metadata or `Makefile`
- package-manager install hooks when a known lockfile is present

`workspace.copyToWorktree` is not emitted by default. Add it manually only when the repository needs ignored local files copied into managed workspaces.

## Example

```json
{
  "repo": "owner/repo",
  "baseBranch": "main",
  "verify": "bun run check",
  "readyLabel": "ready-for-agent",
  "inProgressLabel": "agent-in-progress",
  "successLabel": "agent-pr-opened",
  "failureLabel": "agent-failed",
  "skipLabels": [
    "needs-triage",
    "blocked",
    "needs-human",
    "triage-rejected",
    "wont-fix",
    "agent-in-progress",
    "agent-failed",
    "agent-pr-opened"
  ],
  "maxFixPasses": 3,
  "workspace": {
    "root": "~/.roark/workspaces",
    "strategy": "clone",
    "cloneRemote": "origin",
    "clone": {
      "filter": "blob:none",
      "depth": null
    },
    "copyToWorktree": [".secrets/env"]
  },
  "hooks": {
    "beforeRun": "bun install --frozen-lockfile",
    "beforeVerify": "bun install --frozen-lockfile",
    "timeoutMs": 600000
  },
  "sandbox": { "provider": "host" },
  "notifications": { "onExit": true }
}
```

## Top-level keys

| Key | Type | Default | CLI equivalent | Notes |
| --- | --- | --- | --- | --- |
| `repo` | string | inferred when possible | `--repo` | GitHub repository as `owner/repo`. |
| `baseBranch` | string | `main` | `--base-branch` | Base branch for issue branches and PRs. |
| `verify` | string | inferred for some repos | `--verify` | Shell command run by the verification gate through `sh -c`. |
| `readyLabel` | string | `ready-for-agent` | `--label` | Label that opts an issue into autorun eligibility. |
| `inProgressLabel` | string | `agent-in-progress` | `--in-progress-label` | Label applied when Roark claims an issue. |
| `successLabel` | string | `agent-pr-opened` | `--success-label` | Label applied after PR creation. |
| `failureLabel` | string | `agent-failed` | `--failure-label` | Label applied when readiness or verification fails. |
| `skipLabels` | string[] | default skip set | `--skip-label`, `--skip-labels` | Labels that prevent autorun selection. |
| `maxFixPasses` | number | `3` | `--max-fix-passes` | Maximum shared fix/review cycles, including review-driven fixes and verification repair. |
| `workspace` | object | clone strategy defaults | none | Managed workspace configuration. |
| `hooks` | object | no commands, default timeout | none | Lifecycle hook configuration. |
| `sandbox` | object | `{ "provider": "host" }` | none | Currently host execution only. |
| `notifications` | object | exit notifications disabled | none | Opt-in macOS exit notification configuration. |

## Exit notifications

Set `notifications.onExit` to `true` to receive a macOS notification when a Roark command finishes:

```json
{
  "notifications": {
    "onExit": true
  }
}
```

The default is `false`. When enabled, notifications apply to every command, including `status` and workspace commands.

Roark sends notifications through `/usr/bin/osascript` and waits up to two seconds. Notifications include the command, repository directory, and issue or PR number. They exclude raw errors and arbitrary arguments.

Notification failures produce a warning but do not change the command's result. Non-macOS hosts do nothing. Roark also skips notification when:

- the current directory is not in a Git repository
- `.roark/config.json` is missing or invalid
- the process exits through a signal, runtime crash, forced termination, or power loss

## Workspace keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `root` | string | `~/.roark/workspaces` | Parent directory for managed clone workspaces. |
| `strategy` | string | `clone` | Managed workspace strategy. |
| `cloneRemote` | string | `origin` | Remote used for clone and fetch behavior. |
| `clone.filter` | string or null | `blob:none` | Partial clone filter. |
| `clone.depth` | number or null | `null` | Clone depth. `null` means full history. |
| `copyToWorktree` | string[] | `[]` | Ignored local paths copied from the control checkout into managed workspaces, including PR review and revision workspaces. |

Use `copyToWorktree` for path names only, not secret values:

```json
{
  "workspace": {
    "copyToWorktree": [".secrets/env"]
  }
}
```

See [Managed workspaces](managed-workspaces.md).

## Hook keys

| Key | Type | Failure behavior | Notes |
| --- | --- | --- | --- |
| `afterCreate` | string | fails run | Runs after a new workspace is cloned and checked out. |
| `beforeRun` | string | fails run | Runs before agent workflow execution. |
| `beforeVerify` | string | fails run | Runs immediately before verification. |
| `afterRun` | string | warning | Runs after workflow completion. |
| `beforeRemove` | string | warning | Runs before workspace removal. |
| `timeoutMs` | number | n/a | Hook timeout. Defaults to `600000`. |

Hooks must be non-interactive. See [Lifecycle hooks](lifecycle-hooks.md).

When `roark init` recognizes a package-manager lockfile, it puts the install command in `beforeRun` and `beforeVerify`. It leaves `afterCreate` empty because a new workspace runs `beforeRun` immediately afterward.

## Label configuration

Roark adds configured lifecycle labels and the required workflow-state labels to the skip set. This prevents a non-ready issue from being selected again.

Read [Label semantics](label-semantics.md) before changing label names on a live repository.

## Verification configuration

For `auto` and `continue`, Roark gets the verification command from the CLI flag first, then config, then repository inference. Verification failures and reviewer findings share the `maxFixPasses` limit.

For `review-pr` and `revise-pr`, Roark uses `--verify`, then configured `verify`, then `bun run typecheck`.

Workspace hooks and verification run against the pull request checkout. Use these commands only on pull requests you trust.

Good examples:

```json
{ "verify": "bun run check" }
```

```json
{ "verify": "make test" }
```

See [Verification](verification.md).
