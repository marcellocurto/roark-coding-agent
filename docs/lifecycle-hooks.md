---
title: Lifecycle hooks
summary: Run setup commands at specific points in a Roark workflow.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-25T07:06:45Z
---

```json
{
  "hooks": {
    "beforeRun": "bun install --frozen-lockfile",
    "beforeVerify": "bun install --frozen-lockfile",
    "timeoutMs": 600000
  }
}
```

## Hooks

- `afterCreate`: runs after a new workspace is cloned and checked out.
- `beforeRun`: runs before agent workflow execution.
- `beforeVerify`: runs immediately before verification.
- `afterRun`: runs after workflow completion; failures warn instead of stopping the run.
- `beforeRemove`: runs before workspace removal; failures warn instead of stopping removal.

Put dependency installation in `beforeRun` and `beforeVerify`. A new workspace runs `beforeRun` immediately after creation, so putting the same command in `afterCreate` only runs it twice. Use `afterCreate` for one-time setup.

`review-pr` uses the same configured lifecycle hooks and verification setup as `revise-pr`. Hooks and verification run against the pinned PR checkout.

## Timeout

`timeoutMs` controls hook timeout. The default is `600000` milliseconds.

## Use hooks for

- Install dependencies.
- Generate local build artifacts required by verification.
- Run lightweight setup checks.

## Do not use hooks for

- Writing secrets into Git-tracked files.
- Long-running daemons.
- Interactive prompts.
- Commands that mutate unrelated host state.

For ignored local file copying, prefer `workspace.copyToWorktree`. See [Managed workspaces](managed-workspaces.md).
