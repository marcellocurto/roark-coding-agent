import type { VerificationResult } from "./verification.ts";

export type ReadinessStatus = "ready-for-pr" | "not-ready";

export type PublishGateInput = {
  readinessStatus: string | undefined;
  verification?: VerificationResult;
};

export type PublishGateDecision =
  | { publish: true }
  | { publish: false; phase: "readiness" | "verification"; reason: string; artifactPath: string };

export function parseReadinessStatus(markdown: string): ReadinessStatus | undefined {
  const match = markdown.match(/##\s*Status\s*\r?\n+\s*([^\r\n]+)/i);
  const candidate = match?.[1];
  if (!candidate) return undefined;

  const normalized = candidate.replace(/[`*_]/g, "").trim().toLowerCase();
  if (normalized === "ready-for-pr") return "ready-for-pr";
  if (normalized === "not-ready") return "not-ready";
  return undefined;
}

export function decidePublish(input: PublishGateInput): PublishGateDecision {
  if (input.readinessStatus !== "ready-for-pr") {
    const status = input.readinessStatus ?? "missing";
    return {
      publish: false,
      phase: "readiness",
      reason: `readiness status is "${status}"`,
      artifactPath: "readiness.md",
    };
  }

  if (input.verification && !input.verification.ok) {
    return {
      publish: false,
      phase: "verification",
      reason: `verify command exited ${input.verification.exitCode}`,
      artifactPath: "verification.md",
    };
  }

  return { publish: true };
}
