# Development references

These upstream repositories are read-only reference material for agents and
contributors working on Roark. They are committed as Git subtrees, so normal
clones and worktrees include them without a separate initialization step.
Application code imports installed packages, never files from this directory.

## Effect

- Upstream: <https://github.com/Effect-TS/effect>
- Tag: `effect@4.0.0-rc.112`
- Commit: `2600f62f4532026928454dcea8d1c48557b3f942`
- Import: complete upstream tree, with history squashed by `git subtree`
- License: [MIT, Effectful Technologies Inc](effect/LICENSE), preserved with the source

Start with [Effect's agent guide](effect/LLMS.md), then follow its links to
examples under `effect/ai-docs/`. Consult the source and tests under
`effect/packages/` for the APIs involved in the task. Read relevant files as
needed; the entire repository does not need to be loaded into an agent's context.

This follows [Effect's source-vendoring guidance](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive).
The reference is pinned to the versions of `effect` and `@effect/platform-bun`
in Roark's `package.json`, rather than the moving upstream `main` branch.

## Updating Effect

Update the reference as part of the same change that upgrades Roark's Effect
dependencies. Start from a clean working tree: `git subtree pull` creates a
commit. Set `effect_version` below to the target package version.

```sh
effect_version=4.0.0-rc.112
git subtree pull --prefix=repos/effect \
  https://github.com/Effect-TS/effect.git \
  "effect@$effect_version" --squash
git ls-remote --tags https://github.com/Effect-TS/effect.git "refs/tags/effect@$effect_version"
```

Update the tag and commit recorded above, upgrade the package dependencies and
lockfile, and run `bun run release:check`. Do not patch upstream files locally.

## Tooling and distribution

- TypeScript, Oxlint, oxfmt, and Bun test discovery exclude `repos/`.
- Roark's lint commands disable nested configuration discovery so upstream lint
  configurations cannot load their own development plugins.
- VS Code excludes it from auto-import suggestions, watching, and default search.
  Agents can still search this directory explicitly.
- The `package.json` files allowlist omits `repos/`, and the package check verifies
  that it is absent from the installed package.

This reference supports development of Roark itself. The globally installed CLI
does not need it, and target repositories do not need their own copy to run Roark.
