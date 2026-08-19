---
title: Roark label semantics
summary: Labels Roark reads, creates, and applies.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-08-19T07:58:25Z
---

## Autorun eligibility

Autorun is label-gated. An open issue is eligible only when both are true:

1. The issue has the configured ready label. The default ready label is `ready-for-agent`.
2. The issue has none of the configured skip labels.

`autorun` is not a special label by default. It only becomes the ready label if autorun is invoked with `--label autorun`.

## Autorun labels

| Label | Default role | Notes | Configurable flag |
| --- | --- | --- | --- |
| `ready-for-agent` | Ready label | Opts an issue into autorun eligibility when no skip label is present. | `--label` |
| `needs-triage` | Skip/status label | Prevents autorun until a maintainer approves the issue for agent work. | `--skip-label` / `--skip-labels` |
| `blocked` | Skip/status label | Prevents autorun from selecting the issue; also used for terminal blocked triage outcomes. | `--skip-label` / `--skip-labels` |
| `needs-human` | Skip/status label | Prevents autorun from selecting the issue; also used for terminal human-decision outcomes. | `--skip-label` / `--skip-labels` |
| `triage-rejected` | Skip/status label | Prevents autorun from selecting the issue; applied when triage rejects the issue. | `--skip-label` / `--skip-labels` |
| `wont-fix` | Skip label | Prevents autorun from selecting the issue. | `--skip-label` / `--skip-labels` |
| `agent-in-progress` | Claim label and skip label | Applied when an agent claims or resumes an issue so concurrent runs skip it. | `--in-progress-label`; replacements are always added to the effective skip set |
| `agent-failed` | Failure label and skip label | Applied when readiness or verification fails. | `--failure-label`; replacements are always added to the effective skip set |
| `agent-pr-opened` | Success label and skip label | Applied after an agent opens a PR. | `--success-label`; replacements are always added to the effective skip set |

Default skip set: `needs-triage`, `blocked`, `needs-human`, `triage-rejected`, `wont-fix`, `agent-in-progress`, `agent-failed`, `agent-pr-opened`.

Before doing any issue work, `auto` checks for the ready, in-progress, failure, success, `blocked`, `needs-human`, and `triage-rejected` labels.

- Missing required labels are created with Roark's default color and description.
- Existing labels are not changed.
- `--dry-run` reports missing labels without creating them.
- Custom skip-only labels are not created unless they also serve one of the required roles.

## Generated issue labels

`create-issues` assigns these labels to issues generated from review findings:

| Label | Applied to | Meaning |
| --- | --- | --- |
| `needs-triage` | All generated issues | Marks newly generated issues for maintainer triage. |
| `review:external-blocker` | Generated blocking issues | Classifies an issue generated from an external-blocker reviewer finding. |
| `review:follow-up` | Generated follow-up issues | Classifies valid non-blocking work discovered during review. |
| `review:suggestion` | Generated suggestion issues | Classifies optional improvement work discovered during review. |

Generated issues do not receive `needs-human` by default. That status is reserved for a concrete decision, clarification, or approval requested by the agent.

## Configurable label flags

| Flag | Effect |
| --- | --- |
| `--label <label>` | Sets the ready label. Defaults to `ready-for-agent`. |
| `--skip-label <label>` | Sets one autorun skip label. Repeat the flag to set more than one. The first use replaces the default skip set. Roark still adds required lifecycle and status labels. |
| `--skip-labels <labels>` | Sets a comma-separated list of autorun skip labels. The first use replaces the default skip set. Roark still adds required lifecycle and status labels. |
| `--in-progress-label <label>` | Sets the label applied when Roark claims an issue. Defaults to `agent-in-progress`. |
| `--success-label <label>` | Sets the label applied after Roark opens a pull request. Defaults to `agent-pr-opened`. |
| `--failure-label <label>` | Sets the label applied when readiness or verification fails. Defaults to `agent-failed`. |

## Lifecycle transitions

| State | Typical labels | What Roark does next |
| --- | --- | --- |
| Ready for automation | `ready-for-agent` and no skip labels | Eligible for `roark auto` discovery. |
| Claimed or resumed | `agent-in-progress` | Run is in progress; other autorun processes skip it. |
| Published | `agent-pr-opened` | PR has been opened; future autorun skips it. |
| Failed readiness or verification | `agent-failed` | Operator should inspect artifacts and use `roark continue`. |
| Blocked by triage or external condition | `blocked` | Autorun skips it until a human changes labels or scope. |
| Needs human decision | `needs-human` | Autorun skips it until a human resolves the decision. |
| Rejected by triage | `triage-rejected` | Autorun skips it unless the issue is revised and the label is removed. |

An issue has at most one workflow-state label. Each transition removes the old state before applying the new one. Topic labels such as `bug`, `auth`, or `storage` are unaffected.

Use native GitHub dependency links for issue-to-issue blocking. Reserve the `blocked` label for external conditions that cannot be represented by a dependency link.

Passing an issue directly to `roark auto` skips the ready-label requirement. Skip labels and active GitHub dependencies still apply.

## Migrating older repositories

Roark does not rewrite an existing `.roark/config.json`. Migrate an older repository in one pass:

1. Add `ready-for-agent` to issues that currently use `afk`, then remove the `afk` label.
2. Rename `roark-in-progress`, `roark-failed`, and `roark-pr-opened` to their `agent-*` equivalents.
3. Replace `wontfix` with `wont-fix` and remove the unused `roark-ready-for-review` skip entry.
4. Rename reviewer-generated `external-blocker`, `follow-up`, and `suggestion` labels to their `review:*` equivalents when those labels are not also used as general repository taxonomy.
5. Update `.roark/config.json` to the defaults documented above.
6. Remove conflicting workflow-state labels so each open issue has at most one of them.

GitHub cannot rename `afk` directly when `ready-for-agent` already exists, so those issue assignments must be merged before deleting `afk`.

## Check labels

Preview selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

Inspect one issue:

```bash
gh issue view 123 --repo owner/repo --json labels,state,assignees
```
