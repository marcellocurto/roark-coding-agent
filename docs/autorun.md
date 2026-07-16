---
title: Autorun
summary: End-to-end behavior of `roark auto`, including issue selection, claiming, gates, and PR publishing.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-07-16T00:00:00Z
---

```bash
roark auto --repo owner/repo --limit 1
```

## Flow

1. List open GitHub issues.
2. Select issues with the ready label and no skip labels.
3. Claim one issue by assigning the actor, applying the in-progress label, and posting a claim comment.
4. Prepare the managed workspace and issue branch.
5. Fetch issue context and dependency metadata.
6. Run triage, planning, implementation, review, fix passes, and readiness.
7. Apply the readiness gate.
8. Run the verification gate.
9. If verification fails and `maxFixPasses` has budget, repair through a fix pass, code refinement, numbered Review A/B, and readiness, then rerun verification.
10. On success, commit code changes and push the branch.
11. A PR authoring agent submits a schema-validated draft from canonical workflow artifacts, the Git-derived changed-file list, and the authoritative verification result. Roark persists `pr-draft.json`, deterministically renders the Markdown, and opens the PR with `gh`.
12. Reviewer-generated follow-up issue drafts are submitted as structured data. Roark renders and publishes them, then rerenders the PR body from `pr-draft.json` with their links and updates it directly.
13. On exhausted-budget or non-repairable failure, leave work uncommitted and post recovery information.

## Recommended posture

Keep `--limit 1` while building trust. Roark is intentionally one-shot; use an external scheduler if you want periodic execution.

## Selection labels

The default ready label is `ready-for-agent`. The default skip set includes intake, paused, terminal, and lifecycle states such as `needs-triage`, `needs-human`, `agent-in-progress`, `agent-failed`, and `agent-pr-opened`.

See [Label semantics](label-semantics.md) for the full label reference.

## Safety boundaries

Autorun never merges PRs or closes issues. A human reviewer remains responsible for reviewing PRs and merging them.

## Useful commands

Preview selection:

```bash
roark auto --repo owner/repo --limit 1 --dry-run
```

Target one issue through the autorun path:

```bash
roark auto 123 --repo owner/repo
```

Inspect status after a background run:

```bash
roark status 123 --repo owner/repo
```

## Next steps

- Use [Quickstart](quickstart.md) before the first autorun.
- Use [Scheduling](scheduling.md) and [Operations runbook](operations-runbook.md) before repeated runs.
- Use [Troubleshooting](troubleshooting.md#no-eligible-issues) when selection is surprising.
