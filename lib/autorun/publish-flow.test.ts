import { GitHub } from "../github/service.ts";
import { GitHubRequestError } from "../github/errors.ts";
import { presentAutorunOutcome } from "../../roark.ts";
import { publishIssueLedgerComment } from "./ledger-comments.ts";
import type { AttemptMetadata } from "./attempts.ts";
import { Schema, Effect, PlatformError } from "effect";
import {
  readArtifact,
  writeArtifact,
  writeJsonArtifact,
  fixLogRef,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { PrReviewError } from "../pr-review/workflow.ts";
import {
  runApplicationPromise,
  applicationLayer,
} from "../runtime/application.ts";
import { Verification } from "../runtime/services.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import { Presenter } from "../presentation/presenter.ts";
import { ProcessExecutionError } from "../cli/process.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import {
  handleNonPublish,
  createReviewerIssuesAfterPr,
  planVerificationRepair,
  runPublishGate,
} from "./publish-flow.ts";
import { runVerification, type VerificationResult } from "./verification.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import { type ReviewFinding } from "../review/result.ts";
import { readinessResult } from "../testing/workflow-results.ts";
import { changeReport } from "../testing/change-reports.ts";
import { type TerminalStream } from "../presentation/terminal.ts";
import { type ReviewPrCliOptions } from "../cli/args.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("verification repair planning", () => {
  test.each([true, false])(
    "failure reports preserve current GitHub publication=%s",
    async (published) => {
      const context = await tempContext(1);
      const metadata: AttemptMetadata = attemptMetadata(context);
      const issueUrl = "https://github.com/owner/repo/issues/1";
      metadata.githubComments = {
        issue: {
          "attempt-status": {
            id: 98,
            url: `${issueUrl}#issuecomment-98`,
            marker: "old",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      };
      await runApplicationPromise(
        writeArtifact(
          context,
          "verification",
          "# Verification\n\nDependency command unavailable",
        ),
      );
      let output = "";
      await runWithPresenter(
        new Presenter({
          stream: {
            isTTY: true,
            columns: 40,
            write(chunk) {
              output += chunk;
            },
          },
          env: { TERM: "xterm" },
          titleEnabled: false,
        }),
        Effect.gen(function* () {
          const report = yield* handleNonPublish({
            options: {
              cwd: context.controlCwd,
              repo: "owner/repo",
              verifyCommand: "bun test",
              failureLabel: "failed",
              successLabel: "done",
              inProgressLabel: "busy",
              remote: "origin",
              baseBranch: "main",
            },
            issue: { number: 1, title: "Issue", url: issueUrl },
            workflowContext: context,
            attemptMetadata: metadata,
            attemptMetadataPath: `${context.runDirRelative}/attempt.json`,
            decision: {
              publish: false,
              phase: "verification",
              reason: "Dependency command unavailable",
              artifactPath: "verification.md",
            },
          });
          yield* presentAutorunOutcome({
            issueNumber: 1,
            outcome: "failed-verification",
            outcomeDetail: "Verification failed",
            report,
          });
        }).pipe(
          Effect.updateService(GitHub, (github) => ({
            ...github,
            addIssueLabel: () => Effect.void,
            removeIssueLabel: () => Effect.void,
            postOrUpdateIssueCommentByMarker: (input) => {
              expect(input.existingCommentId).toBe(98);
              expect(input.marker).toContain("phase=attempt-status");
              return published
                ? Effect.succeed({
                    id: 99,
                    url: `${issueUrl}#issuecomment-99`,
                    marker: input.marker,
                  })
                : Effect.fail(
                    new GitHubRequestError({ message: "GitHub unavailable" }),
                  );
            },
          })),
        ),
      );
      expect(output).toContain(
        `${issueUrl}${published ? "#issuecomment-99" : ""}\n`,
      );
      expect(output).not.toContain("#issuecomment-98");
      expect(metadata.githubComments.issue?.["attempt-status"]?.id).toBe(
        published ? 99 : 98,
      );
      expect(output).toContain("reason: Dependency command unavailable");
      expect(output).toContain(`${context.runDirRelative}/verification.md\n`);
      expect(output.includes("Could not post the report to GitHub")).toBe(
        !published,
      );
    },
  );
  test("archives failed verification and schedules the next shared fix pass", async () => {
    const context = await tempContext(2);
    const repair = await runApplicationPromise(
      planVerificationRepair(context, failedVerification(1)),
    );
    expect(repair).toEqual({ pass: 1 });
    expect(
      await runApplicationPromise(
        readArtifact(context, { name: "verificationBeforeFix", pass: 1 }),
      ),
    ).toContain("## Exit Code\n1");
  });
  test("uses the next pass after reviewer-driven fixes", async () => {
    const context = await tempContext(2);
    await runApplicationPromise(
      writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport())),
    );
    expect(
      await runApplicationPromise(
        planVerificationRepair(context, failedVerification(1)),
      ),
    ).toEqual({ pass: 2 });
    expect(
      await runApplicationPromise(
        readArtifact(context, { name: "verificationBeforeFix", pass: 2 }),
      ),
    ).toContain("## Exit Code\n1");
  });
  test("does not schedule repair when fix budget is exhausted", async () => {
    const context = await tempContext(1);
    await runApplicationPromise(
      writeArtifact(context, fixLogRef(1), JSON.stringify(changeReport())),
    );
    expect(
      await runApplicationPromise(
        planVerificationRepair(context, failedVerification(1)),
      ),
    ).toBeUndefined();
  });
  test("does not consume fix budget for command-unavailable verification failures", async () => {
    const context = await tempContext(1);
    expect(
      await runApplicationPromise(
        planVerificationRepair(
          context,
          failedVerification(127, "sh: missing: command not found"),
        ),
      ),
    ).toBeUndefined();
  });
  test("canonical readiness JSON drives publication even when rendered Markdown disagrees", async () => {
    const context = await tempContext(1);
    context.model = "provider/reviewer";
    context.thinkingProfile = "deep";
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr")),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        "readinessMarkdown",
        "# PR Readiness\n\n## Status\nnot-ready\n",
      ),
    );
    const postPrCalls: string[] = [];
    const prBodyUpdates: {
      pr: string;
      followUpCount: number;
    }[] = [];
    const postPublicationOrder: string[] = [];
    const reviewCalls: ReviewPrCliOptions[] = [];
    const workspace = {
      root: "/tmp/roark-workspaces",
      strategy: "clone" as const,
      cloneRemote: "origin",
      clone: {},
      copyToWorktree: ["local.env"],
    };
    const hooks = { beforeRun: "bun install", timeoutMs: 1234 };
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runPublishGate(
          {
            options: {
              cwd: context.controlCwd,
              repo: "owner/repo",
              verifyCommand: "bun run typecheck",
              failureLabel: "failed",
              successLabel: "done",
              inProgressLabel: "in-progress",
              remote: "origin",
              baseBranch: "main",
              workspace,
              hooks,
            },
            issue: {
              number: 1,
              title: "Issue",
              url: "https://github.com/owner/repo/issues/1",
            },
            branchPlan: {
              issueNumber: 1,
              branchName: "roark/issue-1",
              baseBranch: "main",
            },
            workflowContext: context,
            attemptMetadata: attemptMetadata(context),
            attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
          },
          {
            refreshCopyToWorktree: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            runLifecycleHook: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            runVerification: Effect.fnUntraced(function* ({ command }) {
              return (
                yield* Effect.void,
                { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" }
              );
            }),
            writeVerificationArtifact: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            publishAutorunResult: Effect.fnUntraced(function* () {
              return (
                yield* Effect.void,
                { url: "https://github.com/owner/repo/pull/10", number: 10 }
              );
            }),
            publishIssueLedgerComment: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            postPrIssueCreation: Effect.fnUntraced(function* ({ prUrl }) {
              yield* Effect.void;
              postPrCalls.push(prUrl);
              return undefined;
            }),
            updatePrBody: Effect.fnUntraced(function* ({ pr, followUpIssues }) {
              yield* Effect.void;
              postPublicationOrder.push("body-update");
              prBodyUpdates.push({
                pr,
                followUpCount: followUpIssues?.length ?? 0,
              });
              return undefined;
            }),
            runPrReview: Effect.fnUntraced(function* (options) {
              yield* Effect.void;
              postPublicationOrder.push("pr-review");
              reviewCalls.push(options);
              return {
                outcome: "completed" as const,
                context: { reviewDirRelative: ".roark/runs/pr/10/review-1" },
              };
            }),
          },
        );
      }).pipe(Effect.provide(applicationLayer)),
    );
    expect(outcome).toEqual({ outcome: "published", outcomeDetail: null });
    expect(postPrCalls).toEqual(["https://github.com/owner/repo/pull/10"]);
    expect(prBodyUpdates).toEqual([
      { pr: "https://github.com/owner/repo/pull/10", followUpCount: 0 },
    ]);
    expect(postPublicationOrder).toEqual(["body-update", "pr-review"]);
    expect(reviewCalls).toEqual([
      {
        command: "review-pr",
        prNumber: 10,
        cwd: context.controlCwd,
        outDir: context.outDir,
        repo: "owner/repo",
        model: "provider/reviewer",
        thinkingLevel: undefined,
        thinkingProfile: "deep",
        verifyCommand: "bun run typecheck",
        comment: true,
        workspace,
        hooks,
      },
    ]);
  });
  test("automatic PR review failures do not turn an opened PR into a failed attempt", async () => {
    const context = await tempContext(1);
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr")),
    );
    let warningOutput = "";
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        warningOutput += chunk;
      },
    };
    return runWithPresenter(
      new Presenter({
        stream,
        errorStream: stream,
        roots: [context.controlCwd],
      }),
      Effect.gen(function* () {
        const outcome = yield* runPublishGate(
          {
            options: publishGateOptions(context),
            issue: {
              number: 1,
              title: "Issue",
              url: "https://github.com/owner/repo/issues/1",
            },
            branchPlan: {
              issueNumber: 1,
              branchName: "roark/issue-1",
              baseBranch: "main",
            },
            workflowContext: context,
            attemptMetadata: attemptMetadata(context),
            attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
          },
          successfulPublicationDependencies({
            runPrReview: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return yield* Effect.fail(
                new PrReviewError({ message: "review service unavailable" }),
              );
            }),
          }),
        );
        expect(outcome).toEqual({
          outcome: "published" as const,
          outcomeDetail: null,
        });
        expect(warningOutput).toContain(
          "automatic PR review failed after PR #10 was published",
        );
        expect(warningOutput).toContain("review service unavailable");
      }),
    );
  });
  test("a stale automatic PR review preserves the published outcome and review artifact", async () => {
    const context = await tempContext(1);
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr")),
    );
    let warningOutput = "";
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        warningOutput += chunk;
      },
    };
    return runWithPresenter(
      new Presenter({
        stream,
        errorStream: stream,
        roots: [context.controlCwd],
      }),
      Effect.gen(function* () {
        const outcome = yield* runPublishGate(
          {
            options: publishGateOptions(context),
            issue: {
              number: 1,
              title: "Issue",
              url: "https://github.com/owner/repo/issues/1",
            },
            branchPlan: {
              issueNumber: 1,
              branchName: "roark/issue-1",
              baseBranch: "main",
            },
            workflowContext: context,
            attemptMetadata: attemptMetadata(context),
            attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
          },
          successfulPublicationDependencies({
            runPrReview: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return {
                outcome: "blocked" as const,
                context: { reviewDirRelative: ".roark/runs/pr/10/review-1" },
              };
            }),
          }),
        );
        expect(outcome).toEqual({
          outcome: "published" as const,
          outcomeDetail: null,
        });
        expect(warningOutput).toContain(
          "automatic PR review for #10 was blocked",
        );
        expect(warningOutput).toContain("artifact: .roark/runs/pr/10/review-1");
      }),
    );
  });
  test("failed readiness does not trigger post-PR reviewer issue creation", async () => {
    const context = await tempContext(1);
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("not-ready")),
    );
    let postPrCalled = false;
    let reviewPrCalled = false;
    const outcome = await runApplicationPromise(
      runPublishGate(
        {
          options: {
            cwd: context.controlCwd,
            repo: "owner/repo",
            verifyCommand: "bun run typecheck",
            failureLabel: "failed",
            successLabel: "done",
            inProgressLabel: "in-progress",
            remote: "origin",
            baseBranch: "main",
          },
          issue: {
            number: 1,
            title: "Issue",
            url: "https://github.com/owner/repo/issues/1",
          },
          branchPlan: {
            issueNumber: 1,
            branchName: "roark/issue-1",
            baseBranch: "main",
          },
          workflowContext: context,
          attemptMetadata: attemptMetadata(context),
          attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
        },
        {
          handleNonPublish: Effect.fnUntraced(function* ({ decision }) {
            yield* Effect.void;
            return {
              published: false,
              artifactPath: path.join(
                context.runDirRelative,
                decision.artifactPath,
              ),
              runDirectory: context.runDirRelative,
              issueUrl: undefined,
              commentUrl: undefined,
              reason: decision.reason,
            };
          }),
          postPrIssueCreation: Effect.fnUntraced(function* () {
            yield* Effect.void;
            postPrCalled = true;
            return undefined;
          }),
          runPrReview: Effect.fnUntraced(function* () {
            yield* Effect.void;
            reviewPrCalled = true;
            return {
              outcome: "completed" as const,
              context: { reviewDirRelative: ".roark/runs/pr/10/review-1" },
            };
          }),
        },
      ),
    );
    expect(outcome.outcome).toBe("failed-readiness");
    expect(postPrCalled).toBe(false);
    expect(reviewPrCalled).toBe(false);
  });
  test("failed verification does not trigger post-PR reviewer issue creation", async () => {
    const context = await tempContext(0);
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr")),
    );
    let postPrCalled = false;
    let reviewPrCalled = false;
    const outcome = await runApplicationPromise(
      runPublishGate(
        {
          options: {
            cwd: context.controlCwd,
            repo: "owner/repo",
            verifyCommand: "bun run typecheck",
            failureLabel: "failed",
            successLabel: "done",
            inProgressLabel: "in-progress",
            remote: "origin",
            baseBranch: "main",
          },
          issue: {
            number: 1,
            title: "Issue",
            url: "https://github.com/owner/repo/issues/1",
          },
          branchPlan: {
            issueNumber: 1,
            branchName: "roark/issue-1",
            baseBranch: "main",
          },
          workflowContext: context,
          attemptMetadata: attemptMetadata(context),
          attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
        },
        {
          refreshCopyToWorktree: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          runLifecycleHook: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          runVerification: Effect.fnUntraced(function* ({ command }) {
            return (
              yield* Effect.void,
              {
                ok: false,
                command,
                exitCode: 1,
                stdout: "",
                stderr: "lint failed",
              }
            );
          }),
          writeVerificationArtifact: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          handleNonPublish: Effect.fnUntraced(function* ({ decision }) {
            yield* Effect.void;
            return {
              published: false,
              artifactPath: path.join(
                context.runDirRelative,
                decision.artifactPath,
              ),
              runDirectory: context.runDirRelative,
              issueUrl: undefined,
              commentUrl: undefined,
              reason: decision.reason,
            };
          }),
          postPrIssueCreation: Effect.fnUntraced(function* () {
            yield* Effect.void;
            postPrCalled = true;
            return undefined;
          }),
          runPrReview: Effect.fnUntraced(function* () {
            yield* Effect.void;
            reviewPrCalled = true;
            return {
              outcome: "completed" as const,
              context: { reviewDirRelative: ".roark/runs/pr/10/review-1" },
            };
          }),
        },
      ),
    );
    expect(outcome.outcome).toBe("failed-verification");
    expect(postPrCalled).toBe(false);
    expect(reviewPrCalled).toBe(false);
  });
  test("verification runner exceptions propagate through the publish gate", async () => {
    const context = await tempContext(1);
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr")),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        "readinessMarkdown",
        "# PR Readiness\n\n## Status\nready-for-pr\n",
      ),
    );
    const failure = new ProcessExecutionError({
      args: ["bun", "test"],
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "verification runner failed",
      }),
    });
    const running = runApplicationPromise(
      runPublishGate(
        {
          options: {
            cwd: context.controlCwd,
            repo: "owner/repo",
            verifyCommand: "bun run typecheck",
            failureLabel: "failed",
            successLabel: "done",
            inProgressLabel: "in-progress",
            remote: "origin",
            baseBranch: "main",
          },
          issue: {
            number: 1,
            title: "Issue",
            url: "https://github.com/owner/repo/issues/1",
          },
          branchPlan: {
            issueNumber: 1,
            branchName: "roark/issue-1",
            baseBranch: "main",
          },
          workflowContext: context,
          attemptMetadata: attemptMetadata(context),
          attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
        },
        {
          refreshCopyToWorktree: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          runLifecycleHook: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return undefined;
          }),
          runVerification: (input) =>
            runVerification(input).pipe(
              Effect.provideService(Verification, {
                execute: () => Effect.fail(failure),
              }),
              Effect.provide(applicationLayer),
            ),
        },
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
  test("post-PR reviewer issue creation curates numbered autorun review artifacts", async () => {
    const context = await tempContext(1);
    await runApplicationPromise(
      writeArtifact(
        context,
        "issue",
        `<github_issue number="1">\n  <title>Issue</title>\n  <url>https://github.com/owner/repo/issues/1</url>\n</github_issue>`,
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        reviewARef(0),
        structuredReview([
          reviewFinding("follow-up", "Document numbered review curation", {
            severity: "low",
            evidence: [
              "lib/workflow/issue-curation.ts:116 selects the latest numbered review artifact.",
            ],
            currentIssueImpact:
              "Reviewer findings from normal autorun attempts are promoted after PR publication.",
            recommendedHandling:
              "Use numbered review artifacts when curating reviewer-generated issues.",
            suggestedIssueTitle: "Document numbered review curation",
          }),
        ]),
      ),
    );
    await runApplicationPromise(
      writeArtifact(context, reviewBRef(0), structuredReview()),
    );
    await runApplicationPromise(
      writeArtifact(
        context,
        "issueCreationResults",
        JSON.stringify({
          created: [
            {
              planItemId: "follow-up-1",
              kind: "follow-up",
              title: "Document numbered review curation",
              url: "https://github.com/owner/repo/issues/100",
            },
          ],
        }),
      ),
    );
    await runApplicationPromise(
      createReviewerIssuesAfterPr({
        workflowContext: context,
        prUrl: "https://github.com/owner/repo/pull/10",
      }),
    );
    const plan = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          run: Schema.Struct({
            prUrl: Schema.optional(Schema.String),
            artifactPaths: Schema.mutable(Schema.Array(Schema.String)),
          }),
          issuesToCreate: Schema.mutable(
            Schema.Array(
              Schema.Struct({
                planItemId: Schema.String,
                sourceFindingIds: Schema.mutable(Schema.Array(Schema.String)),
                runContext: Schema.Struct({
                  prUrl: Schema.optional(Schema.String),
                }),
              }),
            ),
          ),
        }),
      ),
    )(await runApplicationPromise(readArtifact(context, "issueCurationPlan")));
    expect(plan.run.prUrl).toBe("https://github.com/owner/repo/pull/10");
    expect(plan.issuesToCreate).toHaveLength(1);
    expect(plan.issuesToCreate[0]?.planItemId).toBe("follow-up-1");
    expect(plan.issuesToCreate[0]?.sourceFindingIds).toEqual([
      "review-a:document-numbered-review-curation",
    ]);
    expect(plan.issuesToCreate[0]?.runContext.prUrl).toBe(
      "https://github.com/owner/repo/pull/10",
    );
    expect(plan.run.artifactPaths).toContain(
      ".roark/runs/issue/1/attempts/1/review-a-0.json",
    );
  });
  test("terminal command-unavailable failures include setup guidance", async () => {
    await Promise.resolve();
    const context = await tempContext(1);
    await runApplicationPromise(
      writeJsonArtifact(context, "readiness", readinessResult("ready-for-pr")),
    );
    let failureComment = "";
    let output = "";
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        output += chunk;
      },
    };
    return runWithPresenter(
      new Presenter({ stream, roots: [context.controlCwd] }),
      Effect.gen(function* () {
        const outcome = yield* runPublishGate(
          {
            options: {
              cwd: context.controlCwd,
              repo: "owner/repo",
              verifyCommand: "bun run typecheck",
              failureLabel: "failed",
              successLabel: "done",
              inProgressLabel: "in-progress",
              remote: "origin",
              baseBranch: "main",
              hooks: { timeoutMs: 1000 },
            },
            issue: {
              number: 1,
              title: "Issue",
              url: "https://github.com/owner/repo/issues/1",
            },
            branchPlan: {
              issueNumber: 1,
              branchName: "roark/issue-1",
              baseBranch: "main",
            },
            workflowContext: context,
            attemptMetadata: {
              attempt: 1,
              issueNumber: 1,
              branch: "roark/issue-1",
              baseBranch: "main",
              worktreePath: context.agentCwd,
              runArtifactPath: context.runDirRelative,
              startedAt: new Date("2026-05-08T00:00:00.000Z").toISOString(),
              endedAt: null,
              outcome: "in-progress" as const,
              outcomeDetail: null,
            },
            attemptMetadataPath: ".roark/runs/issue/1/attempts/1/attempt.json",
          },
          {
            refreshCopyToWorktree: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            runLifecycleHook: Effect.fnUntraced(function* () {
              yield* Effect.void;
              return undefined;
            }),
            runVerification: Effect.fnUntraced(function* ({ command }) {
              return (
                yield* Effect.void,
                {
                  ok: false,
                  command,
                  exitCode: 127,
                  stdout: "",
                  stderr: "/bin/bash: tsc: command not found",
                }
              );
            }),
            handleNonPublish: Effect.fnUntraced(function* ({ decision }) {
              yield* Effect.void;
              failureComment = decision.reason;
              return {
                published: false,
                artifactPath: path.join(
                  context.runDirRelative,
                  decision.artifactPath,
                ),
                runDirectory: context.runDirRelative,
                issueUrl: undefined,
                commentUrl: undefined,
                reason: decision.reason,
              };
            }),
          },
        );
        expect(outcome).toMatchObject({
          outcome: "failed-verification" as const,
          outcomeDetail:
            "verification command exited 127 because a required command was not found. Install dependencies in the verification workspace or configure hooks.beforeVerify, for example: bun install --frozen-lockfile.",
        });
        expect(failureComment).toContain("hooks.beforeVerify");
        expect(output).toContain(
          "artifact: .roark/runs/issue/1/attempts/1/verification.md",
        );
        expect(output).toContain("ACTION user action required:");
      }),
    );
  });
});
function attemptMetadata(context: WorkflowContext) {
  return {
    attempt: 1,
    issueNumber: 1,
    branch: "roark/issue-1",
    baseBranch: "main",
    worktreePath: context.agentCwd,
    runArtifactPath: context.runDirRelative,
    startedAt: new Date("2026-05-08T00:00:00.000Z").toISOString(),
    endedAt: null,
    outcome: "in-progress" as const,
    outcomeDetail: null,
  };
}
function publishGateOptions(context: WorkflowContext) {
  return {
    cwd: context.controlCwd,
    repo: "owner/repo",
    verifyCommand: "bun run typecheck",
    failureLabel: "failed",
    successLabel: "done",
    inProgressLabel: "in-progress",
    remote: "origin",
    baseBranch: "main",
  };
}
function successfulPublicationDependencies(
  overrides: Parameters<typeof runPublishGate>[1] = {},
): Parameters<typeof runPublishGate>[1] {
  return {
    refreshCopyToWorktree: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return undefined;
    }),
    runLifecycleHook: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return undefined;
    }),
    runVerification: Effect.fnUntraced(function* ({ command }) {
      return (
        yield* Effect.void,
        { ok: true, command, exitCode: 0, stdout: "ok", stderr: "" }
      );
    }),
    writeVerificationArtifact: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return undefined;
    }),
    publishAutorunResult: Effect.fnUntraced(function* () {
      return (
        yield* Effect.void,
        { url: "https://github.com/owner/repo/pull/10", number: 10 }
      );
    }),
    publishIssueLedgerComment: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return undefined;
    }),
    postPrIssueCreation: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return undefined;
    }),
    updatePrBody: Effect.fnUntraced(function* () {
      yield* Effect.void;
      return undefined;
    }),
    runPrReview: Effect.fnUntraced(function* () {
      return (
        yield* Effect.void,
        {
          outcome: "completed" as const,
          context: { reviewDirRelative: ".roark/runs/pr/10/review-1" },
        }
      );
    }),
    ...overrides,
  };
}
async function tempContext(maxFixPasses: number): Promise<WorkflowContext> {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-publish-flow-"));
  tempDirs.push(cwd);
  const runDir = path.join(cwd, ".roark/runs/issue/1/attempts/1");
  await mkdir(runDir, { recursive: true });
  return {
    controlCwd: cwd,
    agentCwd: cwd,
    outDir: path.join(cwd, ".roark/runs"),
    runDir,
    runDirRelative: path.relative(cwd, runDir),
    issueInput: "1",
    issueNumber: "1",
    attempt: 1,
    force: false,
    yes: false,
    maxFixPasses,
    thinkingConfig: getWorkflowThinkingConfig(),
  };
}
function failedVerification(
  exitCode: number,
  stderr = "lint failed",
): VerificationResult {
  return {
    ok: false,
    command: "bun run check",
    exitCode,
    stdout: "",
    stderr,
  };
}
function structuredReview(findings: ReviewFinding[] = []): string {
  return JSON.stringify(reviewResult(findings));
}

