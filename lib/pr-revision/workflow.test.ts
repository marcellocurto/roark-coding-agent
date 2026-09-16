import { Fiber, Exit, Cause } from "effect";
import { Schema, Effect, PlatformError } from "effect";
import { ProcessExecutionError } from "../cli/process.ts";
import { runPrRevision } from "./workflow.ts";
import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import { GitHub } from "../github/service.ts";
import { Workspace } from "../autorun/workspace-service.ts";
import { WorkspaceCommandError } from "../autorun/workspace.ts";
import { RevisionReporting } from "./comments.ts";
import { provideTestAgent } from "../testing/agents.ts";
import { Verification } from "../runtime/services.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import { Presenter } from "../presentation/presenter.ts";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { type RevisePrCliOptions } from "../cli/args.ts";
import { type PullRequestFeedback } from "../github/pr.ts";
import {
  reviewFinding,
  reviewResult,
  submitReview,
} from "../testing/reviews.ts";
import {
  revisionPlanResult,
  submitRevisionPlan,
} from "../testing/revision-plans.ts";
import {
  revisionExecutionResult,
  submitRevisionExecution,
} from "../testing/revision-executions.ts";
import { type TerminalStream } from "../presentation/terminal.ts";
import { parseRevisionExecutionResultJson } from "./execution.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function trackedTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
async function tempGitRepo(): Promise<string> {
  const cwd = await trackedTempDir("roark-pr-workflow-");
  await Bun.spawn(["git", "init"], { cwd }).exited;
  await Bun.spawn(["git", "config", "user.email", "roark@example.invalid"], {
    cwd,
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "Roark Test"], { cwd }).exited;
  return cwd;
}
async function isolatedWorkspace(
  setup?: (workspace: string) => Promise<void>,
): Promise<{
  workspace: string;
  prepareWorkspace: Workspace["Service"]["preparePrRevision"];
}> {
  const workspace = await tempGitRepo();
  await setup?.(workspace);
  return {
    workspace,
    prepareWorkspace: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return {
        path: workspace,
        metadata: {
          path: workspace,
          strategy: "clone" as const,
          cloneRemote: "origin",
          createdNow: false,
        },
      };
    }),
  };
}
async function run(args: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${args.join(" ")} failed\n${stderr || stdout}`);
}
async function runOutput(args: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${args.join(" ")} failed\n${stderr || stdout}`);
  return stdout;
}
function options(
  cwd: string,
  overrides: Partial<RevisePrCliOptions> = {},
): RevisePrCliOptions {
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
      baseRefOid: "base123",
      headRefOid: "head123",
      baseRepository: "owner/repo",
      headRepository: "owner/repo",
    },
    comments: [],
    plannerComments: [],
    reviewThreads: [],
    excludedRoarkSummaryCommentIds: [],
  };
}
function freshReviewComment(): string {
  return [
    "<!-- roark:pr=12 phase=pr-review reviewer=a -->",
    "## Review A: Spec and Correctness",
    "",
    "**Changes requested.**",
    "",
    "### Preserve the public response contract",
    "",
    "The changed handler omits the required field, so clients cannot parse successful responses. Restore the field before merging.",
    "",
  ].join("\n");
}
describe("runPrRevision", () => {
  test.each(["approve", "fixes-required", "blocked"] as const)(
    "presents structured revision outcomes for %s without interpreting report headings",
    async (disposition) => {
      const control = await tempGitRepo();
      const { prepareWorkspace } = await isolatedWorkspace();
      let output = "";
      const result = await runWithPresenter(
        new Presenter({
          stream: {
            isTTY: false,
            write(chunk) {
              output += chunk;
            },
          },
        }),
        runPrRevision(options(control, { comment: false })).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: () => Effect.succeed(feedback()),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          Effect.provideService(RevisionReporting, {
            postSummary: () => Effect.void,
          }),
          Effect.provideService(Verification, {
            execute: ({ command }) =>
              Effect.succeed({
                command,
                ok: false,
                exitCode: 127,
                stdout: "",
                stderr: "sh: missing-command: command not found",
              }),
          }),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              if (request.display.phaseId === "pr-revision-revision-plan")
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(
                      request,
                      revisionPlanResult(
                        "revise",
                        disposition === "approve"
                          ? {
                              additionalSections: [
                                { heading: "Verdict", items: ["needs-human"] },
                              ],
                            }
                          : {},
                      ),
                    ),
                  catch: (error) => error,
                });
              if (request.fileEditingToolsEnabled)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(
                      request,
                      revisionExecutionResult(
                        disposition === "fixes-required"
                          ? {
                              summary:
                                "Completed the requested work.\n\n## Status\nneeds-human",
                            }
                          : {},
                      ),
                    ),
                  catch: (error) => error,
                });
              const findings =
                disposition === "approve"
                  ? []
                  : [
                      reviewFinding(
                        disposition === "blocked"
                          ? "external-blocker"
                          : "must-fix-current",
                      ),
                    ];
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult(findings)),
                catch: (error) => error,
              });
            }),
          ),
        ),
      );
      expect(result.planStatus).toBe("revise");
      expect(result.reviewVerdict).toBe(disposition);
      expect(output).toContain(
        "DONE PR #12 · Revision plan · revision 1 · revise ·",
      );
      expect(output).toContain(
        "DONE PR #12 · Revision implementation · revision 1 · completed ·",
      );
      expect(output).toContain(
        `DONE PR #12 · Revision review · revision 1 · ${disposition} ·`,
      );
    },
  );
  test("sets the preparation title while workspace preparation is pending", async () => {
    const cwd = process.cwd();
    let output = "";
    const stream: TerminalStream = {
      isTTY: true,
      columns: 80,
      write(chunk) {
        output += chunk;
      },
    };
    return runWithPresenter(
      new Presenter({ stream, env: { TERM: "xterm" } }),
      Effect.gen(function* () {
        let preparationStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          preparationStarted = resolve;
        });
        let rejectPreparation: ((error: Error) => void) | undefined;
        const pendingPreparation = new Promise<never>((_, reject) => {
          rejectPreparation = reject;
        });
        const running = yield* Effect.forkScoped(
          runPrRevision(options(cwd, { yes: true })).pipe(
            Effect.updateService(GitHub, (service) => ({
              ...service,
              fetchPullRequestFeedback: Effect.fnUntraced(function* () {
                return yield* Effect.sync(() => feedback());
              }),
            })),
            Effect.updateService(Workspace, (service) => ({
              ...service,
              preparePrRevision: Effect.fnUntraced(function* () {
                preparationStarted?.();
                return yield* Effect.tryPromise({
                  try: () => pendingPreparation,
                  catch: (error) => new WorkspaceCommandError({ cause: error }),
                });
              }),
            })),
          ),
        );
        yield* Effect.tryPromise({
          try: () => started,
          catch: (error) => error,
        });
        const outputWhilePending = output;
        rejectPreparation?.(new Error("stop after title assertion"));
        const exit = yield* Fiber.await(running);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            "stop after title assertion",
          );
        expect(outputWhilePending).toContain("PR #12 · Revision preparation");
      }),
    );
  });
  test("shared artifact locations retain canonical artifacts after a no-op revision", async () => {
    await Promise.resolve();
    const cwd = await tempGitRepo();
    let workspacePrepared = false;
    let commentCalled = false;
    const plan = revisionPlanResult("no-action-needed", {
      additionalSections: [
        {
          heading: "Why no revision is needed",
          items: [
            "The current head already contains the behavior requested by the review.",
          ],
        },
      ],
    });
    const result = await runApplicationPromise(
      runPrRevision(options(cwd)).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          fetchPullRequestFeedback: Effect.fnUntraced(function* () {
            return yield* Effect.sync(() => feedback());
          }),
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          preparePrRevision: Effect.fnUntraced(function* () {
            workspacePrepared = true;
            return yield* Effect.succeed({
              path: cwd,
              metadata: {
                path: cwd,
                strategy: "clone" as const,
                cloneRemote: "origin",
                createdNow: false,
              },
            });
          }),
        })),
        Effect.updateService(RevisionReporting, (service) => ({
          ...service,
          postSummary: Effect.fnUntraced(function* () {
            yield* Effect.void;
            commentCalled = true;
          }),
        })),
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            return yield* Effect.tryPromise({
              try: () => submitRevisionPlan(request, plan),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(result.outcome).toBe("no-action-needed");
    expect(workspacePrepared).toBe(true);
    expect(commentCalled).toBe(true);
    expect(result.context.agentCwd).toBe(result.context.controlCwd);
    expect(result.context.revisionDir).toBe(result.context.agentRevisionDir);
    expect(result.context.revisionDirRelative).toBe(
      ".roark/runs/pr/12/revision-1",
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(result.context.revisionDir, "revision-plan.json"),
          "utf8",
        ),
      ),
    ).toEqual(plan);
    expect(
      await readFile(
        path.join(result.context.revisionDir, "revision-plan.md"),
        "utf8",
      ),
    ).toContain("## Status\nno-action-needed");
    expect(
      await readFile(
        path.join(result.context.revisionDir, "revision-plan.md"),
        "utf8",
      ),
    ).toContain("## Why no revision is needed");
  });
  test("no-action-needed isolated revisions remove mirrored workspace artifacts", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { workspace, prepareWorkspace } = await isolatedWorkspace();
    let commentCalls = 0;
    const result = await runApplicationPromise(
      runPrRevision(options(control)).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          fetchPullRequestFeedback: Effect.fnUntraced(function* () {
            return yield* Effect.sync(() => feedback());
          }),
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          preparePrRevision: prepareWorkspace,
        })),
        Effect.updateService(RevisionReporting, (service) => ({
          ...service,
          postSummary: Effect.fnUntraced(function* () {
            yield* Effect.void;
            commentCalls++;
          }),
        })),
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            return yield* Effect.tryPromise({
              try: () =>
                submitRevisionPlan(
                  request,
                  revisionPlanResult("no-action-needed"),
                ),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(result.outcome).toBe("no-action-needed");
    expect(result.context.agentCwd).toBe(workspace);
    expect(
      await Bun.file(
        path.join(result.context.revisionDir, "metadata.json"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        path.join(result.context.agentRevisionDir, "metadata.json"),
      ).exists(),
    ).toBe(false);
    expect(commentCalls).toBe(1);
    expect(
      (await runOutput(["git", "status", "--porcelain"], workspace)).trim(),
    ).toBe("");
  });
  test("no-action-needed respects --no-comment", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    let commentCalled = false;
    const result = await runApplicationPromise(
      runPrRevision(options(control, { comment: false })).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          fetchPullRequestFeedback: Effect.fnUntraced(function* () {
            return yield* Effect.sync(() => feedback());
          }),
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          preparePrRevision: prepareWorkspace,
        })),
        Effect.updateService(RevisionReporting, (service) => ({
          ...service,
          postSummary: Effect.fnUntraced(function* () {
            yield* Effect.void;
            commentCalled = true;
          }),
        })),
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            return yield* Effect.tryPromise({
              try: () =>
                submitRevisionPlan(
                  request,
                  revisionPlanResult("no-action-needed"),
                ),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(result.outcome).toBe("no-action-needed");
    expect(commentCalled).toBe(false);
  });
  test("passes a published fresh-review finding into revision planning", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    const reviewComment = freshReviewComment();
    let plannerSawFinding = false;
    const result = await runApplicationPromise(
      runPrRevision(options(control, { comment: false })).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          fetchPullRequestFeedback: Effect.fnUntraced(function* () {
            yield* Effect.void;
            const value = feedback();
            const comment = { author: "roark-bot", body: reviewComment };
            return {
              ...value,
              comments: [comment],
              plannerComments: [comment],
            };
          }),
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          preparePrRevision: prepareWorkspace,
        })),
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            const artifact = yield* Effect.tryPromise({
              try: () =>
                readFile(
                  path.join(
                    request.cwd,
                    ".roark",
                    "runs",
                    "pr",
                    "12",
                    "revision-1",
                    "pr-feedback.json",
                  ),
                  "utf8",
                ),
              catch: (error) => error,
            });
            plannerSawFinding =
              artifact.includes("Preserve the public response contract") &&
              artifact.includes('"id": "comment:1"') &&
              request.prompt.includes(
                "pr-feedback.json as the canonical PR feedback artifact",
              ) &&
              !request.prompt.includes("- pr-feedback.md");
            return yield* Effect.tryPromise({
              try: () =>
                submitRevisionPlan(
                  request,
                  revisionPlanResult("no-action-needed"),
                ),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(result.outcome).toBe("no-action-needed");
    expect(plannerSawFinding).toBe(true);
  });
  test("allocates revisions across the control checkout and isolated workspace", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace(async (workspace) => {
      await mkdir(
        path.join(workspace, ".roark", "runs", "pr", "12", "revision-1"),
        { recursive: true },
      );
    });
    let commentCalls = 0;
    const result = await runApplicationPromise(
      runPrRevision(options(control)).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          fetchPullRequestFeedback: Effect.fnUntraced(function* () {
            return yield* Effect.sync(() => feedback());
          }),
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          preparePrRevision: prepareWorkspace,
        })),
        Effect.updateService(RevisionReporting, (service) => ({
          ...service,
          postSummary: Effect.fnUntraced(function* () {
            yield* Effect.void;
            commentCalls++;
          }),
        })),
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            return yield* Effect.tryPromise({
              try: () =>
                submitRevisionPlan(
                  request,
                  revisionPlanResult("no-action-needed"),
                ),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(result.outcome).toBe("no-action-needed");
    expect(result.context.revision).toBe(2);
    expect(result.context.revisionDirRelative).toBe(
      ".roark/runs/pr/12/revision-2",
    );
    expect(commentCalls).toBe(1);
  });
  test("needs-human stops before enabling file-editing tools and posts one summary by default", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    const fileEditingToolCalls: boolean[] = [];
    let commentCalled = false;
    let dispositionDetails: string[] | undefined;
    const result = await runApplicationPromise(
      runPrRevision(options(control)).pipe(
        Effect.updateService(GitHub, (service) => ({
          ...service,
          fetchPullRequestFeedback: Effect.fnUntraced(function* () {
            return yield* Effect.sync(() => feedback());
          }),
        })),
        Effect.updateService(Workspace, (service) => ({
          ...service,
          preparePrRevision: prepareWorkspace,
        })),
        Effect.updateService(RevisionReporting, (service) => ({
          ...service,
          postSummary: Effect.fnUntraced(function* (
            summary: Parameters<RevisionReporting["Service"]["postSummary"]>[0],
          ) {
            yield* Effect.void;
            commentCalled = true;
            dispositionDetails = summary.dispositions.map(
              (item) => item.details,
            );
          }),
        })),
        provideTestAgent(
          Effect.fnUntraced(function* (request) {
            yield* Effect.void;
            fileEditingToolCalls.push(request.fileEditingToolsEnabled);
            return yield* Effect.tryPromise({
              try: () =>
                submitRevisionPlan(
                  request,
                  revisionPlanResult("needs-human", {
                    feedbackItems: [
                      {
                        id: "pr:12",
                        sourceIds: ["pr:12"],
                        summary: "Feedback needs an explicit product decision.",
                        classification: "needs-human",
                        rationale: "Please decide.",
                      },
                    ],
                  }),
                ),
              catch: (error) => error,
            });
          }),
        ),
      ),
    );
    expect(result.outcome).toBe("needs-human");
    expect(fileEditingToolCalls).toEqual([false]);
    expect(commentCalled).toBe(true);
    expect(dispositionDetails).toEqual(["Please decide."]);
  });
  test("honors an explicit thinking override across revision agents", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    const thinkingLevels: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(
          options(control, { thinkingLevel: "medium" }),
        ).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          Effect.updateService(RevisionReporting, (service) => ({
            ...service,
            postSummary: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              thinkingLevels.push(request.thinkingLevel);
              if (request.fileEditingToolsEnabled)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(request, revisionExecutionResult()),
                  catch: (error) => error,
                });
              if (thinkingLevels.length === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: ({ command }) =>
            Effect.succeed({
              ok: false,
              command,
              exitCode: 127,
              stdout: "",
              stderr: "sh: missing-command: command not found",
            }),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(result.outcome).toBe("verification-failed");
    expect(thinkingLevels).toEqual(["medium", "medium", "medium"]);
  });
  test("non-repairable verification failure leaves revision unpublished without a fix pass", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    let commentCalled = false;
    let calls = 0;
    let writableCalls = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(options(control, { maxFixPasses: 3 })).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          Effect.updateService(RevisionReporting, (service) => ({
            ...service,
            postSummary: Effect.fnUntraced(function* () {
              yield* Effect.void;
              commentCalled = true;
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              calls++;
              if (request.fileEditingToolsEnabled) {
                writableCalls++;
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(request, revisionExecutionResult()),
                  catch: (error) => error,
                });
              }
              if (calls === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              if (calls === 5) {
                yield* Effect.tryPromise({
                  try: () =>
                    Bun.write(
                      path.join(
                        request.cwd,
                        ".roark",
                        "runs",
                        "pr",
                        "12",
                        "revision-1",
                        "revision-log-fix-pass-1.md",
                      ),
                      "# Revision Log\n\n## Addressed Must Fix Current Items\n- Malicious Markdown override.\n",
                    ),
                  catch: (error) => error,
                });
              }
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: ({ command }) =>
            Effect.succeed({
              ok: false,
              command,
              exitCode: 127,
              stdout: "",
              stderr: "sh: missing-command: command not found",
            }),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(result.outcome).toBe("verification-failed");
    expect(writableCalls).toBe(1);
    expect(commentCalled).toBe(true);
    expect(
      existsSync(
        path.join(result.context.revisionDir, "verification-before-fix-1.md"),
      ),
    ).toBe(false);
  });
  test("verification runner exceptions propagate through PR revision", async () => {
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    const failure = new ProcessExecutionError({
      args: ["bun", "test"],
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "verification runner failed",
      }),
    });
    let calls = 0;
    const running = Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(options(control, { comment: false })).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              calls++;
              if (request.fileEditingToolsEnabled) {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(request, revisionExecutionResult()),
                  catch: (error) => error,
                });
              }
              if (calls === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: () => Effect.fail(failure),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    let thrown: unknown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });
  test("repairable verification failure runs a fix pass, review, then publishes after verification passes", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const remote = await trackedTempDir("roark-pr-remote-");
    await Bun.spawn(["git", "init", "--bare"], { cwd: remote }).exited;
    await run(["git", "remote", "add", "origin", remote], control);
    const { prepareWorkspace } = await isolatedWorkspace(async (workspace) => {
      await run(["git", "checkout", "-b", "feature/pr-12"], workspace);
    });
    let calls = 0;
    let verificationCalls = 0;
    let commentCalls = 0;
    let finalDispositions:
      | {
          feedbackId: string;
          details: string;
        }[]
      | undefined;
    const writableArtifacts: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(options(control, { maxFixPasses: 3 })).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          Effect.updateService(RevisionReporting, (service) => ({
            ...service,
            postSummary: Effect.fnUntraced(function* (
              summary: Parameters<
                RevisionReporting["Service"]["postSummary"]
              >[0],
            ) {
              yield* Effect.void;
              commentCalls++;
              finalDispositions = summary.dispositions.map(
                ({ feedbackId, details }) => ({ feedbackId, details }),
              );
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              calls++;
              if (request.fileEditingToolsEnabled) {
                writableArtifacts.push(request.prompt);
                yield* Effect.tryPromise({
                  try: () =>
                    Bun.write(
                      path.join(request.cwd, "fixed.txt"),
                      `fixed ${writableArtifacts.length}\n`,
                    ),
                  catch: (error) => error,
                });
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(
                      request,
                      revisionExecutionResult({
                        feedbackDispositions: [
                          {
                            feedbackId: "pr:12",
                            status: "addressed",
                            details: `Fixed pass ${writableArtifacts.length}.`,
                          },
                        ],
                      }),
                    ),
                  catch: (error) => error,
                });
              }
              if (calls === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: ({ command }) =>
            Effect.sync(() => {
              verificationCalls++;
              return verificationCalls === 1
                ? {
                    ok: false,
                    command,
                    exitCode: 1,
                    stdout: "",
                    stderr: "type error",
                  }
                : { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" };
            }),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(result.outcome).toBe("published");
    expect(verificationCalls).toBe(2);
    expect(writableArtifacts).toHaveLength(2);
    expect(writableArtifacts[1]).toContain("/revision-review.json");
    expect(writableArtifacts[1]).not.toContain("revision-review.md");
    expect(writableArtifacts[1]).not.toContain("Markdown companion");
    expect(commentCalls).toBe(1);
    expect(finalDispositions).toEqual([
      { feedbackId: "pr:12", details: "Fixed pass 2." },
    ]);
    const canonicalExecution = Effect.runSync(
      parseRevisionExecutionResultJson(
        await readFile(
          path.join(result.context.revisionDir, "revision-log-fix-pass-1.json"),
          "utf8",
        ),
      ),
    );
    expect(canonicalExecution.feedbackDispositions[0]?.details).toBe(
      "Fixed pass 2.",
    );
    expect(
      existsSync(
        path.join(result.context.revisionDir, "revision-log-fix-pass-1.md"),
      ),
    ).toBe(true);
    const archivedFailure = path.join(
      result.context.revisionDir,
      "verification-before-fix-1.md",
    );
    expect(existsSync(archivedFailure)).toBe(true);
    expect(await readFile(archivedFailure, "utf8")).toContain("type error");
    await run(
      ["git", "ls-remote", "--exit-code", "origin", "feature/pr-12"],
      control,
    );
  });
  test("review and verification repairs share the fix-pass budget", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const { prepareWorkspace } = await isolatedWorkspace();
    let calls = 0;
    let writableCalls = 0;
    let verificationCalls = 0;
    let commentCalls = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(options(control, { maxFixPasses: 1 })).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          Effect.updateService(RevisionReporting, (service) => ({
            ...service,
            postSummary: Effect.fnUntraced(function* () {
              yield* Effect.void;
              commentCalls++;
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              yield* Effect.void;
              calls++;
              if (request.fileEditingToolsEnabled) {
                writableCalls++;
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(request, revisionExecutionResult()),
                  catch: (error) => error,
                });
              }
              if (calls === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              if (calls === 3) {
                return yield* Effect.tryPromise({
                  try: () =>
                    submitReview(
                      request,
                      reviewResult([
                        reviewFinding(
                          "must-fix-current",
                          "Address reviewer feedback.",
                        ),
                      ]),
                    ),
                  catch: (error) => error,
                });
              }
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: ({ command }) =>
            Effect.sync(() => {
              verificationCalls++;
              return {
                ok: false,
                command,
                exitCode: 1,
                stdout: "",
                stderr: "test failed",
              };
            }),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(result.outcome).toBe("verification-failed");
    expect(writableCalls).toBe(2);
    expect(verificationCalls).toBe(1);
    expect(commentCalls).toBe(1);
    expect(
      existsSync(
        path.join(result.context.revisionDir, "verification-before-fix-1.md"),
      ),
    ).toBe(false);
    const metadata = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ verificationFailureReason: Schema.String }),
      ),
    )(
      await readFile(
        path.join(result.context.revisionDir, "metadata.json"),
        "utf8",
      ),
    );
    expect(metadata.verificationFailureReason).toContain(
      "Verification failed after 1 fix passes",
    );
  });
  test("successful isolated revision preserves the control checkout, uses configured remote, and excludes ignored run artifacts", async () => {
    const root = await trackedTempDir("roark-pr-isolated-");
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(
          options(control, {
            remote: "upstream",
            workspace: {
              root: workspaceRoot,
              strategy: "clone" as const,
              cloneRemote: "origin",
              clone: { filter: null, depth: null },
              copyToWorktree: [],
            },
            hooks: {
              timeoutMs: 10000,
              afterCreate:
                "git config user.email roark@example.invalid && git config user.name 'Roark Test'",
            },
          }),
        ).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(RevisionReporting, (service) => ({
            ...service,
            postSummary: Effect.fnUntraced(function* () {
              yield* Effect.void;
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              calls++;
              agentCwds.push(request.cwd);
              if (request.fileEditingToolsEnabled) {
                yield* Effect.tryPromise({
                  try: () =>
                    writeFile(
                      path.join(request.cwd, "fixed.txt"),
                      "fixed in workspace\n",
                      "utf8",
                    ),
                  catch: (error) => error,
                });
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(request, revisionExecutionResult()),
                  catch: (error) => error,
                });
              }
              if (calls === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: ({ command, cwd }) =>
            Effect.sync(() => {
              verificationCwds.push(cwd);
              return {
                ok: true,
                command,
                exitCode: 0,
                stdout: "ok",
                stderr: "",
              };
            }),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(result.outcome).toBe("published");
    expect(
      (await runOutput(["git", "branch", "--show-current"], control)).trim(),
    ).toBe("main");
    expect(await Bun.file(path.join(control, "fixed.txt")).exists()).toBe(
      false,
    );
    expect(agentCwds.every((cwd) => cwd === result.context.agentCwd)).toBe(
      true,
    );
    expect(result.context.agentCwd).not.toBe(control);
    expect(verificationCwds).toEqual([result.context.agentCwd]);
    expect(
      await Bun.file(
        path.join(result.context.agentRevisionDir, "metadata.json"),
      ).exists(),
    ).toBe(true);
    const pushedTree = await runOutput(
      [
        "git",
        "--git-dir",
        remote,
        "ls-tree",
        "-r",
        "--name-only",
        "feature/pr-12",
      ],
      root,
    );
    expect(pushedTree).toContain("fixed.txt");
    expect(pushedTree).not.toContain(
      ".roark/runs/pr/12/revision-1/metadata.json",
    );
    expect(pushedTree).not.toContain(".roark/runs");
  });
  test("successful verification commits, pushes, and comments once", async () => {
    await Promise.resolve();
    const control = await tempGitRepo();
    const remote = await trackedTempDir("roark-pr-remote-");
    await Bun.spawn(["git", "init", "--bare"], { cwd: remote }).exited;
    await run(["git", "remote", "add", "origin", remote], control);
    const { prepareWorkspace } = await isolatedWorkspace(async (workspace) => {
      await run(["git", "checkout", "-b", "feature/pr-12"], workspace);
    });
    let calls = 0;
    let commentCalls = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPrRevision(options(control)).pipe(
          Effect.updateService(GitHub, (service) => ({
            ...service,
            fetchPullRequestFeedback: Effect.fnUntraced(function* () {
              return yield* Effect.sync(() => feedback());
            }),
          })),
          Effect.updateService(Workspace, (service) => ({
            ...service,
            preparePrRevision: prepareWorkspace,
          })),
          Effect.updateService(RevisionReporting, (service) => ({
            ...service,
            postSummary: Effect.fnUntraced(function* () {
              yield* Effect.void;
              commentCalls++;
            }),
          })),
          provideTestAgent(
            Effect.fnUntraced(function* (request) {
              calls++;
              if (request.fileEditingToolsEnabled) {
                yield* Effect.tryPromise({
                  try: () =>
                    Bun.write(path.join(request.cwd, "fixed.txt"), "fixed\n"),
                  catch: (error) => error,
                });
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionExecution(request, revisionExecutionResult()),
                  catch: (error) => error,
                });
              }
              if (calls === 1)
                return yield* Effect.tryPromise({
                  try: () =>
                    submitRevisionPlan(request, revisionPlanResult("revise")),
                  catch: (error) => error,
                });
              return yield* Effect.tryPromise({
                try: () => submitReview(request, reviewResult()),
                catch: (error) => error,
              });
            }),
          ),
        );
      }).pipe(
        Effect.provideService(Verification, {
          execute: ({ command }) =>
            Effect.succeed({
              ok: true,
              command,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            }),
        }),
        Effect.provide(applicationLayer),
      ),
    );
    expect(result.outcome).toBe("published");
    expect(commentCalls).toBe(1);
    expect(result.context.agentCwd).not.toBe(control);
    expect(await Bun.file(path.join(control, "fixed.txt")).exists()).toBe(
      false,
    );
    const log = Bun.spawn(["git", "log", "--oneline", "-1"], {
      cwd: result.context.agentCwd,
      stdout: "pipe",
    });
    expect(await new Response(log.stdout).text()).toContain(
      "roark: revise PR #12 (revision 1)",
    );
    await run(
      ["git", "ls-remote", "--exit-code", "origin", "feature/pr-12"],
      control,
    );
  });
});
