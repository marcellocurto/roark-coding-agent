---
title: Labels
summary: Short entry point for GitHub labels used by Roark, linking to the full label semantics reference.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

See [Label semantics](label-semantics.md) for the full reference.

Common defaults:

- `afk`: ready for autorun.
- `roark-in-progress`: claimed by Roark.
- `roark-failed`: stopped at readiness or verification.
- `roark-pr-opened`: draft PR opened.
- `blocked`, `needs-human`, `wontfix`: skip/status labels.

Common lifecycle:

```text
afk -> roark-in-progress -> roark-pr-opened
                       \-> roark-failed
                       \-> blocked or needs-human
```

Use [Troubleshooting](troubleshooting.md#no-eligible-issues) when autorun does not select the expected issue.
