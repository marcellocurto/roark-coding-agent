import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContinueCliOptions } from "../cli/args.ts";
import { writeArtifact, writeJsonArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import { formatAttemptMetadata, readAttemptMetadata, writeAttemptMetadata } from "./attempts.ts";
import { autorunWorktreePath } from "./branch.ts";
import { runAutoContinue, createContinueWorkflowOptions } from "./continue.ts";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const continueOptions = {
  command: "continue",
  issue: "123",
  cwd: "/repo",
  outDir: ".roark/runs",
  repo: "owner/repo",
  model: "provider/model",
  thinkingLevel: "high",
  force: false,
  yes: true,
  maxFixPasses: 3,
  attempt: 2,
  verifyCommand: "bun test",
  failureLabel: "failed",
  successLabel: "opened",
  inProgressLabel: "busy",
  remote: "origin",
} satisfies ContinueCliOptions;

describe("runAutoContinue", () => {
  test("already-published attempts return before label preflight or branch work", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-published-"));
    tempDirs.push(cwd);
    await installFailingGh(cwd);
    await writeAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: path.join(cwd, ".roark/worktrees/issue-24"),
      runArtifactPath: ".roark/runs/issue/24/attempts/2",
      startedAt: "2026-05-07T00:00:00.000Z",
      endedAt: "2026-05-07T00:10:00.000Z",
      outcome: "published",
    }));

    await runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 2 });
  });

  test("records Review A/B issue comments when a later workflow phase fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-error-ledger-"));
    tempDirs.push(cwd);
    await initGitRepo(cwd, "roark/issue-24");
    await installFakeGh(cwd);

    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      repo: "owner/repo",
      attempt: 2,
      force: false,
      yes: true,
      maxFixPasses: 1,
    };
    await writeArtifact(workflowContext, "issue", "# Issue\n\n<github_issue_relationships />\n");
    await writeJsonArtifact(workflowContext, "metadata", {
      issue: { number: 24, title: "Ledger comments", url: "https://github.com/owner/repo/issues/24", labels: [] },
    });
    await writeArtifact(workflowContext, "triage", "# Triage\n\n## Verdict\nproceed\n");
    await writeArtifact(workflowContext, "implementationPlan", "# Implementation Plan\n\n## Ready For Implementation\nyes\n");
    await writeArtifact(workflowContext, "implementationLog", "# Implementation Log\n\nDone.\n");
    await writeArtifact(workflowContext, "reviewA", "# Review A\n\n## Verdict\nfixes-required\n");
    await writeArtifact(workflowContext, "reviewB", "# Review B\n\n## Verdict\napprove\n");
    await writeAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: path.join(cwd, "deleted-worktree"),
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    }));

    await expect(runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 2 }, {
      runner: async (_request: AgentRunRequest) => {
        throw new Error("fix failed after reviews");
      },
    })).rejects.toThrow("Fix pass 1 failed");

    const metadata = await readAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), 2);
    expect(metadata.outcome).toBe("errored");
    expect(metadata.worktreePath).toBe(autorunWorktreePath(cwd, 24));
    expect(metadata.githubComments?.issue?.["review-a"]?.id).toBe(4242);
    expect(metadata.githubComments?.issue?.["review-b"]?.id).toBe(4242);
  });
});

describe("createContinueWorkflowOptions", () => {
  test("targets the existing attempt with issue workflow options", () => {
    const workflowOptions = createContinueWorkflowOptions(continueOptions, 2);
    expect(workflowOptions).toEqual({
      command: "do",
      issue: "123",
      cwd: "/repo",
      outDir: ".roark/runs",
      repo: "owner/repo",
      model: "provider/model",
      thinkingLevel: "high",
      force: false,
      yes: true,
      maxFixPasses: 3,
      attempt: 2,
    });
  });
});

async function initGitRepo(cwd: string, branchName: string): Promise<void> {
  await run(cwd, ["git", "init", "-b", "main"]);
  await run(cwd, ["git", "config", "user.email", "roark@example.com"]);
  await run(cwd, ["git", "config", "user.name", "Roark Test"]);
  await writeFile(path.join(cwd, "README.md"), "test\n", "utf8");
  await run(cwd, ["git", "add", "README.md"]);
  await run(cwd, ["git", "commit", "-m", "initial"]);
  await run(cwd, ["git", "branch", branchName]);
}

async function installFailingGh(cwd: string): Promise<void> {
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
echo "gh should not be called" >&2
exit 99
`, "utf8");
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

async function installFakeGh(cwd: string): Promise<void> {
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  if [ "$3" = "--paginate" ]; then
    printf '[]\\n'
    exit 0
  fi
  printf '{"id":4242,"html_url":"https://github.com/owner/repo/issues/24#issuecomment-4242"}\\n'
  exit 0
fi
exit 0
`, "utf8");
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

async function run(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed with ${exitCode}: ${stderr || stdout}`);
}
