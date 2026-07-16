---
title: Configuration
summary: Reference for `.roark/config.json`, precedence, supported keys, defaults, and examples.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-13T00:00:00Z
---

## Precedence

For most options, Roark uses this order:

1. CLI flag
2. `.roark/config.json`
3. inferred value or built-in default

CLI-only values such as `model` and `thinking` are intentionally not supported in config v1.

Unknown keys fail fast so misspellings do not silently change behavior.

## Generated Config

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

## Top-Level Keys

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

## Exit Notifications

Set `notifications.onExit` to `true` to request one silent macOS system notification when a Roark invocation finishes successfully or with a caught top-level error:

```json
{
  "notifications": {
    "onExit": true
  }
}
```

`notifications.onExit` defaults to `false` and must be a boolean when set. Unknown keys under `notifications` fail validation. The opt-in applies to every command, including quick commands such as `status` and workspace operations, with no minimum duration.

Delivery uses the system-provided `/usr/bin/osascript` and is macOS-only and best-effort. Non-macOS hosts silently do nothing. Notifications contain only the command, normalized issue or PR number when available, and repository directory name; they do not include raw errors or arbitrary arguments. Roark waits at most two seconds for delivery. A launch failure, timeout, or nonzero notifier exit writes one warning but does not change the command's result.

Roark can use this opt-in only after locating and parsing a valid repository `.roark/config.json`. It does not notify outside a Git repository, without config, or when config is invalid. Abrupt termination—including `SIGINT`, `SIGTERM`, `SIGKILL`, runtime crashes, and power loss—is not covered.

## Workspace Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `root` | string | `~/.roark/workspaces` | Parent directory for managed clone workspaces. |
| `strategy` | string | `clone` | Managed workspace strategy. |
| `cloneRemote` | string | `origin` | Remote used for clone and fetch behavior. |
| `clone.filter` | string or null | `blob:none` | Partial clone filter. |
| `clone.depth` | number or null | `null` | Clone depth. `null` means full history. |
| `copyToWorktree` | string[] | `[]` | Ignored local paths copied from control checkout into managed workspaces. `review-pr` always ignores this setting. |

Use `copyToWorktree` for path names only, not secret values:

```json
{
  "workspace": {
    "copyToWorktree": [".secrets/env"]
  }
}
```

See [Managed workspaces](managed-workspaces.md).

## Hook Keys

| Key | Type | Failure behavior | Notes |
| --- | --- | --- | --- |
| `afterCreate` | string | fails run | Runs after a new workspace is cloned and checked out. |
| `beforeRun` | string | fails run | Runs before agent workflow execution. |
| `beforeVerify` | string | fails run | Runs immediately before verification. |
| `afterRun` | string | warning | Runs after workflow completion. |
| `beforeRemove` | string | warning | Runs before workspace removal. |
| `timeoutMs` | number | n/a | Hook timeout. Defaults to `600000`. |

Hooks must be non-interactive. See [Lifecycle hooks](lifecycle-hooks.md).
When `roark init` detects a supported package-manager lockfile, it assigns the inferred install command to `beforeRun` and `beforeVerify`. It does not also assign it to `afterCreate`, because a newly created workspace proceeds directly to `beforeRun` without changing dependency inputs.

## Label Configuration

Roark always appends configured lifecycle labels plus required workflow states such as `needs-triage`, `blocked`, `needs-human`, `triage-rejected`, and `wont-fix` to the effective skip set. This prevents issues in non-ready states from being selected again.

Read [Label semantics](label-semantics.md) before changing label names on a live repository.

## Verification Configuration

For `auto` and `continue`, Roark requires a verification command. It uses CLI flag, config, then inference. Failed verification consumes the same `maxFixPasses` budget as reviewer-requested fixes.

`review-pr` treats the current checkout as untrusted and does not hydrate behavior from `.roark/config.json`. It uses explicit CLI values, Git origin inference, and built-in workspace defaults; only an explicit `--verify` command may execute against the PR checkout. At the invocation boundary, Roark may separately validate the config and read only `notifications.onExit`; this does not hydrate hooks, verification, or workspace-copy settings.

Good examples:

```json
{ "verify": "bun run check" }
```

```json
{ "verify": "make test" }
```

See [Verification](verification.md).

## Next Steps

- Use [Quickstart](quickstart.md) to validate a new config.
- Use [Operations runbook](operations-runbook.md) before scheduling.
- Use [Troubleshooting](troubleshooting.md) for common config failures.
