import { GitHub } from "../github/service.ts";
import { readArtifact } from "../workflow/artifacts.ts";
import {
  writeJsonArtifact,
  writeArtifact,
  reviewARef,
  reviewBRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { runApplicationPromise } from "../runtime/application.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWorkflowThinkingConfig } from "../workflow/thinking.ts";
import { formatAttemptMetadata } from "./attempts.ts";
import {
  formatReadinessLedgerComment,
  publishPlanningLedgerComments,
  publishReviewLedgerComments,
} from "./ledger-comments.ts";
import { reviewFinding, reviewResult } from "../testing/reviews.ts";
import {
  implementationPlanResult,
  triageResult,
} from "../testing/workflow-results.ts";
import { formatTriageMarkdown } from "../triage/result.ts";
import { formatImplementationPlanMarkdown } from "../implementation-plan/result.ts";
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("autorun ledger comment publishing", () => {
  test("uses the complete sanitized readiness artifact as the comment body", () => {
    const evidence = "r".repeat(10001);
    const body = formatReadinessLedgerComment({
      issueNumber: 24,
      attempt: 2,
      artifactContent: `# PR Readiness\n\nTOKEN=secret\n/Users/alice/private\n${evidence}`,
      recoveryCommand: "roark continue 24 --repo owner/repo --attempt 2",
    });
    expect(body).toBe(`<!-- roark:issue=24 attempt=2 phase=attempt-status -->

## Recovery

\`\`\`\`bash
roark continue 24 --repo owner/repo --attempt 2
\`\`\`\`

# PR Readiness

TOKEN=[redacted]
[local path redacted]
${evidence}
`);
  });
  test("publishes existing triage and implementation plan artifacts through the injected ledger publisher", async () => {
    await Promise.resolve();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-ledger-planning-"));
    tempDirs.push(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      attempt: 2,
      force: false,
      yes: false,
      maxFixPasses: 1,
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    const triage = triageResult("proceed", {
      evidence: ["Unique triage evidence at /Users/alice/private."],
    });
    const plan = implementationPlanResult(true, {
      proposedChanges: ["Unique plan action with TOKEN=secret."],
    });
    await runApplicationPromise(
      writeJsonArtifact(workflowContext, "triage", triage),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "triageMarkdown",
        formatTriageMarkdown(triage),
      ),
    );
    await runApplicationPromise(
      writeJsonArtifact(workflowContext, "implementationPlan", plan),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        "implementationPlanMarkdown",
        formatImplementationPlanMarkdown(plan, "final"),
      ),
    );
    const attemptMetadata = formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: cwd,
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    });
    const published: {
      phase: string;
      body: string;
    }[] = [];
    await runApplicationPromise(
      publishPlanningLedgerComments(
        {
          cwd,
          issue: { number: 24, title: "Ledger comments" },
          workflowContext,
          attemptMetadata,
        },
        {
          publishIssueLedgerComment: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            published.push({ phase: input.phase, body: input.body });
          }),
        },
      ),
    );
    expect(published.map(({ phase }) => phase)).toEqual([
      "triage",
      "implementation-plan",
    ]);
    expect(published[0]?.body).toContain(
      "Unique triage evidence at [local path redacted]",
    );
    expect(published[0]?.body).not.toContain("/Users/alice/private");
    expect(published[1]?.body).toContain(
      "Unique plan action with TOKEN=[redacted]",
    );
    expect(published[1]?.body).not.toContain("TOKEN=secret");
  });
  test("updates the same review IDs across three passes without changing history", async () => {
    await Promise.resolve();
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-ledger-comments-"));
    tempDirs.push(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      attempt: 2,
      force: false,
      yes: false,
      maxFixPasses: 1,
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        reviewARef(0),
        JSON.stringify(
          reviewResult([
            reviewFinding("must-fix-current", "Unique review A finding", {
              evidence: ["Unique review A evidence at /Users/alice/private."],
            }),
          ]),
        ),
      ),
    );
    await runApplicationPromise(
      writeArtifact(
        workflowContext,
        reviewBRef(0),
        JSON.stringify(
          reviewResult([], {
            evidenceReviewed: ["Unique review B evidence with TOKEN=secret."],
          }),
        ),
      ),
    );
    const attemptMetadata = formatAttemptMetadata({
      attempt: 2,
      issueNumber: 24,
      branch: "roark/issue-24",
      baseBranch: "main",
      worktreePath: cwd,
      runArtifactPath: workflowContext.runDirRelative,
      startedAt: "2026-05-07T00:00:00.000Z",
    });
    const published: {
      phase: string;
      body: string;
    }[] = [];
    const remote = new Map<number, string>();
    const originals = await runApplicationPromise(
      Effect.gen(function* () {
        return [
          yield* readArtifact(workflowContext, reviewARef(0)),
          yield* readArtifact(workflowContext, reviewBRef(0)),
        ];
      }),
    );
    for (let pass = 0; pass <= 2; pass++) {
      await runApplicationPromise(
        Effect.gen(function* () {
          if (pass > 0) {
            yield* writeArtifact(
              workflowContext,
              reviewARef(pass),
              originals[0] ?? "",
            );
            yield* writeArtifact(
              workflowContext,
              reviewBRef(pass),
              originals[1] ?? "",
            );
          }
          const github = yield* GitHub;
          yield* publishReviewLedgerComments({
            cwd,
            repo: "owner/repo",
            issue: { number: 24, title: "Ledger comments" },
            workflowContext,
            attemptMetadata,
          }).pipe(
            Effect.provideService(GitHub, {
              ...github,
              postOrUpdateIssueCommentByMarker: (input) =>
                Effect.sync(() => {
                  const id = input.existingCommentId ?? 101 + remote.size;
                  expect(input.body.match(/<!-- roark:/g)).toHaveLength(1);
                  expect(input.body.startsWith(input.marker)).toBe(true);
                  remote.set(id, input.body);
                  if (pass === 0)
                    published.push({
                      phase: input.marker.includes("phase=review-a")
                        ? "review-a"
                        : "review-b",
                      body: input.body,
                    });
                  return { id, marker: input.marker };
                }),
            }),
          );
          expect(yield* readArtifact(workflowContext, reviewARef(0))).toBe(
            originals[0] ?? "",
          );
          expect(yield* readArtifact(workflowContext, reviewBRef(0))).toBe(
            originals[1] ?? "",
          );
        }),
      );
    }
    expect(remote.size).toBe(2);
    expect(remote.get(101)).toContain("Review A pass 2");
    expect(remote.get(102)).toContain("Review B pass 2");
    expect(Object.keys(attemptMetadata.githubComments?.issue ?? {})).toEqual([
      "review-a",
      "review-b",
    ]);
    expect(published.map(({ phase }) => phase)).toEqual([
      "review-a",
      "review-b",
    ]);
    expect(published[0]?.body).toContain(
      "Unique review A evidence at [local path redacted]",
    );
    expect(published[1]?.body).toContain(
      "Unique review B evidence with TOKEN=[redacted]",
    );
    expect(published[0]?.body).not.toContain("/Users/alice/private");
    expect(published[1]?.body).not.toContain("TOKEN=secret");
    expect(attemptMetadata.githubComments?.issue?.["review-a"]?.id).toBe(101);
    expect(attemptMetadata.githubComments?.issue?.["review-b"]?.id).toBe(102);
  });
  test("does not publish unnumbered review JSON files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-ledger-comments-"));
    tempDirs.push(cwd);
    const workflowContext: WorkflowContext = {
      controlCwd: cwd,
      agentCwd: cwd,
      outDir: path.join(cwd, ".roark/runs"),
      runDir: path.join(cwd, ".roark/runs/issue/24/attempts/2"),
      runDirRelative: ".roark/runs/issue/24/attempts/2",
      issueInput: "24",
      issueNumber: "24",
      attempt: 2,
      force: false,
      yes: false,
      maxFixPasses: 1,
      thinkingConfig: getWorkflowThinkingConfig(),
    };
    await runApplicationPromise(
      writeJsonArtifact(workflowContext, "triage", triageResult()),
    );
    await Bun.write(
      path.join(workflowContext.runDir, "review-a.json"),
      JSON.stringify(
        reviewResult([
          reviewFinding("must-fix-current", "Stale unnumbered finding"),
        ]),
      ),
    );
    await Bun.write(
      path.join(workflowContext.runDir, "review-b.json"),
      JSON.stringify(reviewResult()),
    );
    const published: string[] = [];
    await runApplicationPromise(
      publishReviewLedgerComments(
        {
          cwd,
          repo: "owner/repo",
          issue: { number: 24, title: "Ledger comments" },
          workflowContext,
          attemptMetadata: formatAttemptMetadata({
            attempt: 2,
            issueNumber: 24,
            branch: "roark/issue-24",
            baseBranch: "main",
            worktreePath: cwd,
            runArtifactPath: workflowContext.runDirRelative,
            startedAt: "2026-05-07T00:00:00.000Z",
          }),
        },
        {
          publishIssueLedgerComment: Effect.fnUntraced(function* (input) {
            yield* Effect.void;
            published.push(input.phase);
          }),
        },
      ),
    );
    expect(published).toEqual([]);
  });
});
