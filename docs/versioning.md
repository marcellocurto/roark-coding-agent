---
title: Versioning and releases
summary: Version and release Roark.
dateCreated: 2026-05-11T00:00:00Z
lastUpdated: 2026-07-25T07:13:47Z
---

Roark uses the `version` field in `package.json` as the source of truth.

## Version policy

Roark follows Semantic Versioning:

- `PATCH` for fixes, documentation corrections, and small internal improvements.
- `MINOR` for new commands, flags, or backward-compatible behavior.
- `MAJOR` for breaking CLI, config, artifact, or workflow behavior.

While Roark is `0.x`, minor releases may break compatibility. Release `1.0.0` once the CLI and config contracts are expected to remain stable.

## Changelog policy

Keep `CHANGELOG.md` updated with one section per release:

```md
## [0.2.0] - 2026-05-11

### Added
- Added a new command.

### Changed
- Changed an existing default.

### Fixed
- Fixed a regression.
```

Use `Unreleased` for changes that have landed but are not tagged yet.

## Release checklist

1. Confirm the working tree contains only intended changes.
2. Move relevant `CHANGELOG.md` entries from `Unreleased` to the target version and date.
3. Commit the release notes and any remaining release-prep changes.
4. Run the release check:

```bash
bun run release:check
```

5. Bump the version. This creates a version commit and Git tag such as `v0.2.0`:

```bash
bun run version:patch
# or
bun run version:minor
# or
bun run version:major
```

6. Push the branch and tags:

```bash
git push origin main --follow-tags
```

7. For operator installs, pin deployments to the pushed tag.

## Inspect versions

```bash
roark --version
git tag --list 'v*' --sort=-v:refname
```
