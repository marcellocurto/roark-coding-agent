import { GitHub } from "../github/service.ts";
import { Workspace } from "./workspace-service.ts";
import { GitHubRequestError } from "../github/errors.ts";
import {
  continuationResult,
  submitContinuation,
} from "../testing/continuations.ts";
import { AttemptStore, formatAttemptMetadata } from "./attempts.ts";
import {
  writeArtifact,
  writeJsonArtifact,
  refinementLogRef,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { rejects as assertRejects } from "node:assert/strict";
import { provideTestAgent } from "../testing/agents.ts";
import { Effect, Schema } from "effect";
import { runApplicationPromise } from "../runtime/application.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ContinueCliOptions } from "../cli/args.ts";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { autorunWorktreePath } from "./branch.ts";
import { createContinueWorkflowOptions, runAutoContinue } from "./continue.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import {
  implementationPlanResult,
  triageResult,
} from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";
const decodeRemoteComments = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ body: Schema.String })),
  ),
);
const tempDirs: string[] = [];
const originalPath = process.env["PATH"];
afterEach(async () => {
  process.env["PATH"] = originalPath;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const continueOptions = {
  command: "continue",
  issue: "123",
  cwd: "/repo",
  outDir: ".roark/runs",
  repo: "owner/repo",
  model: "provider/model",
  thinkingLevel: "high",
  restart: false,
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
  test.each(["planning-stopped", "execution-stopped"] as const)(
    "%s fetches current feedback before preparing the workspace",
    async (outcome) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-stopped-"));
      tempDirs.push(cwd);
      await installFailingGh(cwd);
      await runApplicationPromise(
        Effect.flatMap(AttemptStore, (store) =>
          store.write(
            path.join(cwd, ".roark/runs/issue/24"),
            formatAttemptMetadata({
              attempt: 2,
              issueNumber: 24,
              branch: "roark/issue-24",
              baseBranch: "main",
              worktreePath: "/unused",
              runArtifactPath: ".roark/runs/issue/24/attempts/2",
              startedAt: "2026-09-09T00:00:00Z",
              outcome,
            }),
          ),
        ),
      );
      let fetched = false;
      await assertRejects(
        runApplicationPromise(
          runAutoContinue({
            ...continueOptions,
            issue: "24",
            cwd,
            attempt: 2,
          }).pipe(
            Effect.updateService(GitHub, (service) => ({
              ...service,
              fetchGitHubIssue: Effect.fnUntraced(function* () {
                fetched = true;
                return yield* Effect.fail(
                  new GitHubRequestError({
                    message: "latest comments unavailable",
                  }),
                );
              }),
            })),
          ),
        ),
        /latest comments unavailable/,
      );
      expect(fetched).toBe(true);
    },
  );
  test("already-published attempts return before label preflight or branch work", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-published-"));
    tempDirs.push(cwd);
    await installFailingGh(cwd);
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.write(
          path.join(cwd, ".roark/runs/issue/24"),
          formatAttemptMetadata({
            attempt: 2,
            issueNumber: 24,
            branch: "roark/issue-24",
            baseBranch: "main",
            worktreePath: path.join(cwd, ".roark/worktrees/issue-24"),
            runArtifactPath: ".roark/runs/issue/24/attempts/2",
            startedAt: "2026-05-07T00:00:00.000Z",
            endedAt: "2026-05-07T00:10:00.000Z",
            outcome: "published",
          }),
        ),
      ),
    );
    await runApplicationPromise(
      runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 2 }),
    );
  });
  test("reuses workspace metadata and runs beforeRun in the attempt lifecycle", async () => {
    await Promise.resolve();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-workspace-"));
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "roark-continue-managed-"),
    );
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
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "issue",
        "# Issue\n\n<github_issue_relationships />\n",
      ),
    );
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.write(
          path.join(cwd, ".roark/runs/issue/24"),
          formatAttemptMetadata({
            attempt: 2,
            issueNumber: 24,
            branch: "roark/issue-24",
            baseBranch: "main",
            worktreePath: path.join(cwd, "legacy-worktree"),
            workspace: {
              path: workspacePath,
              strategy: "clone",
              cloneRemote: "upstream",
              createdNow: false,
            },
            runArtifactPath: workflowContext.runDirRelative,
            startedAt: "2026-05-07T00:00:00.000Z",
          }),
        ),
      ),
    );
    const calls: string[] = [];
    await assertRejects(
      runApplicationPromise(
        runAutoContinue({
          ...continueOptions,
          issue: "24",
          cwd,
          attempt: 2,
          hooks: {
            timeoutMs: 1000,
            beforeRun: "printf before > before-run.txt",
          },
        }).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            ensureGitHubLabels: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void, { existing: [], missing: [], created: [] }
              );
            }),
            fetchGitHubIssue: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                {
                  issue: {
                    number: 24,
                    title: "Issue 24",
                    labels: [{ name: "failed" }, { name: "ready-for-agent" }],
                  },
                  issueNumber: "24",
                  repo: "owner/repo",
                  fetchedAt: "now",
                  relationships: {
                    fetchedAt: "now",
                    nativeDependenciesAvailable: true,
                    blockedBy: [],
                    blocking: [],
                    bodyDeclaredBlockers: [],
                  },
                }
              );
            }),
            transitionGitHubIssueLabels: Effect.fnUntraced(function* (
              input: Parameters<
                GitHub["Service"]["transitionGitHubIssueLabels"]
              >[0],
            ) {
              yield* Effect.void;
              calls.push("transition");
              expect(input.nextLabel).toBe("busy");
              expect(input.removeLabels).toEqual(["failed", "ready-for-agent"]);
              return undefined;
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            prepareClone: Effect.fnUntraced(function* (
              input: Parameters<Workspace["Service"]["prepareClone"]>[0],
            ) {
              yield* Effect.void;
              calls.push(`prepare:${input.workspacePath ?? ""}`);
              expect(input.mode).toBe("continue");
              expect(input.workspacePath).toBe(workspacePath);
              return {
                path: workspacePath,
                metadata: {
                  path: workspacePath,
                  strategy: "clone" as const,
                  cloneRemote: "upstream",
                  createdNow: false,
                },
              };
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* () {
              yield* Effect.void;
              calls.push("runner");
              return yield* Effect.fail(new Error("triage failed"));
            }),
          ),
        ),
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("triage failed"),
    );
    expect(calls).toEqual([`prepare:${workspacePath}`, "transition", "runner"]);
    expect(
      await Bun.file(path.join(workspacePath, "before-run.txt")).text(),
    ).toBe("before");
    const metadata = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.read(path.join(cwd, ".roark/runs/issue/24"), 2),
      ),
    );
    expect(metadata.worktreePath).toBe(workspacePath);
    expect(metadata.workspace?.path).toBe(workspacePath);
    expect(metadata.outcome).toBe("errored");
  });
  test("refreshes resumed status and reuses earlier review IDs across repeated continuation", async () => {
    await Promise.resolve();
    const cwd = await mkdtemp(
      path.join(tmpdir(), "roark-continue-error-ledger-"),
    );
    tempDirs.push(cwd);
    await initGitRepo(cwd, "roark/issue-24");
    await installFakeGh(cwd, true);
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
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "issue",
        "# Issue\n\n<github_issue_relationships />\n",
      ),
    );
    await runApplicationPromise(
      writeJsonArtifact(workflowContext, "metadata", {
        issue: {
          number: 24,
          title: "Ledger comments",
          url: "https://github.com/owner/repo/issues/24",
          labels: [],
        },
      }),
    );
    await runApplicationPromise(
      writeJsonArtifact(workflowContext, "triage", triageResult()),
    );
    await runApplicationPromise(
      writeJsonArtifact(
        workflowContext,
        "implementationPlanDraft",
        implementationPlanResult(),
      ),
    );
    await runApplicationPromise(
      writeJsonArtifact(
        workflowContext,
        "implementationPlan",
        implementationPlanResult(),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "preImplementationBaseline",
        JSON.stringify({
          head: "abc",
          capturedAt: "now",
          excludes: [".roark"],
        }),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "implementationLog",
        JSON.stringify(changeReport()),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        refinementLogRef(0),
        JSON.stringify(changeReport({ summary: "Refined." })),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        reviewARef(0),
        JSON.stringify(
          reviewResult([
            reviewFinding("must-fix-current", "Fix failed after reviews"),
          ]),
        ),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        reviewBRef(0),
        JSON.stringify(reviewResult()),
      ),
    );
    for (const ref of [reviewARef(1), reviewBRef(1)]) {
      await runApplicationPromise(
        writeArtifact(workflowContext, ref, JSON.stringify(reviewResult())),
      );
    }
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.write(
          path.join(cwd, ".roark/runs/issue/24"),
          formatAttemptMetadata({
            attempt: 2,
            issueNumber: 24,
            branch: "roark/issue-24",
            baseBranch: "main",
            worktreePath: path.join(cwd, "deleted-worktree"),
            runArtifactPath: workflowContext.runDirRelative,
            startedAt: "2026-05-07T00:00:00.000Z",
            githubComments: {
              issue: {
                "attempt-start": {
                  id: 501,
                  marker: "legacy:start",
                  updatedAt: "2026-05-07T00:00:00.000Z",
                },
                "review-a-0": {
                  id: 502,
                  marker: "legacy:a",
                  updatedAt: "2026-05-07T00:00:00.000Z",
                },
                "review-b-0": {
                  id: 503,
                  marker: "legacy:b",
                  updatedAt: "2026-05-07T00:00:00.000Z",
                },
              },
            },
          }),
        ),
      ),
    );
    for (let continuation = 0; continuation < 2; continuation++) {
      await assertRejects(
        runApplicationPromise(
          runAutoContinue({ ...continueOptions, issue: "24", cwd, attempt: 2 })
            .pipe()
            .pipe(
              provideTestAgent(
                Effect.fnUntraced(function* (request) {
                  if (request.display.phaseId === "continuation-review") {
                    const saved = yield* Effect.flatMap(AttemptStore, (store) =>
                      store.read(path.join(cwd, ".roark/runs/issue/24"), 2),
                    );
                    const remote = decodeRemoteComments(
                      yield* Effect.tryPromise(() =>
                        readFile(path.join(cwd, ".git/comments.json"), "utf8"),
                      ),
                    );
                    expect(remote["501"]?.body).toContain("in progress");
                    expect(remote["501"]?.body).toContain("roark/issue-24");
                    expect(remote["501"]?.body).not.toContain("roark continue");
                    expect(
                      saved.githubComments?.issue?.["attempt-status"]?.marker,
                    ).toContain("phase=attempt-status");
                    expect(
                      saved.githubComments?.issue?.["attempt-status"]?.id,
                    ).toBe(501);
                    expect(saved.githubComments?.issue?.["review-a"]?.id).toBe(
                      502,
                    );
                    expect(saved.githubComments?.issue?.["review-b"]?.id).toBe(
                      503,
                    );
                    return yield* Effect.tryPromise(() =>
                      submitContinuation(request, continuationResult()),
                    );
                  }
                  yield* Effect.void;
                  return yield* Effect.fail(
                    new Error("fix failed after reviews"),
                  );
                }),
              ),
            ),
        ),
        (error: unknown) =>
          error instanceof Error && error.message.includes("Fix pass 1 failed"),
      );
    }
    const metadata = await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.read(path.join(cwd, ".roark/runs/issue/24"), 2),
      ),
    );
    const remote = decodeRemoteComments(
      await readFile(path.join(cwd, ".git/comments.json"), "utf8"),
    );
    for (const phase of ["attempt-status", "review-a", "review-b"]) {
      expect(
        Object.values(remote).filter((comment) =>
          comment.body.includes(`phase=${phase} -->`),
        ),
      ).toHaveLength(1);
    }
    expect(remote["502"]?.body).toContain("Review A pass 1");
    expect(remote["503"]?.body).toContain("Review B pass 1");
    expect(metadata.outcome).toBe("errored");
    expect(metadata.worktreePath).toBe(autorunWorktreePath(cwd, 24));
    expect(metadata.githubComments?.issue?.["review-a"]?.id).toBe(502);
    expect(metadata.githubComments?.issue?.["review-b"]?.id).toBe(503);
  });
  test("serializes concurrent continues for the same issue across attempts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-continue-lock-"));
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "roark-continue-lock-workspace-"),
    );
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
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "issue",
        "# Issue\n\n<github_issue_relationships />\n",
      ),
    );
    await runApplicationPromise(
      Effect.flatMap(AttemptStore, (store) =>
        store.write(
          path.join(cwd, ".roark/runs/issue/24"),
          formatAttemptMetadata({
            attempt: 2,
            issueNumber: 24,
            branch: "roark/issue-24",
            baseBranch: "main",
            worktreePath: workspacePath,
            workspace: {
              path: workspacePath,
              strategy: "clone",
              cloneRemote: "origin",
              createdNow: false,
            },
            runArtifactPath: workflowContext.runDirRelative,
            startedAt: "2026-05-07T00:00:00.000Z",
          }),
        ),
      ),
    );
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const githubOverrides = {
      ensureGitHubLabels: Effect.fnUntraced(function* () {
        return (yield* Effect.void, { existing: [], missing: [], created: [] });
      }),
    };
    const workspaceOverrides = {
      prepareClone: Effect.fnUntraced(function* () {
        yield* Effect.void;
        return {
          path: workspacePath,
          metadata: {
            path: workspacePath,
            strategy: "clone" as const,
            cloneRemote: "origin",
            createdNow: false,
          },
        };
      }),
    };
    const first = runApplicationPromise(
      runAutoContinue({
        ...continueOptions,
        issue: "24",
        cwd,
        attempt: 2,
      }).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          ...githubOverrides,
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          ...workspaceOverrides,
        })),
        provideTestAgent(
          Effect.fnUntraced(function* () {
            enteredFirst();
            yield* Effect.tryPromise({
              try: () => release,
              catch: (error) => error,
            });
            return yield* Effect.fail(new Error("stop first continue"));
          }),
        ),
      ),
    );
    await firstEntered;
    await assertRejects(
      runApplicationPromise(
        runAutoContinue({
          ...continueOptions,
          issue: "24",
          cwd,
          attempt: 3,
        }).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            ...githubOverrides,
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            ...workspaceOverrides,
          })),
          provideTestAgent(
            Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.fail(
                new Error("second continue should not run lifecycle"),
              );
            }),
          ),
        ),
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "roark continue issue #24 attempt 3 is already running",
        ),
    );
    releaseFirst();
    await assertRejects(
      first,
      (error: unknown) =>
        error instanceof Error && error.message.includes("stop first continue"),
    );
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
  await writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
