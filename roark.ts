#!/usr/bin/env bun
import { runAutoContinue } from "./lib/autorun/continue.ts";
import { runAutoDiscovery } from "./lib/autorun/discovery.ts";
import { listManagedWorkspaces, runRemoveCommand, runWorkspaceCommand } from "./lib/autorun/workspace.ts";
import { parseArgs, usage } from "./lib/cli/args.ts";
import { hydrateCliOptions } from "./lib/cli/hydrate.ts";
import { runInit } from "./lib/cli/init.ts";
import { resolveInteractiveArgv, resolveInteractiveWorkspaceRemoval } from "./lib/cli/interactive.ts";
import { sendExitNotification, type ExitNotificationRequest } from "./lib/cli/notifications.ts";
import { runPrRevision } from "./lib/pr-revision/workflow.ts";
import { runPrReview } from "./lib/pr-review/workflow.ts";
import { formatDoLocalModeStartMessage, printDoLocalModeReadyMessageIfReady } from "./lib/cli/local-mode.ts";
import { renderStatus } from "./lib/observability/status.ts";
import { createWorkflowContext } from "./lib/workflow/artifacts.ts";
import { runFullWorkflow, runSinglePhase } from "./lib/workflow/phases.ts";

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const cliArgv = argv.length === 0 ? await resolveInteractiveArgv() : argv;
  if (!cliArgv) return;

  if (isVersionArgv(cliArgv)) {
    console.log(await readPackageVersion());
    return;
  }

  const rawParsed = parseArgs(cliArgv);
  if ("help" in rawParsed) {
    console.log(usage);
    return;
  }

  const parsed = await hydrateCliOptions(rawParsed);

  if (parsed.command === "init") {
    const result = await runInit(parsed);
    console.log(`Initialized Roark in ${result.root}`);
    for (const file of result.files) console.log(`- ${file}`);
    for (const line of result.guidance) console.log(line);
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

  if (parsed.command === "review-pr") {
    const result = await runPrReview(parsed);
    console.log(`\nDone. PR review outcome: ${result.outcome}. Artifacts: ${result.context.reviewDirRelative}`);
    return;
  }

  if (parsed.command === "status") {
    console.log(await renderStatus(parsed));
    return;
  }

  if (parsed.command === "workspace") {
    await runWorkspaceCommand(parsed);
    return;
  }

  if (parsed.command === "remove") {
    if (parsed.targets.length > 0) {
      await runRemoveCommand(parsed);
      return;
    }

    const managedWorkspaces = await listManagedWorkspaces({ workspace: parsed.workspace, repo: parsed.repo, cwd: parsed.cwd });
    if (managedWorkspaces.length === 0) {
      console.log("No managed workspaces found.");
      return;
    }
    const selection = await resolveInteractiveWorkspaceRemoval({ workspacePaths: managedWorkspaces.map((managedWorkspace) => managedWorkspace.path) });
    if (!selection) return;
    const targets = selection.selectedIndexes.map((index) => {
      const managedWorkspace = managedWorkspaces[index];
      if (!managedWorkspace) throw new Error("Interactive workspace selection returned an invalid index.");
      return managedWorkspace.target;
    });
    await runRemoveCommand({ ...parsed, targets });
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

function isVersionArgv(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v");
}

async function readPackageVersion(): Promise<string> {
  const packageJson = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("package.json is missing a string version.");
  return packageJson.version;
}

interface CliLifecycleDependencies {
  execute?: (argv: string[]) => Promise<void>;
  notify?: (request: ExitNotificationRequest) => Promise<void>;
  reportError?: (error: unknown) => void;
}

export async function runCli(
  argv = Bun.argv.slice(2),
  dependencies: CliLifecycleDependencies = {},
): Promise<number> {
  const execute = dependencies.execute ?? main;
  const notify = dependencies.notify ?? sendExitNotification;
  const reportError = dependencies.reportError ?? ((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });

  let exitCode = 0;
  try {
    await execute(argv);
  } catch (error) {
    exitCode = 1;
    reportError(error);
  }

  try {
    await notify({ argv, succeeded: exitCode === 0 });
  } catch {
    console.error("Warning: Roark could not deliver the exit notification.");
  }
  return exitCode;
}

if (import.meta.main) process.exitCode = await runCli();
