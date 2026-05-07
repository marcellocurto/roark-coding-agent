import { parseReadyForImplementationValue, parseVerdict } from "./verdicts.ts";
import { artifactContract, formatArtifactRef, type ArtifactRef } from "./artifact-catalog.ts";

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

  const priorError = parseDiagnosticArtifactError(trimmed);
  if (priorError) return invalid(priorError);

  const contract = artifactContract(artifact);
  if (!contract) return ok();

  if (contract.requiredHeading && !requiredHeadingRegex(contract.requiredHeading).test(content)) {
    return invalid(`missing # ${contract.requiredHeading} heading`);
  }

  if (contract.requiresReadyForImplementation) {
    const ready = parseReadyForImplementationValue(content);
    if (!ready) return invalid("missing ## Ready For Implementation value of yes or no");
  }

  if (contract.allowedVerdicts) return requireVerdict(artifact, content, contract.allowedVerdicts);

  return ok();
}

function requiredHeadingRegex(heading: string): RegExp {
  const pattern = heading.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`^#\\s+${pattern}\\b`, "im");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireVerdict(
  artifact: ArtifactRef,
  content: string,
  allowed: readonly string[],
): ArtifactValidationResult {
  const verdict = parseVerdict(content);
  if (!verdict) return invalid("missing ## Verdict/## Status value");
  if (!allowed.includes(verdict)) {
    return invalid(
      `${formatArtifactRef(artifact)} verdict '${verdict}' is not one of: ${allowed.join(", ")}`,
    );
  }
  return ok();
}

function parseDiagnosticArtifactError(markdown: string): string | undefined {
  const heading = markdown.match(/^#\s+(.+ Error)\s*$/im)?.[1]?.trim();
  if (!heading) return undefined;

  const phase = markdown.match(/##\s*Phase\s*\n+([^\n]+)/i)?.[1]?.trim();
  const error = markdown.match(/##\s*Error\s*\n+`{4,}(?:text)?\s*\n([\s\S]*?)\n`{4,}/i)?.[1]?.trim();
  const summary = [phase, error].filter(Boolean).join(": ");
  return summary ? `previous ${heading} diagnostic: ${summary}` : `previous ${heading} diagnostic`;
}

function ok(): ArtifactValidationResult {
  return { ok: true };
}

function invalid(reason: string): ArtifactValidationResult {
  return { ok: false, reason };
}
