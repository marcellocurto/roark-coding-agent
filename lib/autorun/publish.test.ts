import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  buildCommitArgv,
  buildPrCreateArgv,
  buildPushArgv,
  buildStageAllArgv,
  buildSuccessLabelArgv,
  defaultAutorunRemote,
  defaultAutorunSuccessLabel,
  formatCommitMessage,
  formatPrBody,
  hasUncommittedChanges,
  publishAutorunResult,
} from "./publish.ts";
import { formatAttemptMetadata } from "./attempts.ts";
import type { VerificationResult } from "./verification.ts";

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
  test("buildStageAllArgv stages target changes but excludes run artifacts", () => {
    expect(buildStageAllArgv()).toEqual(["git", "add", "-A", "--", ".", ":(exclude).roark/runs"]);
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
    await runProcessOrThrow(["git", "add", "README.md"], { cwd: repo });
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
  test("uses agent cwd for git and control cwd for PR creation and issue labels", async () => {
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

    const oldPath = process.env.PATH;
    const oldGhLog = process.env.ROARK_GH_LOG;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.ROARK_GH_LOG = ghLog;
    try {
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
        },
      });

      expect(prUrl).toBe("https://github.com/owner/repo/pull/1");
    } finally {
      process.env.PATH = oldPath;
      if (oldGhLog === undefined) delete process.env.ROARK_GH_LOG;
      else process.env.ROARK_GH_LOG = oldGhLog;
    }

    const ghCalls = await readFile(ghLog, "utf8");
    expect(ghCalls).toContain(`${controlCwd}\tpr create`);
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
    await runProcessOrThrow(["git", "add", "README.md"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd: agentCwd });
    await runProcessOrThrow(["git", "init", "--bare", remote]);
    await runProcessOrThrow(["git", "remote", "add", "origin", remote], { cwd: agentCwd });
    await runProcessOrThrow(["git", "push", "-u", "origin", "roark/issue-9"], { cwd: agentCwd });

    const beforeCommitCount = Number(await gitOutput(agentCwd, ["rev-list", "--count", "HEAD"]));
    await writeFile(path.join(agentCwd, "feature.txt"), "feature\n", "utf8");
    await mkdir(path.join(agentCwd, ".roark/runs/issue/9/attempts/1"), { recursive: true });
    await writeFile(path.join(agentCwd, ".roark/runs/issue/9/attempts/1/attempt.json"), "{}\n", "utf8");

    const oldPath = process.env.PATH;
    const oldGhLog = process.env.ROARK_GH_LOG;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.ROARK_GH_LOG = ghLog;
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
        },
      });
    } finally {
      process.env.PATH = oldPath;
      if (oldGhLog === undefined) delete process.env.ROARK_GH_LOG;
      else process.env.ROARK_GH_LOG = oldGhLog;
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
    expect(body).toContain("## Verification");
    expect(body).toContain("- Command: `bun run typecheck`");
    expect(body).toContain("- Exit code: 0");
    expect(body).toContain("- Status: passed");
    expect(body).toContain("## Review summary");
    expect(body).toContain("- Review A: unknown");
    expect(body).toContain("- Review B: unknown");
    expect(body).toContain("- Full run ledger: issue comments on #9");
    expect(body).toContain("## Workflow artifacts");
    expect(body).toContain("These artifacts are local control-plane state and are not committed to this PR branch.");
    expect(body).toContain("- `.roark/runs/issue/9/readiness.md`");
    expect(body).toContain("- `.roark/runs/issue/9/verification.md`");
    expect(body).toContain("- `.roark/runs/issue/9/implementation-plan.md`");
    expect(body).toContain("Generated by roark autorun.");
  });

  test("reports failed verification status and exit code", () => {
    const body = formatPrBody({
      issueNumber: 9,
      verification: failedVerification,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/verification.md"],
    });

    expect(body).toContain("- Exit code: 2");
    expect(body).toContain("- Status: failed");
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

  test("renders the Attempt section with branch, timestamps, worktree, and metadata path", () => {
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

    expect(body).toContain("## Attempt");
    expect(body).toContain("- Attempt: 2");
    expect(body).toContain("- Branch: `roark/issue-10`");
    expect(body).toContain("- Started: 2026-05-05T07:17:40.000Z");
    expect(body).toContain("- Ended: 2026-05-05T07:42:11.000Z");
    expect(body).toContain("- Worktree: `/repo`");
    expect(body).toContain("- Metadata: `.roark/runs/issue/10/attempts/2/attempt.json`");
    // Attempt block precedes the artifacts list.
    expect(body.indexOf("## Attempt")).toBeLessThan(body.indexOf("## Workflow artifacts"));
    expect(body).toContain("- `.roark/runs/issue/10/attempts/2/readiness.md`");
  });

  test("omits the Attempt section when no metadata is provided", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/readiness.md"],
    });
    expect(body).not.toContain("## Attempt");
  });

  test("renders supplied Review A/B verdict summary", () => {
    const body = formatPrBody({
      issueNumber: 9,
      runDirRelative: ".roark/runs/issue/9",
      artifactPaths: [".roark/runs/issue/9/review-a.md", ".roark/runs/issue/9/review-b.md"],
      reviewVerdicts: { reviewA: "approve", reviewB: "fixes-required" },
    });

    expect(body).toContain("## Review summary");
    expect(body).toContain("- Review A: approve");
    expect(body).toContain("- Review B: fixes-required");
    expect(body).toContain("- Full run ledger: issue comments on #9");
  });
});

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await runProcessOrThrow(["git", ...args], { cwd })).trim();
}
