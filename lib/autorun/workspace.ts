import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, runProcessOrThrow, type ProcessResult } from "../cli/process.ts";
import type { AutorunBranchPlan } from "./branch.ts";

export type WorkspaceStrategy = "clone";

export interface WorkspaceCloneConfig {
  filter?: string | null | undefined;
  depth?: number | null | undefined;
}

export interface WorkspaceConfig {
  root: string;
  strategy: WorkspaceStrategy;
  cloneRemote: string;
  clone: WorkspaceCloneConfig;
  copyToWorktree: string[];
}

export interface LifecycleHooksConfig {
  afterCreate?: string | undefined;
  beforeRun?: string | undefined;
  beforeVerify?: string | undefined;
  afterRun?: string | undefined;
  beforeRemove?: string | undefined;
  timeoutMs: number;
}

export interface AttemptWorkspaceMetadata {
  path: string;
  strategy: WorkspaceStrategy;
  cloneRemote: string;
  cloneUrl?: string | undefined;
  createdNow: boolean;
}

export interface PreparedWorkspace {
  path: string;
  metadata: AttemptWorkspaceMetadata;
  releaseLock?: (() => Promise<void>) | undefined;
}

export interface PreparedPrRevisionWorkspace extends PreparedWorkspace {
  releaseLock: () => Promise<void>;
}

export interface PrReviewComparison {
  baseOid: string;
  headOid: string;
  mergeBaseOid: string;
  changedFiles: string[];
  diffStat: string;
  inspectionCommand: string;
}

export interface PreparedPrReviewWorkspace extends PreparedWorkspace {
  comparison: PrReviewComparison;
  releaseLock: () => Promise<void>;
}

class PrReviewHeadChangedError extends Error {}

export type WorkspaceRemoveTarget =
  | { kind: "issue"; number: number }
  | { kind: "pr"; number: number };

export interface ManagedWorkspace {
  path: string;
  target: WorkspaceRemoveTarget;
}

export type WorkspaceCommandOptions =
  | { command: "workspace"; action: "list"; cwd: string; repo?: string | undefined; workspace: WorkspaceConfig; hooks: LifecycleHooksConfig }
  | { command: "workspace"; action: "prune"; olderThan: string; cwd: string; repo?: string | undefined; force: boolean; workspace: WorkspaceConfig; hooks: LifecycleHooksConfig };

export interface RemoveCommandOptions {
  command: "remove";
  targets: WorkspaceRemoveTarget[];
  cwd: string;
  repo?: string | undefined;
  force: boolean;
  workspace: WorkspaceConfig;
  hooks: LifecycleHooksConfig;
}

export const workspaceStateFile = ".roark-workspace-state.json";
export const defaultWorkspaceConfig: WorkspaceConfig = {
  root: "~/.roark/workspaces",
  strategy: "clone",
  cloneRemote: "origin",
  clone: { filter: "blob:none", depth: null },
  copyToWorktree: [],
};
export const defaultLifecycleHooks: LifecycleHooksConfig = { timeoutMs: 600_000 };

export type ProcessRunner = (args: string[], options?: { cwd?: string  | undefined}) => Promise<ProcessResult>;

