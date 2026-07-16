import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContinueCliOptions } from "../cli/args.ts";
import { refinementLogRef, reviewARef, reviewBRef, writeArtifact, writeJsonArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { formatAttemptMetadata, readAttemptMetadata, writeAttemptMetadata } from "./attempts.ts";
import { autorunWorktreePath } from "./branch.ts";
import { runAutoContinue, createContinueWorkflowOptions } from "./continue.ts";
import { noopAsync } from "../utils/async.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import { implementationPlanResult, triageResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";

const tempDirs: string[] = [];
const originalPath = process.env["PATH"];

afterEach(async () => {
  process.env["PATH"] = originalPath;
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
  readyLabel: "ready-for-agent",
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

  test("reuses workspace metadata and runs beforeRun in the attempt lifecycle", async () => {
        await noopAsync();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-workspace-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "roark-continue-managed-"));
    tempDirs.push(cwd, workspacePath);
    await installFakeGh(cwd);

    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: workspacePath,
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
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await writeArtifact(workflowContext, "issue", "# Issue\n\n<github_issue_relationships />\n");
    await writeAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: path.join(cwd, "legacy-worktree"),
      workspace: { path: workspacePath, strategy: "clone", cloneRemote: "upstream", createdNow: false },
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    }));

    const calls: string[] = [];
    expect(runAutoContinue({
      ...continueOptions,
      issue: "24",
      cwd,
      attempt: 2,
      hooks: { timeoutMs: 1000, beforeRun: "printf before > before-run.txt" },
    }, {
      ensureAutorunLabelContract: async () => (await noopAsync(), ({ existing: [], missing: [], created: [] })),
      prepareCloneWorkspace: async (input) => {
        await noopAsync();
        calls.push(`prepare:${input.workspacePath ?? ""}`);
        expect(input.mode).toBe("continue");
        expect(input.workspacePath).toBe(workspacePath);
        return {
          path: workspacePath,
          metadata: { path: workspacePath, strategy: "clone", cloneRemote: "upstream", createdNow: false },
        };
      },
      fetchGitHubIssue: async () => (await noopAsync(), {
        issue: { number: 24, title: "Issue 24", labels: [{ name: "failed" }, { name: "ready-for-agent" }] },
        issueNumber: "24",
        repo: "owner/repo",
        fetchedAt: "now",
        relationships: { fetchedAt: "now", nativeDependenciesAvailable: true, blockedBy: [], blocking: [], bodyDeclaredBlockers: [] },
      }),
      transitionGitHubIssueLabels: async (input) => {
        await noopAsync();
        calls.push("transition");
        expect(input.nextLabel).toBe("busy");
        expect(input.removeLabels).toEqual(["failed", "ready-for-agent"]);
      },
      runner: async () => {
        await noopAsync();
        calls.push("runner");
        throw new Error("triage failed");
      },
    })).rejects.toThrow("Triage failed: triage failed");

    expect(calls).toEqual([`prepare:${workspacePath}`, "transition", "runner"]);
    expect(await Bun.file(path.join(workspacePath, "before-run.txt")).text()).toBe("before");
    const metadata = await readAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), 2);
    expect(metadata.worktreePath).toBe(workspacePath);
    expect(metadata.workspace?.path).toBe(workspacePath);
    expect(metadata.outcome).toBe("errored");
  });

  test("records Review A/B issue comments when a later workflow phase fails", async () => {
        await noopAsync();
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
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await writeArtifact(workflowContext, "issue", "# Issue\n\n<github_issue_relationships />\n");
    await writeJsonArtifact(workflowContext, "metadata", {
      issue: { number: 24, title: "Ledger comments", url: "https://github.com/owner/repo/issues/24", labels: [] },
    });
    await writeJsonArtifact(workflowContext, "triage", triageResult());
    await writeJsonArtifact(workflowContext, "implementationPlanDraft", implementationPlanResult());
    await writeJsonArtifact(workflowContext, "implementationPlan", implementationPlanResult());
    await writeArtifact(workflowContext, "preImplementationBaseline", JSON.stringify({ head: "abc", capturedAt: "now", excludes: [".roark"] }));
    await writeArtifact(workflowContext, "implementationLog", JSON.stringify(changeReport()));
    await writeArtifact(workflowContext, refinementLogRef(0), JSON.stringify(changeReport({ summary: "Refined." })));
    await writeArtifact(workflowContext, reviewARef(0), JSON.stringify(reviewResult([
      reviewFinding("must-fix-current", "Fix failed after reviews"),
    ])));
    await writeArtifact(workflowContext, reviewBRef(0), JSON.stringify(reviewResult()));
    await writeAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: path.join(cwd, "deleted-worktree"),
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    }));

    expect(runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 2 }, {
      runner: async () => {
        await noopAsync();
        throw new Error("fix failed after reviews");
      },
    })).rejects.toThrow("Fix pass 1 failed");

    const metadata = await readAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), 2);
    expect(metadata.outcome).toBe("errored");
    expect(metadata.worktreePath).toBe(autorunWorktreePath(cwd, 24));
    expect(metadata.githubComments?.issue?.["review-a-0"]?.id).toBe(4242);
    expect(metadata.githubComments?.issue?.["review-b-0"]?.id).toBe(4242);
  });

  test("serializes concurrent continues for the same issue across attempts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-lock-"));
    const workspacePath = await mkdtemp(path.join(tmpdir(), "roark-continue-lock-workspace-"));
    tempDirs.push(cwd, workspacePath);
    await installFakeGh(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: workspacePath,
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
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await writeArtifact(workflowContext, "issue", "# Issue\n\n<github_issue_relationships />\n");
    await writeAttemptMetadata(path.join(cwd, ".roark/runs/issue/24"), formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: workspacePath,
      workspace: { path: workspacePath, strategy: "clone", cloneRemote: "origin", createdNow: false },
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    }));

    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const injected = {
      ensureAutorunLabelContract: async () => (await noopAsync(), ({ existing: [], missing: [], created: [] })),
      prepareCloneWorkspace: async () => {
        await noopAsync();
        return {
          path: workspacePath,
          metadata: { path: workspacePath, strategy: "clone" as const, cloneRemote: "origin", createdNow: false },
        };
      },
    };

    const first = runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 2 }, {
      ...injected,
      runner: async () => {
        enteredFirst();
        await release;
        throw new Error("stop first continue");
      },
    });

    await firstEntered;

    expect(runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 3 }, {
      ...injected,
      runner: async () => {
        await noopAsync();
        throw new Error("second continue should not run lifecycle");
      },
    })).rejects.toThrow("roark continue issue #24 attempt 3 is already running");

    releaseFirst();
    expect(first).rejects.toThrow("stop first continue");
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
  process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

async function installFakeGh(cwd: string): Promise<void> {
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "gh"), `#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '{"number":24,"title":"Issue 24","body":"","state":"OPEN","labels":[{"name":"failed"},{"name":"ready-for-agent"}],"assignees":[],"milestone":null,"url":"https://github.com/owner/repo/issues/24","comments":[]}\n'
  exit 0
fi
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
  process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
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
