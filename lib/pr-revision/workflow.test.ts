import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { RevisePrCliOptions } from "../cli/args.ts";
import type { PullRequestFeedback } from "../github/pr.ts";
import { noopAsync } from "../utils/async.ts";
import { runPrRevision, type RunPrRevisionDependencies } from "./workflow.ts";

async function tempGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-pr-workflow-"));
  await Bun.spawn(["git", "init"], { cwd }).exited;
  await Bun.spawn(["git", "config", "user.email", "roark@example.invalid"], { cwd }).exited;
  await Bun.spawn(["git", "config", "user.name", "Roark Test"], { cwd }).exited;
  return cwd;
}

async function isolatedWorkspace(setup?: (workspace: string) => Promise<void>): Promise<{
  workspace: string;
  prepareWorkspace: NonNullable<RunPrRevisionDependencies["prepareWorkspace"]>;
}> {
  const workspace = await tempGitRepo();
  await setup?.(workspace);
  return {
    workspace,
    prepareWorkspace: async () => {
      await noopAsync();
      return {
        path: workspace,
        metadata: { path: workspace, strategy: "clone", cloneRemote: "origin", createdNow: false },
        releaseLock: noopAsync,
      };
    },
  };
}

async function run(args: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed\n${stderr || stdout}`);
}

async function runOutput(args: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed\n${stderr || stdout}`);
  return stdout;
}

function options(cwd: string, overrides: Partial<RevisePrCliOptions> = {}): RevisePrCliOptions {
  return {
    command: "revise-pr",
    prNumber: 12,
    cwd,
    outDir: ".roark/runs",
    repo: "owner/repo",
    verifyCommand: "true",
    remote: "origin",
    maxFixPasses: 1,
    force: false,
    yes: false,
    comment: true,
    ...overrides,
  };
}

function feedback(): PullRequestFeedback {
  return {
    repo: "owner/repo",
    fetchedAt: "2026-05-07T00:00:00.000Z",
    pr: {
      number: 12,
      title: "Draft work",
      body: "Closes #46",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature/pr-12",
      baseRepository: "owner/repo",
      headRepository: "owner/repo",
    },
    comments: [],
    plannerComments: [],
    reviewThreads: [],
    excludedRoarkSummaryCommentIds: [],
  };
}

