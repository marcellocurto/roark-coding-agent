import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { RevisePrCliOptions } from "../cli/args.ts";
import type { PullRequestFeedback } from "../github/pr.ts";
import { runPrRevision } from "./workflow.ts";
import { tick } from "../test-utils/async.ts";

async function tempGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-pr-workflow-"));
  await Bun.spawn(["git", "init"], { cwd }).exited;
  await Bun.spawn(["git", "config", "user.email", "roark@example.invalid"], { cwd }).exited;
  await Bun.spawn(["git", "config", "user.name", "Roark Test"], { cwd }).exited;
  return cwd;
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
  test("no-action-needed writes artifacts without code mutation, push, or comment", async () => {
        await tick();
    const cwd = await tempGitRepo();
    let checkoutCalled = false;
    let commentCalled = false;

    const result = await runPrRevision(options(cwd), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await tick();
        checkoutCalled = true;
      },
      agentRunner: async () => (await tick(), "# Revision Plan\n\n## Status\nno-action-needed\n\n## Classified Feedback\n- None\n"),
      postSummaryComment: async () => {
        await tick();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(checkoutCalled).toBe(true);
    expect(commentCalled).toBe(false);
    expect(result.context.revisionDirRelative).toBe(".roark/runs/pr/12/revision-1");
  });

  test("non-published isolated revisions remove mirrored workspace artifacts", async () => {
    await tick();
    const control = await tempGitRepo();
    const workspace = await tempGitRepo();

    const result = await runPrRevision(options(control), {
      fetchFeedback: async () => (await tick(), feedback()),
      prepareWorkspace: async () => {
        await tick();
        return {
          path: workspace,
          metadata: { path: workspace, strategy: "clone", cloneRemote: "origin", createdNow: false },
          releaseLock: async () => { await Promise.resolve(); },
        };
      },
      agentRunner: async () => (await tick(), "# Revision Plan\n\n## Status\nno-action-needed\n\n## Classified Feedback\n- None\n"),
      postSummaryComment: async () => {
        await tick();
        throw new Error("summary comment should not be posted for no-action-needed");
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(await Bun.file(path.join(result.context.revisionDir, "metadata.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(result.context.agentRevisionDir, "metadata.json")).exists()).toBe(false);
    expect((await runOutput(["git", "status", "--porcelain"], workspace)).trim()).toBe("");
  });

  test("allocates revision after checking out the PR head branch", async () => {
        await tick();
    const cwd = await tempGitRepo();

    const result = await runPrRevision(options(cwd), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await mkdir(path.join(cwd, ".roark", "runs", "pr", "12", "revision-1"), { recursive: true });
      },
      agentRunner: async () => (await tick(), "# Revision Plan\n\n## Status\nno-action-needed\n"),
      postSummaryComment: async () => {
        await tick();
        throw new Error("summary comment should not be posted for no-action-needed");
      },
    });

    expect(result.outcome).toBe("no-action-needed");
    expect(result.context.revision).toBe(2);
    expect(result.context.revisionDirRelative).toBe(".roark/runs/pr/12/revision-2");
  });

  test("needs-human stops before writable implementation and posts one summary by default", async () => {
        await tick();
    const cwd = await tempGitRepo();
    const writableCalls: boolean[] = [];
    let commentCalled = false;

    const result = await runPrRevision(options(cwd), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await tick();},
      agentRunner: async (request) => {
        await tick();
        writableCalls.push(request.writable);
        return "# Revision Plan\n\n## Status\nneeds-human\n\n## Human Needs\n- Please decide.\n";
      },
      postSummaryComment: async () => {
        await tick();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("needs-human");
    expect(writableCalls).toEqual([false]);
    expect(commentCalled).toBe(true);
  });

  test("uses centralized thinking profiles for revision agents", async () => {
        await tick();
    const cwd = await tempGitRepo();
    const thinkingLevels: string[] = [];

    const result = await runPrRevision(options(cwd, { thinkingProfile: "fast" }), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await tick();},
      agentRunner: async (request) => {
        await tick();
        thinkingLevels.push(request.thinkingLevel);
        if (request.writable) return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n";
        if (thinkingLevels.length === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => (await tick(), ({ ok: false, command, exitCode: 127, stdout: "", stderr: "sh: missing-command: command not found" })),
      postSummaryComment: async () => {
        await tick();},
    });

    expect(result.outcome).toBe("verification-failed");
    expect(thinkingLevels).toEqual(["low", "low", "low"]);
  });

  test("non-repairable verification failure leaves revision unpublished without a fix pass", async () => {
        await tick();
    const cwd = await tempGitRepo();
    let commentCalled = false;
    let calls = 0;
    let writableCalls = 0;

    const result = await runPrRevision(options(cwd, { maxFixPasses: 3 }), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await tick();},
      agentRunner: async (request) => {
        await tick();
        calls++;
        if (request.writable) {
          writableCalls++;
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => (await tick(), ({ ok: false, command, exitCode: 127, stdout: "", stderr: "sh: missing-command: command not found" })),
      postSummaryComment: async () => {
        await tick();
        commentCalled = true;
      },
    });

    expect(result.outcome).toBe("verification-failed");
    expect(writableCalls).toBe(1);
    expect(commentCalled).toBe(true);
    expect(existsSync(path.join(result.context.revisionDir, "verification-before-fix-1.md"))).toBe(false);
  });

  test("repairable verification failure runs a fix pass, review, then publishes after verification passes", async () => {
        await tick();
    const cwd = await tempGitRepo();
    const remote = await mkdtemp(path.join(tmpdir(), "roark-pr-remote-"));
    await Bun.spawn(["git", "init", "--bare"], { cwd: remote }).exited;
    await run(["git", "remote", "add", "origin", remote], cwd);
    let calls = 0;
    let verificationCalls = 0;
    let commentCalls = 0;
    const writableArtifacts: string[] = [];

    const result = await runPrRevision(options(cwd, { maxFixPasses: 3 }), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await run(["git", "checkout", "-b", "feature/pr-12"], cwd);
      },
      agentRunner: async (request) => {
        await tick();
        calls++;
        if (request.writable) {
          writableArtifacts.push(request.prompt);
          await Bun.write(path.join(cwd, "fixed.txt"), `fixed ${writableArtifacts.length}\n`);
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n\n## Skipped Items\n- None.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => {
        await tick();
        verificationCalls++;
        return verificationCalls === 1
          ? { ok: false, command, exitCode: 1, stdout: "", stderr: "type error" }
          : { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" };
      },
      postSummaryComment: async () => {
        await tick();
        commentCalls++;
      },
    });

    expect(result.outcome).toBe("published");
    expect(verificationCalls).toBe(2);
    expect(writableArtifacts).toHaveLength(2);
    expect(commentCalls).toBe(1);
    const archivedFailure = path.join(result.context.revisionDir, "verification-before-fix-1.md");
    expect(existsSync(archivedFailure)).toBe(true);
    expect(await readFile(archivedFailure, "utf8")).toContain("type error");
    await run(["git", "ls-remote", "--exit-code", "origin", "feature/pr-12"], cwd);
  });

  test("review and verification repairs share the fix-pass budget", async () => {
        await tick();
    const cwd = await tempGitRepo();
    let calls = 0;
    let writableCalls = 0;
    let verificationCalls = 0;
    let commentCalls = 0;

    const result = await runPrRevision(options(cwd, { maxFixPasses: 1 }), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await tick();},
      agentRunner: async (request) => {
        await tick();
        calls++;
        if (request.writable) {
          writableCalls++;
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        if (calls === 3) return "# Revision Review\n\n## Verdict\nfixes-required\n\n## Required Fixes\n- Address reviewer feedback.\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => {
        await tick();
        verificationCalls++;
        return { ok: false, command, exitCode: 1, stdout: "", stderr: "test failed" };
      },
      postSummaryComment: async () => {
        await tick();
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

  test("successful isolated revision preserves the control checkout, uses configured remote, and force-adds ignored run artifacts", async () => {
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
      fetchFeedback: async () => (await tick(), feedback()),
      agentRunner: async (request) => {
        calls++;
        agentCwds.push(request.cwd);
        if (request.writable) {
          await writeFile(path.join(request.cwd, "fixed.txt"), "fixed in workspace\n", "utf8");
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n\n## Skipped Items\n- None.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command, cwd }) => {
        await tick();
        verificationCwds.push(cwd);
        return { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" };
      },
      postSummaryComment: async () => { await tick(); },
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
    expect(pushedTree).toContain(".roark/runs/pr/12/revision-1/metadata.json");
  });

  test("successful verification commits, pushes, and comments once", async () => {
        await tick();
    const cwd = await tempGitRepo();
    const remote = await mkdtemp(path.join(tmpdir(), "roark-pr-remote-"));
    await Bun.spawn(["git", "init", "--bare"], { cwd: remote }).exited;
    await run(["git", "remote", "add", "origin", remote], cwd);
    let calls = 0;
    let commentCalls = 0;

    const result = await runPrRevision(options(cwd), {
      fetchFeedback: async () => (await tick(), feedback()),
      checkout: async () => {
        await run(["git", "checkout", "-b", "feature/pr-12"], cwd);
      },
      agentRunner: async (request) => {
        calls++;
        if (request.writable) {
          await Bun.write(path.join(cwd, "fixed.txt"), "fixed\n");
          return "# Revision Log\n\n## Addressed Must Fix Current Items\n- Fixed required item.\n\n## Skipped Items\n- None.\n";
        }
        if (calls === 1) return "# Revision Plan\n\n## Status\nrevise\n";
        return "# Revision Review\n\n## Verdict\napprove\n";
      },
      verificationRunner: async ({ command }) => (await tick(), ({ ok: true, command, exitCode: 0, stdout: "ok", stderr: "" })),
      postSummaryComment: async () => {
        await tick();
        commentCalls++;
      },
    });

    expect(result.outcome).toBe("published");
    expect(commentCalls).toBe(1);
    const log = Bun.spawn(["git", "log", "--oneline", "-1"], { cwd, stdout: "pipe" });
    expect(await new Response(log.stdout).text()).toContain("roark: revise PR #12 (revision 1)");
    await run(["git", "ls-remote", "--exit-code", "origin", "feature/pr-12"], cwd);
  });
});