interface WorkspaceLockOwner {
  token: string;
  pid: number;
  createdAt: string;
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function normalizeWorkspaceRoot(root: string): string {
  return path.resolve(expandHome(root));
}

export function sanitizeWorkspaceSegment(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return sanitized || "unknown";
}

export function workspacePathForIssue(input: { root: string; repo?: string | undefined; issueNumber: number; controlCwd?: string  | undefined}): string {
  const root = normalizeWorkspaceRoot(input.root);
  const repoSegment = repoSegmentForWorkspace(input.repo, input.controlCwd);
  const issueSegment = `issue-${sanitizeWorkspaceSegment(String(input.issueNumber))}`;
  const workspacePath = path.resolve(root, repoSegment, issueSegment);
  assertPathInsideRoot({ root, target: workspacePath });
  return workspacePath;
}

export function workspacePathForPrRevision(input: { root: string; repo?: string | undefined; prNumber: number; controlCwd?: string | undefined }): string {
  const root = normalizeWorkspaceRoot(input.root);
  const repoSegment = repoSegmentForWorkspace(input.repo, input.controlCwd);
  const prSegment = `pr-${sanitizeWorkspaceSegment(String(input.prNumber))}`;
  const workspacePath = path.resolve(root, repoSegment, prSegment);
  assertPathInsideRoot({ root, target: workspacePath });
  return workspacePath;
}

export async function assertWorkspacePathSafe(input: { root: string; workspacePath: string }): Promise<void> {
  const root = normalizeWorkspaceRoot(input.root);
  const workspacePath = path.resolve(input.workspacePath);
  assertPathInsideRoot({ root, target: workspacePath });
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Unsafe workspace root '${root}': symlink roots are not allowed.`);
  const rootReal = await realpath(root);

  let current = rootReal;
  const relative = path.relative(root, workspacePath);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) throw new Error(`Unsafe workspace path '${workspacePath}': symlink path component '${current}' is not allowed.`);
    const currentReal = await realpath(current);
    assertPathInsideRoot({ root: rootReal, target: currentReal });
  }
}

export async function resolveCloneRemote(input: { cwd: string; cloneRemote?: string; runner?: ProcessRunner  | undefined}): Promise<{ remote: string; url: string }> {
  const runner = input.runner ?? runProcess;
  const remote = input.cloneRemote?.trim() ?? "origin";
  const remoteResult = await runner(["git", "remote", "get-url", remote], { cwd: input.cwd });
  const url = remoteResult.exitCode === 0 && remoteResult.stdout.trim() ? remoteResult.stdout.trim() : remote;

  const preflight = await runner(["git", "ls-remote", url, "HEAD"], { cwd: input.cwd });
  if (preflight.exitCode !== 0) {
    throw new Error(
      [
        `Unable to access clone remote '${remote}' (${url}).`,
        `Command: git ls-remote ${url} HEAD`,
        `Exit code: ${preflight.exitCode}`,
        `stderr: ${tail(preflight.stderr || preflight.stdout)}`,
        "Suggested fixes: check workspace.cloneRemote in .roark/config.json, verify the git remote URL, and ensure credentials allow cloning.",
      ].join("\n"),
    );
  }

  return { remote, url };
}

export async function resolvePrReviewCloneRemote(input: {
  cwd: string;
  repo?: string | undefined;
  repositoryUrl?: string | undefined;
  runner?: ProcessRunner | undefined;
}): Promise<{ remote: "origin"; url: string }> {
  const runner = input.runner ?? runProcess;
  const repositoryUrl = input.repositoryUrl?.trim();
  const url = repositoryUrl && repositoryUrl.length > 0 ? repositoryUrl : githubRepositoryUrl(input.repo);
  const preflight = await runner(["git", "ls-remote", url, "HEAD"], { cwd: input.cwd });
  if (preflight.exitCode !== 0) {
    throw new Error(
      [
        `Unable to access PR repository '${input.repo ?? url}' (${url}).`,
        `Command: git ls-remote ${url} HEAD`,
        `Exit code: ${preflight.exitCode}`,
        `stderr: ${tail(preflight.stderr || preflight.stdout)}`,
        "Suggested fixes: verify --repo identifies the PR's base repository and ensure git credentials allow cloning it.",
      ].join("\n"),
    );
  }
  return { remote: "origin", url };
}

export async function prepareCloneWorkspace(input: {
  controlCwd: string;
  repo?: string | undefined  ;
  issueNumber: number;
  plan: AutorunBranchPlan;
  workspace: WorkspaceConfig;
  hooks: LifecycleHooksConfig;
  mode: "auto" | "continue";
  workspacePath?: string | undefined  ;
  runner?: ProcessRunner | undefined  ;
}): Promise<PreparedWorkspace> {
  const runner = input.runner ?? runProcess;
  const root = normalizeWorkspaceRoot(input.workspace.root);
  const workspacePath = path.resolve(input.workspacePath ?? workspacePathForIssue({ root, repo: input.repo, issueNumber: input.issueNumber, controlCwd: input.controlCwd }));
  await assertWorkspacePathSafe({ root, workspacePath });
  const remote = await resolveCloneRemote({ cwd: input.controlCwd, cloneRemote: input.workspace.cloneRemote, runner });
    const createdNow = !existsSync(workspacePath);

    if (createdNow) {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      const cloneArgs = buildCloneArgs({ url: remote.url, target: workspacePath, clone: input.workspace.clone });
      await runProcessOrThrowWithRunner(runner, cloneArgs, { cwd: input.controlCwd, label: "git clone" });
      try {
        await checkoutWorkspaceBranch({ cwd: workspacePath, plan: input.plan, runner });
        await refreshCopyToWorktree({ controlCwd: input.controlCwd, worktreePath: workspacePath, copyToWorktree: input.workspace.copyToWorktree, runner });
        await runLifecycleHook("afterCreate", input.hooks, workspacePath, runner);
      } catch (error) {
        await writePoisonState(workspacePath, error);
        throw error;
      }
    } else {
      await assertNotPoisoned(workspacePath);
      await assertGitWorkspaceOnBranch({ cwd: workspacePath, branchName: input.plan.branchName, runner });
      if (input.mode === "auto" && await hasGitChanges(workspacePath, runner)) {
        throw new Error(
          `Workspace '${workspacePath}' has uncommitted changes. Use 'roark continue ${input.issueNumber} --cwd ${input.controlCwd}' to recover a failed attempt, or clean/remove the workspace before starting fresh auto work.`,
        );
      }
      await refreshCopyToWorktree({ controlCwd: input.controlCwd, worktreePath: workspacePath, copyToWorktree: input.workspace.copyToWorktree, runner });
    }

    return {
      path: workspacePath,
      metadata: {
        path: workspacePath,
        strategy: "clone",
        cloneRemote: remote.remote,
        cloneUrl: remote.url,
        createdNow,
      },
    };
}

export async function preparePrRevisionWorkspace(input: {
  controlCwd: string;
  repo?: string | undefined;
  prNumber: number;
  headRefName: string;
  workspace: WorkspaceConfig;
  hooks: LifecycleHooksConfig;
  workspacePath?: string | undefined;
  runner?: ProcessRunner | undefined;
}): Promise<PreparedPrRevisionWorkspace> {
  const runner = input.runner ?? runProcess;
  const root = normalizeWorkspaceRoot(input.workspace.root);
  const workspacePath = path.resolve(input.workspacePath ?? workspacePathForPrRevision({
    root,
    repo: input.repo,
    prNumber: input.prNumber,
    controlCwd: input.controlCwd,
  }));
  await assertWorkspacePathSafe({ root, workspacePath });
  const releaseLock = await acquireWorkspaceLock(workspacePath);

  try {
    const remote = await resolveCloneRemote({ cwd: input.controlCwd, cloneRemote: input.workspace.cloneRemote, runner });
    const createdNow = !existsSync(workspacePath);

    if (createdNow) {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await runProcessOrThrowWithRunner(runner, buildCloneArgs({ url: remote.url, target: workspacePath, clone: input.workspace.clone }), {
        cwd: input.controlCwd,
        label: "git clone",
      });
      try {
        await checkoutPrWorkspaceBranch({ cwd: workspacePath, headRefName: input.headRefName, runner });
        await refreshCopyToWorktree({ controlCwd: input.controlCwd, worktreePath: workspacePath, copyToWorktree: input.workspace.copyToWorktree, runner });
        await runLifecycleHook("afterCreate", input.hooks, workspacePath, runner);
      } catch (error) {
        await writePoisonState(workspacePath, error);
        throw error;
      }
    } else {
      await assertNotPoisoned(workspacePath);
      const insideWorkTree = await runner(["git", "rev-parse", "--is-inside-work-tree"], { cwd: workspacePath });
      if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== "true") throw new Error(`Workspace '${workspacePath}' is not a git work tree.`);
      if (await hasGitChanges(workspacePath, runner)) throw new Error(`Workspace '${workspacePath}' has uncommitted changes. Clean or remove it before revising PR #${input.prNumber}.`);
      await checkoutPrWorkspaceBranch({ cwd: workspacePath, headRefName: input.headRefName, runner });
      await refreshCopyToWorktree({ controlCwd: input.controlCwd, worktreePath: workspacePath, copyToWorktree: input.workspace.copyToWorktree, runner });
    }

