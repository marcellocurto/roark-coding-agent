import {
  artifactExists,
  finalReviewRef,
  fixLogRef,
  readArtifact,
  type ArtifactRef,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import { validateAgentArtifact } from "../workflow/artifact-validation.ts";
import {
  hasBlockedReview,
  needsFix,
  shouldRunAnotherFixPass,
} from "../workflow/verdicts.ts";

export type ContinuePlanStep =
  | { type: "run"; phase: "fetch" | "triage" | "plan" | "implement" | "review-a" | "review-b" | "fix" | "final-review"; pass?: number; reason: string }
  | { type: "write-readiness"; reason: string }
  | { type: "publish-gate"; reason: string }
  | { type: "noop"; reason: string };

export async function planContinuation(context: WorkflowContext): Promise<ContinuePlanStep[]> {
  const issue = await inspect(context, "issue");
  if (!issue.exists) return [run("fetch", "issue artifact is missing"), run("triage", "triage has not run"), run("plan", "plan has not run"), run("implement", "implementation has not run"), run("review-a", "review A has not run"), run("review-b", "review B has not run"), readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];

  const triage = await inspect(context, "triage");
  if (!triage.valid) return [run("triage", triage.reason), run("plan", "plan depends on triage"), run("implement", "implementation depends on plan"), run("review-a", "review A depends on implementation"), run("review-b", "review B depends on implementation"), readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];

  const plan = await inspect(context, "implementationPlan");
  if (!plan.valid) return [run("plan", plan.reason), run("implement", "implementation depends on plan"), run("review-a", "review A depends on implementation"), run("review-b", "review B depends on implementation"), readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];

  const implementation = await inspect(context, "implementationLog");
  if (!implementation.valid) return [run("implement", implementation.reason), run("review-a", "review A depends on implementation"), run("review-b", "review B depends on implementation"), readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];

  const reviewA = await inspect(context, "reviewA");
  const reviewB = await inspect(context, "reviewB");
  const steps: ContinuePlanStep[] = [];
  if (!reviewA.valid) steps.push(run("review-a", reviewA.reason));
  if (!reviewB.valid) steps.push(run("review-b", reviewB.reason));
  if (steps.length > 0) return [...steps, readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];

  const reviewAMarkdown = reviewA.content ?? "";
  const reviewBMarkdown = reviewB.content ?? "";
  if (hasBlockedReview(reviewAMarkdown, reviewBMarkdown)) {
    return [readiness("a review is blocked; readiness records the stop"), gate("publish gate records non-publish")];
  }

  if (needsFix(reviewAMarkdown, reviewBMarkdown)) {
    for (let pass = 1; pass <= context.maxFixPasses; pass++) {
      const fix = await inspect(context, fixLogRef(pass));
      if (!fix.valid) return [run("fix", fix.reason, pass), run("final-review", "final review depends on fix", pass), readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];

      const finalReview = await inspect(context, finalReviewRef(pass));
      if (!finalReview.valid) return [run("final-review", finalReview.reason, pass), readiness("workflow must recompute readiness"), gate("publish gate must run after readiness")];
      if (!shouldRunAnotherFixPass(finalReview.content ?? "")) {
        return [readiness("latest final review decides readiness"), gate("publish gate must run after readiness")];
      }
    }

    return [readiness("maximum fix passes reached"), gate("publish gate records non-publish")];
  }

  return [readiness("reviews approve; recompute deterministic readiness"), gate("publish gate must run after readiness")];
}

export function formatContinuationPlan(steps: readonly ContinuePlanStep[]): string[] {
  return steps.map((step) => {
    if (step.type === "run") {
      const suffix = step.pass === undefined ? "" : ` pass ${step.pass}`;
      return `- run ${step.phase}${suffix}: ${step.reason}`;
    }
    if (step.type === "write-readiness") return `- write readiness: ${step.reason}`;
    if (step.type === "publish-gate") return `- run publish gate: ${step.reason}`;
    return `- no-op: ${step.reason}`;
  });
}

type Inspection = {
  exists: boolean;
  valid: boolean;
  reason: string;
  content?: string;
};

async function inspect(context: WorkflowContext, artifact: ArtifactRef): Promise<Inspection> {
  if (!artifactExists(context, artifact)) return { exists: false, valid: false, reason: "artifact is missing" };
  const content = await readArtifact(context, artifact);
  const validation = validateAgentArtifact(artifact, content);
  if (!validation.ok) return { exists: true, valid: false, reason: validation.reason, content };
  return { exists: true, valid: true, reason: "artifact is valid", content };
}

function run(phase: Extract<ContinuePlanStep, { type: "run" }>["phase"], reason: string, pass?: number): ContinuePlanStep {
  return { type: "run", phase, pass, reason };
}

function readiness(reason: string): ContinuePlanStep {
  return { type: "write-readiness", reason };
}

function gate(reason: string): ContinuePlanStep {
  return { type: "publish-gate", reason };
}
