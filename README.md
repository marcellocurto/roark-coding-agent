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

Use `--force` to regenerate an existing phase artifact. Use `--yes` to continue implementation when the git tree has pre-existing changes outside `.roark`.

## Auto mode

`auto` finds eligible issues, claims them, runs the workflow, and — when readiness is `ready-for-pr` and the verification command succeeds — commits workflow artifacts, pushes the issue branch, opens a draft PR against `main`, and labels the issue with `roark-pr-opened`.

```bash
bun run roark-coding-agent.ts auto --repo owner/repo
```

Relevant flags:

- `--remote <name>` — git remote to push the issue branch to. Defaults to `origin`.
- `--success-label <label>` — label applied to the issue when a draft PR is opened. Defaults to `roark-pr-opened`.
- `--failure-label <label>` — label applied when readiness or verification fails. Defaults to `roark-failed`.

Auto never merges PRs and never closes issues.

## Inspiration

[symphony](https://github.com/openai/symphony)
https://openai.com/index/open-source-codex-orchestration-symphony/
https://openai.com/index/harness-engineering/

[sandcastle](https://github.com/mattpocock/sandcastle)
