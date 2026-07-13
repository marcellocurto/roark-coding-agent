import { inferVerificationCommand } from "../autorun/verification.ts";

export interface ResolvedPrReviewVerification {
  command?: string | undefined;
  source: "explicit" | "not-configured";
  suggestedCommand?: string | undefined;
  reason?: string | undefined;
}

export async function resolvePrReviewVerification(input: {
  cwd: string;
  command?: string | undefined;
  source: "explicit" | "unresolved";
}): Promise<ResolvedPrReviewVerification> {
  if (input.source === "explicit" && input.command) return { command: input.command, source: "explicit" };
  const inferred = await inferVerificationCommand(input.cwd, { scripts: ["check", "verify", "test"], allowMakefile: false });
  return inferred
    ? {
        source: "not-configured",
        suggestedCommand: inferred,
        reason: `Host review did not execute inferred command '${inferred}'. Pass --verify explicitly to authorize running PR code.`,
      }
    : { source: "not-configured", reason: "No explicit verification command was provided." };
}
