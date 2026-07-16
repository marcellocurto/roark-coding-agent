---
title: Roark label semantics
summary: Full reference for GitHub labels Roark reads, applies, or assigns during autorun and issue-curation workflows.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

## Autorun eligibility

Autorun is label-gated. An open issue is eligible only when both are true:

1. The issue has the configured ready label. The default ready label is `afk`.
2. The issue has none of the configured skip labels.

`autorun` is not a special label by default. It only becomes the ready label if autorun is invoked with `--label autorun`.

## Autorun labels

| Label | Default role | Notes | Configurable flag |
| --- | --- | --- | --- |
| `afk` | Ready label | Opts an issue into autorun eligibility when no skip label is present. | `--label` |
| `blocked` | Skip/status label | Prevents autorun from selecting the issue; also used for terminal blocked triage outcomes. | `--skip-label` / `--skip-labels` |
| `needs-human` | Skip/status label | Prevents autorun from selecting the issue; also used for terminal human-decision outcomes. | `--skip-label` / `--skip-labels` |
| `triage-rejected` | Skip/status label | Prevents autorun from selecting the issue; applied when triage rejects the issue. | `--skip-label` / `--skip-labels` |
| `wontfix` | Skip label | Prevents autorun from selecting the issue. | `--skip-label` / `--skip-labels` |
| `roark-in-progress` | Claim label and skip label | Applied when Roark claims an issue so concurrent runs skip it. | `--in-progress-label`; replacements are always added to the effective skip set |
| `roark-failed` | Failure label and skip label | Applied when readiness or verification fails. | `--failure-label`; replacements are always added to the effective skip set |
| `roark-pr-opened` | Success label and skip label | Applied after Roark opens a PR. | `--success-label`; replacements are always added to the effective skip set |
| `roark-ready-for-review` | Skip label | Prevents autorun from selecting issues already awaiting human review. | `--skip-label` / `--skip-labels` |

Default skip set: `blocked`, `needs-human`, `triage-rejected`, `wontfix`, `roark-in-progress`, `roark-failed`, `roark-ready-for-review`, `roark-pr-opened`.

Before `auto` performs discovery, targeted issue fetch, claim, branch setup, or agent work, Roark verifies that the required repository labels exist: ready, in-progress, failure, success, `blocked`, `needs-human`, and `triage-rejected`. Missing required labels are created with Roark-owned default colors/descriptions. Existing labels are not modified. `--dry-run` reports missing required labels without creating them. Custom skip-only labels are observed for selection but are not auto-created unless they are also one of the required lifecycle/status labels.

## Generated issue labels

The issue-curation and `create-issues` flow assigns labels to new GitHub issues generated from reviewer findings:

| Label | Applied to | Meaning |
| --- | --- | --- |
| `needs-triage` | All generated issues | Marks newly generated issues for maintainer triage. |
| `external-blocker` | Generated blocking issues | Tracks outside information, access, dependency resolution, or human decisions that block the source issue. |
| `follow-up` | Generated follow-up issues | Tracks valid non-blocking work that should be handled separately from the source issue. |

## Configurable label flags

- `--label <label>` — ready label for autorun eligibility. Defaults to `afk`.
- `--skip-label <label>` — autorun skip label; repeatable. Passing it replaces the default skip set on first use; Roark still appends required lifecycle/status skip labels.
- `--skip-labels <labels>` — comma-separated autorun skip labels. Passing it replaces the default skip set on first use; Roark still appends required lifecycle/status skip labels.
- `--in-progress-label <label>` — label applied when claiming an issue. Defaults to `roark-in-progress`.
- `--success-label <label>` — label applied after opening a PR. Defaults to `roark-pr-opened`.
- `--failure-label <label>` — label applied when readiness or verification fails. Defaults to `roark-failed`.

When changing in-progress, success, or failure labels, Roark appends those lifecycle labels to the effective skip set automatically so already-claimed, successful, or failed issues are not selected again unintentionally.

## Lifecycle transitions

| State | Typical labels | What Roark does next |
| --- | --- | --- |
| Ready for automation | `afk` and no skip labels | Eligible for `roark auto` discovery. |
| Claimed | `afk`, `roark-in-progress` | Run is in progress; other autorun processes skip it. |
| Published | `roark-pr-opened` | PR has been opened; future autorun skips it. |
| Failed readiness or verification | `roark-failed` | Operator should inspect artifacts and use `roark continue`. |
| Blocked by triage or external condition | `blocked` | Autorun skips it until a human changes labels or scope. |
| Needs human decision | `needs-human` | Autorun skips it until a human resolves the decision. |
| Rejected by triage | `triage-rejected` | Autorun skips it unless the issue is revised and the label is removed. |

## Operational checks

Preview selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

Inspect one issue:

```bash
gh issue view 123 --repo owner/repo --json labels,state,assignees
```

## Next steps

- Use [Autorun](autorun.md) for the full label-gated workflow.
- Use [Troubleshooting](troubleshooting.md#no-eligible-issues) when selection is surprising.
- Use [Configuration](configuration.md#label-configuration) before changing label names.
