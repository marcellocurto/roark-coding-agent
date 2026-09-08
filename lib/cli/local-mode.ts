import { decodeArtifact } from "../workflow/validation.ts";
import { Effect } from "effect";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";
import { parseReadinessResultJson } from "../workflow/readiness.ts";
export function formatDoLocalModeStartMessage(issue: string): string {
  return [
    `Local/manual do mode for issue ${issue}.`,
    "This mode runs in the current checkout and will not create/switch branches, claim, label/comment on GitHub, push, or open a PR.",
    `For the managed branch/PR flow, use: bun run auto ${issue}`,
  ].join("\n");
}
export function formatDoLocalModeReadyMessage(issue: string): string {
  return `Issue ${issue} is ready for PR, but no PR was opened because this was local/manual do mode. Use 'bun run auto ${issue}' for the managed branch/PR flow.`;
}
export const printDoLocalModeReadyMessageIfReady = Effect.fnUntraced(function* (
  context: WorkflowContext,
  log: (message: string) => void = console.log,
) {
  const readiness = yield* readArtifact(context, "readiness").pipe(
    Effect.flatMap((raw) => decodeArtifact(parseReadinessResultJson, raw)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (readiness?.decision.status === "ready-for-pr")
    log(`\n${formatDoLocalModeReadyMessage(context.issueInput)}`);
});
