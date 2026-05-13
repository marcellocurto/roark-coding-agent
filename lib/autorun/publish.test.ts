import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  buildCommitArgv,
  buildPrCreateArgv,
  buildPrEditBodyArgv,
  buildPushArgv,
  buildStageAllArgv,
  buildSuccessLabelArgv,
  defaultAutorunRemote,
  defaultAutorunSuccessLabel,
  formatAutorunPrBody,
  formatCommitMessage,
  formatPrBody,
  hasUncommittedChanges,
  publishAutorunResult,
} from "./publish.ts";
import { formatAttemptMetadata } from "./attempts.ts";
import type { VerificationResult } from "./verification.ts";
import { createWorkflowContext, reviewARef, reviewBRef, writeArtifact } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";

const okVerification: VerificationResult = {
  ok: true,
  command: "bun run typecheck",
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const failedVerification: VerificationResult = {
  ok: false,
  command: "bun run typecheck",
  exitCode: 2,
  stdout: "",
  stderr: "errors",
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("autorun publish defaults", () => {
  test("default success label is roark-pr-opened", () => {
    expect(defaultAutorunSuccessLabel).toBe("roark-pr-opened");
  });

  test("default remote is origin", () => {
    expect(defaultAutorunRemote).toBe("origin");
  });
});

describe("autorun publish argv builders", () => {
  test("buildStageAllArgv stages target changes but excludes roark control state", () => {
    expect(buildStageAllArgv()).toEqual(["git", "add", "-A", "--", ".", ":(exclude).roark"]);
  });

  test("buildCommitArgv composes a git commit command", () => {
    expect(buildCommitArgv({ message: "roark: workflow artifacts for #9" })).toEqual([
      "git",
      "commit",
      "-m",
      "roark: workflow artifacts for #9",
    ]);
  });

  test("buildPushArgv composes a git push command with -u", () => {
    expect(buildPushArgv({ remote: "origin", branchName: "roark/issue-9" })).toEqual([
      "git",
      "push",
      "-u",
      "origin",
      "roark/issue-9",
    ]);
  });

  test("buildPrCreateArgv produces a gh pr create command with --repo", () => {
    expect(
      buildPrCreateArgv({
        repo: "owner/repo",
        baseBranch: "main",
        branchName: "roark/issue-9",
        title: "Fix bug",
        body: "Closes #9\n",
      }),
    ).toEqual([
      "gh",
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "roark/issue-9",
      "--title",
      "Fix bug",
      "--body",
      "Closes #9\n",
      "--repo",
      "owner/repo",
    ]);
  });

  test("buildPrCreateArgv omits --repo when not provided", () => {
    expect(
      buildPrCreateArgv({
        baseBranch: "main",
        branchName: "roark/issue-9",
        title: "Fix bug",
        body: "Closes #9\n",
      }),
    ).toEqual([
      "gh",
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "roark/issue-9",
      "--title",
      "Fix bug",
      "--body",
      "Closes #9\n",
    ]);
  });

  test("buildPrEditBodyArgv produces a gh pr edit command with --repo", () => {
    expect(buildPrEditBodyArgv({ repo: "owner/repo", pr: "https://github.com/owner/repo/pull/9", body: "body" })).toEqual([
      "gh",
      "pr",
      "edit",
      "https://github.com/owner/repo/pull/9",
      "--body",
      "body",
      "--repo",
      "owner/repo",
    ]);
  });

  test("buildSuccessLabelArgv composes a gh issue edit command", () => {
    expect(
      buildSuccessLabelArgv({ issueNumber: 9, label: "roark-pr-opened", repo: "owner/repo" }),
    ).toEqual([
      "gh",
      "issue",
      "edit",
      "9",
      "--add-label",
      "roark-pr-opened",
      "--repo",
      "owner/repo",
    ]);
  });

  test("buildSuccessLabelArgv omits --repo when not provided", () => {
    expect(buildSuccessLabelArgv({ issueNumber: 9, label: "roark-pr-opened" })).toEqual([
      "gh",
      "issue",
      "edit",
      "9",
      "--add-label",
      "roark-pr-opened",
    ]);
  });
});

describe("formatCommitMessage", () => {
  test("includes the issue number", () => {
    expect(formatCommitMessage({ issueNumber: 9 })).toBe("roark: implement issue #9");
  });
});

describe("publish git staging", () => {
  test("ignores .roark/runs when deciding and staging publish changes", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "roark-publish-stage-test-"));
    tempDirs.push(repo);
    await runProcessOrThrow(["git", "init", "-b", "main", repo]);
    await runProcessOrThrow(["git", "config", "user.email", "test@example.com"], { cwd: repo });
    await runProcessOrThrow(["git", "config", "user.name", "Test User"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
    await mkdir(path.join(repo, ".roark"), { recursive: true });
    await writeFile(path.join(repo, ".roark/.gitignore"), "runs/\n", "utf8");
    await runProcessOrThrow(["git", "add", "README.md", ".roark/.gitignore"], { cwd: repo });
    await runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd: repo });

    await mkdir(path.join(repo, ".roark/runs/issue/9/attempts/1"), { recursive: true });
    await writeFile(path.join(repo, ".roark/runs/issue/9/attempts/1/attempt.json"), "{}\n", "utf8");
    expect(await hasUncommittedChanges({ cwd: repo })).toBe(false);

    await writeFile(path.join(repo, "feature.txt"), "feature\n", "utf8");
    expect(await hasUncommittedChanges({ cwd: repo })).toBe(true);
    await runProcessOrThrow(buildStageAllArgv(), { cwd: repo });

    const cached = await gitOutput(repo, ["diff", "--cached", "--name-only"]);
    expect(cached).toContain("feature.txt");
    expect(cached).not.toContain(".roark/runs");
  });
});

