---
title: Managed workspaces
summary: How Roark prepares clone-backed workspaces and copies ignored host-local files into them.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Workspace layout

By default, workspaces live under:

```text
~/.roark/workspaces/<owner>-<repo>/issue-<number>
~/.roark/workspaces/<owner>-<repo>/pr-<number>
```

Issue workflow runs use `issue-<number>` workspaces. `review-pr` and `revise-pr` use `pr-<number>` workspaces under different non-mutating and mutating preparation contracts.

Each issue gets a persistent workspace and a branch named:

```text
roark/issue-<number>
```

The workspace starts from Git state. Ignored host-local files are not present unless explicitly copied.

## Copy ignored local files

If verification fails because ignored local files are missing, for example:

```text
Missing .secrets/env/dev/local.web.env
```

add the ignored path to `.roark/config.json`:

```json
{
  "workspace": {
    "strategy": "clone",
    "copyToWorktree": [".secrets/env"]
  }
}
```

`copyToWorktree` is nested under `workspace`. The same relative path is used as the source in the control checkout and the destination in the managed workspace.

## Safety rules

Roark rejects entries that are:

- absolute paths
- empty strings
- parent traversal such as `../secret`
- `.git` paths
- glob-looking paths containing `*`, `?`, or `[`

Before copying, Roark requires the destination path itself to be ignored by Git:

```bash
git check-ignore .secrets/env
```

After copying, Roark checks `git status --porcelain -- <path>` and refuses to continue if copied content is visible to Git.

## Copy behavior

- Missing sources fail clearly before any configured paths are written.
- Existing destination paths are removed first.
- Directories are copied recursively.
- Symlinks are dereferenced into target contents rather than preserved as symlinks.
- File modes such as `0600` are preserved.
- Copied files are refreshed before workspace run and before verification.
- `review-pr` always ignores configured copies. Host-only files are never copied into a PR review workspace.

Do not store secret values in `.roark/config.json`; store only path names such as `.secrets/env`.

## Workspace commands

```bash
roark workspace list
roark remove
roark remove 123
roark remove --pr 98
roark workspace prune --older-than 30d
```

`roark remove` lists the current repository's managed workspaces and accepts multiple selections. `list`, interactive removal, and `prune` include both issue and PR workspaces. Dirty workspaces require `--force`. Use it only after confirming that recoverable work is disposable.

## Next steps

- Use [Recovery](recovery.md) before deleting a failed issue workspace.
- Use [Security and secrets](security-and-secrets.md) for copied ignored files.
- Use [Operations runbook](operations-runbook.md#workspace-cleanup) for cleanup procedures.
