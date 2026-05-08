# roark-coding-agent

A small CLI workflow runner around the Pi coding-agent SDK.

## Install

```bash
bun install
```

## Global/operator usage

Install from an absolute package path. Bun currently treats `bun install -g .` as an anonymous package and may not link the `roark` binary.

```bash
bun install -g "$PWD"
command -v roark
roark --help
roark
roark auto 4
roark continue 4
roark do 4
```

You can also run the convenience script from this checkout:

```bash
bun run install-global
```

Bare `roark` in an interactive terminal opens a small menu for common commands.

## Local development usage

```bash
bun run roark.ts --help
bun run roark.ts auto 4
bun run roark.ts do 4
bun test
bun run typecheck
```

## Run the full workflow

```bash
roark do https://github.com/owner/repo/issues/123
# or, from a checkout
bun run roark.ts do 123 --repo owner/repo
```

Artifacts are written to:

```text
.roark/runs/issue/<number>/
```

The full `do` workflow fetches the GitHub issue, triages it, plans it, implements it, runs two review agents, applies up to `--max-fix-passes` fix/review cycles when needed, and writes `readiness.md`.

By default, `--max-fix-passes` is `3`.

```bash
bun run roark.ts do 123 --repo owner/repo --max-fix-passes 3
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
bun run roark.ts fetch 123 --repo owner/repo
bun run roark.ts triage 123
bun run roark.ts plan 123
bun run roark.ts implement 123
bun run roark.ts review 123
bun run roark.ts fix 123
bun run roark.ts final-review 123
bun run roark.ts readiness 123
```

Standalone fix phases infer the next sensible pass, or you can choose one:

```bash
bun run roark.ts fix 123 --fix-pass 2
bun run roark.ts final-review 123 --fix-pass 2
```

Use `--force` to regenerate an existing phase artifact. Use `--yes` to continue implementation when the git tree has pre-existing changes outside `.roark`. Use `--attempt <n>` with issue commands when you need to target a specific autorun attempt directory.

## Manual PR feedback revision

After a draft PR exists, use `revise-pr` to respond to PR-scoped feedback without starting a new issue run:

```bash
bun run roark.ts revise-pr 123 --repo owner/repo
```

The workflow fetches PR metadata, unresolved review threads, and relevant PR comments with `gh api graphql` (including thread `isResolved` state), writes artifacts under `.roark/runs/pr/<pr-number>/revision-<n>/`, checks out the existing PR head branch, plans feedback classifications, applies only `must-fix-current` items, runs one revision reviewer plus up to `--max-fix-passes` fix/review loops (default `1`), runs `--verify` (default `bun run typecheck`), then commits, pushes, and posts one PR summary comment only after review and verification pass.

Safety boundaries: the PR must be open; fork PR heads are refused in v1; the head branch must be non-empty, different from the base branch, and not a shared base branch name such as `main` or `master`; the working tree must be completely clean (including `.roark`) unless `--yes` is passed. `no-action-needed` writes artifacts only and does not mutate, commit, push, or comment by default. `needs-human` and verification/review stops do not commit or push; they leave local changes/artifacts for inspection and post a concise summary unless `--no-comment` is used.

## Bundled workflow skills

Roark disables Pi skill discovery for normal workflow agents. The approved `create-issues --yes` publishing path resolves the Roark-owned `github-issue-create` skill and passes only that resolved skill path to the Pi runner; global or machine-local skills are not used as fallbacks.

Skill resolution currently checks the target workspace first at `.roark/skills/github-issue-create/`. If that repo override directory exists, Roark validates its `SKILL.md` and uses it. Missing or malformed override metadata fails clearly instead of falling back to the bundled copy.

When no repo override exists, Roark loads the bundled package skill from `skills/github-issue-create/` relative to the installed Roark package, not the process working directory. The bundled package includes the skill's `SKILL.md`, `templates/`, `examples/`, and `references/`. When updating the bundled skill, copy the upstream skill directory deliberately, record the upstream source/commit in the update PR, then run the skill and create-issues tests.

## Auto mode

`auto` is a one-shot, label-gated, draft-PR-only workflow. A single invocation finds eligible GitHub issues, claims one, runs the full `do` workflow in `.roark/worktrees/issue-<n>` on a dedicated branch, and — only when readiness is `ready-for-pr` and the verification command succeeds — pushes the branch and opens a draft PR. Roark itself ships no daemon: to run it on a schedule, invoke it from `cron`, `launchd`, GitHub Actions, or any other scheduler you control. While maintainers are still building trust in the workflow, the recommended posture is `--limit 1` (the default) so each invocation processes one issue.

### One-shot example