describe("runPrRevision", () => {
  test("legacy checkout fallback uses the control checkout as the agent workspace", async () => {
    await noopAsync();
    const cwd = await tempGitRepo();
    let checkoutCalled = false;
    let commentCalled = false;

    const result = await runPrRevision(options(cwd), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      checkout: async () => {
        await noopAsync();
        checkoutCalled = true;
      },
      agentRunner: async () => (await noopAsync(), "# Revision Plan\n\n## Status\nno-action-needed\n\n## Classified Feedback\n- None\n"),
      postSummaryComment: async () => {
        await noopAsync();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(checkoutCalled).toBe(true);
    expect(commentCalled).toBe(true);
    expect(result.context.agentCwd).toBe(result.context.controlCwd);
    expect(result.context.revisionDir).toBe(result.context.agentRevisionDir);
    expect(result.context.revisionDirRelative).toBe(".roark/runs/pr/12/revision-1");
  });

  test("no-action-needed isolated revisions remove mirrored workspace artifacts", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { workspace, prepareWorkspace } = await isolatedWorkspace();

    let commentCalls = 0;
    const result = await runPrRevision(options(control), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async () => (await noopAsync(), "# Revision Plan\n\n## Status\nno-action-needed\n\n## Classified Feedback\n- None\n"),
      postSummaryComment: async () => {
        await noopAsync();
        commentCalls++;
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(result.context.agentCwd).toBe(workspace);
    expect(await Bun.file(path.join(result.context.revisionDir, "metadata.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(result.context.agentRevisionDir, "metadata.json")).exists()).toBe(false);
    expect(commentCalls).toBe(1);
    expect((await runOutput(["git", "status", "--porcelain"], workspace)).trim()).toBe("");
  });

  test("no-action-needed respects --no-comment", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    let commentCalled = false;

    const result = await runPrRevision(options(control, { comment: false }), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async () => (await noopAsync(), "# Revision Plan\n\n## Status\nno-action-needed\n\n## Classified Feedback\n- None\n"),
      postSummaryComment: async () => {
        await noopAsync();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(commentCalled).toBe(false);
  });

  test("allocates revisions across the control checkout and isolated workspace", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace(async (workspace) => {
      await mkdir(path.join(workspace, ".roark", "runs", "pr", "12", "revision-1"), { recursive: true });
    });

    let commentCalls = 0;
    const result = await runPrRevision(options(control), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async () => (await noopAsync(), "# Revision Plan\n\n## Status\nno-action-needed\n"),
      postSummaryComment: async () => {
        await noopAsync();
        commentCalls++;
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(result.context.revision).toBe(2);
    expect(result.context.revisionDirRelative).toBe(".roark/runs/pr/12/revision-2");
    expect(commentCalls).toBe(1);
  });

  test("needs-human stops before enabling file-editing tools and posts one summary by default", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    const fileEditingToolCalls: boolean[] = [];
    let commentCalled = false;

    const result = await runPrRevision(options(control), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async (request) => {
        await noopAsync();
        fileEditingToolCalls.push(request.fileEditingToolsEnabled);
        return "# Revision Plan\n\n## Status\nneeds-human\n\n## Human Needs\n- Please decide.\n";
      },
      postSummaryComment: async () => {
        await noopAsync();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("needs-human");
    expect(fileEditingToolCalls).toEqual([false]);
    expect(commentCalled).toBe(true);
  });

  test("uses centralized thinking profiles for revision agents", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    const thinkingLevels: string[] = [];

    const result = await runPrRevision(options(control, { thinkingProfile: "fast" }), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async (request) => {
        await noopAsync();
        thinkingLevels.push(request.thinkingLevel);
        if (request.fileEditingToolsEnabled) return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n";
        if (thinkingLevels.length === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => (await noopAsync(), ({ ok: false, command, exitCode: 127, stdout: "", stderr: "sh: missing-command: command not found" })),
      postSummaryComment: async () => {
        await noopAsync();
      },
    });

    expect(result.outcome).toBe("verification-failed");
    expect(thinkingLevels).toEqual(["low", "low", "low"]);
  });

  test("non-repairable verification failure leaves revision unpublished without a fix pass", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    let commentCalled = false;
    let calls = 0;
    let writableCalls = 0;

    const result = await runPrRevision(options(control, { maxFixPasses: 3 }), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async (request) => {
        await noopAsync();
        calls++;
        if (request.fileEditingToolsEnabled) {
          writableCalls++;
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => (await noopAsync(), ({ ok: false, command, exitCode: 127, stdout: "", stderr: "sh: missing-command: command not found" })),
      postSummaryComment: async () => {
        await noopAsync();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("verification-failed");
    expect(writableCalls).toBe(1);
    expect(commentCalled).toBe(true);
    expect(existsSync(path.join(result.context.revisionDir, "verification-before-fix-1.md"))).toBe(false);
  });

  test("repairable verification failure runs a fix pass, review, then publishes after verification passes", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const remote = await mkdtemp(path.join(tmpdir(), "roark-pr-remote-"));
    await Bun.spawn(["git", "init", "--bare"], { cwd: remote }).exited;
    await run(["git", "remote", "add", "origin", remote], control);
    const { prepareWorkspace } = await isolatedWorkspace(async (workspace) => {
      await run(["git", "checkout", "-b", "feature/pr-12"], workspace);
    });
    let calls = 0;
    let verificationCalls = 0;
    let commentCalls = 0;
    let addressedSummary: string[] | undefined;
    const writableArtifacts: string[] = [];

    const result = await runPrRevision(options(control, { maxFixPasses: 3 }), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async (request) => {
        await noopAsync();
        calls++;
        if (request.fileEditingToolsEnabled) {
          writableArtifacts.push(request.prompt);
          await Bun.write(path.join(request.cwd, "fixed.txt"), `fixed ${writableArtifacts.length}\n`);
          return `# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed pass ${writableArtifacts.length}.\n\n## Skipped Items\n- None.\n`;
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => {
        await noopAsync();
        verificationCalls++;
        return verificationCalls === 1
          ? { ok: false, command, exitCode: 1, stdout: "", stderr: "type error" }
          : { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" };
      },
      postSummaryComment: async (summary) => {
        await noopAsync();
        commentCalls++;
        addressedSummary = summary.addressed;
      },
    });

    expect(result.outcome).toBe("published");
    expect(verificationCalls).toBe(2);
    expect(writableArtifacts).toHaveLength(2);
    expect(commentCalls).toBe(1);
    expect(addressedSummary).toEqual(["Fixed pass 2."]);
    const archivedFailure = path.join(result.context.revisionDir, "verification-before-fix-1.md");
    expect(existsSync(archivedFailure)).toBe(true);
    expect(await readFile(archivedFailure, "utf8")).toContain("type error");
    await run(["git", "ls-remote", "--exit-code", "origin", "feature/pr-12"], control);
  });

  test("review and verification repairs share the fix-pass budget", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    let calls = 0;
    let writableCalls = 0;
    let verificationCalls = 0;
    let commentCalls = 0;

    const result = await runPrRevision(options(control, { maxFixPasses: 1 }), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async (request) => {
        await noopAsync();
        calls++;
        if (request.fileEditingToolsEnabled) {
          writableCalls++;
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        if (calls === 3) return "# Revision Review\n\n## Verdict\nfixes-required\n\n## Required Fixes\n- Address reviewer feedback.\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => {
        await noopAsync();
        verificationCalls++;
        return { ok: false, command, exitCode: 1, stdout: "", stderr: "test failed" };
      },
      postSummaryComment: async () => {
        await noopAsync();
        commentCalls++;
      },
    });

    expect(result.outcome).toBe("verification-failed");
    expect(writableCalls).toBe(2);
    expect(verificationCalls).toBe(1);
    expect(commentCalls).toBe(1);
    expect(existsSync(path.join(result.context.revisionDir, "verification-before-fix-1.md"))).toBe(false);
    const metadata = JSON.parse(await readFile(path.join(result.context.revisionDir, "metadata.json"), "utf8")) as { verificationFailureReason: string };
    expect(metadata.verificationFailureReason).toContain("Verification failed after 1 fix passes");
  });

  test("successful isolated revision preserves the control checkout, uses configured remote, and excludes ignored run artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-isolated-"));
    const seed = path.join(root, "seed");
    const remote = path.join(root, "remote.git");
    const control = path.join(root, "control");
    const workspaceRoot = path.join(root, "workspaces");

    await mkdir(seed, { recursive: true });
    await run(["git", "init", "-b", "main"], seed);
    await run(["git", "config", "user.email", "roark@example.invalid"], seed);
    await run(["git", "config", "user.name", "Roark Test"], seed);
    await mkdir(path.join(seed, ".roark"), { recursive: true });
    await writeFile(path.join(seed, ".roark", ".gitignore"), "runs/\n", "utf8");
    await writeFile(path.join(seed, "README.md"), "main\n", "utf8");
    await run(["git", "add", "."], seed);
    await run(["git", "commit", "-m", "initial"], seed);
    await run(["git", "checkout", "-b", "feature/pr-12"], seed);
    await writeFile(path.join(seed, "feature.txt"), "feature\n", "utf8");
    await run(["git", "add", "feature.txt"], seed);
    await run(["git", "commit", "-m", "feature"], seed);
    await run(["git", "init", "--bare", remote], root);
    await run(["git", "remote", "add", "origin", remote], seed);
    await run(["git", "push", "origin", "main", "feature/pr-12"], seed);
    await run(["git", "clone", remote, control], root);
    await run(["git", "checkout", "main"], control);
    await run(["git", "remote", "add", "upstream", remote], control);

    const verificationCwds: string[] = [];
    const agentCwds: string[] = [];
    let calls = 0;

    const result = await runPrRevision(options(control, {
      remote: "upstream",
      workspace: { root: workspaceRoot, strategy: "clone", cloneRemote: "origin", clone: { filter: null, depth: null }, copyToWorktree: [] },
      hooks: { timeoutMs: 10_000, afterCreate: "git config user.email roark@example.invalid && git config user.name 'Roark Test'" },
    }), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      agentRunner: async (request) => {
        calls++;
        agentCwds.push(request.cwd);
        if (request.fileEditingToolsEnabled) {
          await writeFile(path.join(request.cwd, "fixed.txt"), "fixed in workspace\n", "utf8");
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n\n## Skipped Items\n- None.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command, cwd }) => {
        await noopAsync();
        verificationCwds.push(cwd);
        return { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" };
      },
      postSummaryComment: async () => { await noopAsync(); },
    });

    expect(result.outcome).toBe("published");
    expect((await runOutput(["git", "branch", "--show-current"], control)).trim()).toBe("main");
    expect(await Bun.file(path.join(control, "fixed.txt")).exists()).toBe(false);
    expect(agentCwds.every((cwd) => cwd === result.context.agentCwd)).toBe(true);
    expect(result.context.agentCwd).not.toBe(control);
    expect(verificationCwds).toEqual([result.context.agentCwd]);
    expect(await Bun.file(path.join(result.context.agentRevisionDir, "metadata.json")).exists()).toBe(true);

    const pushedTree = await runOutput(["git", "--git-dir", remote, "ls-tree", "-r", "--name-only", "feature/pr-12"], root);
    expect(pushedTree).toContain("fixed.txt");
    expect(pushedTree).not.toContain(".roark/runs/pr/12/revision-1/metadata.json");
    expect(pushedTree).not.toContain(".roark/runs");
  });

  test("successful verification commits, pushes, and comments once", async () => {
    await noopAsync();
    const control = await tempGitRepo();
    const remote = await mkdtemp(path.join(tmpdir(), "roark-pr-remote-"));
    await Bun.spawn(["git", "init", "--bare"], { cwd: remote }).exited;
    await run(["git", "remote", "add", "origin", remote], control);
    const { prepareWorkspace } = await isolatedWorkspace(async (workspace) => {
      await run(["git", "checkout", "-b", "feature/pr-12"], workspace);
    });
    let calls = 0;
    let commentCalls = 0;

    const result = await runPrRevision(options(control), {
      fetchFeedback: async () => (await noopAsync(), feedback()),
      prepareWorkspace,
      agentRunner: async (request) => {
        calls++;
        if (request.fileEditingToolsEnabled) {
          await Bun.write(path.join(request.cwd, "fixed.txt"), "fixed\n");
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n\n## Skipped Items\n- None.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => (await noopAsync(), ({ ok: true, command, exitCode: 0, stdout: "ok", stderr: "" })),
      postSummaryComment: async () => {
        await noopAsync();
        commentCalls++;
      },
    });

    expect(result.outcome).toBe("published");
    expect(commentCalls).toBe(1);
    expect(result.context.agentCwd).not.toBe(control);
    expect(await Bun.file(path.join(control, "fixed.txt")).exists()).toBe(false);
    const log = Bun.spawn(["git", "log", "--oneline", "-1"], { cwd: result.context.agentCwd, stdout: "pipe" });
    expect(await new Response(log.stdout).text()).toContain("roark: revise PR #12 (revision 1)");
    await run(["git", "ls-remote", "--exit-code", "origin", "feature/pr-12"], control);
  });
});