describe("publishAutorunResult", () => {
  test("uses agent cwd for git and control cwd for PR authoring agent and issue labels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-publish-test-"));
    tempDirs.push(root);
    const controlCwd = path.join(root, "control");
    const agentCwd = path.join(root, "agent");
    const remote = path.join(root, "remote.git");
    const binDir = path.join(root, "bin");
    const ghLog = path.join(root, "gh.log");
    await mkdir(controlCwd, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, "gh"),
      `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> "$ROARK_GH_LOG"\nif [ "$1" = "pr" ]; then echo "https://github.com/owner/repo/pull/1"; fi\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "gh"), 0o755);

    await runProcessOrThrow(["git", "init", "-b", "roark/issue-9", agentCwd]);
    await runProcessOrThrow(["git", "config", "user.email", "test@example.com"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "config", "user.name", "Test User"], { cwd: agentCwd });
    await writeFile(path.join(agentCwd, "README.md"), "hello\n", "utf8");
    await runProcessOrThrow(["git", "add", "README.md"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "init", "--bare", remote]);
    await runProcessOrThrow(["git", "remote", "add", "origin", remote], { cwd: agentCwd });
    await runProcessOrThrow(["git", "push", "-u", "origin", "roark/issue-9"], { cwd: agentCwd });

    const oldPath = process.env["PATH"];
    const oldGhLog = process.env["ROARK_GH_LOG"];
    process.env["PATH"] = `${binDir}:${oldPath ?? ""}`;
    process.env["ROARK_GH_LOG"] = ghLog;
    try {
      const agentRequests: { cwd: string; prompt: string; skillPaths?: string[] | undefined }[] = [];
      const prUrl = await publishAutorunResult({
        options: {
          cwd: controlCwd,
          repo: "owner/repo",
          failureLabel: "roark-failed",
          successLabel: "roark-pr-opened",
          inProgressLabel: "roark-in-progress",
          remote: "origin",
          baseBranch: "main",
        },
        issue: { number: 9, title: "Fix bug" },
        branchPlan: { issueNumber: 9, branchName: "roark/issue-9", baseBranch: "main" },
        workflowContext: {
          controlCwd,
          agentCwd,
          outDir: path.join(controlCwd, ".roark/runs"),
          runDir: path.join(controlCwd, ".roark/runs/issue/9/attempts/1"),
          runDirRelative: ".roark/runs/issue/9/attempts/1",
          issueInput: "9",
          issueNumber: "9",
          attempt: 1,
          force: false,
          yes: false,
          maxFixPasses: 1,
          thinkingConfig: getWorkflowThinkingConfig(),
        },
        agentRunner: (request) => {
          agentRequests.push({ cwd: request.cwd, prompt: request.prompt, skillPaths: request.skillPaths });
          return Promise.resolve(JSON.stringify({ url: "https://github.com/owner/repo/pull/1", title: "Fix bug" }));
        },
      });

      expect(prUrl).toBe("https://github.com/owner/repo/pull/1");
      expect(agentRequests).toHaveLength(1);
      expect(agentRequests[0]?.cwd).toBe(controlCwd);
      expect(agentRequests[0]?.skillPaths).toBeUndefined();
      expect(agentRequests[0]?.prompt).toContain("Write the final PR title and body yourself");
      expect(agentRequests[0]?.prompt).toContain("<branch>roark/issue-9</branch>");
    } finally {
      process.env["PATH"] = oldPath;
      if (oldGhLog === undefined) delete process.env["ROARK_GH_LOG"];
      else process.env["ROARK_GH_LOG"] = oldGhLog;
    }

    const ghCalls = await readFile(ghLog, "utf8");
    expect(ghCalls).not.toContain(`${controlCwd}\tpr create`);
    expect(ghCalls).toContain(`${controlCwd}\tissue edit 9 --add-label roark-pr-opened`);
    expect(ghCalls).toContain(`${controlCwd}\tissue edit 9 --remove-label roark-in-progress`);
    expect(ghCalls).toContain(`${controlCwd}\tissue edit 9 --remove-label roark-failed`);
  });

  test("creates one commit for target changes and excludes .roark/runs artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-publish-commit-test-"));
    tempDirs.push(root);
    const controlCwd = path.join(root, "control");
    const agentCwd = path.join(root, "agent");
    const remote = path.join(root, "remote.git");
    const binDir = path.join(root, "bin");
    const ghLog = path.join(root, "gh.log");
    await mkdir(controlCwd, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, "gh"),
      `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> "$ROARK_GH_LOG"\nif [ "$1" = "pr" ]; then echo "https://github.com/owner/repo/pull/1"; fi\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "gh"), 0o755);

    await runProcessOrThrow(["git", "init", "-b", "roark/issue-9", agentCwd]);
    await runProcessOrThrow(["git", "config", "user.email", "test@example.com"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "config", "user.name", "Test User"], { cwd: agentCwd });
    await writeFile(path.join(agentCwd, "README.md"), "hello\n", "utf8");
    await mkdir(path.join(agentCwd, ".roark"), { recursive: true });
    await writeFile(path.join(agentCwd, ".roark/.gitignore"), "runs/\n", "utf8");
    await runProcessOrThrow(["git", "add", "README.md", ".roark/.gitignore"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "init", "--bare", remote]);
    await runProcessOrThrow(["git", "remote", "add", "origin", remote], { cwd: agentCwd });
    await runProcessOrThrow(["git", "push", "-u", "origin", "roark/issue-9"], { cwd: agentCwd });

    const beforeCommitCount = Number(await gitOutput(agentCwd, ["rev-list", "--count", "HEAD"]));
    await writeFile(path.join(agentCwd, "feature.txt"), "feature\n", "utf8");
    await mkdir(path.join(agentCwd, ".roark/runs/issue/9/attempts/1"), { recursive: true });
    await writeFile(path.join(agentCwd, ".roark/runs/issue/9/attempts/1/attempt.json"), "{}\n", "utf8");

    const oldPath = process.env["PATH"];
    const oldGhLog = process.env["ROARK_GH_LOG"];
    process.env["PATH"] = `${binDir}:${oldPath ?? ""}`;
    process.env["ROARK_GH_LOG"] = ghLog;
    try {
      await publishAutorunResult({
        options: {
          cwd: controlCwd,
          repo: "owner/repo",
          failureLabel: "roark-failed",
          successLabel: "roark-pr-opened",
          inProgressLabel: "roark-in-progress",
          remote: "origin",
          baseBranch: "main",
        },
        issue: { number: 9, title: "Fix bug" },
        branchPlan: { issueNumber: 9, branchName: "roark/issue-9", baseBranch: "main" },
        workflowContext: {
          controlCwd,
          agentCwd,
          outDir: path.join(controlCwd, ".roark/runs"),
          runDir: path.join(controlCwd, ".roark/runs/issue/9/attempts/1"),
          runDirRelative: ".roark/runs/issue/9/attempts/1",
          issueInput: "9",
          issueNumber: "9",
          attempt: 1,
          force: false,
          yes: false,
          maxFixPasses: 1,
          thinkingConfig: getWorkflowThinkingConfig(),
        },
        agentRunner: () => Promise.resolve(JSON.stringify({ url: "https://github.com/owner/repo/pull/1", title: "Fix bug" })),
      });
    } finally {
      process.env["PATH"] = oldPath;
      if (oldGhLog === undefined) delete process.env["ROARK_GH_LOG"];
      else process.env["ROARK_GH_LOG"] = oldGhLog;
    }

    const afterCommitCount = Number(await gitOutput(agentCwd, ["rev-list", "--count", "HEAD"]));
    expect(afterCommitCount).toBe(beforeCommitCount + 1);
    expect(await gitOutput(agentCwd, ["log", "-1", "--pretty=%s"])).toBe(formatCommitMessage({ issueNumber: 9 }));
    expect(await gitOutput(agentCwd, ["show", "HEAD:feature.txt"])).toBe("feature");

    const committedPaths = await gitOutput(agentCwd, ["ls-tree", "-r", "--name-only", "HEAD"]);
    expect(committedPaths).toContain("feature.txt");
    expect(committedPaths).not.toContain(".roark/runs");
  });
});

