---
title: Lifecycle hooks
summary: Reference for workspace lifecycle hooks such as dependency installation and pre-verification setup.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

# Lifecycle hooks

Lifecycle hooks are shell commands configured in `.roark/config.json` under `hooks`.

```json
{
  "hooks": {
    "afterCreate": "bun install --frozen-lockfile",
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

## Timeout

`timeoutMs` controls hook timeout. The default is `600000` milliseconds.

## Good uses

- Install dependencies.
- Generate local build artifacts required by verification.
- Run lightweight setup checks.

## Avoid

- Writing secrets into Git-tracked files.
- Long-running daemons.
- Interactive prompts.
- Commands that mutate unrelated host state.

For ignored local file copying, prefer `workspace.copyToWorktree`. See [Managed workspaces](managed-workspaces.md).

## Next steps

- Use [Configuration](configuration.md#hook-keys) for the hook reference table.
- Use [Verification](verification.md#hooks-before-verification) for pre-verification setup.
- Use [Security and secrets](security-and-secrets.md#threat-boundaries) before adding hooks on shared hosts.
