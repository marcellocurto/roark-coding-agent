---
title: Labels
summary: Short entry point for GitHub labels used by Roark, linking to the full label semantics reference.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

See [Label semantics](label-semantics.md) for the full reference.

Common defaults:

- `ready-for-agent`: approved for autorun.
- `needs-triage`: awaiting maintainer triage.
- `agent-in-progress`: actively claimed or resumed by an agent.
- `agent-failed`: stopped at readiness or verification.
- `agent-pr-opened`: PR opened.
- `blocked`, `needs-human`, `triage-rejected`, `wont-fix`: terminal or paused skip/status labels.

Common lifecycle:

```text
needs-triage -> ready-for-agent -> agent-in-progress -> agent-pr-opened
                                      \-> agent-failed -> agent-in-progress
                                      \-> blocked, needs-human, or triage-rejected
```

Use [Troubleshooting](troubleshooting.md#no-eligible-issues) when autorun does not select the expected issue.
