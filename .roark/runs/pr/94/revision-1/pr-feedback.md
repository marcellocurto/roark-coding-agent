# PR Feedback

## Pull Request
- Repo: marcellocurto/roark-coding-agent
- PR: #94 Remove local autorun and workspace lock mechanism
- State: OPEN
- Base: main
- Head: roark/issue-92
- URL: https://github.com/marcellocurto/roark-coding-agent/pull/94

## Review Threads
- Thread PRRT_kwDOST2KSc6BSC58: unresolved (lib/autorun/workspace.ts)
  - chatgpt-codex-connector: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Remove legacy sidecar lock when deleting a workspace** Removing the `rm(`${input.workspacePath}.lock`)` cleanup leaves legacy `issue-*.lock` directories behind when users run `workspace remove`, and those stale directories are later treated as workspaces by `listWorkspaces()` (it includes any directory starting with `issue-`). In upgraded environments that still have old lock dirs, `workspace list` can show gh
- Thread PRRT_kwDOST2KSc6BSC5-: unresolved (lib/autorun/workspace.ts)
  - chatgpt-codex-connector: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Remove legacy sidecar lock when deleting a workspace** Removing the `rm(`${input.workspacePath}.lock`)` cleanup leaves legacy `issue-*.lock` directories behind when users run `workspace remove`. Those stale directories are later treated as candidate workspaces and can break maintenance commands (for example, `workspace prune` can attempt git checks inside a non-repo lock directory). Keeping the sidecar cleanup
- Thread PRRT_kwDOST2KSc6BSC6C: unresolved (lib/autorun/discovery.ts)
  - chatgpt-codex-connector: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Restore per-checkout serialization for auto discovery runs** With the repo-level autorun lock removed, two `roark auto` processes started in the same checkout can now execute discovery and attempt setup concurrently, which allows both to race through selection/claim and then mutate the same branch/workspace paths (`issueDir`, managed workspace) at the same time. This can produce nondeterministic failures and c
- Thread PRRT_kwDOST2KSc6BSC6H: unresolved (lib/autorun/discovery.ts)
  - chatgpt-codex-connector: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Restore per-checkout serialization for auto discovery runs** After removing the repo-level autorun lock, two `roark auto` processes in the same checkout can execute discovery and attempt setup concurrently, race through selection/claim, and then mutate the same branch/workspace/attempt paths at the same time. This can create duplicate claims or nondeterministic attempt artifact failures under parallel invocati
- Thread PRRT_kwDOST2KSc6BSC6N: unresolved (lib/autorun/continue.ts)
  - chatgpt-codex-connector: **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Prevent concurrent continue runs on the same attempt** The continue flow now runs without any local mutual exclusion, so two `roark continue` invocations targeting the same issue/attempt can enter the lifecycle simultaneously and both write attempt metadata, run hooks, and perform git/publish steps from the same workspace. That race can produce inconsistent run artifacts and intermittent git failures; add an a

## PR Comments
None.

## Excluded Roark Revision Summary Comments
None.
