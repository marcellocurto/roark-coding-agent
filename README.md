# roark-coding-agent

A small CLI workflow runner around the Pi coding-agent SDK.

## Install

```bash
bun install
```

## Run the full workflow

```bash
bun run roark-coding-agent.ts do 123 --repo owner/repo
# or
roark-coding-agent do https://github.com/owner/repo/issues/123
```

Artifacts are written to:

```text
.roark/runs/issue/<number>/
```

The full `do` workflow fetches the GitHub issue, triages it, plans it, implements it, runs two review agents, applies up to `--max-fix-passes` fix/review cycles when needed, and writes `readiness.md`.

By default, `--max-fix-passes` is `1`.

```bash
bun run roark-coding-agent.ts do 123 --repo owner/repo --max-fix-passes 3
```

Fix artifacts are numbered:

```text
fix-log-1.md
final-review-1.md
fix-log-2.md
final-review-2.md
```

Each phase is also callable independently:

```bash
bun run roark-coding-agent.ts fetch 123 --repo owner/repo
bun run roark-coding-agent.ts triage 123
bun run roark-coding-agent.ts plan 123
bun run roark-coding-agent.ts implement 123
bun run roark-coding-agent.ts review 123
bun run roark-coding-agent.ts fix 123
bun run roark-coding-agent.ts final-review 123
bun run roark-coding-agent.ts readiness 123
```

Standalone fix phases infer the next sensible pass, or you can choose one:

```bash
bun run roark-coding-agent.ts fix 123 --fix-pass 2
bun run roark-coding-agent.ts final-review 123 --fix-pass 2
```

Use `--force` to regenerate an existing phase artifact. Use `--yes` to continue implementation when the git tree has pre-existing changes outside `.roark`. Use `--attempt <n>` with issue commands when you need to target a specific autorun attempt directory.

## Auto mode

`auto` is a one-shot, label-gated, draft-PR-only workflow. A single invocation finds eligible GitHub issues, claims one, runs the full `do` workflow on a dedicated branch, and — only when readiness is `ready-for-pr` and the verification command succeeds — pushes the branch and opens a draft PR. Roark itself ships no daemon: to run it on a schedule, invoke it from `cron`, `launchd`, GitHub Actions, or any other scheduler you control. While maintainers are still building trust in the workflow, the recommended posture is `--limit 1` (the default) so each invocation processes one issue.

### One-shot example

Preview which issue would be picked up, without claiming or branching:

```bash
bun run roark-coding-agent.ts auto --repo owner/repo --limit 1 --dry-run
```

Real one-shot run — claim one eligible issue, run the workflow, open a draft PR if both gates pass:

```bash
bun run roark-coding-agent.ts auto --repo owner/repo --limit 1
```

### How an auto run proceeds

