import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  buildCommitArgv,
  buildPushArgv,
  buildStageAllArgv,
  buildSuccessLabelArgv,
  formatCommitMessage,
  hasUncommittedChanges,
  publishAutorunResult,
  updatePrBodyWithAgent,
} from "./publish.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { configurePresenter } from "../presentation/presenter.ts";
import type { TerminalStream } from "../presentation/terminal.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

describe("PR body update presentation", () => {
  test("completes the continuation phase when the agent rejects", async () => {
    let output = "";
    const stream: TerminalStream = { isTTY: false, columns: 80, write(chunk) { output += chunk; } };
    configurePresenter({ stream });
    let command: string | undefined;

    try {
      const update = updatePrBodyWithAgent({
        cwd: "/tmp",
        repo: "owner/repo",
        pr: "https://github.com/owner/repo/pull/1",
        issueNumber: 9,
        issueTitle: "Fix bug",
        workflowContext: {
          controlCwd: "/tmp",
          agentCwd: "/tmp",
          outDir: "/tmp/.roark/runs",
          runDir: "/tmp/.roark/runs/issue/9/attempts/1",
          runDirRelative: ".roark/runs/issue/9/attempts/1",
          issueInput: "9",
          issueNumber: "9",
          displayCommand: "continue",
          attempt: 1,
          force: false,
          yes: false,
          maxFixPasses: 1,
          thinkingConfig: getWorkflowThinkingConfig(),
        },
        agentRunner: (request) => {
          command = request.display.command;
          return Promise.reject(new Error("agent unavailable"));
        },
      });
      let failure: unknown;
      try {
        await update;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("agent unavailable");

      expect(command).toBe("continue");
      expect(output).toContain("PHASE #9 · Update PR body");
      expect(output).toContain("FAILED #9 · Update PR body · agent unavailable");
    } finally {
      configurePresenter({});
    }
  });
});

describe("publishAutorunResult", () => {
  test("announces publication before starting git operations", () => {
    let output = "";
    const stream: TerminalStream = { isTTY: true, columns: 80, write(chunk) { output += chunk; } };
    configurePresenter({ stream, env: { TERM: "xterm" } });
    const missingCwd = path.join(tmpdir(), `roark-missing-publish-${crypto.randomUUID()}`);

    try {
      expect(publishAutorunResult({
        options: {
          cwd: missingCwd,
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
          controlCwd: missingCwd,
          agentCwd: missingCwd,
          outDir: path.join(missingCwd, ".roark/runs"),
          runDir: path.join(missingCwd, ".roark/runs/issue/9/attempts/1"),
          runDirRelative: ".roark/runs/issue/9/attempts/1",
          issueInput: "9",
          issueNumber: "9",
          attempt: 1,
          force: false,
          yes: false,
          maxFixPasses: 1,
          thinkingConfig: getWorkflowThinkingConfig(),
        },
      })).rejects.toThrow();
      expect(output).toContain("PHASE #9 · Publish pull request");
    } finally {
      configurePresenter({});
    }
  });

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
      const agentRequests: { cwd: string; prompt: string; command: string; skillPaths?: string[] | undefined }[] = [];
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
          displayCommand: "continue",
          attempt: 1,
          force: false,
          yes: false,
          maxFixPasses: 1,
          thinkingConfig: getWorkflowThinkingConfig(),
        },
        agentRunner: (request) => {
          agentRequests.push({ cwd: request.cwd, prompt: request.prompt, command: request.display.command, skillPaths: request.skillPaths });
          return Promise.resolve(JSON.stringify({ url: "https://github.com/owner/repo/pull/1", title: "Fix bug" }));
        },
      });

      expect(prUrl).toBe("https://github.com/owner/repo/pull/1");
      expect(agentRequests).toHaveLength(1);
      expect(agentRequests[0]?.cwd).toBe(controlCwd);
      expect(agentRequests[0]?.command).toBe("continue");
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

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await runProcessOrThrow(["git", ...args], { cwd })).trim();
}
