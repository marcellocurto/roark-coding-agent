#!/usr/bin/env bun
import {
  CommandExecution,
  ExitNotifications,
  Presentation,
} from "./lib/runtime/services.ts";
import type { ApplicationExecution } from "./lib/runtime/application.ts";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Layer } from "effect";
import {
  applicationServicesLayer,
  fromLegacyPromise,
  runApplicationPromise,
} from "./lib/runtime/application.ts";
import { runAutoContinuePromise } from "./lib/autorun/continue-promise.ts";
import { runAutoDiscoveryPromise } from "./lib/autorun/discovery-promise.ts";
import {
  listManagedWorkspacesPromise as listManagedWorkspaces,
  runRemoveCommandPromise as runRemoveCommand,
  runWorkspaceCommandPromise as runWorkspaceCommand,
} from "./lib/autorun/workspace-promise.ts";
import { isLongRunningCommand, parseArgs, usage } from "./lib/cli/args.ts";
import { hydrateCliOptions } from "./lib/cli/hydrate.ts";
import { runInit } from "./lib/cli/init.ts";
import {
  resolveInteractiveArgv,
  resolveInteractiveWorkspaceRemoval,
} from "./lib/cli/interactive.ts";
import { runPrRevisionPromise } from "./lib/pr-revision/workflow.ts";
import { runPrReviewPromise } from "./lib/pr-review/workflow-promise.ts";
import {
  formatDoLocalModeStartMessage,
  printDoLocalModeReadyMessageIfReady,
} from "./lib/cli/local-mode.ts";
import { renderStatus } from "./lib/observability/status.ts";
import { createWorkflowContext } from "./lib/workflow/artifacts.ts";
import {
  runFullWorkflowPromise as runFullWorkflow,
  runSinglePhasePromise as runSinglePhase,
} from "./lib/workflow/phases-promise.ts";
import { presenter, presentationLayer } from "./lib/presentation/presenter.ts";
import type { AutorunAttemptResult } from "./lib/autorun/attempt-lifecycle.ts";
import { displayArgvTarget, displayCommandTarget } from "./lib/cli/target.ts";

export async function main(
  argv = Bun.argv.slice(2),
  application?: ApplicationExecution,
): Promise<void> {
  if (!application)
    return runApplicationPromise(
      fromLegacyPromise((application) => main(argv, application)),
      application,
    );

  const cliArgv =
    argv.length === 0
      ? await resolveInteractiveArgv({ signal: application.signal })
      : argv;
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

  const parsed = await hydrateCliOptions(rawParsed, undefined, application);

  if (isLongRunningCommand(parsed.command)) {
    presenter(application).setRoots([parsed.cwd]);
    presenter(application).run({
      command: parsed.command,
      repository: parsed.repo,
      target: displayCommandTarget(parsed),
    });
  }

  if (parsed.command === "init") {
    const result = await runInit(parsed, undefined, application);
    console.log(`Initialized Roark in ${result.root}`);
    for (const file of result.files) console.log(`- ${file}`);
    for (const line of result.guidance) console.log(line);
    return;
  }

  if (parsed.command === "auto") {
    const result = await runAutoDiscoveryPromise(parsed, application);
    if (result.kind === "dry-run")
      presenter(application).outcome(
        "SUCCESS",
        presenter(application).currentTarget() ??
          displayCommandTarget(parsed) ??
          "auto",
        "dry run complete",
      );
    else if (result.kind === "no-eligible")
      presenter(application).outcome("STOPPED", "auto", "no eligible issues");
    else if (result.attempts.length === 0)
      presenter(application).outcome(
        "STOPPED",
        presenter(application).currentTarget() ??
          displayCommandTarget(parsed) ??
          "auto",
        "no attempt started",
      );
    else
      for (const attempt of result.attempts)
        presentAutorunOutcome(attempt, application);
    return;
  }

  if (parsed.command === "continue") {
    presentAutorunOutcome(
      await runAutoContinuePromise(parsed, application),
      application,
    );
    return;
  }

  if (parsed.command === "revise-pr") {
    const result = await runPrRevisionPromise(parsed, undefined, application);
    presenter(application).outcome(
      outcomeStatus(result.outcome),
      `PR #${parsed.prNumber}`,
      result.outcome,
    );
    presenter(application).artifact(result.context.revisionDirRelative);
    return;
  }

  if (parsed.command === "review-pr") {
    const result = await runPrReviewPromise(parsed, application);
    presenter(application).outcome(
      result.outcome === "blocked" ? "BLOCKED" : "SUCCESS",
      `PR #${parsed.prNumber}`,
      result.outcome,
    );
    presenter(application).artifact(result.context.reviewDirRelative);
    return;
  }

  if (parsed.command === "status") {
    console.log(await renderStatus(parsed));
    return;
  }

  if (parsed.command === "workspace") {
    await runWorkspaceCommand(parsed, application);
    return;
  }

  if (parsed.command === "remove") {
    if (parsed.targets.length > 0) {
      await runRemoveCommand(parsed, application);
      return;
    }

    const managedWorkspaces = await listManagedWorkspaces({
      workspace: parsed.workspace,
      repo: parsed.repo,
      cwd: parsed.cwd,
    });
    if (managedWorkspaces.length === 0) {
      console.log("No managed workspaces found.");
      return;
    }
    const selection = await resolveInteractiveWorkspaceRemoval({
      signal: application.signal,
      workspacePaths: managedWorkspaces.map(
        (managedWorkspace) => managedWorkspace.path,
      ),
    });
    if (!selection) return;
    const targets = selection.selectedIndexes.map((index) => {
      const managedWorkspace = managedWorkspaces[index];
      if (!managedWorkspace)
        throw new Error(
          "Interactive workspace selection returned an invalid index.",
        );
      return managedWorkspace.target;
    });
    await runRemoveCommand({ ...parsed, targets }, application);
    return;
  }

  const context = createWorkflowContext(parsed);
  presenter(application).line(`Run directory: ${context.runDirRelative}`);

  if (parsed.command === "do") {
    for (const line of formatDoLocalModeStartMessage(parsed.issue).split("\n"))
      presenter(application).line(line);
    const result = await runFullWorkflow(
      context,
      undefined,
      undefined,
      application,
    );
    await printDoLocalModeReadyMessageIfReady(
      context,
      (message) => {
        presenter(application).line(message);
      },
      application,
    );
    presenter(application).outcome(
      workflowOutcomeStatus(result.status),
      `#${context.issueNumber}`,
      result.status,
    );
  } else {
    await runSinglePhase(context, parsed.command, undefined, application);
    presenter(application).outcome(
      "SUCCESS",
      `#${context.issueNumber}`,
      `${parsed.command} complete`,
    );
  }

  presenter(application).artifact(context.runDirRelative);
}

