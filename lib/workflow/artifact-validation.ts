import { parseReadyForImplementationValue, parseVerdict } from "./verdicts.ts";
import { formatArtifactRef, type ArtifactRef } from "./artifacts.ts";

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

  if (typeof artifact === "string") {
    if (artifact === "triage") {
      return requireVerdict(artifact, content, ["proceed", "blocked", "reject", "needs-human-decision"]);
    }
    if (artifact === "implementationPlan") {
      if (!/^#\s+Implementation Plan\b/im.test(content)) return invalid("missing # Implementation Plan heading");
      const ready = parseReadyForImplementationValue(content);
      if (!ready) return invalid("missing ## Ready For Implementation value of yes or no");
      return ok();
    }
    if (artifact === "implementationLog") {
      if (!/^#\s+Implementation Log\b/im.test(content)) return invalid("missing # Implementation Log heading");
      return ok();
    }
    if (artifact === "reviewA" || artifact === "reviewB") {
      return requireVerdict(artifact, content, ["approve", "fixes-required", "blocked"]);
    }
    return ok();
  }

  if (artifact.name === "fixLog") {
    if (!new RegExp(`^#\\s+Fix Log Pass\\s+${artifact.pass}\\b`, "im").test(content)) {
      return invalid(`missing # Fix Log Pass ${artifact.pass} heading`);
    }
    return ok();
  }

  if (artifact.name === "finalReview") {
    return requireVerdict(artifact, content, ["ready-for-pr", "fixes-required", "blocked"]);
  }

  return ok();
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
