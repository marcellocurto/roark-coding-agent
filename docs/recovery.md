---
title: Recovery
summary: Inspect and resume a stopped run.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-09-09T07:06:16Z
---

## Continue an attempt

```bash
roark continue 123 --repo owner/repo --attempt 1
```

If `--attempt` is omitted, Roark uses the latest attempt recorded in:

```text
.roark/runs/issue/<number>/attempts.json
```

## Continue or restart

`continue` reads the current issue description, all comments, and the saved reports before deciding what to do next. It checks whether new information answers an open question or changes the requirements, then resumes the affected step. Completed code stays in the managed workspace. An attempt that has already opened a PR is complete; issue continuation does not revise that PR.

```bash
roark continue 123 --repo owner/repo --attempt 1
```

For example, if implementation stopped over a session-expiry rule, a comment explaining that rule can let Roark finish the partial implementation. If the comment changes the design, Roark returns to the relevant planning step first. Tests and reviews affected by the change run again.

Use `--restart` when you want to discard the previous approach and start over:

```bash
roark continue 123 --repo owner/repo --attempt 1 --restart
```

Restart reads the current issue and all its comments too. It backs up prior reports, the current commit, uncommitted changes, and untracked files, then restores the workspace to the saved starting commit. It runs triage, planning, implementation, and checks again. Ignored configuration files and `.roark` are preserved.

The backup is stored in the attempt's `continuations/<n>/` directory. Its `workspace/backup.json` records the saved Git reference and starting commit. The staged and unstaged patches and the `untracked/` directory hold uncommitted work.

`continue --force` is no longer supported. Continuing saved work and restarting it are separate choices.

## When a run stops

Roark investigates questions using the code, issue discussion, and relevant documentation. If essential information remains missing, a decision needs someone else to make it, or a dependency prevents further work, the run stops.

In autorun, Roark posts a report on the issue. `needs-human` means information or a decision is still needed; `blocked` means an outside dependency or access problem remains. A rejected issue receives `triage-rejected`.

To supply information, update the issue or add a comment with the answer, decision, or a reference Roark can check. Then run `roark continue`. Roark does not watch for replies or resume automatically.

If the new information does not resolve the problem, the run stays stopped and the report explains what is still missing. Continuation failures preserve the previous work and cannot restore outdated review approvals.

## Saved reports

Continuation keeps a history of the reports it replaces. `continuation-input.json` records the discussion, previous results, and workspace changes used for the decision. `continuation-review.md` explains the answers found and the step selected to run next.

Plans from older Roark versions may need another planning pass because required details are missing. Continuation can return to that step while preserving existing code. Use `--restart` if you want a completely new implementation instead.

## Dirty workspaces

A stopped or failed attempt may leave uncommitted edits in its managed workspace. `continue` inspects and preserves that work. A new `auto` run still requires a clean workspace.

## Limits

Uncommitted work is recoverable only while the issue workspace exists. Roark can recreate a deleted workspace from the issue branch, but it cannot restore deleted uncommitted edits.

## Files to inspect

- `.roark/runs/issue/<n>/attempts/<k>/attempt.json`
- `.roark/runs/issue/<n>/attempts/<k>/summary.json`
- `.roark/runs/issue/<n>/attempts/<k>/verification.md`
- `.roark/runs/issue/<n>/attempts/<k>/verification-before-fix-<pass>.md`
- `.roark/runs/issue/<n>/attempts/<k>/readiness.json`
- `.roark/runs/issue/<n>/attempts/<k>/readiness.md`

See [Artifacts](artifacts.md) for the full layout.

## Recovery checklist

1. Open `summary.json`.
2. Open `readiness.md` and `verification.md`; use `readiness.json` for exact gate values.
3. Inspect the managed workspace if uncommitted edits matter.
4. Fix host setup, config, hook, ignored-file, or code issues.
5. Run `roark continue`.
