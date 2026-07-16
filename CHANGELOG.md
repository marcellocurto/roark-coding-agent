# Changelog

All notable changes to Roark are tracked here.

This project uses [Semantic Versioning](https://semver.org/). While Roark is pre-1.0, incompatible CLI/config changes may ship in minor releases.

## Unreleased

### Changed

- Autorun and continuation now automatically run the pinned, read-only PR review workflow after opening and finalizing a pull request. Post-publication review failures preserve the published attempt and review artifacts for explicit retry.
- `review-pr` now uses the same configured verification command, managed-workspace copies, and lifecycle hooks as `revise-pr`, so agent-authored PR reviews always persist validation evidence unless verification itself cannot run.
- PR authoring now reads canonical workflow artifacts plus Git-derived changed files and authoritative verification directly. `pr-draft.json` remains the accepted publishing source for deterministic PR creation and updates.
- `review-pr` now posts each reviewer's Markdown directly as its own new PR comment. It no longer requires structured PR-review submissions, synthesizes an aggregate summary, duplicates full reviews inside details blocks, or updates a marked summary comment.
- `revise-pr` now assigns every planned feedback item a stable source-derived identity and requires execution and fix passes to provide exactly one final disposition for every identity. Summary comments render that single linked list with objective outcome, review, verification, changed-file, and commit metadata; internal plans, logs, reviews, feedback snapshots, and local artifact paths stay local.
- Public GitHub comments, pull request bodies, and generated issues no longer expose machine-local `.roark` run or artifact paths. PR bodies also omit the redundant Roark automation details block. Internal paths and run metadata remain available in local artifacts, status output, observability, prompts, and terminal recovery guidance.

### Removed

- Removed the derived `pr-narrative.md` artifact and its generation lifecycle.

## [0.2.0] - 2026-07-14

### Added

- Added `roark remove` with repository-scoped workspace discovery, interactive multi-selection, positional issue shorthand, explicit PR targets, and atomic dirty-workspace preflight for batch removal.
- Added schema-validated `submit_triage`, `submit_implementation_plan`, `submit_change_report`, `submit_review`, `submit_revision_plan`, `submit_revision_execution`, `submit_pr_draft`, and `submit_issue_drafts` tool contracts, with structured JSON source artifacts and deterministic Markdown presentation.
- Added `--verbose` completed-agent output and `--no-title` terminal-title opt-out for long-running commands.
- Added complete `verification-full.md` companion artifacts while retaining bounded verification artifacts for routine inspection.

### Changed

- Review outcomes and finding identifiers are now derived from typed findings instead of parsed from agent-authored Markdown, so arbitrary reviewer formatting cannot hide required fixes.
- Issue-workflow readiness, curation, publishing, and ledger comments now use only validated numbered review cycles; unnumbered review files are ignored.
- Triage, draft/final implementation plans, implementation/refinement/fix reports, and readiness now persist canonical JSON. Workflow routing, PR narrative construction, local-mode reporting, and the publish gate consume validated JSON; Markdown companions are deterministic presentation only.
- PR revision execution logs now persist canonical JSON. Revision review prompts and public revision summaries consume the structured execution result; Markdown companions are presentation only.
- PR and reviewer-generated issue agents now submit structured drafts. Roark validates them, renders GitHub Markdown, checks exact-title issue duplicates, and invokes `gh`; publishing agents no longer author opaque Markdown, invoke GitHub, or return raw JSON status text.
- All structured agent phases now use one runner for terminating tool submission, validation, canonical JSON serialization, deterministic Markdown rendering, and paired persistence. Issue-workflow reviews now persist matching Markdown companions without using them as workflow state.
- Review findings now use stable semantic IDs and separate handling from external constraints. Reviews require substantive inspected evidence, bounded content, explicit completeness/limitations, finding-linked restart recommendations, and escaped Markdown rendering; workflows complete available local fixes before stopping on remaining blockers.
- Readiness artifacts now use schema version 2 to represent the revised review finding and blocker model without misreading version 1 data.
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
