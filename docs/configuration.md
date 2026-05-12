---
title: Configuration
summary: Reference for `.roark/config.json`, precedence, supported keys, defaults, and examples.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
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
  "readyLabel": "afk",
  "inProgressLabel": "roark-in-progress",
  "successLabel": "roark-pr-opened",
  "failureLabel": "roark-failed",
  "skipLabels": [
    "blocked",
    "needs-human",
    "wontfix",
    "roark-in-progress",
    "roark-failed",
    "roark-ready-for-review",
    "roark-pr-opened"
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
    "afterCreate": "bun install --frozen-lockfile",
    "beforeRun": "bun install --frozen-lockfile",
    "beforeVerify": "bun install --frozen-lockfile",
    "timeoutMs": 600000
  },
  "sandbox": { "provider": "host" }
}
```

## Top-Level Keys

| Key | Type | Default | CLI equivalent | Notes |
| --- | --- | --- | --- | --- |
| `repo` | string | inferred when possible | `--repo` | GitHub repository as `owner/repo`. |
| `baseBranch` | string | `main` | `--base-branch` | Base branch for issue branches and PRs. |
| `verify` | string | inferred for some repos | `--verify` | Shell command run by the verification gate through `sh -c`. |
| `readyLabel` | string | `afk` | `--label` | Label that opts an issue into autorun eligibility. |
| `inProgressLabel` | string | `roark-in-progress` | `--in-progress-label` | Label applied when Roark claims an issue. |
| `successLabel` | string | `roark-pr-opened` | `--success-label` | Label applied after PR creation. |
| `failureLabel` | string | `roark-failed` | `--failure-label` | Label applied when readiness or verification fails. |
| `skipLabels` | string[] | default skip set | `--skip-label`, `--skip-labels` | Labels that prevent autorun selection. |
| `maxFixPasses` | number | `3` | `--max-fix-passes` | Maximum shared fix/review cycles, including review-driven fixes and verification repair. |
| `workspace` | object | clone strategy defaults | none | Managed workspace configuration. |
| `hooks` | object | no commands, default timeout | none | Lifecycle hook configuration. |
| `sandbox` | object | `{ "provider": "host" }` | none | Currently host execution only. |

## Workspace Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `root` | string | `~/.roark/workspaces` | Parent directory for managed clone workspaces. |
| `strategy` | string | `clone` | Managed workspace strategy. |
| `cloneRemote` | string | `origin` | Remote used for clone and fetch behavior. |
| `clone.filter` | string or null | `blob:none` | Partial clone filter. |
| `clone.depth` | number or null | `null` | Clone depth. `null` means full history. |
| `copyToWorktree` | string[] | `[]` | Ignored local paths copied from control checkout into managed workspaces. |

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

## Label Configuration

When changing lifecycle labels, Roark appends those lifecycle labels to the effective skip set automatically. This prevents already-claimed, failed, or successful issues from being selected again.

Read [Label semantics](label-semantics.md) before changing label names on a live repository.

## Verification Configuration

For `auto` and `continue`, Roark requires a verification command. It uses CLI flag, config, then inference. Failed verification consumes the same `maxFixPasses` budget as reviewer-requested fixes.

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
