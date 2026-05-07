#!/usr/bin/env bun
import { runAutoContinue } from "./lib/autorun/continue.ts";
import { runAutoDiscovery } from "./lib/autorun/discovery.ts";
import { parseArgs, usage } from "./lib/cli/args.ts";
import { resolveInteractiveArgv } from "./lib/cli/interactive.ts";
import { runPrRevision } from "./lib/pr-revision/workflow.ts";
import { formatDoLocalModeStartMessage, printDoLocalModeReadyMessageIfReady } from "./lib/cli/local-mode.ts";
import { renderStatus } from "./lib/observability/status.ts";
import { createWorkflowContext } from "./lib/workflow/artifacts.ts";
import { runFullWorkflow, runSinglePhase } from "./lib/workflow/phases.ts";

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const cliArgv = argv.length === 0 ? await resolveInteractiveArgv() : argv;
  if (!cliArgv) return;

  const parsed = parseArgs(cliArgv);
  if ("help" in parsed) {
    console.log(usage);
    return;
  }

  if (parsed.command === "auto") {
    await runAutoDiscovery(parsed);
    return;
  }

  if (parsed.command === "continue") {
    await runAutoContinue(parsed);
    return;
  }

  if (parsed.command === "revise-pr") {
    const result = await runPrRevision(parsed);
    console.log(`\nDone. Revision outcome: ${result.outcome}. Artifacts: ${result.context.revisionDirRelative}`);
    return;
  }

  if (parsed.command === "status") {
    console.log(await renderStatus(parsed));
    return;
  }

  const context = createWorkflowContext(parsed);
  console.log(`Run directory: ${context.runDirRelative}`);

  if (parsed.command === "do") {
    console.log(`\n${formatDoLocalModeStartMessage(parsed.issue)}\n`);
    await runFullWorkflow(context);
    await printDoLocalModeReadyMessageIfReady(context);
  } else await runSinglePhase(context, parsed.command);

  console.log(`\nDone. Artifacts: ${context.runDirRelative}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
