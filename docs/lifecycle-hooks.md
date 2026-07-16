---
title: Lifecycle hooks
summary: Reference for workspace lifecycle hooks such as dependency installation and pre-verification setup.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
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

For dependency installation, prefer `beforeRun` and `beforeVerify`. A fresh workspace runs `beforeRun` immediately after creation, so configuring the same install command in both `afterCreate` and `beforeRun` only repeats setup. Reserve `afterCreate` for setup that must run exactly once when the workspace is first created.

`review-pr` does not load repository configuration or run lifecycle hooks. Use an explicit `--verify` command when a PR review genuinely requires authorized execution.

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