    return {
      path: workspacePath,
      metadata: {
        path: workspacePath,
        strategy: "clone",
        cloneRemote: remote.remote,
        cloneUrl: remote.url,
        createdNow,
      },
      releaseLock,
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

export async function preparePrReviewWorkspace(input: {
  controlCwd: string;
  repo?: string | undefined;
  repositoryUrl?: string | undefined;
  prNumber: number;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  workspace: WorkspaceConfig;
  hooks: LifecycleHooksConfig;
  workspacePath?: string | undefined;
  runner?: ProcessRunner | undefined;
}): Promise<PreparedPrReviewWorkspace> {
  if (!input.baseRefOid || !input.headRefOid) {
    throw new Error(`PR #${input.prNumber} metadata did not include immutable base and head commit identifiers.`);
  }
  const runner = input.runner ?? runProcess;
  const root = normalizeWorkspaceRoot(input.workspace.root);
  const workspacePath = path.resolve(input.workspacePath ?? workspacePathForPrRevision({
    root,
    repo: input.repo,
    prNumber: input.prNumber,
    controlCwd: input.controlCwd,
  }));
  await assertWorkspacePathSafe({ root, workspacePath });
  const releaseLock = await acquireWorkspaceLock(workspacePath);

  try {
    const remote = await resolvePrReviewCloneRemote({
      cwd: input.controlCwd,
      repo: input.repo,
      repositoryUrl: input.repositoryUrl,
      runner,
    });
    const createdNow = !existsSync(workspacePath);
    if (createdNow) {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await runProcessOrThrowWithRunner(runner, buildCloneArgs({ url: remote.url, target: workspacePath, clone: input.workspace.clone }), {
        cwd: input.controlCwd,
        label: "git clone",
      });
    } else {
      await assertNotPoisoned(workspacePath);
      const insideWorkTree = await runner(["git", "rev-parse", "--is-inside-work-tree"], { cwd: workspacePath });
      if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== "true") throw new Error(`Workspace '${workspacePath}' is not a git work tree.`);
      if (await hasGitChanges(workspacePath, runner)) throw new Error(`Workspace '${workspacePath}' has uncommitted changes. Clean or remove it before reviewing PR #${input.prNumber}.`);
      await runProcessOrThrowWithRunner(runner, ["git", "remote", "set-url", "origin", remote.url], {
        cwd: workspacePath,
        label: "git set PR review origin",
      });
    }

    try {
      const comparison = await checkoutPinnedPrReview({
        cwd: workspacePath,
        prNumber: input.prNumber,
        baseRefName: input.baseRefName,
        baseRefOid: input.baseRefOid,
        headRefOid: input.headRefOid,
        runner,
      });
      await refreshCopyToWorktree({ controlCwd: input.controlCwd, worktreePath: workspacePath, copyToWorktree: input.workspace.copyToWorktree, runner });
      if (createdNow) await runLifecycleHook("afterCreate", input.hooks, workspacePath, runner);
      await assertPinnedPrReviewWorkspace({ cwd: workspacePath, headOid: input.headRefOid, runner });
      return {
        path: workspacePath,
        comparison,
        metadata: {
          path: workspacePath,
          strategy: "clone",
          cloneRemote: remote.remote,
          cloneUrl: remote.url,
          createdNow,
        },
        releaseLock,
      };
    } catch (error) {
      if (createdNow && !(error instanceof PrReviewHeadChangedError)) await writePoisonState(workspacePath, error);
      throw error;
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

function githubRepositoryUrl(repo: string | undefined): string {
  const normalized = repo?.trim();
  if (!normalized || !/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("Cannot resolve the PR repository clone URL. Pass --repo owner/repo.");
  }
  return `https://github.com/${normalized}.git`;
}

export async function assertPinnedPrReviewWorkspace(input: {
  cwd: string;
  headOid: string;
  runner?: ProcessRunner | undefined;
}): Promise<void> {
  const runner = input.runner ?? runProcess;
  const currentHead = (await runProcessOrThrowWithRunner(runner, ["git", "rev-parse", "HEAD"], {
    cwd: input.cwd,
    label: "git rev-parse review HEAD",
  })).trim();
  if (currentHead !== input.headOid) {
    throw new Error(`PR review workspace HEAD changed from pinned commit ${input.headOid} to ${currentHead || "(unknown)"}. Refusing to publish this review.`);
  }
  const status = await runner(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: input.cwd });
  if (status.exitCode !== 0) throw new Error(`Unable to verify PR review workspace cleanliness: ${tail(status.stderr || status.stdout)}`);
  if (status.stdout.trim()) {
    throw new Error(`PR review workspace changed during inspection. Refusing to publish this review.\n${status.stdout.trim()}`);
  }
}

async function checkoutPinnedPrReview(input: {
  cwd: string;
  prNumber: number;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  runner: ProcessRunner;
}): Promise<PrReviewComparison> {
  const baseReviewRef = `refs/remotes/roark/pr-${input.prNumber}-base`;
  const headReviewRef = `refs/remotes/roark/pr-${input.prNumber}-head`;
  await runProcessOrThrowWithRunner(input.runner, ["git", "fetch", "origin", `+refs/heads/${input.baseRefName}:${baseReviewRef}`], {
    cwd: input.cwd,
    label: "git fetch PR base",
  });
  await runProcessOrThrowWithRunner(input.runner, ["git", "fetch", "origin", `+refs/pull/${input.prNumber}/head:${headReviewRef}`], {
    cwd: input.cwd,
    label: "git fetch GitHub PR head",
  });
  const fetchedHead = (await runProcessOrThrowWithRunner(input.runner, ["git", "rev-parse", headReviewRef], { cwd: input.cwd, label: "git rev-parse PR head" })).trim();
  if (fetchedHead !== input.headRefOid) {
    throw new PrReviewHeadChangedError(`PR #${input.prNumber} changed while its review workspace was prepared (expected ${input.headRefOid}, fetched ${fetchedHead}).`);
  }
  await assertFetchedOid(input.runner, input.cwd, input.baseRefOid, "base");
  await assertFetchedOid(input.runner, input.cwd, input.headRefOid, "head");
  await ensureCompleteHistory(input.runner, input.cwd, input.prNumber);
  const mergeBaseResult = await input.runner(["git", "merge-base", input.baseRefOid, input.headRefOid], { cwd: input.cwd });
  const mergeBaseOid = mergeBaseResult.stdout.trim();
  if (mergeBaseResult.exitCode !== 0 || !mergeBaseOid) {
    throw new Error(`Could not determine merge base for PR #${input.prNumber} after ensuring complete clone history: ${tail(mergeBaseResult.stderr || mergeBaseResult.stdout) || "no common ancestor was available"}`);
  }
  await runProcessOrThrowWithRunner(input.runner, ["git", "checkout", "--detach", input.headRefOid], { cwd: input.cwd, label: "git checkout pinned PR head" });
  const changedFiles = (await runProcessOrThrowWithRunner(input.runner, ["git", "diff", "--name-only", `${mergeBaseOid}..${input.headRefOid}`, "--"], {
    cwd: input.cwd,
    label: "git diff PR changed files",
  })).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const diffStat = (await runProcessOrThrowWithRunner(input.runner, ["git", "diff", "--stat", `${mergeBaseOid}..${input.headRefOid}`, "--"], {
    cwd: input.cwd,
    label: "git diff PR stat",
  })).trim();
  return {
    baseOid: input.baseRefOid,
    headOid: input.headRefOid,
    mergeBaseOid,
    changedFiles,
    diffStat,
    inspectionCommand: `git diff ${mergeBaseOid}..${input.headRefOid} --`,
  };
}

async function ensureCompleteHistory(runner: ProcessRunner, cwd: string, prNumber: number): Promise<void> {
  let shallow = await runner(["git", "rev-parse", "--is-shallow-repository"], { cwd });
  if (shallow.exitCode !== 0) {
    throw new Error(`Unable to inspect clone history before calculating the merge base for PR #${prNumber}: ${tail(shallow.stderr || shallow.stdout)}`);
  }
  if (shallow.stdout.trim() !== "true") return;

  const unshallow = await runner(["git", "fetch", "--unshallow", "origin"], { cwd });
  if (unshallow.exitCode !== 0) {
    throw new Error(`Unable to fetch complete history for shallow PR review workspace #${prNumber}: ${tail(unshallow.stderr || unshallow.stdout)}`);
  }
  shallow = await runner(["git", "rev-parse", "--is-shallow-repository"], { cwd });
  if (shallow.exitCode !== 0 || shallow.stdout.trim() === "true") {
    throw new Error(`PR review workspace #${prNumber} remains shallow after fetching complete history; its merge base cannot be calculated reliably.`);
  }
}

async function assertFetchedOid(runner: ProcessRunner, cwd: string, oid: string, label: string): Promise<void> {
  let result = await runner(["git", "cat-file", "-e", `${oid}^{commit}`], { cwd });
  if (result.exitCode !== 0) {
    result = await runner(["git", "fetch", "origin", oid], { cwd });
    if (result.exitCode !== 0) throw new Error(`Unable to fetch pinned PR ${label} commit ${oid}: ${tail(result.stderr || result.stdout)}`);
    result = await runner(["git", "cat-file", "-e", `${oid}^{commit}`], { cwd });
  }
  if (result.exitCode !== 0) throw new Error(`Pinned PR ${label} commit ${oid} is unavailable after fetch.`);
}

export async function refreshCopyToWorktree(input: {
  controlCwd: string;
  worktreePath: string;
  copyToWorktree?: readonly string[] | undefined  ;
  runner?: ProcessRunner | undefined  ;
}): Promise<void> {
  const entries = input.copyToWorktree ?? [];
  if (entries.length === 0) return;
  const runner = input.runner ?? runProcess;
  const preflight: { entry: string; source: string; destination: string }[] = [];

  for (const rawEntry of entries) {
    const entry = validateCopyToWorktreeEntry(rawEntry, "workspace.copyToWorktree");
    const source = path.resolve(input.controlCwd, entry);
    const destination = path.resolve(input.worktreePath, entry);
    assertPathInsideRoot({ root: path.resolve(input.controlCwd), target: source });
    assertPathInsideRoot({ root: path.resolve(input.worktreePath), target: destination });
    await assertCopyDestinationParentsSafe({ worktreePath: input.worktreePath, destination, entry });

    try {
      await stat(source);
    } catch {
      throw new Error(`Configured workspace.copyToWorktree source '${entry}' is missing at '${source}'.`);
    }

    const ignored = await runner(["git", "check-ignore", "--quiet", "--", entry], { cwd: input.worktreePath });
    if (ignored.exitCode !== 0) {
      const detail = ignored.exitCode === 1 ? "path is not ignored" : `git check-ignore failed: ${tail(ignored.stderr || ignored.stdout) || "(empty)"}`;
      throw new Error(`Refusing to copy workspace.copyToWorktree path '${entry}': destination must be ignored by Git in '${input.worktreePath}' (${detail}).`);
    }

    preflight.push({ entry, source, destination });
  }

  for (const item of preflight) {
    await rm(item.destination, { recursive: true, force: true });
    await copyDereferenced(item.source, item.destination);

    const status = await runner(["git", "status", "--porcelain", "--", item.entry], { cwd: input.worktreePath });
    if (status.exitCode !== 0) {
      throw new Error(`git status check failed after copying workspace.copyToWorktree path '${item.entry}': ${tail(status.stderr || status.stdout)}`);
    }
    if (status.stdout.trim() !== "") {
      throw new Error(`Refusing copied workspace.copyToWorktree path '${item.entry}': copied destination is visible to Git.\n${status.stdout.trim()}`);
    }
  }
}

export function validateCopyToWorktreeEntry(value: string, keyPath = "workspace.copyToWorktree"): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${keyPath} entries must be non-empty strings.`);
  const entry = value.trim().replace(/\\+/g, "/");
  if (entry.includes("*") || entry.includes("?") || entry.includes("[")) throw new Error(`${keyPath} entry '${value}' must be a literal path; globs are not supported.`);
  if (path.isAbsolute(entry) || /^[A-Za-z]:\//.test(entry) || entry.startsWith("//")) throw new Error(`${keyPath} entry '${value}' must be a relative path.`);
  const segments = entry.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error(`${keyPath} entry '${value}' must be a non-empty relative path.`);
  if (segments.some((segment) => segment === "..")) throw new Error(`${keyPath} entry '${value}' must not contain parent traversal.`);
  if (segments.some((segment) => segment === ".git")) throw new Error(`${keyPath} entry '${value}' must not target .git.`);
  return segments.join("/");
}

async function assertCopyDestinationParentsSafe(input: { worktreePath: string; destination: string; entry: string }): Promise<void> {
  const root = path.resolve(input.worktreePath);
  const destination = path.resolve(input.destination);
  assertPathInsideRoot({ root, target: destination });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Refusing to copy workspace.copyToWorktree path '${input.entry}': worktree path '${root}' is a symlink.`);
  const rootReal = await realpath(root);
  let current = root;
  const relativeParent = path.relative(root, path.dirname(destination));
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch (error) {
      if (isNotFoundError(error)) break;
      throw error;
    }
    if (currentStat.isSymbolicLink()) {
      throw new Error(`Refusing to copy workspace.copyToWorktree path '${input.entry}': destination parent '${current}' is a symlink.`);
    }
    const currentReal = await realpath(current);
    assertPathInsideRoot({ root: rootReal, target: currentReal });
  }
}

