---
title: Configuration
summary: Reference for `.roark/config.json`, including precedence, supported keys, and examples.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T06:27:02Z
---

# Configuration

Roark loads repository configuration from `.roark/config.json` at the Git root.

## Precedence

For most options, Roark uses this order:

1. CLI flag
2. `.roark/config.json`
3. Inferred value or built-in default

CLI-only values such as `model` and `thinking` are intentionally not supported in config v1.

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
  "skipLabels": ["blocked", "needs-human", "wontfix", "roark-in-progress", "roark-failed", "roark-ready-for-review", "roark-pr-opened"],
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

## Supported top-level keys

- `repo`: GitHub repository as `owner/repo`.
- `baseBranch`: base branch for issue branches. Defaults to `main`.
- `verify`: shell command run by the verification gate.
- `readyLabel`, `inProgressLabel`, `successLabel`, `failureLabel`, `skipLabels`: label configuration for autorun.
- `maxFixPasses`: maximum issue workflow fix/review cycles.
- `workspace`: managed workspace configuration. See [Managed workspaces](managed-workspaces.md).
- `hooks`: lifecycle hook configuration. See [Lifecycle hooks](lifecycle-hooks.md).
- `sandbox`: currently `{ "provider": "host" }` only.

Unknown keys fail fast so misspellings do not silently change behavior.

## Generated config

Run:

```bash
roark init
```

`roark init` writes `.roark/config.json`, `.roark/WORKFLOW.md`, and `.roark/.gitignore`. It infers `repo`, a verification command when obvious, and a package-manager install hook when a known lockfile is present.

`workspace.copyToWorktree` is not emitted by default. Add it manually only when the repository needs ignored local files copied into managed workspaces.
