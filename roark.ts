#!/usr/bin/env bun
import { runAutoContinue } from "./lib/autorun/continue.ts";
import { runAutoDiscovery } from "./lib/autorun/discovery.ts";
import { listManagedWorkspaces, runRemoveCommand, runWorkspaceCommand } from "./lib/autorun/workspace.ts";
import { isLongRunningCommand, parseArgs, usage } from "./lib/cli/args.ts";
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
import { Presenter, presenter, runWithPresenter } from "./lib/presentation/presenter.ts";
import { sanitizeTerminalText } from "./lib/presentation/terminal.ts";
import type { AutorunAttemptResult } from "./lib/autorun/attempt-lifecycle.ts";
import { displayArgvTarget, displayCommandTarget } from "./lib/cli/target.ts";

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

  if (isLongRunningCommand(parsed.command)) {
    presenter().setRoots([parsed.cwd]);
    presenter().run({ command: parsed.command, repository: parsed.repo, target: displayCommandTarget(parsed) });
  }

  if (parsed.command === "init") {
    const result = await runInit(parsed);
    console.log(`Initialized Roark in ${result.root}`);
    for (const file of result.files) console.log(`- ${file}`);
    for (const line of result.guidance) console.log(line);
    return;
  }

  if (parsed.command === "auto") {
    const result = await runAutoDiscovery(parsed);
    if (result.kind === "dry-run") presenter().outcome("SUCCESS", presenter().currentTarget() ?? displayCommandTarget(parsed) ?? "auto", "dry run complete");
    else if (result.kind === "no-eligible") presenter().outcome("STOPPED", "auto", "no eligible issues");
    else if (result.attempts.length === 0) presenter().outcome("STOPPED", presenter().currentTarget() ?? displayCommandTarget(parsed) ?? "auto", "no attempt started");
    else for (const attempt of result.attempts) presentAutorunOutcome(attempt);
    return;
  }

  if (parsed.command === "continue") {
    presentAutorunOutcome(await runAutoContinue(parsed));
    return;
  }

  if (parsed.command === "revise-pr") {
    const result = await runPrRevision(parsed);
    presenter().outcome(outcomeStatus(result.outcome), `PR #${parsed.prNumber}`, result.outcome);
    presenter().artifact(result.context.revisionDirRelative);
    return;
  }

  if (parsed.command === "review-pr") {
    const result = await runPrReview(parsed);
    presenter().outcome(result.outcome === "blocked" ? "BLOCKED" : "SUCCESS", `PR #${parsed.prNumber}`, result.outcome);
    presenter().artifact(result.context.reviewDirRelative);
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
  presenter().line(`Run directory: ${context.runDirRelative}`);

  if (parsed.command === "do") {
    for (const line of formatDoLocalModeStartMessage(parsed.issue).split("\n")) presenter().line(line);
    const result = await runFullWorkflow(context);
    await printDoLocalModeReadyMessageIfReady(context, (message) => {
      presenter().line(message);
    });
    presenter().outcome(workflowOutcomeStatus(result.status), `#${context.issueNumber}`, result.status);
  } else {
    await runSinglePhase(context, parsed.command);
    presenter().outcome("SUCCESS", `#${context.issueNumber}`, `${parsed.command} complete`);
  }

  presenter().artifact(context.runDirRelative);
}

export function presentAutorunOutcome(result: AutorunAttemptResult): void {
  const status = result.outcome === "published"
    ? "SUCCESS"
    : result.outcome === "triage-stopped"
      ? "STOPPED"
      : "FAILED";
  presenter().outcome(status, `#${result.issueNumber}`, result.outcomeDetail ?? result.outcome);
}

export function workflowOutcomeStatus(status: "completed" | "triage-stopped" | "planning-stopped" | "review-blocked"): "SUCCESS" | "BLOCKED" | "STOPPED" {
  if (status === "completed") return "SUCCESS";
  if (status === "review-blocked") return "BLOCKED";
  return "STOPPED";
}

function outcomeStatus(outcome: string): "SUCCESS" | "FAILED" | "BLOCKED" | "STOPPED" {
  if (outcome === "published" || outcome === "no-action-needed" || outcome === "no-code-changes") return "SUCCESS";
  if (outcome === "needs-human" || outcome === "review-blocked") return "BLOCKED";
  return "FAILED";
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
  presentation?: Presenter | undefined;
}

export async function runCli(
  argv = Bun.argv.slice(2),
  dependencies: CliLifecycleDependencies = {},
): Promise<number> {
  const execute = dependencies.execute ?? main;
  const notify = dependencies.notify ?? sendExitNotification;
  const reportError = dependencies.reportError ?? ((error: unknown) => {
    console.error(sanitizeTerminalText(error instanceof Error ? error.message : String(error)));
  });

  const longRunning = isLongRunningCommand(argv[0]);
  const presentation = dependencies.presentation ?? new Presenter({
    verbose: argv.includes("--verbose"),
    titleEnabled: !argv.includes("--no-title"),
  });

  let exitCode = 0;
  try {
    await runWithPresenter(presentation, () => execute(argv));
  } catch (error) {
    exitCode = 1;
    if (longRunning) presentation.outcome("FAILED", presentation.currentTarget() ?? displayArgvTarget(argv), "run failed");
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
