# Revision Log

## Summary

Implemented the required concurrency guards and legacy workspace lock cleanup.

## Addressed Must Fix Current Items

- Filtered legacy `issue-*.lock` sidecar directories out of managed workspace listings.
- Removed `${workspacePath}.lock` during workspace removal, including when the workspace itself is already gone.
- Added checkout-scoped locking for non-dry `roark auto` managed attempt setup.
- Added issue/attempt-scoped locking for `roark continue` before attempt metadata/lifecycle work.

## Skipped Items

None.

## Changed Files

- `lib/autorun/lock.ts`
- `lib/autorun/workspace.ts`
- `lib/autorun/discovery.ts`
- `lib/autorun/continue.ts`
- `lib/autorun/workspace.test.ts`
- `lib/autorun/discovery.test.ts`
- `lib/autorun/continue.test.ts`

## Validation Performed

- `bun test`
- `bun test lib/autorun/continue.test.ts`
- `bun run typecheck`
- `git diff --check`
