# Changelog

All notable changes to Roark are tracked here.

This project uses [Semantic Versioning](https://semver.org/). While Roark is pre-1.0, incompatible CLI/config changes may ship in minor releases.

## [0.0.2] - 2026-07-11

### Added

- Added version tracking policy, release scripts, Git tag guidance, and `roark --version`.
- Added observable per-phase GPT-5.6 family routing with explicit global model override precedence.
- Added GPT-5.6 authentication, troubleshooting, and rollback guidance.

### Changed

- Changed every active agent phase default from GPT-5.5 to GPT-5.6 Sol through Pi 0.80.6. Artifact schemas, verdicts, tools for change phases, retries, and recovery contracts remain unchanged.
- Terra, Luna, max effort, and Pro mode are not active defaults pending measured evidence.

## [0.0.1] - 2026-05-11

### Added

- Initial tracked CLI baseline.
