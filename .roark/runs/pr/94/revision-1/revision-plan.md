# Revision Plan

## Status
revise

## Classified Feedback
- [must-fix-current] PRRT_kwDOST2KSc6BSC58 / workspace.ts: legacy `.lock` sidecar cleanup was removed; stale `issue-*.lock` dirs can be listed/pruned as workspaces.
- [must-fix-current] PRRT_kwDOST2KSc6BSC5- / workspace.ts: duplicate of above; same required cleanup/filtering issue.
- [must-fix-current] PRRT_kwDOST2KSc6BSC6C / discovery.ts: removing autorun serialization allows concurrent `roark auto` runs in same checkout to race on issue/workspace/attempt setup.
- [must-fix-current] PRRT_kwDOST2KSc6BSC6H / discovery.ts: duplicate of above; same concurrent discovery/setup race.
- [must-fix-current] PRRT_kwDOST2KSc6BSC6N / continue.ts: concurrent `roark continue` on same attempt can corrupt metadata/artifacts and race git/publish steps.

## Must Fix Current Items
- Restore/delete legacy workspace sidecar `${workspacePath}.lock` during workspace removal, or filter/delete legacy lock dirs so they are not treated as managed workspaces.
- Add a lightweight local guard for `roark auto` discovery/targeted setup to prevent concurrent mutation in the same checkout.
- Add attempt-scoped or checkout-scoped mutual exclusion for `roark continue` before lifecycle execution.

## Human Needs
None
