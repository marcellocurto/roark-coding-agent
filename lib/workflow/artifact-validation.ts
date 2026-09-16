import { Effect } from "effect";
import type { ArtifactContractError } from "../structured-output/contract.ts";
import {
  artifactContract,
  isReviewArtifact,
  isChangeReportArtifact,
  type ArtifactRef,
} from "./artifact-catalog.ts";
import { parseReviewResultJson } from "../review/result.ts";
import { parseTriageResultJson } from "../triage/result.ts";
import { parseImplementationPlanResultJson } from "../implementation-plan/result.ts";
import { parseChangeReportJson } from "../change-report/result.ts";

export type ArtifactValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export const validateAgentArtifact = Effect.fn("validateAgentArtifact")(
  function* (
    artifact: ArtifactRef,
    content: string,
  ): Effect.fn.Return<ArtifactValidationResult> {
    const trimmed = content.trim();
    if (!trimmed) return invalid("artifact is empty");

    if (isReviewArtifact(artifact))
      return yield* validateStructured(
        parseReviewResultJson(trimmed, { allowRestart: true }),
      );
    if (artifact === "triage")
      return yield* validateStructured(parseTriageResultJson(trimmed));
    if (
      artifact === "implementationPlanDraft" ||
      artifact === "implementationPlan"
    )
      return yield* validateStructured(
        parseImplementationPlanResultJson(trimmed),
      );
    if (isChangeReportArtifact(artifact))
      return yield* validateStructured(parseChangeReportJson(trimmed));

    const priorError = parseDiagnosticArtifactError(trimmed);
    if (priorError) return invalid(priorError);

    const contract = artifactContract(artifact);
    if (!contract) return ok();

    if (
      contract.requiredHeading &&
      !requiredHeadingRegex(contract.requiredHeading).test(content)
    ) {
      return invalid(`missing # ${contract.requiredHeading} heading`);
    }

    return ok();
  },
);

function validateStructured(
  parse: Effect.Effect<unknown, ArtifactContractError>,
) {
  return parse.pipe(
    Effect.match({
      onSuccess: ok,
      onFailure: (error) => invalid(error.message),
    }),
  );
}

function requiredHeadingRegex(heading: string): RegExp {
  const pattern = heading.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`^#\\s+${pattern}\\b`, "im");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDiagnosticArtifactError(markdown: string): string | undefined {
  const heading = /^#\s+(.+ Error)\s*$/im.exec(markdown)?.[1]?.trim();
  if (!heading) return undefined;

  const phase = /##\s*Phase\s*\n+([^\n]+)/i.exec(markdown)?.[1]?.trim();
  const error = /##\s*Error\s*\n+`{4,}(?:text)?\s*\n([\s\S]*?)\n`{4,}/i
    .exec(markdown)?.[1]
    ?.trim();
  const summary = [phase, error].filter(Boolean).join(": ");
  return summary
    ? `previous ${heading} diagnostic: ${summary}`
    : `previous ${heading} diagnostic`;
}

function ok(): ArtifactValidationResult {
  return { ok: true };
}

function invalid(reason: string): ArtifactValidationResult {
  return { ok: false, reason };
}
