---
title: Scheduling
summary: How to run Roark periodically using external schedulers with safe concurrency.
dateCreated: 2026-05-08T06:27:02Z
lastUpdated: 2026-05-08T07:00:00Z
---

# Scheduling

Roark ships no daemon. Run it periodically with an external scheduler.

## Principles

- Keep `--limit 1` unless you intentionally want multiple issues per invocation.
- Serialize runs so two Roark processes do not race.
- Run as a user with working `gh auth status`.
- Use a dedicated checkout or runner not shared with humans.
- Prefer explicit `--repo` and configured `verify` in non-interactive environments.

## cron

```cron
0 * * * * /usr/bin/flock -n /tmp/roark-auto.lock /usr/local/bin/roark auto --cwd /srv/roark/repos/app --repo owner/repo --limit 1 >> /var/log/roark.log 2>&1
```

## launchd

Use a `launchd` job under the user's login session so GitHub CLI keychain credentials are available. Set the working directory to the control checkout and pass `--cwd` explicitly.

## GitHub Actions

```yaml
name: roark-auto
on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch:

concurrency:
  group: roark-auto
  cancel-in-progress: false

jobs:
  auto:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: bun run roark.ts auto --repo ${{ github.repository }} --limit 1
```

## Failure handling

When a scheduled run fails a gate, Roark posts recovery information on the issue. Use `roark continue` from the same control checkout to inspect and resume.

## Next steps

- Use [Operations runbook](operations-runbook.md) for host setup, monitoring, cleanup, and upgrades.
- Use [Troubleshooting](troubleshooting.md#scheduler-runs-overlap) for scheduler race symptoms.
- Use [Security and secrets](security-and-secrets.md) before running on shared hosts.