async function copyDereferenced(source: string, destination: string): Promise<void> {
  const sourceStat = await stat(source);
  const mode = sourceStat.mode & 0o7777;
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode });
    await chmod(destination, mode);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyDereferenced(path.join(source, entry.name), path.join(destination, entry.name));
    }
    await chmod(destination, mode);
    return;
  }
  if (sourceStat.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, mode);
    return;
  }
  throw new Error(`Cannot copy workspace.copyToWorktree source '${source}': unsupported file type.`);
}

export async function runLifecycleHook(
  name: keyof LifecycleHooksConfig,
  hooks: LifecycleHooksConfig | undefined,
  cwd: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  const command = typeof hooks?.[name] === "string" ? hooks[name].trim() : "";
  if (!command) return;
  const timeoutMs = hooks?.timeoutMs ?? defaultLifecycleHooks.timeoutMs;
  const result = await runHookCommand(command, cwd, timeoutMs, runner);
  if (result.exitCode === 0) return;
  const message = `${name} hook failed with exit code ${result.exitCode}: ${command}\n${tail(result.stderr || result.stdout)}`;
  if (name === "afterRun" || name === "beforeRemove") {
    console.warn(message);
    return;
  }
  throw new WorkspaceHookError(message, { hook: name, command, result });
}

