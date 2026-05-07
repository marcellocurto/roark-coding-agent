# Roark label semantics

This page summarizes the GitHub labels Roark reads, applies, or assigns to generated issues during autorun and issue-curation workflows.

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
| `needs-human` | Skip/status label | Prevents autorun from selecting the issue; also used for terminal human-decision/reject outcomes. | `--skip-label` / `--skip-labels` |
| `wontfix` | Skip label | Prevents autorun from selecting the issue. | `--skip-label` / `--skip-labels` |
| `roark-in-progress` | Claim label and skip label | Applied when Roark claims an issue so concurrent runs skip it. | `--in-progress-label`; include the replacement in the skip set if changing defaults |
| `roark-failed` | Failure label and skip label | Applied when readiness or verification fails. | `--failure-label`; include the replacement in the skip set if changing defaults |
| `roark-pr-opened` | Success label and skip label | Applied after Roark opens a draft PR. | `--success-label`; include the replacement in the skip set if changing defaults |
| `roark-ready-for-review` | Skip label | Prevents autorun from selecting issues already awaiting human review. | `--skip-label` / `--skip-labels` |

Default skip set: `blocked`, `needs-human`, `wontfix`, `roark-in-progress`, `roark-failed`, `roark-ready-for-review`, `roark-pr-opened`.

## Generated issue labels

The issue-curation and `create-issues` flow assigns labels to new GitHub issues generated from reviewer findings:

| Label | Applied to | Meaning |
| --- | --- | --- |
| `needs-triage` | All generated issues | Marks newly generated issues for maintainer triage. |
| `external-blocker` | Generated blocking issues | Tracks outside information, access, dependency resolution, or human decisions that block the source issue. |
| `follow-up` | Generated follow-up issues | Tracks valid non-blocking work that should be handled separately from the source issue. |

## Configurable label flags

- `--label <label>` — ready label for autorun eligibility. Defaults to `afk`.
- `--skip-label <label>` — autorun skip label; repeatable. Passing it replaces the default skip set on first use.
- `--skip-labels <labels>` — comma-separated autorun skip labels. Passing it replaces the default skip set on first use.
- `--in-progress-label <label>` — label applied when claiming an issue. Defaults to `roark-in-progress`.
- `--success-label <label>` — label applied after opening a draft PR. Defaults to `roark-pr-opened`.
- `--failure-label <label>` — label applied when readiness or verification fails. Defaults to `roark-failed`.

When changing in-progress, success, or failure labels, keep the skip labels aligned so already-claimed, successful, or failed issues are not selected again unintentionally.
