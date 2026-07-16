import { artifactContract, formatArtifactRef, type ArtifactRef } from "./artifact-catalog.ts";
import { parseReviewResultJson } from "../review/result.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";
import { parseChangeReportJson } from "../change-report/result.ts";

export type ArtifactValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export class ArtifactValidationError extends Error {
  readonly artifact: ArtifactRef;
  readonly reason: string;

  constructor(artifact: ArtifactRef, reason: string) {
    super(`${formatArtifactRef(artifact)} failed output contract: ${reason}`);
    this.name = "ArtifactValidationError";
    this.artifact = artifact;
    this.reason = reason;
  }
}

export function validateAgentArtifact(artifact: ArtifactRef, content: string): ArtifactValidationResult {
  const trimmed = content.trim();
  if (!trimmed) return invalid("artifact is empty");

  if (isReviewArtifact(artifact)) {
    try {
      parseReviewResultJson(trimmed, { allowRestart: true });
      return ok();
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error));
    }
  }

  if (artifact === "triage") return validateStructured(() => parseTriageResultJson(trimmed));
  if (artifact === "implementationPlanDraft" || artifact === "implementationPlan") {
    return validateStructured(() => parseImplementationPlanResultJson(trimmed));
  }
  if (isChangeReportArtifact(artifact)) return validateStructured(() => parseChangeReportJson(trimmed));

  const priorError = parseDiagnosticArtifactError(trimmed);
  if (priorError) return invalid(priorError);

  const contract = artifactContract(artifact);
  if (!contract) return ok();

  if (contract.requiredHeading && !requiredHeadingRegex(contract.requiredHeading).test(content)) {
    return invalid(`missing # ${contract.requiredHeading} heading`);
  }

  return ok();
}

function validateStructured(parse: () => unknown): ArtifactValidationResult {
  try {
    parse();
    return ok();
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

function isReviewArtifact(artifact: ArtifactRef): boolean {
  return typeof artifact !== "string" && (artifact.name === "reviewA" || artifact.name === "reviewB");
}

function isChangeReportArtifact(artifact: ArtifactRef): boolean {
  return artifact === "implementationLog"
    || (typeof artifact !== "string" && (artifact.name === "fixLog" || artifact.name === "refinementLog"));
}

function requiredHeadingRegex(heading: string): RegExp {
  const pattern = heading.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`^#\\s+${pattern}\\b`, "im");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDiagnosticArtifactError(markdown: string): string | undefined {
  const heading = (/^#\s+(.+ Error)\s*$/im.exec(markdown))?.[1]?.trim();
  if (!heading) return undefined;

  const phase = (/##\s*Phase\s*\n+([^\n]+)/i.exec(markdown))?.[1]?.trim();
  const error = (/##\s*Error\s*\n+`{4,}(?:text)?\s*\n([\s\S]*?)\n`{4,}/i.exec(markdown))?.[1]?.trim();
  const summary = [phase, error].filter(Boolean).join(": ");
  return summary ? `previous ${heading} diagnostic: ${summary}` : `previous ${heading} diagnostic`;
}

function ok(): ArtifactValidationResult {
  return { ok: true };
}

function invalid(reason: string): ArtifactValidationResult {
  return { ok: false, reason };
}