export function presentAutorunOutcome(
  result: AutorunAttemptResult,
  application: ApplicationExecution,
): void {
  const status =
    result.outcome === "published"
      ? "SUCCESS"
      : result.outcome === "triage-stopped"
        ? "STOPPED"
        : "FAILED";
  presenter(application).outcome(
    status,
    `#${result.issueNumber}`,
    result.outcomeDetail ?? result.outcome,
  );
}

export function workflowOutcomeStatus(
  status:
    | "completed"
    | "triage-stopped"
    | "planning-stopped"
    | "review-blocked",
): "SUCCESS" | "BLOCKED" | "STOPPED" {
  if (status === "completed") return "SUCCESS";
  if (status === "review-blocked") return "BLOCKED";
  return "STOPPED";
}

function outcomeStatus(
  outcome: string,
): "SUCCESS" | "FAILED" | "BLOCKED" | "STOPPED" {
  if (
    outcome === "published" ||
    outcome === "no-action-needed" ||
    outcome === "no-code-changes"
  )
    return "SUCCESS";
  if (outcome === "needs-human" || outcome === "review-blocked")
    return "BLOCKED";
  return "FAILED";
}

function isVersionArgv(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v");
}

async function readPackageVersion(): Promise<string> {
  const packageJson = (await Bun.file(
    new URL("./package.json", import.meta.url),
  ).json()) as { version?: unknown };
  if (typeof packageJson.version !== "string")
    throw new Error("package.json is missing a string version.");
  return packageJson.version;
}

const commandExecutionLayer = Layer.succeed(
  CommandExecution,
  CommandExecution.of({
    execute: (argv) =>
      fromLegacyPromise((application) => main(argv, application)),
  }),
);

export const cliLayer = (argv: string[]) =>
  Layer.mergeAll(applicationServicesLayer, commandExecutionLayer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        BunServices.layer,
        presentationLayer({
          verbose: argv.includes("--verbose"),
          titleEnabled: !argv.includes("--no-title"),
        }),
      ),
    ),
  );

export const runCli = Effect.fn("runCli")(function* (
  argv: string[] = Bun.argv.slice(2),
) {
  const commands = yield* CommandExecution;
  const presentation = yield* Presentation;
  const notifications = yield* ExitNotifications;
  const longRunning = isLongRunningCommand(argv[0]);
  const exitCode = yield* commands.execute(argv).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (longRunning)
          presentation.outcome(
            "FAILED",
            presentation.currentTarget() ?? displayArgvTarget(argv),
            "run failed",
          );
        presentation.error(
          error instanceof Error ? error.message : String(error),
        );
        return 1;
      }),
    ),
  );
  yield* notifications.send({ argv, succeeded: exitCode === 0 }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        presentation.error(
          "Warning: Roark could not deliver the exit notification.",
        );
      }),
    ),
  );
  return exitCode;
});

export function runCliPromise(
  argv = Bun.argv.slice(2),
  application?: ApplicationExecution,
): Promise<number> {
  if (application)
    return runApplicationPromise(
      runCli(argv).pipe(Effect.provide(commandExecutionLayer)),
      application,
    );
  return Effect.runPromise(runCli(argv).pipe(Effect.provide(cliLayer(argv))));
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  BunRuntime.runMain(
    runCli(argv).pipe(
      Effect.tap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = exitCode;
        }),
      ),
      Effect.provide(cliLayer(argv)),
    ),
  );
}
