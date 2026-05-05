#!/usr/bin/env bun
import { runAutoDiscovery } from "./lib/autorun/discovery.ts";
import { parseArgs, usage } from "./lib/cli/args.ts";
import { createWorkflowContext } from "./lib/workflow/artifacts.ts";
import { runFullWorkflow, runSinglePhase } from "./lib/workflow/phases.ts";

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    console.log(usage);
    return;
  }

  if (parsed.command === "auto") {
    await runAutoDiscovery(parsed);
    return;
  }

  const context = createWorkflowContext(parsed);
  console.log(`Run directory: ${context.runDirRelative}`);

  if (parsed.command === "do") await runFullWorkflow(context);
  else await runSinglePhase(context, parsed.command);

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
