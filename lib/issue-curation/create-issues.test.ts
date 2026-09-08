import { ArtifactStore } from "../workflow/artifact-store.ts";
import { ArtifactContractError } from "../structured-output/contract.ts";
import { readExistingCreatedEntries } from "./persistence.ts";
import { Context, Scope } from "effect";
import { Cause, Exit, PlatformError, Schema, Effect } from "effect";
import {
  createIssuesFromCurationPlan,
  type CreateIssuesOptions,
} from "./create-issues.ts";
import { IssuePublishing } from "../issue-publishing/service.ts";
import {
  type IssuePublishRequest,
  type IssuePublishResult,
} from "../issue-publishing/github.ts";
import { GitHubRequestError } from "../github/errors.ts";
import {
  runApplicationPromise,
  type ApplicationServices,
  applicationLayer,
} from "../runtime/application.ts";
import { type AgentRunner, provideTestAgent } from "../testing/agents.ts";
type FixtureEffect<A> = Effect.Effect<
  A,
  unknown,
  ApplicationServices | Scope.Scope
>;
type IssuePublisher = (
  request: IssuePublishRequest,
) => FixtureEffect<IssuePublishResult>;
interface TestCreateIssuesOptions extends CreateIssuesOptions {
  agentRunner?: AgentRunner | undefined;
  labelEnsurer?:
    | false
    | ((options: {
        cwd: string;
        repo?: string | undefined;
      }) => FixtureEffect<unknown>)
    | undefined;
  issuePublisher?: IssuePublisher | undefined;
}
const runIssueCreation = Effect.fnUntraced(function* (
  options: TestCreateIssuesOptions,
) {
  const live = yield* IssuePublishing;
  const services = Context.omit(Scope.Scope)(
    yield* Effect.context<ApplicationServices>(),
  );
  const publish = options.issuePublisher;
  const labels = options.labelEnsurer;
  return yield* createIssuesFromCurationPlan(options).pipe(
    Effect.provideService(IssuePublishing, {
      publish: publish
        ? (request) =>
            publish(request).pipe(
              Effect.mapError(
                (cause) =>
                  new GitHubRequestError({
                    message:
                      cause instanceof Error ? cause.message : String(cause),
                  }),
              ),
              Effect.provide(services),
              Effect.scoped,
            )
        : (request) => live.publish(request),
      ensureLabels:
        labels === false
          ? () => Effect.void
          : labels
            ? (request) =>
                labels(request).pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) =>
                      new GitHubRequestError({
                        message:
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                      }),
                  ),
                  Effect.provide(services),
                  Effect.scoped,
                )
            : (request) => live.ensureLabels(request),
    }),
    provideTestAgent(options.agentRunner),
  );
});
import {
  writeArtifact,
  writeJsonArtifact,
  artifactExists,
  readArtifact,
  createWorkflowContext,
} from "../workflow/artifacts.ts";
import { runWithPresenter } from "../testing/presentation.ts";
import { Presenter } from "../presentation/presenter.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRunRequest } from "../workflow/agent-runner.ts";
import { type IssueCurationPlan } from "../workflow/issue-curation.ts";
import { type TerminalStream } from "../presentation/terminal.ts";
import { issueDraft, submitIssueDrafts } from "../testing/publishing-drafts.ts";
const tempDirs: string[] = [];
const clock = { now: () => new Date("2026-05-07T00:00:00.000Z") };
const successfulIssuePublisher: IssuePublisher = Effect.fnUntraced(
  function* (request) {
    const number =
      request.title.includes("external-blocker") ||
      request.title.includes("blocker")
        ? 300
        : 301;
    return { url: `https://github.com/owner/repo/issues/${number}`, number };
  },
);
afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("createIssuesFromCurationPlan", () => {
  test("dry-run reports approved plan items without calling GitHub or writing results", async () => {
    await Promise.resolve();
    const context = await tempContext({ yes: false });
    const validPlan = basePlan();
    const plan = {
      ...validPlan,
      issuesToCreate: [
        ...validPlan.issuesToCreate,
        { planItemId: "bad", proposedTitle: "Bad" },
      ],
    };
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", plan),
    );
    const result = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        agentRunner: Effect.fnUntraced(function* () {
          yield* Effect.void;
          return yield* Effect.fail(
            new Error("dry-run should not invoke an agent"),
          );
        }),
      }),
    );
    expect(
      await runApplicationPromise(
        artifactExists(context, "issueCreationResults"),
      ),
    ).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.wouldCreate.map((item) => item.planItemId)).toEqual([
      "external-blocker-1",
      "follow-up-1",
    ]);
    expect(result.wouldCreate[0]?.labels).toEqual([
      "needs-triage",
      "review:external-blocker",
    ]);
    expect(result.counts.skippedRejectedCandidates).toBe(1);
    expect(result.counts.skippedDuplicateGroups).toBe(1);
    expect(result.counts.skippedDuplicateSourceFindings).toBe(2);
    expect(result.counts.skippedMalformed).toBe(1);
  });
  test("derives classification labels when proposed labels are incomplete", async () => {
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    const first = plan.issuesToCreate[0];
    if (!first) throw new Error("expected base plan item");
    first.proposedLabels = [];
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", plan),
    );
    const result = await runApplicationPromise(
      runIssueCreation({ context, clock }),
    );
    expect(result.wouldCreate[0]?.labels).toEqual([
      "needs-triage",
      "review:external-blocker",
    ]);
  });
  test("empty normalized plan does not fall back to legacy arrays", async () => {
    const context = await tempContext({ yes: false });
    const plan = basePlan();
    plan.issuesToCreate = [];
    plan.blockingIssuesToCreate = [
      planItem(
        "legacy-blocking-1",
        "Legacy blocking",
        ["external-blocker"],
        "external-blocker",
      ),
    ];
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", plan),
    );
    const result = await runApplicationPromise(
      runIssueCreation({ context, clock }),
    );
    expect(result.wouldCreate).toEqual([]);
    expect(result.counts.acceptedPlanItems).toBe(0);
  });
  test("invalid normalized classifications are skipped as malformed instead of defaulting to follow-up", async () => {
    const context = await tempContext({ yes: false });
    const validPlan = basePlan();
    const item = planItem("bad-kind-1", "Bad kind", ["follow-up"], "follow-up");
    const plan = {
      ...validPlan,
      issuesToCreate: [{ ...item, classification: "blocking" }],
    };
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", plan),
    );
    const result = await runApplicationPromise(
      runIssueCreation({ context, clock }),
    );
    expect(result.wouldCreate).toEqual([]);
    expect(result.skipped).toEqual([
      {
        planItemId: "bad-kind-1",
        kind: "unknown",
        title: "Bad kind",
        reason: "malformed",
        message:
          "Missing or invalid required field(s): classification. Expected one of: external-blocker, follow-up, suggestion.",
      },
    ]);
    expect(result.counts.acceptedPlanItems).toBe(1);
    expect(result.counts.skippedMalformed).toBe(1);
  });
  test("internal approval can publish with label preflight while context.yes is false", async () => {
    const context = await tempContext({ yes: false });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const ensured: {
      cwd: string;
      repo?: string | undefined;
    }[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* runIssueCreation({
          context,
          approved: true,
          approvalReason: "autorun PR was opened",
          clock,
          labelEnsurer: Effect.fnUntraced(function* (options) {
            yield* Effect.void;
            ensured.push(options);
          }),
          issuePublisher: successfulIssuePublisher,
          agentRunner: Effect.fnUntraced(function* (request) {
            expect(request.prompt).toContain("autorun PR was opened");
            return yield* Effect.tryPromise({
              try: () =>
                submitIssueDrafts(request, {
                  issues: [
                    issueDraft("external-blocker-1"),
                    issueDraft("follow-up-1"),
                  ],
                }),
              catch: (error) => error,
            });
          }),
        });
      }).pipe(Effect.provide(applicationLayer)),
    );
    expect(ensured).toEqual([{ cwd: context.agentCwd, repo: "owner/repo" }]);
    expect(result.approved).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.created.map((entry) => entry.planItemId)).toEqual([
      "external-blocker-1",
      "follow-up-1",
    ]);
  });
  test("preserves the parent workflow command in issue-publishing display context", async () => {
    const context = await tempContext({ yes: true, displayCommand: "auto" });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    let displayCommand: string | undefined;
    await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        agentRunner: Effect.fnUntraced(function* (request) {
          yield* Effect.void;
          displayCommand = request.display.command;
          return JSON.stringify({
            created: [
              {
                planItemId: "external-blocker-1",
                url: "https://github.com/owner/repo/issues/300",
                number: 300,
              },
              {
                planItemId: "follow-up-1",
                url: "https://github.com/owner/repo/issues/301",
                number: 301,
              },
            ],
            failed: [],
            relationshipOutcomes: [],
          });
        }),
      }),
    );
    expect(displayCommand).toBe("auto");
  });
  test("approved run uses the issue-authoring publishing agent without loading a skill", async () => {
    await Promise.resolve();
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const requests: AgentRunRequest[] = [];
    const publishRequests: Parameters<IssuePublisher>[0][] = [];
    const result = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        issuePublisher: Effect.fnUntraced(function* (request) {
          publishRequests.push(request);
          return yield* successfulIssuePublisher(request);
        }),
        agentRunner: Effect.fnUntraced(function* (request) {
          requests.push(request);
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [
                  issueDraft("external-blocker-1", {
                    title: "Clear blocker title",
                  }),
                  issueDraft("follow-up-1"),
                ],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.skillPaths).toBeUndefined();
    expect(requests[0]?.fileEditingToolsEnabled).toBe(false);
    expect(requests[0]?.prompt).toContain("external-blocker-1");
    expect(result.created.map((entry) => entry.number)).toEqual([300, 301]);
    expect(result.created[0]?.title).toBe("Clear blocker title");
    expect(result.relationshipOutcomes).toEqual([]);
    expect(publishRequests[0]?.labels).toEqual([
      "needs-triage",
      "review:external-blocker",
    ]);
    expect(publishRequests[0]?.body).toContain("## Simple summary");
    expect(publishRequests[0]?.body).toContain(
      "- Source issue: #12 Source title",
    );
    expect(publishRequests[0]?.body).toContain(
      "- Source finding IDs: review-a:external-blocker-1",
    );
    expect(publishRequests[0]?.body).not.toContain(".roark/runs/");
    expect(publishRequests[0]?.body).not.toContain("Roark run artifacts");
    expect(publishRequests[0]?.body).not.toContain("## Source\n");
    expect(
      JSON.parse(
        await runApplicationPromise(readArtifact(context, "issueDrafts")),
      ),
    ).toHaveProperty("issues.0.planItemId", "external-blocker-1");
    expect(
      await runApplicationPromise(readArtifact(context, "issueDraftsMarkdown")),
    ).toContain("# Clear blocker title");
  });
  test("publishing context names the result artifact and completes only after it is persisted", async () => {
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const resultPath = path.join(context.runDir, "issue-creation-results.json");
    let persistedAtCompletion = false;
    let expectedArtifact: string | undefined;
    const stream: TerminalStream = {
      isTTY: false,
      columns: 80,
      write(chunk) {
        if (chunk.startsWith("DONE #12 · Author and create issues"))
          persistedAtCompletion = existsSync(resultPath);
      },
    };
    return runWithPresenter(
      new Presenter({ stream }),
      Effect.gen(function* () {
        yield* runIssueCreation({
          context,
          clock,
          labelEnsurer: false,
          issuePublisher: successfulIssuePublisher,
          agentRunner: Effect.fnUntraced(function* (request) {
            yield* Effect.void;
            expectedArtifact = request.display.expectedArtifact;
            return yield* Effect.tryPromise({
              try: () =>
                submitIssueDrafts(request, {
                  issues: [
                    issueDraft("external-blocker-1"),
                    issueDraft("follow-up-1"),
                  ],
                }),
              catch: (error) => error,
            });
          }),
        });
        expect(expectedArtifact).toBe(
          ".roark/runs/issue/12/attempts/2/issue-creation-results.json",
        );
        expect(persistedAtCompletion).toBe(true);
      }),
    );
  });
  test("approved publishing agent prompt uses artifact paths visible from a split agent workspace", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "roark-create-issues-split-"),
    );
    tempDirs.push(root);
    const controlCwd = path.join(root, "control");
    const agentCwd = path.join(root, "agent");
    const context = await tempContext({
      yes: true,
      reuseDir: controlCwd,
      agentCwd,
    });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const requests: AgentRunRequest[] = [];
    await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        issuePublisher: successfulIssuePublisher,
        agentRunner: Effect.fnUntraced(function* (request) {
          requests.push(request);
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [
                  issueDraft("external-blocker-1"),
                  issueDraft("follow-up-1"),
                ],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    const expectedPlanPath = path.join(
      "..",
      "control",
      ".roark",
      "runs",
      "issue",
      "12",
      "attempts",
      "2",
      "issue-curation-plan.json",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.cwd).toBe(agentCwd);
    expect(requests[0]?.prompt).toContain(
      `The curation plan at \`${expectedPlanPath}\``,
    );
  });
  test("approved publishing agent uses the issue-publishing thinking stage", async () => {
    await Promise.resolve();
    const context = await tempContext({ yes: true });
    context.thinkingConfig.issuePublishing = "minimal";
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const thinkingLevels: string[] = [];
    await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        issuePublisher: successfulIssuePublisher,
        agentRunner: Effect.fnUntraced(function* (request) {
          thinkingLevels.push(request.thinkingLevel);
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [
                  issueDraft("external-blocker-1"),
                  issueDraft("follow-up-1"),
                ],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    expect(thinkingLevels).toEqual(["minimal"]);
  });
  test("structured issue drafts must cover every creatable plan item exactly once", async () => {
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const result = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        issuePublisher: successfulIssuePublisher,
        agentRunner: Effect.fnUntraced(function* (request) {
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [issueDraft("external-blocker-1")],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain(
      "Issue drafts omit planItemId(s): follow-up-1",
    );
  });
  test("structured issue drafts reject duplicate plan item IDs", async () => {
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const result = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        issuePublisher: successfulIssuePublisher,
        agentRunner: Effect.fnUntraced(function* (request) {
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [
                  issueDraft("external-blocker-1"),
                  issueDraft("external-blocker-1"),
                  issueDraft("follow-up-1"),
                ],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain(
      "Issue drafts contain duplicate planItemId(s): external-blocker-1",
    );
  });
  test("publishing agent failures are recorded for every creatable issue", async () => {
    await Promise.resolve();
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    let agentCalls = 0;
    const result = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        agentRunner: Effect.fnUntraced(function* () {
          yield* Effect.void;
          agentCalls += 1;
          return yield* Effect.fail(new Error("publishing agent failed"));
        }),
      }),
    );
    expect(agentCalls).toBe(1);
    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.message).toContain("publishing agent failed");
    expect(
      await runApplicationPromise(
        artifactExists(context, "issueCreationResults"),
      ),
    ).toBe(true);
  });
  test("records partial GitHub publishing failures while preserving successes", async () => {
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    const result = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        agentRunner: Effect.fnUntraced(function* (request) {
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [
                  issueDraft("external-blocker-1", {
                    title: "Blocking tracker",
                  }),
                  issueDraft("follow-up-1", { title: "Follow-up tracker" }),
                ],
              }),
            catch: (error) => error,
          });
        }),
        issuePublisher: Effect.fnUntraced(function* (request) {
          yield* Effect.void;
          if (request.title === "Follow-up tracker")
            return yield* Effect.fail(new Error("rate limited"));
          return {
            url: "https://github.com/owner/repo/issues/200",
            number: 200,
          };
        }),
      }),
    );
    expect(result.created.map((entry) => entry.planItemId)).toEqual([
      "external-blocker-1",
    ]);
    expect(result.failed).toEqual([
      {
        planItemId: "follow-up-1",
        kind: "follow-up",
        title: "Follow-up tracker",
        message: "rate limited",
      },
    ]);
    const written = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          created: Schema.mutable(Schema.Array(Schema.Unknown)),
          failed: Schema.mutable(Schema.Array(Schema.Unknown)),
        }),
      ),
    )(
      await runApplicationPromise(
        readArtifact(context, "issueCreationResults"),
      ),
    );
    expect(written.created).toHaveLength(1);
    expect(written.failed).toHaveLength(1);
  });
  test("rerun skips already-created plan item IDs unless forced", async () => {
    const context = await tempContext({ yes: true });
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCurationPlan", basePlan()),
    );
    await runApplicationPromise(
      writeJsonArtifact(context, "issueCreationResults", {
        version: 1,
        created: [
          {
            planItemId: "external-blocker-1",
            kind: "external-blocker",
            title: "Blocking tracker",
            url: "https://github.com/owner/repo/issues/10",
          },
        ],
      }),
    );
    let agentCalls = 0;
    const rerun = await runApplicationPromise(
      runIssueCreation({
        context,
        clock,
        labelEnsurer: false,
        issuePublisher: successfulIssuePublisher,
        agentRunner: Effect.fnUntraced(function* (request) {
          agentCalls += 1;
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [issueDraft("follow-up-1")],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    expect(agentCalls).toBe(1);
    expect(
      rerun.created
        .filter((entry) => entry.source === "current-run")
        .map((entry) => entry.planItemId),
    ).toEqual(["follow-up-1"]);
    expect(rerun.skipped.map((entry) => entry.planItemId)).toContain(
      "external-blocker-1",
    );
    const forcedContext = await tempContext({
      yes: true,
      force: true,
      reuseDir: context.controlCwd,
    });
    let forcedAgentCalls = 0;
    const forced = await runApplicationPromise(
      runIssueCreation({
        context: forcedContext,
        clock,
        labelEnsurer: false,
        issuePublisher: successfulIssuePublisher,
        agentRunner: Effect.fnUntraced(function* (request) {
          forcedAgentCalls += 1;
          return yield* Effect.tryPromise({
            try: () =>
              submitIssueDrafts(request, {
                issues: [
                  issueDraft("external-blocker-1"),
                  issueDraft("follow-up-1"),
                ],
              }),
            catch: (error) => error,
          });
        }),
      }),
    );
    expect(forcedAgentCalls).toBe(1);
    expect(forced.counts.createdCurrentRun).toBe(2);
  });
});
async function tempContext(options: {
  yes: boolean;
  force?: boolean;
  reuseDir?: string;
  agentCwd?: string | undefined;
  displayCommand?: string | undefined;
}) {
  const dir =
    options.reuseDir ??
    (await mkdtemp(path.join(tmpdir(), "roark-create-issues-")));
  if (!options.reuseDir) tempDirs.push(dir);
  return createWorkflowContext(
    {
      command: "create-issues",
      issue: "12",
      cwd: dir,
      outDir: ".roark/runs",
      repo: "owner/repo",
      force: options.force ?? false,
      yes: options.yes,
      maxFixPasses: 1,
      attempt: 2,
    },
    {
      ...(options.agentCwd ? { agentCwd: options.agentCwd } : {}),
      ...(options.displayCommand
        ? { displayCommand: options.displayCommand }
        : {}),
    },
  );
}
function basePlan(): IssueCurationPlan {
  return {
    version: 2,
    sourceIssue: {
      number: 12,
      title: "Source title",
      url: "https://github.com/owner/repo/issues/12",
    },
    run: {
      runDirRelative: ".roark/runs/issue/12/attempts/2",
      attempt: 2,
      generatedAt: "2026-05-07T00:00:00.000Z",
      artifactPaths: [".roark/runs/issue/12/attempts/2/review-a-0.json"],
    },
    issuesToCreate: [
      planItem(
        "external-blocker-1",
        "Blocking tracker",
        ["needs-triage", "needs-human", "external-blocker"],
        "external-blocker",
      ),
      planItem(
        "follow-up-1",
        "Follow-up tracker",
        ["needs-triage", "needs-human", "follow-up"],
        "follow-up",
      ),
    ],
    rejectedCandidates: [
      {
        sourceFindingIds: ["review-a:S1"],
        reviewerSources: ["review-a"],
        sourceClassifications: ["suggestion"],
        reason: "missing concrete evidence",
      },
    ],
    duplicatesMerged: [
      {
        winningPlanItemId: "follow-up-1",
        mergedSourceFindingIds: ["review-a:F1", "review-b:F1"],
        reviewerSources: ["review-a", "review-b"],
        reason: "same title",
      },
    ],
    warnings: ["source artifact was unavailable"],
  };
}
function planItem(
  id: string,
  title: string,
  labels: string[],
  classification: "external-blocker" | "follow-up",
): IssueCurationPlan["issuesToCreate"][number] {
  return {
    planItemId: id,
    classification,
    proposedTitle: title,
    proposedBody: `## Source\n- Source issue: #12 Source title (https://github.com/owner/repo/issues/12)\n- Run directory: .roark/runs/issue/12/attempts/2\n- Attempt: 2\n- Source finding IDs: review-a:${id}\n- Reviewer source(s): review-a\n- Classification: ${classification}\n\n## Evidence\n- Concrete evidence\n\n## Impact\nImpact.\n\n## Recommended handling\n- Handle it.\n`,
    sourceFindingIds: [`review-a:${id}`],
    reviewerSources: ["review-a"],
    sourceClassifications: [classification],
    severitySummary: "severity: high",
    confidenceSummary: "confidence: high",
    evidence: ["Concrete evidence"],
    impact: "Impact.",
    recommendedHandling: ["Handle it."],
    whyBlockingOrNonBlocking:
      classification === "external-blocker" ? "Blocking." : "Non-blocking.",
    sourceIssueContext: {
      number: 12,
      title: "Source title",
      url: "https://github.com/owner/repo/issues/12",
    },
    runContext: {
      runDirRelative: ".roark/runs/issue/12/attempts/2",
      attempt: 2,
      artifactPaths: [".roark/runs/issue/12/attempts/2/review-a-0.json"],
    },
    proposedLabels: labels,
  };
}

test("legacy plan arrays preserve valid entries, malformed skips, and classification labels", async () => {
  const context = await tempContext({ yes: false });
  const plan = basePlan();
  await runApplicationPromise(
    writeJsonArtifact(context, "issueCurationPlan", {
      sourceIssue: plan.sourceIssue,
      blockingIssuesToCreate: [plan.issuesToCreate[0], null],
      followUpIssuesToCreate: [plan.issuesToCreate[1]],
      duplicatesMerged: [null, { mergedSourceFindingIds: ["one", "two"] }],
    }),
  );
  const result = await runApplicationPromise(
    runIssueCreation({ context, clock }),
  );
  expect(
    result.wouldCreate.map((item) => [item.planItemId, item.kind]),
  ).toEqual([
    ["external-blocker-1", "blocking"],
    ["follow-up-1", "follow-up"],
  ]);
  expect(result.wouldCreate[0]?.labels).toContain("review:external-blocker");
  expect(result.skipped).toContainEqual({
    planItemId: "blocking-2",
    kind: "blocking",
    reason: "malformed",
    message: "Plan entry is not an object.",
  });
  expect(result.counts).toMatchObject({
    acceptedPlanItems: 3,
    skippedMalformed: 1,
    skippedDuplicateGroups: 2,
    skippedDuplicateSourceFindings: 2,
  });
});

test("invalid plan rows leave valid neighbors creatable", async () => {
  const context = await tempContext({ yes: false });
  const plan = basePlan();
  const valid = plan.issuesToCreate[0];
  if (!valid) throw new Error("missing fixture item");
  await runApplicationPromise(
    writeJsonArtifact(context, "issueCurationPlan", {
      ...plan,
      issuesToCreate: [
        {
          ...valid,
          planItemId: "  valid  ",
          proposedTitle: "  Valid title  ",
          proposedLabels: [7, " extra ", "review:follow-up"],
          sourceIssueContext: {
            ...valid.sourceIssueContext,
            url: { invalid: true },
          },
          runContext: { ...valid.runContext, attempt: "invalid", prUrl: false },
        },
        { ...valid, planItemId: "bad-context", sourceFindingIds: [42] },
        { ...valid, planItemId: "bad-title", proposedTitle: "   " },
      ],
    }),
  );
  const result = await runApplicationPromise(
    runIssueCreation({ context, clock }),
  );
  expect(result.wouldCreate).toHaveLength(1);
  expect(result.wouldCreate[0]).toMatchObject({
    planItemId: "valid",
    title: "Valid title",
    labels: ["needs-triage", "review:external-blocker", "extra"],
  });
  expect(result.skipped.map((item) => [item.planItemId, item.message])).toEqual(
    [
      ["bad-context", "Missing required field(s): structured issue context."],
      ["bad-title", "Missing required field(s): proposedTitle."],
    ],
  );
});

test("salvages published identities despite malformed optional metadata and neighboring records", async () => {
  const context = await tempContext({ yes: true });
  await runApplicationPromise(
    writeJsonArtifact(context, "issueCurationPlan", basePlan()),
  );
  await runApplicationPromise(
    writeJsonArtifact(context, "issueCreationResults", {
      created: [
        {
          planItemId: " external-blocker-1 ",
          kind: "blocking",
          title: " Existing blocker ",
          url: 7,
          number: "broken",
          stdout: {},
        },
        null,
        {
          planItemId: "follow-up-1",
          kind: "follow-up",
          title: " Existing follow-up ",
          number: 301,
          url: " https://github.com/owner/repo/issues/301 ",
          stdout: " created ",
        },
        { planItemId: "invalid-kind", kind: "invalid", title: "Bad record" },
      ],
    }),
  );
  const result = await runApplicationPromise(
    runIssueCreation({
      context,
      clock,
      labelEnsurer: () =>
        Effect.die(new Error("already-created issues must not need labels")),
      issuePublisher: () =>
        Effect.die(new Error("already-created issues must not be republished")),
      agentRunner: () =>
        Effect.die(
          new Error("already-created issues must not be authored again"),
        ),
    }),
  );
  expect(result.counts).toMatchObject({
    createdCurrentRun: 0,
    createdTotalRecorded: 2,
    skippedAlreadyCreated: 2,
  });
  expect(result.created).toEqual([
    {
      planItemId: "external-blocker-1",
      kind: "blocking",
      title: "Existing blocker",
      source: "existing-result",
    },
    {
      planItemId: "follow-up-1",
      kind: "follow-up",
      title: "Existing follow-up",
      number: 301,
      url: "https://github.com/owner/repo/issues/301",
      stdout: "created",
      source: "existing-result",
    },
  ]);
});

test("history recovery preserves a read failure combined with a cleanup defect", async () => {
  const context = await tempContext({ yes: false });
  const failure = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
  });
  const defect = new Error("history cleanup defect");
  const exit = await runApplicationPromise(
    Effect.exit(
      readExistingCreatedEntries(context).pipe(
        Effect.provideServiceEffect(
          ArtifactStore,
          Effect.map(ArtifactStore, (store) => ({
            ...store,
            exists: () => Effect.succeed(true),
            read: () =>
              Effect.fail(failure).pipe(Effect.ensuring(Effect.die(defect))),
          })),
        ),
      ),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasFails(exit.cause)).toBe(true);
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.pretty(exit.cause)).toContain(defect.message);
  }
});

test("an unreadable plan fails with a typed artifact error", async () => {
  const context = await tempContext({ yes: false });
  await runApplicationPromise(
    writeArtifact(context, "issueCurationPlan", "not JSON"),
  );
  expect(
    runApplicationPromise(runIssueCreation({ context, clock })),
  ).rejects.toThrow(ArtifactContractError);
});