Preview which issue would be picked up, without claiming or branching:

```bash
bun run roark.ts auto --repo owner/repo --limit 1 --dry-run
```

Real one-shot run — claim one eligible issue, run the workflow, open a draft PR if both gates pass:

```bash
bun run roark.ts auto --repo owner/repo --limit 1
```

### How an auto run proceeds

1. List open issues for `--repo` via `gh issue list`.
2. Filter to issues that carry the ready label and none of the skip labels (see [Label gating](#label-gating-and-one-at-a-time)).
3. Sort oldest-first and slice to `--limit` (default `1`).
4. For each selected issue:
   - **Claim** it: assign the user (`--assignee`, defaulting to the authenticated `gh` user, unless `--no-assign`), apply the in-progress label, and post a claim comment naming the branch.
   - **Prepare** `.roark/worktrees/issue-<n>` on `roark/issue-<n>`, creating the branch from `origin/<base-branch>` (default `origin/main`) when needed.
   - Allocate a per-attempt directory under `.roark/runs/issue/<n>/attempts/<k>/` and run the full `do` workflow in the issue worktree.
   - Before triage, fetch a machine-generated GitHub relationship snapshot: native dependencies via `gh api` when available, plus conservatively parsed `Blocked by` body references verified with `gh issue view`.
   - If triage returns a terminal non-`proceed` verdict, stop cleanly: post a concise issue comment, remove the in-progress label, remove any stale failure label, apply the matching terminal/status label, and skip planning, implementation, verification, publishing, and PR creation.
   - Apply the **readiness gate**: `readiness.md` must declare `## Status` as `ready-for-pr`.
   - Apply the **verification gate**: run `--verify` (default `bun run typecheck`) via `sh -c` and require exit code `0`.
   - On success: commit target-repo changes once after the gates pass, excluding `.roark/runs` artifacts, `git push -u <remote> <branch>`, open a **draft** PR with `gh pr create --draft --base <base-branch> --head <branch>`, and apply the success label to the issue.
   - On failure: leave work uncommitted in the issue worktree, apply the failure label, and post a recovery comment with the branch, worktree, failing artifact, attempt metadata file, and exact `roark continue` command.

### Required labels

| Role | Default | Purpose | Override flag |
| --- | --- | --- | --- |
| Ready | `afk` | Issue is opted in to autorun. Only issues with this label are eligible. | `--label` |
| In-progress | `roark-in-progress` | Applied at claim time so concurrent invocations skip the issue. | `--in-progress-label` |
| Success | `roark-pr-opened` | Applied after a draft PR is opened. | `--success-label` |
| Failure | `roark-failed` | Applied when the readiness or verification gate actually fails, not for clean terminal triage stops. | `--failure-label` |
| Skip set | `blocked`, `needs-human`, `wontfix`, `roark-in-progress`, `roark-failed`, `roark-ready-for-review`, `roark-pr-opened` | Any one of these on an issue removes it from the eligible set. | `--skip-label` (repeatable) or `--skip-labels` (comma-separated) |

Non-`proceed` triage outcomes reuse existing skip/status labels instead of introducing a roark-specific no-op label: `blocked` maps to `blocked`, while `needs-human-decision`, `reject`, and unknown terminal verdicts map to `needs-human`. These labels are already in the default skip set and describe why autorun should not retry without human relabeling.

If you change a default in code, update this table to match.

### Label gating and one-at-a-time

An issue is eligible only if it carries the ready label **and** carries none of the skip labels. The skip set includes the in-progress, success, and failure labels, so an issue that has already been claimed, shipped a draft PR, or failed will not be picked up again until a maintainer relabels it. `--limit` defaults to `1`: a single invocation claims at most one issue, runs to completion, and then exits. Maintainers can raise the limit later, but keeping it at `1` is the recommended posture while building confidence in autorun.

### Worktree isolation and naming

Each issue gets its own branch named `roark/issue-<n>` and a persistent worktree at `.roark/worktrees/issue-<n>`. New branches are created from `--base-branch` (default `main`, fetched as `origin/main`). Autorun refuses to use the base branch as the work branch.

Branches are the durable source for code state. `.roark/runs` artifacts are the durable source for reasoning/history. Uncommitted failed work is recoverable only while the persistent issue worktree still exists; if the worktree is deleted, `continue` can recreate it from the local or remote branch but cannot reconstruct deleted uncommitted edits. Fresh `auto` refuses dirty existing issue worktrees and tells you to use `continue` for recovery.

Per-attempt metadata is written under:

```text
.roark/runs/issue/<n>/attempts/<k>/attempt.json
.roark/runs/issue/<n>/attempts.json
```

The per-attempt `attempt.json` records the branch, base branch, start/end times, and the `worktreePath` (the working directory the run used). The aggregated `attempts.json` is the index of all attempts for that issue.

### Readiness and verification gates

Autorun publishes only when **both** gates pass.

- **Readiness gate.** The workflow's `readiness.md` artifact must contain a `## Status` heading whose value (after stripping backticks/emphasis) is exactly `ready-for-pr`. Anything else — including `not-ready` or a missing status — fails the gate.
- **Verification gate.** Autorun runs `--verify` (default `bun run typecheck`) via `sh -c` in the issue worktree. Exit code `0` passes; any non-zero exit fails. The command, exit code, and tails of stdout/stderr are written to `verification.md`.

When either gate fails, autorun does not commit, push, or open a PR. Instead it applies the failure label (`--failure-label`, default `roark-failed`) and posts a comment on the issue that names the branch, worktree path, failing phase, failing artifact (`readiness.md` or `verification.md`), attempt metadata path, artifact contents/excerpt, and exact `continue` command for that attempt. Intentional triage stops (`blocked`, `reject`, or `needs-human-decision`) are handled before these gates and do not receive `roark-failed`.

A triage no-op is handled before these gates: autorun writes readiness, comments with the triage verdict and artifact paths, removes `roark-in-progress`, removes any stale failure label, applies the mapped skip/status label, and does not run verification, push, or create a PR.

### Recovering stopped attempts

A failed autorun attempt is recoverable without relabeling the issue or starting from scratch. Run the command from the same checkout:

```bash
roark continue 123 --cwd /repo --repo owner/repo --attempt 1
```

If `--attempt` is omitted, `continue` uses the latest attempt recorded in `.roark/runs/issue/<n>/attempts.json`. It reuses `.roark/worktrees/issue-<n>` when present; if the worktree is missing, it recreates it from local branch `roark/issue-<n>` or remote branch `origin/roark/issue-<n>`. If neither exists, it fails clearly. It reuses valid existing artifacts, regenerates missing or malformed phase outputs, rewrites `readiness.md`, reruns verification in the worktree, and publishes the draft PR only if both gates pass. Dirty worktrees are allowed for the selected failed attempt; deleted uncommitted edits are not reconstructed.

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
- `--max-fix-passes <n>` — maximum fix/review cycles. Defaults to `3`.
- `--force` — re-run phases even if their artifact exists.
- `--yes` — continue past dirty git preflight for implementation/fix.

Gate:

- `--verify <cmd>` — verification command, run via `sh -c`. Defaults to `bun run typecheck`.
- `--failure-label <label>` — label applied when readiness or verification fails. Defaults to `roark-failed`.

Publish:

- `--remote <name>` — git remote to push the issue branch to. Defaults to `origin`.
- `--success-label <label>` — label applied when the draft PR is opened. Defaults to `roark-pr-opened`.

### External scheduling

Roark v1 supports server-local one-shot execution only. To run autorun periodically, drive this command from an external scheduler as a user with valid `gh auth status`:

```bash
roark auto --cwd /srv/roark/repos/app --limit 1
```

Roark ships no daemon, SSH worker mode, Docker worker mode, or parallel worker pool in v1. Non-interactive scheduler runs must provide or infer required repository/auth/verification configuration; when required information is missing, Roark should fail clearly rather than prompt. The snippets below are minimal starting points the operator owns; adapt them to your environment.

**cron** (every hour, with a lock file to prevent overlapping runs):

```cron
0 * * * * /usr/bin/flock -n /tmp/roark-auto.lock /usr/local/bin/roark auto --cwd /srv/roark/repos/app --repo owner/repo --limit 1 >> /var/log/roark.log 2>&1
```

**launchd** (macOS, run hourly under the user's login session so `gh` keychain auth is available):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.roark.auto</string>
    <key>WorkingDirectory</key><string>/srv/roark/repos/app</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/roark</string>
      <string>auto</string>
      <string>--cwd</string><string>/srv/roark/repos/app</string>
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
        run: bun run roark.ts auto --repo ${{ github.repository }} --limit 1
```

In every scheduling environment: keep `--limit 1`, serialize runs (a cron lock file, `launchd` not running on overlap, Actions `concurrency:`), use a dedicated host or runner so the working tree is not shared with humans, and confirm `gh auth status` succeeds as the scheduled user before relying on the schedule.

## Inspiration

[symphony](https://github.com/openai/symphony)
https://openai.com/index/open-source-codex-orchestration-symphony/
https://openai.com/index/harness-engineering/

[sandcastle](https://github.com/mattpocock/sandcastle)