1. List open issues for `--repo` via `gh issue list`.
2. Filter to issues that carry the ready label and none of the skip labels (see [Label gating](#label-gating-and-one-at-a-time)).
3. Sort oldest-first and slice to `--limit` (default `1`).
4. For each selected issue:
   - **Claim** it: assign the user (`--assignee`, defaulting to the authenticated `gh` user, unless `--no-assign`), apply the in-progress label, and post a claim comment naming the branch.
   - **Switch** to `roark/issue-<n>`, creating it from `--base-branch` (default `main`) via `git switch -c` if it does not exist yet.
   - Allocate a per-attempt directory under `.roark/runs/issue/<n>/attempts/<k>/` and run the full `do` workflow there.
   - Apply the **readiness gate**: `readiness.md` must declare `## Status` as `ready-for-pr`.
   - Apply the **verification gate**: run `--verify` (default `bun run typecheck`) via `sh -c` and require exit code `0`.
   - On success: commit pending workflow artifacts, `git push -u <remote> <branch>`, open a **draft** PR with `gh pr create --draft --base <base-branch> --head <branch>`, and apply the success label to the issue.
   - On failure: apply the failure label and post a comment that links the failing artifact (e.g. `readiness.md` or `verification.md`) and the attempt metadata file.

### Required labels

| Role | Default | Purpose | Override flag |
| --- | --- | --- | --- |
| Ready | `afk` | Issue is opted in to autorun. Only issues with this label are eligible. | `--label` |
| In-progress | `roark-in-progress` | Applied at claim time so concurrent invocations skip the issue. | `--in-progress-label` |
| Success | `roark-pr-opened` | Applied after a draft PR is opened. | `--success-label` |
| Failure | `roark-failed` | Applied when the readiness or verification gate fails. | `--failure-label` |
| Skip set | `blocked`, `needs-human`, `wontfix`, `roark-in-progress`, `roark-failed`, `roark-ready-for-review`, `roark-pr-opened` | Any one of these on an issue removes it from the eligible set. | `--skip-label` (repeatable) or `--skip-labels` (comma-separated) |

If you change a default in code, update this table to match.

### Label gating and one-at-a-time

An issue is eligible only if it carries the ready label **and** carries none of the skip labels. The skip set includes the in-progress, success, and failure labels, so an issue that has already been claimed, shipped a draft PR, or failed will not be picked up again until a maintainer relabels it. `--limit` defaults to `1`: a single invocation claims at most one issue, runs to completion, and then exits. Maintainers can raise the limit later, but keeping it at `1` is the recommended posture while building confidence in autorun.

### Branch isolation and naming

Each issue gets its own branch named `roark/issue-<n>`, created from `--base-branch` (default `main`) using `git switch -c <branch> <base-branch>`. If the branch already exists, autorun simply switches to it. Autorun refuses to use the base branch as the work branch.

Isolation here is **branch-level**, not a separate `git worktree` directory: the workflow runs in place inside the current checkout. If you want filesystem-level isolation, create a dedicated checkout (or a `git worktree add`) up front and run `auto` from there. In all cases, run `auto` from a clean tree dedicated to roark so its commits do not collide with other in-flight work.

Per-attempt metadata is written under:

```text
.roark/runs/issue/<n>/attempts/<k>/attempt.json
.roark/runs/issue/<n>/attempts.json
```

The per-attempt `attempt.json` records the branch, base branch, start/end times, and the `worktreePath` (the working directory the run used). The aggregated `attempts.json` is the index of all attempts for that issue.

### Readiness and verification gates

Autorun publishes only when **both** gates pass.

- **Readiness gate.** The workflow's `readiness.md` artifact must contain a `## Status` heading whose value (after stripping backticks/emphasis) is exactly `ready-for-pr`. Anything else — including `not-ready` or a missing status — fails the gate.
- **Verification gate.** Autorun runs `--verify` (default `bun run typecheck`) via `sh -c` in the workflow's `cwd`. Exit code `0` passes; any non-zero exit fails. The command, exit code, and tails of stdout/stderr are written to `verification.md`.

When either gate fails, autorun does not push and does not open a PR. Instead it applies the failure label (`--failure-label`, default `roark-failed`) and posts a comment on the issue that names the failing phase, the failing artifact (`readiness.md` or `verification.md`), includes the artifact contents/excerpt directly in the GitHub comment, and gives the exact `continue` command for that attempt.

### Recovering stopped attempts

A failed autorun attempt is recoverable without relabeling the issue or starting from scratch. Run the command from the same checkout:

```bash
bun run roark-coding-agent.ts continue 123 --repo owner/repo --attempt 1
```

If `--attempt` is omitted, `continue` uses the latest attempt recorded in `.roark/runs/issue/<n>/attempts.json`. It switches back to the attempt branch from `attempt.json`, reuses valid existing artifacts, regenerates missing or malformed phase outputs, rewrites `readiness.md`, reruns the verification gate, and publishes the draft PR only if both gates pass. This is the intended recovery path for cases like an empty review artifact, failed readiness, or failed verification.

### Draft PR only — never merges, never closes

When both gates pass, autorun calls `gh pr create --draft` and applies the success label to the issue. It never invokes `gh pr merge`, never invokes `gh issue close`, and never opens a non-draft PR. A human reviewer must mark the PR ready for review and merge it themselves; the issue is closed by GitHub when that merge lands (via the `Closes #<n>` line in the PR body), not by roark.

### Option reference

Defaults below are sourced from `lib/cli/args.ts` and the `lib/autorun/` modules.

Selection:

- `--repo <owner/repo>` — repository to operate on. Required for `gh` commands when not inferable.
- `--label <label>` — ready label. Defaults to `afk`.
- `--skip-label <label>` — add a skip label (repeatable). Replaces the default skip set on first use.
- `--skip-labels <labels>` — comma-separated skip labels. Replaces the default skip set on first use.
- `--limit <n>` — maximum eligible issues to claim per invocation. Defaults to `1`.
- `--dry-run` — print selected issues; do not claim, branch, or run the workflow.

Claim:

- `--in-progress-label <label>` — label applied when claiming. Defaults to `roark-in-progress`.
- `--assignee <login>` — GitHub user to assign. Defaults to the authenticated `gh` user.
- `--no-assign` — claim without assigning anyone. Cannot be combined with `--assignee`.

Branch:

- `--cwd <path>` — repository working directory. Defaults to the current directory.
- `--base-branch <branch>` — base branch for the issue branch. Defaults to `main`.

Workflow:

- `--model <provider/id>` — optional Pi model override.
- `--thinking <level>` — override thinking level (`off|minimal|low|medium|high|xhigh`).
- `--max-fix-passes <n>` — maximum fix/review cycles. Defaults to `1`.
- `--force` — re-run phases even if their artifact exists.
- `--yes` — continue past dirty git preflight for implementation/fix.

Gate:

- `--verify <cmd>` — verification command, run via `sh -c`. Defaults to `bun run typecheck`.
- `--failure-label <label>` — label applied when readiness or verification fails. Defaults to `roark-failed`.

Publish:

- `--remote <name>` — git remote to push the issue branch to. Defaults to `origin`.
- `--success-label <label>` — label applied when the draft PR is opened. Defaults to `roark-pr-opened`.

### External scheduling

Roark ships no daemon. To run autorun periodically, drive the one-shot command from any scheduler that can run `bun` and `gh` as a user with valid `gh auth status`. The snippets below are minimal starting points the operator owns; adapt them to your environment.

**cron** (every hour, with a lock file to prevent overlapping runs):

```cron
0 * * * * cd /path/to/repo && /usr/bin/flock -n /tmp/roark-auto.lock /usr/local/bin/bun run roark-coding-agent.ts auto --repo owner/repo --limit 1 >> /var/log/roark.log 2>&1
```

**launchd** (macOS, run hourly under the user's login session so `gh` keychain auth is available):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.roark.auto</string>
    <key>WorkingDirectory</key><string>/path/to/repo</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/bun</string>
      <string>run</string>
      <string>roark-coding-agent.ts</string>
      <string>auto</string>
      <string>--repo</string><string>owner/repo</string>
      <string>--limit</string><string>1</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>/tmp/roark-auto.out</string>
    <key>StandardErrorPath</key><string>/tmp/roark-auto.err</string>
  </dict>
</plist>
```

See `man launchd.plist` for the full schema.

**GitHub Actions** (hourly schedule with concurrency lock so two runs never race):

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
        run: bun run roark-coding-agent.ts auto --repo ${{ github.repository }} --limit 1
```

In every scheduling environment: keep `--limit 1`, serialize runs (a cron lock file, `launchd` not running on overlap, Actions `concurrency:`), use a dedicated host or runner so the working tree is not shared with humans, and confirm `gh auth status` succeeds as the scheduled user before relying on the schedule.

## Inspiration

[symphony](https://github.com/openai/symphony)
https://openai.com/index/open-source-codex-orchestration-symphony/
https://openai.com/index/harness-engineering/

[sandcastle](https://github.com/mattpocock/sandcastle)