test("terminal readiness and PR publication replace the same attempt status", async () => {
  const context = await tempContext(0);
  const metadata: AttemptMetadata = attemptMetadata(context);
  const remote = new Map<number, string>();
  await runApplicationPromise(
    Effect.gen(function* () {
      const github = yield* GitHub;
      const input = {
        options: publishGateOptions(context),
        issue: { number: 1, title: "Issue" },
        branchPlan: {
          issueNumber: 1,
          branchName: "roark/issue-1",
          baseBranch: "main",
        },
        workflowContext: context,
        attemptMetadata: metadata,
        attemptMetadataPath: "attempt.json",
        recoveryCommand: "roark continue 1",
      };
      const run = () =>
        runPublishGate(
          input,
          successfulPublicationDependencies({ publishIssueLedgerComment }),
        ).pipe(
          Effect.provideService(GitHub, {
            ...github,
            addIssueLabel: () => Effect.void,
            removeIssueLabel: () => Effect.void,
            postOrUpdateIssueCommentByMarker: (options) =>
              Effect.sync(() => {
                const id = options.existingCommentId ?? remote.size + 401;
                remote.set(id, options.body);
                expect(options.marker).toContain("phase=attempt-status");
                return { id, marker: options.marker };
              }),
          }),
        );
      expect((yield* run()).outcome).toBe("failed-readiness");
      expect(remote.get(401)).toContain("readiness");
      expect(remote.get(401)).toContain("roark continue 1");
      yield* writeJsonArtifact(
        context,
        "readiness",
        readinessResult("ready-for-pr"),
      );
      yield* writeArtifact(
        context,
        "readinessMarkdown",
        "## Ready\n\nTOKEN=secret",
      );
      expect((yield* run()).outcome).toBe("published");
      expect(remote.size).toBe(1);
      expect(remote.get(401)).toContain(
        "https://github.com/owner/repo/pull/10",
      );
      expect(remote.get(401)).toContain("TOKEN=[redacted]");
      expect(Object.keys(metadata.githubComments?.issue ?? {})).toEqual([
        "attempt-status",
      ]);
    }),
  );
});