export class WorkspaceHookError extends Error {
  hook: string;
  command: string;
  result: ProcessResult;
  constructor(message: string, options: { hook: string; command: string; result: ProcessResult }) {
    super(message);
    this.name = "WorkspaceHookError";
    this.hook = options.hook;
    this.command = options.command;
    this.result = options.result;
  }
}

export async function listManagedWorkspaces(options: { workspace: WorkspaceConfig; repo?: string | undefined; cwd?: string | undefined }): Promise<ManagedWorkspace[]> {
  const repoRoot = path.dirname(workspacePathForIssue({ root: options.workspace.root, repo: options.repo, issueNumber: 1, controlCwd: options.cwd }));
  if (!existsSync(repoRoot)) return [];
  const entries = await readdir(repoRoot, { withFileTypes: true });
  return entries
    .flatMap((entry): ManagedWorkspace[] => {
      if (!entry.isDirectory()) return [];
      const match = /^(issue|pr)-([1-9]\d*)$/.exec(entry.name);
      if (!match) return [];
      const number = Number(match[2]);
      if (!Number.isSafeInteger(number)) return [];
      return [{
        path: path.join(repoRoot, entry.name),
        target: { kind: match[1] === "pr" ? "pr" : "issue", number },
      }];
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function listWorkspaces(options: { workspace: WorkspaceConfig; repo?: string | undefined; cwd?: string | undefined }): Promise<string[]> {
  return (await listManagedWorkspaces(options)).map((managedWorkspace) => managedWorkspace.path);
}

export async function runWorkspaceCommand(options: WorkspaceCommandOptions): Promise<void> {
  if (options.action === "list") {
    const paths = await listWorkspaces({ workspace: options.workspace, repo: options.repo, cwd: options.cwd });
    if (paths.length === 0) console.log("No managed workspaces found.");
    else for (const workspacePath of paths) console.log(workspacePath);
    return;
  }

  const olderThanMs = parseDurationMs(options.olderThan);
  const cutoff = Date.now() - olderThanMs;
  const paths = await listWorkspaces({ workspace: options.workspace, repo: options.repo, cwd: options.cwd });
  let removed = 0;
  for (const workspacePath of paths) {
    const stats = await stat(workspacePath);
    if (stats.mtimeMs > cutoff) continue;
    if (await removeWorkspace({ workspacePath, force: options.force, hooks: options.hooks })) removed++;
  }
  console.log(`Pruned ${removed} workspace(s).`);
}

export async function runRemoveCommand(options: RemoveCommandOptions): Promise<void> {
  if (options.targets.length === 0) throw new Error("No managed workspaces selected for removal.");
  const paths = [...new Set(options.targets.map((target) => target.kind === "issue"
    ? workspacePathForIssue({ root: options.workspace.root, repo: options.repo, issueNumber: target.number, controlCwd: options.cwd })
    : workspacePathForPrRevision({ root: options.workspace.root, repo: options.repo, prNumber: target.number, controlCwd: options.cwd })))];

  const missingPaths = paths.filter((workspacePath) => !existsSync(workspacePath));
  if (missingPaths.length > 0) {
    throw new Error(`Managed workspace${missingPaths.length === 1 ? "" : "s"} not found:\n${missingPaths.join("\n")}`);
  }

  if (!options.force) {
    const dirtyPaths: string[] = [];
    for (const workspacePath of paths) {
      if (await hasGitChanges(workspacePath, runProcess)) dirtyPaths.push(workspacePath);
    }
    if (dirtyPaths.length > 0) {
      throw new Error(`Refusing to remove dirty workspace${dirtyPaths.length === 1 ? "" : "s"}:\n${dirtyPaths.join("\n")}\nPass --force to remove ${dirtyPaths.length === 1 ? "it" : "them"} anyway.`);
    }
  }

  for (const workspacePath of paths) {
    if (!await removeWorkspaceFiles({ workspacePath, hooks: options.hooks })) {
      throw new Error(`Managed workspace disappeared before it could be removed: ${workspacePath}`);
    }
    console.log(`Removed workspace: ${workspacePath}`);
  }
}

export async function removeWorkspace(input: { workspacePath: string; force: boolean; hooks: LifecycleHooksConfig }): Promise<boolean> {
  const legacyLockPath = `${input.workspacePath}.lock`;
  if (!existsSync(input.workspacePath)) {
    await rm(legacyLockPath, { recursive: true, force: true });
    return false;
  }
  if (!input.force && await hasGitChanges(input.workspacePath, runProcess)) {
    throw new Error(`Refusing to remove dirty workspace '${input.workspacePath}'. Pass --force to remove it anyway.`);
  }
  return removeWorkspaceFiles({ workspacePath: input.workspacePath, hooks: input.hooks });
}

async function removeWorkspaceFiles(input: { workspacePath: string; hooks: LifecycleHooksConfig }): Promise<boolean> {
  if (!existsSync(input.workspacePath)) return false;
  const legacyLockPath = `${input.workspacePath}.lock`;
  await runLifecycleHook("beforeRemove", input.hooks, input.workspacePath);
  await rm(input.workspacePath, { recursive: true, force: true });
  await rm(legacyLockPath, { recursive: true, force: true });
  return true;
}

async function acquireWorkspaceLock(workspacePath: string): Promise<() => Promise<void>> {
  const lockDir = `${workspacePath}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockDir);
      const owner: WorkspaceLockOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
      await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(owner, null, 2), "utf8");
      return async () => {
        if (await lockOwnerToken(lockDir) !== token) return;
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isErrorWithCode(error, "EEXIST")) throw error;
      if (await removeStaleWorkspaceLock(lockDir)) continue;
      throw new Error(`Workspace '${workspacePath}' is already locked (lock: ${lockDir}).`);
    }
  }
}

async function lockOwnerToken(lockDir: string): Promise<string | undefined> {
  try {
    const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as Partial<WorkspaceLockOwner>;
    return owner.token;
  } catch {
    return undefined;
  }
}

async function removeStaleWorkspaceLock(lockDir: string): Promise<boolean> {
  let owner: Partial<WorkspaceLockOwner>;
  try {
    owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as Partial<WorkspaceLockOwner>;
  } catch {
    return false;
  }
  if (typeof owner.pid !== "number" || isProcessAlive(owner.pid)) return false;
  await rm(lockDir, { recursive: true, force: true });
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorWithCode(error, "ESRCH");
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function checkoutWorkspaceBranch(input: { cwd: string; plan: AutorunBranchPlan; runner: ProcessRunner }): Promise<void> {
  await runProcessOrThrowWithRunner(input.runner, ["git", "fetch", "origin"], { cwd: input.cwd, label: "git fetch origin" });
  const remoteBranch = await gitRemoteBranchExists({ cwd: input.cwd, branchName: input.plan.branchName, runner: input.runner });
  if (remoteBranch) {
    await runProcessOrThrowWithRunner(input.runner, ["git", "checkout", "-B", input.plan.branchName, `origin/${input.plan.branchName}`], { cwd: input.cwd, label: "git checkout issue branch" });
  } else {
    await runProcessOrThrowWithRunner(input.runner, ["git", "checkout", "-B", input.plan.branchName, `origin/${input.plan.baseBranch}`], { cwd: input.cwd, label: "git checkout issue branch from base" });
  }
}

async function checkoutPrWorkspaceBranch(input: { cwd: string; headRefName: string; runner: ProcessRunner }): Promise<void> {
  await runProcessOrThrowWithRunner(input.runner, ["git", "fetch", "origin", `+refs/heads/${input.headRefName}:refs/remotes/origin/${input.headRefName}`], {
    cwd: input.cwd,
    label: "git fetch PR head",
  });
  await assertNoUnpushedBranchCommits({ cwd: input.cwd, branchName: input.headRefName, upstreamRef: `origin/${input.headRefName}`, runner: input.runner });
  await runProcessOrThrowWithRunner(input.runner, ["git", "checkout", "-B", input.headRefName, `origin/${input.headRefName}`], {
    cwd: input.cwd,
    label: "git checkout PR head",
  });
}

async function assertNoUnpushedBranchCommits(input: { cwd: string; branchName: string; upstreamRef: string; runner: ProcessRunner }): Promise<void> {
  const localBranch = await input.runner(["git", "show-ref", "--verify", "--quiet", `refs/heads/${input.branchName}`], { cwd: input.cwd });
  if (localBranch.exitCode !== 0) return;
  const ahead = await input.runner(["git", "rev-list", "--count", input.branchName, "--not", input.upstreamRef], { cwd: input.cwd });
  if (ahead.exitCode !== 0) throw new Error(`Unable to inspect local commits on '${input.branchName}': ${tail(ahead.stderr || ahead.stdout)}`);
  const aheadCount = Number(ahead.stdout.trim());
  if (!Number.isFinite(aheadCount)) throw new Error(`Unable to inspect local commits on '${input.branchName}': unexpected rev-list output '${ahead.stdout.trim()}'.`);
  if (aheadCount > 0) {
    throw new Error(`Workspace '${input.cwd}' has ${aheadCount} unpushed local commit(s) on '${input.branchName}'. Refusing to reset it to '${input.upstreamRef}'. Push, remove, or repair the workspace before revising this PR.`);
  }
}

async function assertGitWorkspaceOnBranch(input: { cwd: string; branchName: string; runner: ProcessRunner }): Promise<void> {
  const result = await input.runner(["git", "rev-parse", "--is-inside-work-tree"], { cwd: input.cwd });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") throw new Error(`Workspace '${input.cwd}' is not a git work tree.`);
  const currentBranch = (await runProcessOrThrowWithRunner(input.runner, ["git", "branch", "--show-current"], { cwd: input.cwd, label: "git branch --show-current" })).trim();
  if (currentBranch !== input.branchName) throw new Error(`Workspace '${input.cwd}' is on branch '${currentBranch || "(detached)"}', expected '${input.branchName}'.`);
}

async function assertNotPoisoned(workspacePath: string): Promise<void> {
  const sentinel = path.join(workspacePath, workspaceStateFile);
  if (!existsSync(sentinel)) return;
  let detail = "";
  try { detail = await readFile(sentinel, "utf8"); } catch { /* ignore */ }
  throw new Error(`Workspace '${workspacePath}' is marked poisoned by a failed lifecycle hook. Remove or repair the workspace before reusing it.\n${detail}`);
}

async function writePoisonState(workspacePath: string, error: unknown): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  const payload: Record<string, unknown> = { failedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
  if (error instanceof WorkspaceHookError) {
    payload["hook"] = error.hook;
    payload["command"] = error.command;
    payload["exitCode"] = error.result.exitCode;
    payload["stdoutTail"] = tail(error.result.stdout);
    payload["stderrTail"] = tail(error.result.stderr);
  }
  await writeFile(path.join(workspacePath, workspaceStateFile), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function hasGitChanges(cwd: string, runner: ProcessRunner): Promise<boolean> {
  const result = await runner(["git", "status", "--porcelain"], { cwd });
  if (result.exitCode !== 0) throw new Error(`git status --porcelain failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`);
  return result.stdout.trim() !== "";
}

async function gitRemoteBranchExists(input: { cwd: string; branchName: string; runner: ProcessRunner }): Promise<boolean> {
  const result = await input.runner(["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${input.branchName}`], { cwd: input.cwd });
  return result.exitCode === 0;
}

async function runProcessOrThrowWithRunner(runner: ProcessRunner, args: string[], options: { cwd?: string | undefined; label?: string }): Promise<string> {
  if (runner === runProcess) return runProcessOrThrow(args, options);
  const result = await runner(args, { cwd: options.cwd });
  if (result.exitCode !== 0) throw new Error(`${options.label ?? args.join(" ")} failed with exit code ${result.exitCode}:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

async function runHookCommand(command: string, cwd: string, timeoutMs: number, runner: ProcessRunner): Promise<ProcessResult> {
  if (runner !== runProcess) return runner(["sh", "-lc", command], { cwd });
  const child = Bun.spawn(["sh", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const timeoutState = { timedOut: false };
  const timer = setTimeout(() => {
    timeoutState.timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr: timeoutState.timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms.` : stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

function buildCloneArgs(input: { url: string; target: string; clone: WorkspaceCloneConfig }): string[] {
  const args = ["git", "clone"];
  if (input.clone.filter) args.push(`--filter=${input.clone.filter}`);
  if (input.clone.depth !== null && input.clone.depth !== undefined) args.push("--depth", String(input.clone.depth));
  args.push(input.url, input.target);
  return args;
}

function assertPathInsideRoot(input: { root: string; target: string }): void {
  const relative = path.relative(input.root, input.target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Workspace path '${input.target}' must stay inside workspace root '${input.root}'.`);
}

function repoSegmentForWorkspace(repo?: string  , controlCwd?: string): string {
  if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) {
    const [owner, name] = repo.split("/");
    return `${sanitizeWorkspaceSegment(owner ?? "unknown")}-${sanitizeWorkspaceSegment(name ?? "repo")}`;
  }
  const fallback = controlCwd ? path.basename(path.resolve(controlCwd)) : "repo";
  return `local-${sanitizeWorkspaceSegment(fallback)}`;
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)([dhm])$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration '${value}'. Use formats like 30d, 12h, or 60m.`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function tail(value: string, max = 4000): string {
  return value.length <= max ? value : value.slice(-max);
}
