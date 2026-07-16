import type { VerificationResult } from "./verification.ts";
import type { ReadinessStatus } from "../workflow/readiness.ts";

export interface PublishGateInput {
  readinessStatus: ReadinessStatus | undefined;
  verification?: VerificationResult | undefined;
}

export type PublishGateDecision =
  | { publish: true }
  | { publish: false; phase: "readiness" | "verification"; reason: string; artifactPath: string };

export function decidePublish(input: PublishGateInput): PublishGateDecision {
  if (input.readinessStatus !== "ready-for-pr") {
    const status = input.readinessStatus ?? "missing";
    return {
      publish: false,
      phase: "readiness",
      reason: `readiness status is "${status}"`,
      artifactPath: "readiness.json",
    };
  }

  if (!input.verification) {
    return {
      publish: false,
      phase: "verification",
      reason: "verification result is missing",
      artifactPath: "verification.md",
    };
  }

  if (!input.verification.ok) {
    return {
      publish: false,
      phase: "verification",
      reason: `verify command exited ${input.verification.exitCode}`,
      artifactPath: "verification.md",
    };
  }

  return { publish: true };
}
