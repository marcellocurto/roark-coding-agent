import {
  Schema,
  Scope,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
} from "effect";
import {
  type ProcessResult,
  runProcessOrThrow,
  runProcess,
  type ProcessOptions,
} from "../cli/process.ts";
import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import { rejects as assertRejects } from "node:assert/strict";
import { Workspace } from "./workspace-service.ts";
import { fixedWallClock } from "../testing/clock.ts";
import { existsSync } from "node:fs";
import * as nativeWorkspace from "./workspace.ts";
import { Presentation } from "../runtime/services.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import { Presenter } from "../presentation/presenter.ts";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
  runLifecycleHook,
  sanitizeWorkspaceSegment,
  workspacePathForIssue,
  workspacePathForPrRevision,
  workspaceStateFile,
} from "./workspace.ts";
import { type TerminalStream } from "../presentation/terminal.ts";
const ok = (stdout = ""): Awaited<ReturnType<TestProcessRunner>> => ({
  stdout,
  stderr: "",
  exitCode: 0,
});
const fail = (stderr = "failed"): Awaited<ReturnType<TestProcessRunner>> => ({
  stdout: "",
  stderr,
  exitCode: 1,
});
describe("managed clone workspaces", () => {
  test("computes sanitized issue and PR revision workspace paths inside the configured root", () => {
    const workspacePath = workspacePathForIssue({
      root: "/tmp/roark-root",
      repo: "Owner/Repo.Name",
      issueNumber: 207,
    });
    expect(workspacePath).toBe(
      path.resolve("/tmp/roark-root/owner-repo.name/issue-207"),
    );
    expect(
      workspacePathForPrRevision({
        root: "/tmp/roark-root",
        repo: "Owner/Repo.Name",
        prNumber: 12,
      }),
    ).toBe(path.resolve("/tmp/roark-root/owner-repo.name/pr-12"));
    expect(sanitizeWorkspaceSegment("../Bad Value!")).toBe("bad-value");
  });
  test("rejects workspace path escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-root-"));
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.assertWorkspacePathSafe({
          root,
          workspacePath: path.join(root, "../escape"),
        }),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("must stay inside"),
    );
  });
  test("resolves remote names and preflights the resulting URL", async () => {
    await Promise.resolve();
    const calls: string[][] = [];
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      calls.push(args);
      if (args.join(" ") === "git remote get-url upstream")
        return ok("git@github.com:owner/repo.git\n");
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      return fail();
    };
    expect(
      runApplicationPromise(
        nativeWorkspace.resolveCloneRemote({
          cwd: "/repo",
          cloneRemote: "upstream",
          runner: adaptRunner(runner),
        }),
      ),
    ).resolves.toEqual({
      remote: "upstream",
      url: "git@github.com:owner/repo.git",
    });
    expect(calls).toEqual([
      ["git", "remote", "get-url", "upstream"],
      ["git", "ls-remote", "git@github.com:owner/repo.git", "HEAD"],
    ]);
  });
  test("resolves a PR review clone from the requested repository instead of the control checkout", async () => {
    await Promise.resolve();
    const calls: string[][] = [];
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      calls.push(args);
      return args.join(" ") ===
        "git ls-remote https://github.com/target/repo HEAD"
        ? ok("abc\tHEAD\n")
        : fail(`unexpected command: ${args.join(" ")}`);
    };
    expect(
      runApplicationPromise(
        nativeWorkspace.resolvePrReviewCloneRemote({
          cwd: "/unrelated-control-checkout",
          repo: "target/repo",
          repositoryUrl: "https://github.com/target/repo",
          runner: adaptRunner(runner),
        }),
      ),
    ).resolves.toEqual({
      remote: "origin",
      url: "https://github.com/target/repo",
    });
    expect(calls).toEqual([
      ["git", "ls-remote", "https://github.com/target/repo", "HEAD"],
    ]);
  });
  test("existing legacy lock directory does not block workspace preparation", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-workspace-stale-lock-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 75,
    });
    await mkdir(`${workspacePath}.lock`, { recursive: true });
    const runner: TestProcessRunner = async (args) => {
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      return ok();
    };
    const prepared = await runApplicationPromise(
      nativeWorkspace.prepareCloneWorkspace({
        controlCwd: root,
        repo: "owner/repo",
        issueNumber: 75,
        plan: {
          issueNumber: 75,
          branchName: "roark/issue-75",
          baseBranch: "main",
        },
        workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
        hooks: defaultLifecycleHooks,
        mode: "auto",
        runner: adaptRunner(runner),
      }),
    );
    expect(prepared.path).toBe(workspacePath);
    expect((await lstat(`${workspacePath}.lock`)).isDirectory()).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
  test("reused issue clone workspace does not merge or stash a moved origin base", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-workspace-no-base-sync-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 77,
    });
    await mkdir(path.join(workspacePath, ".git"), { recursive: true });
    const calls: string[][] = [];
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "rev-parse") return ok("true\n");
      if (args[0] === "git" && args[1] === "branch")
        return ok("roark/issue-77\n");
      if (
        args[0] === "git" &&
        ["fetch", "merge", "stash"].includes(args[1] ?? "")
      )
        return fail(`${args[1] ?? "git command"} should not run`);
      return ok();
    };
    const prepared = await runApplicationPromise(
      nativeWorkspace.prepareCloneWorkspace({
        controlCwd: root,
        repo: "owner/repo",
        issueNumber: 77,
        plan: {
          issueNumber: 77,
          branchName: "roark/issue-77",
          baseBranch: "main",
        },
        workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
        hooks: defaultLifecycleHooks,
        mode: "continue",
        runner: adaptRunner(runner),
      }),
    );
    expect(prepared.path).toBe(workspacePath);
    expect(
      calls.some(
        (args) =>
          args[0] === "git" &&
          ["fetch", "merge", "stash"].includes(args[1] ?? ""),
      ),
    ).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("legacy lock sidecars are not listed and are removed with workspaces", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-workspace-legacy-lock-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 76,
    });
    const prWorkspacePath = workspacePathForPrRevision({
      root: workspaceRoot,
      repo: "owner/repo",
      prNumber: 98,
    });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(prWorkspacePath, { recursive: true });
    await mkdir(`${workspacePath}.lock`, { recursive: true });
    await mkdir(`${prWorkspacePath}.lock`, { recursive: true });
    expect(
      await runApplicationPromise(
        nativeWorkspace.listWorkspaces({
          workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
          repo: "owner/repo",
        }),
      ),
    ).toEqual([workspacePath, prWorkspacePath].toSorted());
    await runApplicationPromise(
      nativeWorkspace.removeWorkspace({
        workspacePath,
        force: true,
        hooks: defaultLifecycleHooks,
      }),
    );
    expect(Bun.file(workspacePath).exists()).resolves.toBe(false);
    expect(Bun.file(`${workspacePath}.lock`).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("remove resolves PR revision workspaces", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-pr-workspace-remove-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForPrRevision({
      root: workspaceRoot,
      repo: "owner/repo",
      prNumber: 98,
    });
    await mkdir(workspacePath, { recursive: true });
    await runApplicationPromise(
      nativeWorkspace.runRemoveCommand({
        command: "remove",
        targets: [{ kind: "pr", number: 98 }],
        cwd: root,
        repo: "owner/repo",
        force: true,
        workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
        hooks: defaultLifecycleHooks,
      }),
    );
    expect(Bun.file(workspacePath).exists()).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("managed workspace discovery preserves target identity for interactive selection", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-workspace-select-remove-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const issuePath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 12,
    });
    const prPath = workspacePathForPrRevision({
      root: workspaceRoot,
      repo: "owner/repo",
      prNumber: 34,
    });
    await mkdir(issuePath, { recursive: true });
    await mkdir(prPath, { recursive: true });
    expect(
      await runApplicationPromise(
        nativeWorkspace.listManagedWorkspaces({
          workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
          repo: "owner/repo",
          cwd: root,
        }),
      ),
    ).toEqual([
      { path: issuePath, target: { kind: "issue" as const, number: 12 } },
      { path: prPath, target: { kind: "pr" as const, number: 34 } },
    ]);
    await rm(root, { recursive: true, force: true });
  });
  test("batch removal preflights dirty workspaces before deleting any selection", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-workspace-remove-preflight-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const cleanPath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 12,
    });
    const dirtyPath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 34,
    });
    await mkdir(cleanPath, { recursive: true });
    await mkdir(dirtyPath, { recursive: true });
    await runApplicationPromise(
      runProcessOrThrow(["git", "init"], { cwd: cleanPath }),
    );
    await runApplicationPromise(
      runProcessOrThrow(["git", "init"], { cwd: dirtyPath }),
    );
    await writeFile(path.join(dirtyPath, "recoverable.txt"), "keep me\n");
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.runRemoveCommand({
          command: "remove",
          targets: [
            { kind: "issue", number: 12 },
            { kind: "issue", number: 34 },
          ],
          cwd: root,
          repo: "owner/repo",
          force: false,
          workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
          hooks: defaultLifecycleHooks,
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Refusing to remove dirty workspace"),
    );
    expect(lstat(cleanPath)).resolves.toBeDefined();
    expect(lstat(dirtyPath)).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });
  test("direct removal fails clearly when a managed workspace does not exist", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-workspace-remove-missing-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const missingPath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 404,
    });
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.runRemoveCommand({
          command: "remove",
          targets: [{ kind: "issue", number: 404 }],
          cwd: root,
          repo: "owner/repo",
          force: false,
          workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
          hooks: defaultLifecycleHooks,
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`Managed workspace not found:\n${missingPath}`),
    );
    await rm(root, { recursive: true, force: true });
  });
  test("fatal afterCreate hook poisons a fresh workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-poison-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 74,
    });
    const calls: string[][] = [];
    const runner: TestProcessRunner = async (args, options) => {
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      if (args[0] === "git" && ["fetch", "checkout"].includes(args[1] ?? ""))
        return ok();
      if (args[0] === "sh") return fail("install failed");
      return ok(options?.cwd ?? "");
    };
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.prepareCloneWorkspace({
          controlCwd: root,
          repo: "owner/repo",
          issueNumber: 74,
          plan: {
            issueNumber: 74,
            branchName: "roark/issue-74",
            baseBranch: "main",
          },
          workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
          hooks: { ...defaultLifecycleHooks, afterCreate: "false" },
          mode: "auto",
          runner: adaptRunner(runner),
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("afterCreate hook failed"),
    );
    const state = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ hook: Schema.String, stderrTail: Schema.String }),
      ),
    )(await readFile(path.join(workspacePath, workspaceStateFile), "utf8"));
    expect(state.hook).toBe("afterCreate");
    expect(state.stderrTail).toContain("install failed");
    await rm(root, { recursive: true, force: true });
  });
  test("does not poison a new review workspace when the PR head changes during setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-review-race-"));
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForPrRevision({
      root: workspaceRoot,
      repo: "owner/repo",
      prNumber: 12,
    });
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      if (args[0] === "git" && args[1] === "fetch") return ok();
      if (
        args[0] === "git" &&
        args[1] === "cat-file" &&
        args[3] === "old-head^{commit}"
      )
        return fail("old head is unavailable");
      if (args[0] === "git" && args[1] === "cat-file") return ok();
      if (args[0] === "git" && args[1] === "rev-parse") return ok("new-head\n");
      return fail(`unexpected command: ${args.join(" ")}`);
    };
    await assertRejects(
      preparePrReviewWorkspace({
        controlCwd: root,
        repo: "owner/repo",
        prNumber: 12,
        baseRefName: "main",
        baseRefOid: "base-head",
        headRefOid: "old-head",
        workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
        hooks: defaultLifecycleHooks,
        runner,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "changed while its review workspace was prepared",
        ),
    );
    expect(
      Bun.file(path.join(workspacePath, workspaceStateFile)).exists(),
    ).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("reused PR revision workspace refuses to reset unpushed local commits", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-pr-workspace-unpushed-"),
    );
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForPrRevision({
      root: workspaceRoot,
      repo: "owner/repo",
      prNumber: 12,
    });
    await mkdir(path.join(workspacePath, ".git"), { recursive: true });
    const calls: string[][] = [];
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "rev-parse") return ok("true\n");
      if (args[0] === "git" && args[1] === "status") return ok("");
      if (args[0] === "git" && args[1] === "fetch") return ok();
      if (args[0] === "git" && args[1] === "show-ref") return ok();
      if (args[0] === "git" && args[1] === "rev-list") return ok("1\n");
      if (args[0] === "git" && args[1] === "checkout")
        return fail("checkout should not run");
      return ok();
    };
    let error: unknown;
    try {
      await preparePrRevisionWorkspace({
        controlCwd: root,
        repo: "owner/repo",
        prNumber: 12,
        headRefName: "feature/pr-12",
        workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
        hooks: defaultLifecycleHooks,
        runner,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain(
      "unpushed local commit",
    );
    expect(
      calls.some((args) => args[0] === "git" && args[1] === "checkout"),
    ).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("PR revision workspace preparation creates and releases a lock", async () => {
    const fixture = await createPrRevisionWorkspaceFixture(
      "roark-pr-workspace-lock-",
    );
    let prepared:
      | Awaited<ReturnType<typeof preparePrRevisionWorkspace>>
      | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);
      const owner = await readWorkspaceLockOwner(fixture.lockDir);
      expect((await lstat(fixture.lockDir)).isDirectory()).toBe(true);
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.token).toBe("string");
      expect(owner.token).not.toBe("");
      expect(Number.isNaN(Date.parse(String(owner.createdAt)))).toBe(false);
      await prepared.releaseLock();
      prepared = undefined;
      expect(await Bun.file(fixture.lockDir).exists()).toBe(false);
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test.each([
    { ageMs: 4999, reclaimed: false },
    { ageMs: 5000, reclaimed: true },
  ])(
    "PR revision workspace ownerless lock at $ageMs ms is reclaimed=$reclaimed",
    async ({ ageMs, reclaimed }) => {
      const fixture = await createPrRevisionWorkspaceFixture(
        "roark-pr-workspace-ownerless-",
      );
      try {
        await mkdir(fixture.lockDir, { recursive: true });
        const createdAt = new Date("2000-01-01T00:00:00.000Z");
        await utimes(fixture.lockDir, createdAt, createdAt);
        const exit = await runApplicationPromise(
          Effect.gen(function* () {
            yield* nativeWorkspace.preparePrRevisionWorkspace({
              ...fixture.prepareInput,
              runner: adaptRunner(fixture.prepareInput.runner),
            });
            const owner = yield* Effect.promise(() =>
              readWorkspaceLockOwner(fixture.lockDir),
            );
            expect(owner.pid).toBe(process.pid);
            expect(owner.token).toBeString();
          }).pipe(
            Effect.scoped,
            Effect.provide(
              fixedWallClock(
                new Date(createdAt.getTime() + ageMs).toISOString(),
              ),
            ),
            Effect.exit,
          ),
        );
        expect(Exit.isSuccess(exit)).toBe(reclaimed);
        if (!reclaimed && Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(
            nativeWorkspace.WorkspaceError,
          );
          expect(Cause.pretty(exit.cause)).toContain("already locked");
        }
        expect(existsSync(fixture.lockDir)).toBe(!reclaimed);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );
  test("PR revision workspace preparation refuses an active lock even when its directory is old", async () => {
    const fixture = await createPrRevisionWorkspaceFixture(
      "roark-pr-workspace-active-lock-",
    );
    let prepared:
      | Awaited<ReturnType<typeof preparePrRevisionWorkspace>>
      | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);
      const old = new Date("2000-01-01T00:00:00.000Z");
      await utimes(fixture.lockDir, old, old);
      let error: unknown;
      try {
        await preparePrRevisionWorkspace(fixture.prepareInput);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "already locked",
      );
      expect((await lstat(fixture.lockDir)).isDirectory()).toBe(true);
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("PR revision workspace release preserves a replacement owner's lock", async () => {
    const fixture = await createPrRevisionWorkspaceFixture(
      "roark-pr-workspace-replaced-lock-",
    );
    let prepared:
      | Awaited<ReturnType<typeof preparePrRevisionWorkspace>>
      | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);
      const replacementOwner = {
        token: "replacement-token",
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
      };
      await writeFile(
        path.join(fixture.lockDir, "owner.json"),
        JSON.stringify(replacementOwner),
      );
      await prepared.releaseLock();
      prepared = undefined;
      expect(existsSync(fixture.lockDir)).toBe(true);
      expect(await readWorkspaceLockOwner(fixture.lockDir)).toEqual(
        replacementOwner,
      );
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("PR revision workspace preparation replaces stale locks", async () => {
    const fixture = await createPrRevisionWorkspaceFixture(
      "roark-pr-workspace-stale-lock-",
    );
    await mkdir(fixture.lockDir, { recursive: true });
    const staleOwner = {
      token: "stale-token",
      pid: findDeadPid(),
      createdAt: "2000-01-01T00:00:00.000Z",
    };
    await writeFile(
      path.join(fixture.lockDir, "owner.json"),
      JSON.stringify(staleOwner),
      "utf8",
    );
    let prepared:
      | Awaited<ReturnType<typeof preparePrRevisionWorkspace>>
      | undefined;
    try {
      prepared = await preparePrRevisionWorkspace(fixture.prepareInput);
      const owner = await readWorkspaceLockOwner(fixture.lockDir);
      expect(owner.token).not.toBe("stale-token");
      expect(owner.pid).toBe(process.pid);
      await prepared.releaseLock();
      prepared = undefined;
      expect(await Bun.file(fixture.lockDir).exists()).toBe(false);
    } finally {
      await prepared?.releaseLock();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("PR revision workspace preparation releases its lock on failure", async () => {
    const fixture = await createPrRevisionWorkspaceFixture(
      "roark-pr-workspace-failed-lock-",
    );
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${fixture.root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return fail("remote unavailable");
      return fail("unexpected command");
    };
    try {
      let error: unknown;
      try {
        await preparePrRevisionWorkspace({ ...fixture.prepareInput, runner });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "Unable to access clone remote",
      );
      expect(await Bun.file(fixture.lockDir).exists()).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  test("copies ignored host paths recursively, dereferences symlinks, preserves modes, and removes stale destinations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-worktree-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(path.join(control, ".secrets", "env"), { recursive: true });
    await mkdir(path.join(control, ".secrets", "real-dir"), {
      recursive: true,
    });
    await writeFile(
      path.join(control, ".secrets", "env", "local.env"),
      "secret=1\n",
      "utf8",
    );
    await chmod(path.join(control, ".secrets", "env", "local.env"), 0o600);
    await writeFile(
      path.join(control, ".secrets", "env", "target.txt"),
      "linked file\n",
      "utf8",
    );
    await writeFile(
      path.join(control, ".secrets", "real-dir", "nested.txt"),
      "linked dir\n",
      "utf8",
    );
    await symlink(
      "target.txt",
      path.join(control, ".secrets", "env", "link.txt"),
    );
    await symlink(
      "../real-dir",
      path.join(control, ".secrets", "env", "linkdir"),
    );
    await initGitRepo(worktree, ".secrets/env\n");
    await mkdir(path.join(worktree, ".secrets", "env"), { recursive: true });
    await writeFile(
      path.join(worktree, ".secrets", "env", "stale.txt"),
      "stale\n",
      "utf8",
    );
    await runApplicationPromise(
      nativeWorkspace.refreshCopyToWorktree({
        controlCwd: control,
        worktreePath: worktree,
        copyToWorktree: [".secrets/env"],
        runner: adaptRunner(undefined),
      }),
    );
    expect(
      await readFile(
        path.join(worktree, ".secrets", "env", "local.env"),
        "utf8",
      ),
    ).toBe("secret=1\n");
    expect(
      (await stat(path.join(worktree, ".secrets", "env", "local.env"))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      await readFile(
        path.join(worktree, ".secrets", "env", "link.txt"),
        "utf8",
      ),
    ).toBe("linked file\n");
    expect(
      (
        await lstat(path.join(worktree, ".secrets", "env", "link.txt"))
      ).isSymbolicLink(),
    ).toBe(false);
    expect(
      await readFile(
        path.join(worktree, ".secrets", "env", "linkdir", "nested.txt"),
        "utf8",
      ),
    ).toBe("linked dir\n");
    expect(
      Bun.file(path.join(worktree, ".secrets", "env", "stale.txt")).exists(),
    ).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("copyToWorktree rejects symlink destination parents before removing or copying", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-copy-symlink-parent-"),
    );
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    await mkdir(path.join(control, ".secrets", "env"), { recursive: true });
    await writeFile(
      path.join(control, ".secrets", "env", "local.env"),
      "secret=1\n",
      "utf8",
    );
    await initGitRepo(worktree, ".secrets/env\n");
    await mkdir(path.join(outside, "env"), { recursive: true });
    await writeFile(
      path.join(outside, "env", "stale.txt"),
      "outside stale\n",
      "utf8",
    );
    await symlink(outside, path.join(worktree, ".secrets"));
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.refreshCopyToWorktree({
          controlCwd: control,
          worktreePath: worktree,
          copyToWorktree: [".secrets/env"],
          runner: adaptRunner(undefined),
        }),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("destination parent"),
    );
    expect(await readFile(path.join(outside, "env", "stale.txt"), "utf8")).toBe(
      "outside stale\n",
    );
    expect(
      Bun.file(path.join(outside, "env", "local.env")).exists(),
    ).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });
  test("copyToWorktree fails before writing when a source is missing or destination is not ignored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-preflight-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, "ignored"), "copy me\n", "utf8");
    await initGitRepo(worktree, "ignored\nmissing\n");
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.refreshCopyToWorktree({
          controlCwd: control,
          worktreePath: worktree,
          copyToWorktree: ["ignored", "missing"],
          runner: adaptRunner(undefined),
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("source 'missing' is missing"),
    );
    expect(Bun.file(path.join(worktree, "ignored")).exists()).resolves.toBe(
      false,
    );
    await writeFile(path.join(worktree, "ignored"), "stale\n", "utf8");
    await initGitRepo(worktree, "");
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.refreshCopyToWorktree({
          controlCwd: control,
          worktreePath: worktree,
          copyToWorktree: ["ignored"],
          runner: adaptRunner(undefined),
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("destination must be ignored"),
    );
    expect(await readFile(path.join(worktree, "ignored"), "utf8")).toBe(
      "stale\n",
    );
    await rm(root, { recursive: true, force: true });
  });
  test("copyToWorktree fails when copied content is visible to Git after copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-status-"));
    const control = path.join(root, "control");
    const worktree = path.join(root, "worktree");
    await mkdir(control, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(control, "visible"), "copy me\n", "utf8");
    const runner: TestProcessRunner = async (args) => {
      await Promise.resolve();
      if (args[1] === "check-ignore") return ok();
      if (args[1] === "status") return ok("?? visible\n");
      return ok();
    };
    await assertRejects(
      runApplicationPromise(
        nativeWorkspace.refreshCopyToWorktree({
          controlCwd: control,
          worktreePath: worktree,
          copyToWorktree: ["visible"],
          runner: adaptRunner(runner),
        }),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("visible to Git"),
    );
    await rm(root, { recursive: true, force: true });
  });
  test("copies configured paths before afterCreate hooks run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-copy-after-create-"));
    const control = path.join(root, "control");
    const workspaceRoot = path.join(root, "managed");
    const workspacePath = workspacePathForIssue({
      root: workspaceRoot,
      repo: "owner/repo",
      issueNumber: 88,
    });
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, "local.env"), "ready\n", "utf8");
    const calls: string[][] = [];
    const runner: TestProcessRunner = async (args) => {
      calls.push(args);
      if (args[0] === "git" && args[1] === "remote")
        return ok(`${root}/remote.git\n`);
      if (args[0] === "git" && args[1] === "ls-remote")
        return ok("abc\tHEAD\n");
      if (args[0] === "git" && args[1] === "clone") {
        await mkdir(path.join(workspacePath, ".git"), { recursive: true });
        return ok();
      }
      if (args[0] === "git" && ["fetch", "checkout"].includes(args[1] ?? ""))
        return ok();
      if (args[0] === "git" && args[1] === "check-ignore") return ok();
      if (args[0] === "git" && args[1] === "status") return ok();
      if (args[0] === "sh")
        return (await Bun.file(path.join(workspacePath, "local.env")).exists())
          ? ok()
          : fail("missing local.env");
      return ok();
    };
    await runApplicationPromise(
      nativeWorkspace.prepareCloneWorkspace({
        controlCwd: control,
        repo: "owner/repo",
        issueNumber: 88,
        plan: {
          issueNumber: 88,
          branchName: "roark/issue-88",
          baseBranch: "main",
        },
        workspace: {
          ...defaultWorkspaceConfig,
          root: workspaceRoot,
          copyToWorktree: ["local.env"],
        },
        hooks: { ...defaultLifecycleHooks, afterCreate: "test -f local.env" },
        mode: "auto",
        runner: adaptRunner(runner),
      }),
    );
    expect(calls.some((args) => args[0] === "sh")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
  test("non-fatal afterRun hook warns through sanitized redirected output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-workspace-hook-"));
    await writeFile(path.join(root, "file"), "ok");
    let output = "";
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        output += chunk;
      },
    };
    return runWithPresenter(
      new Presenter({ stream, errorStream: stream }),
      Effect.gen(function* () {
        const hook = yield* Effect.forkScoped(
          nativeWorkspace.runLifecycleHook(
            "afterRun",
            { timeoutMs: 1000, afterRun: "hostile\u001b]0;owned\rcommand" },
            root,
            adaptRunner(() => Promise.resolve(fail("after\nfailed\u0007"))),
          ),
        );
        yield* Fiber.join(hook);
        expect(output).toContain("WARNING afterRun hook failed");
        expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => rm(root, { recursive: true, force: true })),
        ),
      ),
    );
  });
  test("pins a PR pull ref, repairs its origin, and compares merge-base to head without mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roark-pr-review-pinned-"));
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    await initGitRepo(source, ".roark\n");
    const initial = (
      await runApplicationPromise(
        runProcessOrThrow(["git", "rev-parse", "HEAD"], {
          cwd: source,
        }),
      )
    ).trim();
    await runApplicationPromise(
      runProcessOrThrow(["git", "checkout", "-b", "contributor/change"], {
        cwd: source,
      }),
    );
    await writeFile(path.join(source, "feature.txt"), "feature\n", "utf8");
    await runApplicationPromise(
      runProcessOrThrow(["git", "add", "feature.txt"], {
        cwd: source,
      }),
    );
    await runApplicationPromise(
      runProcessOrThrow(["git", "commit", "-m", "feature"], {
        cwd: source,
      }),
    );
    const headOid = (
      await runApplicationPromise(
        runProcessOrThrow(["git", "rev-parse", "HEAD"], {
          cwd: source,
        }),
      )
    ).trim();
    await runApplicationPromise(
      runProcessOrThrow(["git", "checkout", "main"], {
        cwd: source,
      }),
    );
    await writeFile(
      path.join(source, "base-only.txt"),
      "base advance\n",
      "utf8",
    );
    await runApplicationPromise(
      runProcessOrThrow(["git", "add", "base-only.txt"], {
        cwd: source,
      }),
    );
    await runApplicationPromise(
      runProcessOrThrow(["git", "commit", "-m", "advance base"], {
        cwd: source,
      }),
    );
    const baseOid = (
      await runApplicationPromise(
        runProcessOrThrow(["git", "rev-parse", "HEAD"], {
          cwd: source,
        }),
      )
    ).trim();
    await runApplicationPromise(
      runProcessOrThrow(["git", "clone", "--bare", source, remote], {
        cwd: root,
      }),
    );
    await runApplicationPromise(
      runProcessOrThrow(["git", "update-ref", "refs/pull/12/head", headOid], {
        cwd: remote,
      }),
    );
    await runApplicationPromise(
      runProcessOrThrow(
        ["git", "remote", "add", "origin", `file://${remote}`],
        { cwd: source },
      ),
    );
    const calls: string[][] = [];
    const prepared = await preparePrReviewWorkspace({
      controlCwd: source,
      repo: "owner/repo",
      repositoryUrl: `file://${remote}`,
      prNumber: 12,
      baseRefName: "main",
      baseRefOid: baseOid,
      headRefOid: headOid,
      workspace: {
        ...defaultWorkspaceConfig,
        root: path.join(root, "managed"),
        clone: { ...defaultWorkspaceConfig.clone, depth: 1 },
      },
      hooks: defaultLifecycleHooks,
      runner: async (args, options) => {
        calls.push(args);
        return runApplicationPromise(runProcess(args, options));
      },
    });
    expect(prepared.comparison.mergeBaseOid).toBe(initial);
    expect(prepared.comparison.changedFiles).toEqual(["feature.txt"]);
    expect(prepared.comparison.inspectionCommand).toBe(
      `git diff ${initial}..${headOid} --`,
    );
    expect(
      (
        await runApplicationPromise(
          runProcessOrThrow(["git", "rev-parse", "HEAD"], {
            cwd: prepared.path,
          }),
        )
      ).trim(),
    ).toBe(headOid);
    expect(
      calls.some(
        (args) =>
          args[0] === "git" && args[1] === "fetch" && args[2] === "--unshallow",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (args) =>
          args[0] === "git" && ["commit", "push"].includes(args[1] ?? ""),
      ),
    ).toBe(false);
    await prepared.releaseLock();
    await runApplicationPromise(
      runProcessOrThrow(
        ["git", "remote", "set-url", "origin", `file://${source}`],
        { cwd: prepared.path },
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const workspaces = yield* Workspace;
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reused = yield* workspaces.preparePrReview({
              controlCwd: source,
              repo: "owner/repo",
              repositoryUrl: `file://${remote}`,
              prNumber: 12,
              baseRefName: "main",
              baseRefOid: baseOid,
              headRefOid: headOid,
              workspace: {
                ...defaultWorkspaceConfig,
                root: path.join(root, "managed"),
              },
              hooks: defaultLifecycleHooks,
            });
            expect(yield* fs.exists(`${reused.path}.lock`)).toBe(true);
            yield* fs.writeFileString(
              path.join(reused.path, "unexpected.txt"),
              "mutation\n",
            );
            const checked = yield* Effect.exit(
              workspaces.assertPinnedReview({ cwd: reused.path, headOid }),
            );
            expect(Exit.isFailure(checked)).toBe(true);
            if (Exit.isFailure(checked)) {
              expect(Cause.hasFails(checked.cause)).toBe(true);
              expect(Cause.pretty(checked.cause)).toContain(
                "changed during inspection",
              );
            }
          }),
        );
        // The application Layer is still alive: only the review scope has closed.
        expect(yield* fs.exists(`${prepared.path}.lock`)).toBe(false);
      }).pipe(Effect.provide(applicationLayer)),
    );
    await rm(root, { recursive: true, force: true });
  }, 15000);
});
async function createPrRevisionWorkspaceFixture(prefix: string): Promise<{
  root: string;
  lockDir: string;
  prepareInput: Parameters<typeof preparePrRevisionWorkspace>[0];
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const workspaceRoot = path.join(root, "managed");
  const workspacePath = workspacePathForPrRevision({
    root: workspaceRoot,
    repo: "owner/repo",
    prNumber: 12,
  });
  const runner: TestProcessRunner = async (args) => {
    await Promise.resolve();
    if (args[0] === "git" && args[1] === "remote")
      return ok(`${root}/remote.git\n`);
    if (args[0] === "git" && args[1] === "ls-remote") return ok("abc\tHEAD\n");
    if (args[0] === "git" && args[1] === "clone") {
      await mkdir(path.join(workspacePath, ".git"), { recursive: true });
      return ok();
    }
    if (args[0] === "git" && args[1] === "fetch") return ok();
    if (args[0] === "git" && args[1] === "show-ref")
      return fail("branch missing");
    if (args[0] === "git" && args[1] === "checkout") return ok();
    return fail(`unexpected command: ${args.join(" ")}`);
  };
  return {
    root,
    lockDir: `${workspacePath}.lock`,
    prepareInput: {
      controlCwd: root,
      repo: "owner/repo",
      prNumber: 12,
      headRefName: "feature/pr-12",
      workspace: { ...defaultWorkspaceConfig, root: workspaceRoot },
      hooks: defaultLifecycleHooks,
      runner,
    },
  };
}
async function readWorkspaceLockOwner(lockDir: string): Promise<{
  token?: unknown;
  pid?: unknown;
  createdAt?: unknown;
}> {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        token: Schema.optional(Schema.Unknown),
        pid: Schema.optional(Schema.Unknown),
        createdAt: Schema.optional(Schema.Unknown),
      }),
    ),
  )(await readFile(path.join(lockDir, "owner.json"), "utf8"));
}
function findDeadPid(): number {
  for (const pid of [2147483647, 2147483646, 999999, 424242]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return pid;
    }
  }
  throw new Error("Unable to find a dead PID for stale lock test.");
}
async function initGitRepo(cwd: string, gitignore: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await runApplicationPromise(
    runProcessOrThrow(["git", "init", "-b", "main"], { cwd }),
  );
  await runApplicationPromise(
    runProcessOrThrow(["git", "config", "user.email", "roark@example.com"], {
      cwd,
    }),
  );
  await runApplicationPromise(
    runProcessOrThrow(["git", "config", "user.name", "Roark Test"], {
      cwd,
    }),
  );
  await writeFile(path.join(cwd, ".gitignore"), gitignore, "utf8");
  await writeFile(path.join(cwd, "README.md"), "test\n", "utf8");
  await runApplicationPromise(
    runProcessOrThrow(["git", "add", ".gitignore", "README.md"], {
      cwd,
    }),
  );
  await runApplicationPromise(
    runProcessOrThrow(["git", "commit", "-m", "initial"], { cwd }),
  );
}
for (const name of ["beforeRun", "afterRun"] as const) {
  test(`${name} treats a descendant timeout as failure after the shell exits zero`, async () => {
    let output = "";
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        output += chunk;
      },
    };
    const exit = await Effect.runPromiseExit(
      runLifecycleHook(
        name,
        { timeoutMs: 100, [name]: "sleep 30 & exit 0" },
        process.cwd(),
      ).pipe(
        Effect.provideService(
          Presentation,
          new Presenter({ stream, errorStream: stream }),
        ),
        Effect.provide(applicationLayer),
      ),
    );
    if (name === "beforeRun") {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(Cause.squash(exit.cause))).toContain(
          "Timed out after 100ms",
        );
    } else {
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(output).toContain("WARNING afterRun hook failed");
      expect(output).toContain("Timed out after 100ms");
    }
  });
}
test("interrupted workspace initialization records poison before returning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "roark-init-interruption-"));
  const workspacePath = workspacePathForIssue({
    root: path.join(root, "managed"),
    repo: "owner/repo",
    issueNumber: 1,
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const started = yield* Deferred.make<undefined>();
        const runner: nativeWorkspace.ProcessRunner = Effect.fnUntraced(
          function* (args) {
            if (args[0] === "sh") {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            if (args[1] === "clone")
              yield* fs
                .makeDirectory(path.join(workspacePath, ".git"), {
                  recursive: true,
                })
                .pipe(Effect.orDie);
            return {
              stdout: args[1] === "remote" ? "local.git" : "",
              stderr: "",
              exitCode: args[1] === "show-ref" ? 1 : 0,
            };
          },
        );
        const input = {
          controlCwd: root,
          repo: "owner/repo",
          issueNumber: 1,
          plan: {
            issueNumber: 1,
            branchName: "roark/issue-1",
            baseBranch: "main",
          },
          workspace: {
            ...defaultWorkspaceConfig,
            root: path.join(root, "managed"),
          },
          hooks: { ...defaultLifecycleHooks, afterCreate: "setup" },
          mode: "auto" as const,
          runner,
        };
        const initializing = yield* Effect.forkScoped(
          nativeWorkspace.prepareCloneWorkspace(input),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(initializing);
        expect(
          yield* fs.readFileString(
            path.join(workspacePath, workspaceStateFile),
          ),
        ).toContain("interrupted");
        const reused = yield* Effect.exit(
          nativeWorkspace.prepareCloneWorkspace(input),
        );
        expect(Exit.isFailure(reused)).toBe(true);
        if (Exit.isFailure(reused)) {
          expect(Cause.hasFails(reused.cause)).toBe(true);
          expect(Cause.pretty(reused.cause)).toContain("marked poisoned");
        }
      }).pipe(Effect.scoped, Effect.provide(applicationLayer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
type Input<T> = Omit<T, "runner"> & {
  runner?: TestProcessRunner | undefined;
};
function adaptRunner(
  runner: TestProcessRunner | undefined,
): nativeWorkspace.ProcessRunner | undefined {
  if (!runner) return undefined;
  return (args, options) =>
    Effect.tryPromise({
      try: () => runner([...args], options),
      catch: (cause) => new nativeWorkspace.WorkspaceCommandError({ cause }),
    });
}
async function preparePrRevisionWorkspace(
  input: Input<
    Parameters<typeof nativeWorkspace.preparePrRevisionWorkspace>[0]
  >,
) {
  // This Promise API transfers the lock to its caller's workflow finalizer.
  // Closing the intervening Promise bridge must not release that lock early.
  const scope = await Effect.runPromise(Scope.make());
  try {
    const prepared = await runApplicationPromise(
      nativeWorkspace
        .preparePrRevisionWorkspace({
          ...input,
          runner: adaptRunner(input.runner),
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    return {
      ...prepared,
      releaseLock: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
async function preparePrReviewWorkspace(
  input: Input<Parameters<typeof nativeWorkspace.preparePrReviewWorkspace>[0]>,
) {
  // This Promise API transfers the lock to its caller's workflow finalizer.
  // Closing the intervening Promise bridge must not release that lock early.
  const scope = await Effect.runPromise(Scope.make());
  try {
    const prepared = await runApplicationPromise(
      nativeWorkspace
        .preparePrReviewWorkspace({
          ...input,
          runner: adaptRunner(input.runner),
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    return {
      ...prepared,
      releaseLock: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
type TestProcessRunner = (
  args: string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;