echo "gh should not be called" >&2
exit 99
`,
    "utf8",
  );
  await chmod(path.join(binDir, "gh"), 0o755);
  process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}
async function installFakeGh(cwd: string, stateful = false): Promise<void> {
  if (stateful) {
    const statePath = path.join(cwd, ".git/comments.json");
    await writeFile(
      statePath,
      JSON.stringify(
        Object.fromEntries(
          [501, 502, 503].map((id) => [
            id,
            {
              id,
              body: "Stopped. Run roark continue",
              user: { login: "roark" },
            },
          ]),
        ),
      ),
    );
    const scriptPath = path.join(cwd, ".git/comments.cjs");
    await writeFile(
      scriptPath,
      `
const fs = require("node:fs");
const file = ${JSON.stringify(statePath)};
const comments = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const endpoint = args[1];
if (endpoint === "user") { console.log("roark"); process.exit(0); }
const method = args[args.indexOf("--method") + 1];
let result;
if (method === "PATCH" || method === "POST") {
  const id = method === "PATCH" ? Number(endpoint.split("/").pop()) : Math.max(...Object.keys(comments).map(Number)) + 1;
  result = { id, body: args.find(a => a.startsWith("body=")).slice(5), user: { login: "roark" } };
  comments[id] = result;
  fs.writeFileSync(file, JSON.stringify(comments));
} else if (args.includes("--paginate")) result = [Object.values(comments)];
else result = comments[endpoint.split("/").pop()];
const decorate = c => ({ ...c, html_url: "https://github.com/owner/repo/issues/24#issuecomment-" + c.id, created_at: "2026-05-07T00:00:00Z", updated_at: "2026-05-07T00:00:00Z" });
console.log(JSON.stringify(Array.isArray(result) ? result.map(page => page.map(decorate)) : decorate(result)));
`,
    );
  }
  const binDir = path.join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '{"number":24,"title":"Issue 24","body":"","state":"OPEN","labels":[{"name":"failed"},{"name":"ready-for-agent"}],"assignees":[],"milestone":null,"url":"https://github.com/owner/repo/issues/24","comments":[]}\n'
  exit 0
fi
if [ "$1" = "api" ]; then
  ${stateful ? `exec "${process.execPath}" "${path.join(cwd, ".git/comments.cjs")}" "$@"` : ""}
  if [ "$3" = "--paginate" ]; then
    printf '[]\\n'
    exit 0
  fi
  printf '{"id":4242,"html_url":"https://github.com/owner/repo/issues/24#issuecomment-4242"}\\n'
  exit 0
fi
exit 0
`,
    "utf8",
  );
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
  if (exitCode !== 0)
    throw new Error(
      `${args.join(" ")} failed with ${exitCode}: ${stderr || stdout}`,
    );
}
