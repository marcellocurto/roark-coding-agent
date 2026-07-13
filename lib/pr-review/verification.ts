import { inferVerificationCommand } from "../autorun/verification.ts";

export interface ResolvedPrReviewVerification {
  command?: string | undefined;
  source: "explicit" | "config" | "inferred" | "not-configured";
  suggestedCommand?: string | undefined;
  reason?: string | undefined;
}

export async function resolvePrReviewVerification(input: {
  cwd: string;
  command?: string | undefined;
  source: "explicit" | "config" | "unresolved";
}): Promise<ResolvedPrReviewVerification> {
  if (input.command) return { command: input.command, source: input.source === "config" ? "config" : "explicit" };
  const inferred = await inferVerificationCommand(input.cwd, { scripts: ["check", "verify", "test"], allowMakefile: false });
  return inferred
    ? {
        source: "not-configured",
        suggestedCommand: inferred,
        reason: `Host review did not execute inferred command '${inferred}'. Pass --verify explicitly to authorize running PR code.`,
      }
    : { source: "not-configured", reason: "No explicit or repository-configured verification command was provided." };
}