describe("formatPrBody", () => {
  test("includes Closes, verification details, and artifact list when verification passed", () => {
    const body = formatPrBody({
      issueNumber: 9,
      verification: okVerification,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [
        ".roark/runs/issue/9/readiness.md",
        ".roark/runs/issue/9/verification.md",
        ".roark/runs/issue/9/implementation-plan.md",
      ],
    });

    expect(body).toContain("Closes #9");
    expect(body).toContain("## Before / After");
    expect(body).toContain("## Root cause / Fix");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("## Suggested review path");
    expect(body).toContain("## Files changed");
    expect(body).toContain("## Verification");
    expect(body).toContain("- `bun run typecheck` — passed");
    expect(body).toContain("  - Exit code: 0");
    expect(body).toContain("<summary>Automation details</summary>");
    expect(body).toContain("- Review A: unknown");
    expect(body).toContain("- Review B: unknown");
    expect(body).toContain("- Full run ledger: issue comments on #9");
    expect(body).toContain("## Risk");
    expect(body).toContain("## Follow-up issues");
    expect(body).toContain("- None recorded in this PR body at creation time.");
    expect(body).toContain("### Key workflow artifacts");
    expect(body).toContain("These artifacts are local control-plane state and are not committed to this PR branch.");
    expect(body).toContain("- `.roark/runs/issue/9/readiness.md`");
    expect(body).toContain("- `.roark/runs/issue/9/verification.md`");
    expect(body).toContain("- `.roark/runs/issue/9/implementation-plan.md`");
    expect(body).toContain("Generated by roark autorun.");
  });

  test("uses workflow artifacts to open with a human-readable narrative", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-pr-narrative-"));
    tempDirs.push(cwd);
    const context = createWorkflowContext({
      command: "do",
      issue: "9",
      cwd,
      outDir: ".roark/runs",
      force: false,
      yes: false,
      maxFixPasses: 1,
      attempt: 1,
    });
    await writeArtifact(context, "issue", `<github_issue number="9">\n  <title>Status filter was ignored</title>\n</github_issue>`);
    await writeArtifact(context, "implementationPlan", `# Implementation Plan

## Goal
Apply the saved status filter when loading tenders.

## Current Code Findings
- The tender list loader ignored the status query parameter, so users saw unfiltered results.

## Non-Goals
- Do not redesign the filter UI.

## Proposed Changes
- Thread the status filter into the tender query builder.

## Risks
- Query behavior could change for empty filter values.

## Ready For Implementation
yes
`);
    await writeArtifact(context, "implementationLog", `# Implementation Log

## Summary
- Added status filter handling to the tender query.

## Changed Files
- lib/tenders/query.ts
`);

    const body = formatAutorunPrBody({ issueNumber: 9, workflowContext: context, verification: okVerification });

    expect(body.indexOf("## Before / After")).toBeLessThan(body.indexOf("<summary>Automation details</summary>"));
    expect(body).toContain("Before:\n- The tender list loader ignored the status query parameter, so users saw unfiltered results.");
    expect(body).toContain("After:\n- Added status filter handling to the tender query.");
    expect(body).toContain("- Root cause: The tender list loader ignored the status query parameter, so users saw unfiltered results.");
    expect(body).toContain("- Fix: Added status filter handling to the tender query.");
    expect(body).toContain("- [x] Thread the status filter into the tender query builder.");
    expect(body).toContain("Primary output:\n- `lib/tenders/query.ts`");
    expect(body).toContain("- Query behavior could change for empty filter values.");
  });

  test("reports failed verification status and exit code without checking verification as acceptance criteria", () => {
    const body = formatPrBody({
      issueNumber: 9,
      verification: failedVerification,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/verification.md"],
    });

    expect(body).toContain("- `bun run typecheck` — failed");
    expect(body).toContain("  - Exit code: 2");
    expect(body).not.toContain("- [x] Verification completed as recorded below.");
  });

  test("sanitizes verification commands", () => {
    const body = formatPrBody({
      issueNumber: 9,
      verification: {
        ...okVerification,
        command: "GITHUB_TOKEN=secret /Users/alice/repo/scripts/verify.sh --flag C:\\Users\\alice\\repo\\check.bat",
      },
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/verification.md"],
    });

    expect(body).toContain("- `GITHUB_TOKEN=[redacted] [local path redacted] --flag [local path redacted]` — passed");
    expect(body).not.toContain("/Users/alice");
    expect(body).not.toContain("C:\\Users\\alice");
    expect(body).not.toContain("GITHUB_TOKEN=secret");
  });

  test("handles missing verification defensively", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/readiness.md"],
    });

    expect(body).toContain("Closes #9");
    expect(body).toContain("## Verification");
    expect(body).toContain("- Not run.");
    expect(body).toContain("- `.roark/runs/issue/9/readiness.md`");
  });

  test("falls back to the run directory when no artifacts are listed", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [],
    });

    expect(body).toContain("- `.roark/runs/issue/9/`");
  });

  test("renders the Attempt section with branch, timestamps, and metadata path", () => {
    const attemptMetadata = formatAttemptMetadata({
      attempt: 2,
      issueNumber: 10,
      branch: "roark/issue-10",
      baseBranch: "main",
      worktreePath: "/repo",
      runArtifactPath: ".roark/runs/issue/10/attempts/2",
      startedAt: "2026-05-05T07:17:40.000Z",
      endedAt: "2026-05-05T07:42:11.000Z",
      outcome: "published",
    });

    const body = formatPrBody({
      issueNumber: 10,
      verification: okVerification,
      runDirRelative: ".roark/runs/issue/10/attempts/2",
      artifactPaths: [".roark/runs/issue/10/attempts/2/readiness.md"],
      attemptMetadata,
      attemptMetadataPath: ".roark/runs/issue/10/attempts/2/attempt.json",
    });

    expect(body).toContain("### Attempt");
    expect(body).toContain("- Attempt: 2");
    expect(body).toContain("- Branch: `roark/issue-10`");
    expect(body).toContain("- Started: 2026-05-05T07:17:40.000Z");
    expect(body).toContain("- Ended: 2026-05-05T07:42:11.000Z");
    expect(body).not.toContain("- Worktree:");
    expect(body).not.toContain("- Workspace:");
    expect(body).not.toContain("/repo");
    expect(body).toContain("- Metadata: `.roark/runs/issue/10/attempts/2/attempt.json`");
    // Attempt block precedes the artifacts list.
    expect(body.indexOf("### Attempt")).toBeLessThan(body.indexOf("### Key workflow artifacts"));
    expect(body).toContain("- `.roark/runs/issue/10/attempts/2/readiness.md`");
  });

  test("omits the Attempt section when no metadata is provided", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/readiness.md"],
    });
    expect(body).not.toContain("### Attempt");
  });

  test("renders supplied reviewer-facing summaries and ledger/follow-up links", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [],
      triageVerdict: "proceed",
      planReady: "yes",
      readinessStatus: "ready-for-pr",
      ledgerComments: [{ title: "Triage", phase: "triage", url: "https://github.com/owner/repo/issues/9#issuecomment-1" }],
      followUpIssues: [{ title: "Follow up", number: 20, url: "https://github.com/owner/repo/issues/20" }],
    });

    expect(body).toContain("- Triage verdict: proceed");
    expect(body).toContain("- Plan ready for implementation: yes");
    expect(body).toContain("- Readiness status: ready-for-pr");
    expect(body).toContain("- Triage: https://github.com/owner/repo/issues/9#issuecomment-1");
    expect(body).toContain("- #20: https://github.com/owner/repo/issues/20");
  });

  test("links pass-specific review ledger comments in autorun PR bodies", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-pr-body-ledger-"));
    tempDirs.push(cwd);
    const context = createWorkflowContext({
      command: "do",
      issue: "9",
      cwd,
      outDir: ".roark/runs",
      force: false,
      yes: false,
      maxFixPasses: 2,
      attempt: 1,
    });
    await writeArtifact(context, reviewARef(0), "# Review A\n\n## Verdict\napprove\n");
    await writeArtifact(context, reviewBRef(0), "# Review B\n\n## Verdict\napprove\n");
    const attemptMetadata = formatAttemptMetadata({
      attempt: 1,
      issueNumber: 9,
      branch: "roark/issue-9",
      baseBranch: "main",
      worktreePath: cwd,
      runArtifactPath: context.runDirRelative,
      startedAt: "2026-05-05T07:17:40.000Z",
      githubComments: {
        issue: {
          "review-a-0": { id: 101, url: "https://github.com/owner/repo/issues/9#issuecomment-101", marker: "a", updatedAt: "2026-05-05T07:18:40.000Z" },
          "review-b-0": { id: 102, url: "https://github.com/owner/repo/issues/9#issuecomment-102", marker: "b", updatedAt: "2026-05-05T07:18:41.000Z" },
        },
      },
    });

    const body = formatAutorunPrBody({ issueNumber: 9, workflowContext: context, attemptMetadata });

    expect(body).toContain("- Review A: https://github.com/owner/repo/issues/9#issuecomment-101");
    expect(body).toContain("- Review B: https://github.com/owner/repo/issues/9#issuecomment-102");
  });

  test("renders supplied Review A/B verdict summary", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/review-a.md", ".roark/runs/issue/9/review-b.md"],
      reviewVerdicts: { reviewA: "approve", reviewB: "fixes-required" },
    });

    expect(body).toContain("<summary>Automation details</summary>");
    expect(body).toContain("- Review A: approve");
    expect(body).toContain("- Review B: fixes-required");
    expect(body).toContain("- Full run ledger: issue comments on #9");
  });
});

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await runProcessOrThrow(["git", ...args], { cwd })).trim();
}
