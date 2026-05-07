import { parseReadinessStatus } from "../autorun/publish-gate.ts";
import { readArtifact, type WorkflowContext } from "../workflow/artifacts.ts";

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

export async function printDoLocalModeReadyMessageIfReady(
  context: WorkflowContext,
  log: (message: string) => void = console.log,
): Promise<void> {
  try {
    const readiness = await readArtifact(context, "readiness");
    if (parseReadinessStatus(readiness) === "ready-for-pr") {
      log(`\n${formatDoLocalModeReadyMessage(context.issueInput)}`);
    }
  } catch {
    // Some stopped/error paths may not have a readiness artifact. Nothing to announce.
  }
}
