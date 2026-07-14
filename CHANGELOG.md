# Changelog

All notable changes to Roark are tracked here.

This project uses [Semantic Versioning](https://semver.org/). While Roark is pre-1.0, incompatible CLI/config changes may ship in minor releases.

## Unreleased

### Added

- Added `roark remove` with repository-scoped workspace discovery, interactive multi-selection, positional issue shorthand, explicit PR targets, and atomic dirty-workspace preflight for batch removal.
- Added `--verbose` completed-agent output and `--no-title` terminal-title opt-out for long-running commands.
- Added complete `verification-full.md` companion artifacts while retaining bounded verification artifacts for routine inspection.

### Changed

- Long-running commands now use compact phase-aware operational output, safe target-first interactive terminal titles, and concise final outcomes instead of streaming generated artifact Markdown by default.

### Removed

- Removed the pre-1.0 `roark workspace remove` command in favor of the simpler `roark remove` interface.

## [0.0.2] - 2026-07-11

### Added

- Bundled curated React, Next.js, UI, and Convex skills with every normal agent session, loaded from the installed Roark package without ambient machine-local discovery.
- Added version tracking policy, release scripts, Git tag guidance, and `roark --version`.
- Added observable per-phase GPT-5.6 family routing with explicit global model override precedence.
- Added GPT-5.6 authentication, troubleshooting, and rollback guidance.
- Added explicit `max` thinking with reported fallback for models that do not support it.

### Changed

- Changed every active agent phase default from GPT-5.5 to GPT-5.6 Sol through Pi 0.80.6. Artifact schemas, verdicts, tools for change phases, retries, and recovery contracts remain unchanged.
- Terra, Luna, max effort, and Pro mode are not active defaults pending measured evidence.

## [0.0.1] - 2026-05-11

### Added

- Initial tracked CLI baseline.
