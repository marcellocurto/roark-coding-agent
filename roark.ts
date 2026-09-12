#!/usr/bin/env bun
import {
  createFileRunObserver,
  RunObservation,
} from "./lib/observability/observer.ts";
import { fileURLToPath } from "node:url";
import * as nativeWorkspace from "./lib/autorun/workspace.ts";
import { runAutoDiscovery } from "./lib/autorun/discovery.ts";
import { runAutoContinue } from "./lib/autorun/continue.ts";
import { runPrReview } from "./lib/pr-review/workflow.ts";
import * as nativePhases from "./lib/workflow/phases.ts";
import type { WorkflowTerminalStatus } from "./lib/workflow/progression.ts";
import {
  CommandExecution,
  ExitNotifications,
  Presentation,
} from "./lib/runtime/services.ts";
import { applicationServicesLayer } from "./lib/runtime/application.ts";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Effect, Layer, FileSystem, Schema } from "effect";
import { isLongRunningCommand, parseArgs, usage } from "./lib/cli/args.ts";
import { hydrateCliOptions } from "./lib/cli/hydrate.ts";
import { runInit } from "./lib/cli/init.ts";
import {
  resolveInteractiveArgv,
  resolveInteractiveWorkspaceRemoval,
} from "./lib/cli/interactive.ts";
import { runPrRevision } from "./lib/pr-revision/workflow.ts";
import {
  formatDoLocalModeStartMessage,
  printDoLocalModeReadyMessageIfReady,
} from "./lib/cli/local-mode.ts";
import { renderStatus } from "./lib/observability/status.ts";
import { createWorkflowContext } from "./lib/workflow/artifacts.ts";
import { presentationLayer } from "./lib/presentation/presenter.ts";
import { type AutorunAttemptResult } from "./lib/autorun/attempt-lifecycle.ts";
import { displayArgvTarget, displayCommandTarget } from "./lib/cli/target.ts";
export const main = Effect.fn("main")(function* (
  argv: string[] = Bun.argv.slice(2),
) {
  const presentation = yield* Presentation;
  const cliArgv = argv.length === 0 ? yield* resolveInteractiveArgv() : argv;
  if (!cliArgv) return;
  if (isVersionArgv(cliArgv)) {
    console.log(yield* readPackageVersion());
    return;
  }
  const rawParsed = yield* parseCliArguments(cliArgv);
  if ("help" in rawParsed) {
    console.log(usage);
    return;
  }
  const parsed = yield* hydrateCliOptions(rawParsed);
  if (isLongRunningCommand(parsed.command)) {
    presentation.setRoots([parsed.cwd]);
    presentation.run({
      command: parsed.command,
      repository: parsed.repo,
      target: displayCommandTarget(parsed),
    });
  }
  if (parsed.command === "init") {
    const result = yield* runInit(parsed);
    console.log(`Initialized Roark in ${result.root}`);
    for (const file of result.files) console.log(`- ${file}`);
    for (const line of result.guidance) console.log(line);
    return;
  }
  if (parsed.command === "auto") {
    const result = yield* runAutoDiscovery(parsed);
    if (result.kind === "dry-run")
      presentation.outcome(
        "SUCCESS",
        presentation.currentTarget() ?? displayCommandTarget(parsed) ?? "auto",
        "dry run complete",
      );
    else if (result.kind === "no-eligible")
      presentation.outcome("STOPPED", "auto", "no eligible issues");
    else if (result.attempts.length === 0)
      presentation.outcome(
        "STOPPED",
        presentation.currentTarget() ?? displayCommandTarget(parsed) ?? "auto",
        "no attempt started",
      );
    else
      for (const attempt of result.attempts)
        yield* presentAutorunOutcome(attempt);
    return;
  }
  if (parsed.command === "continue") {
    yield* presentAutorunOutcome(yield* runAutoContinue(parsed));
    return;
  }
  if (parsed.command === "revise-pr") {
    const result = yield* runPrRevision(parsed);
    presentation.outcome(
      outcomeStatus(result.outcome),
      `PR #${parsed.prNumber}`,
      result.outcome,
    );
    presentation.artifact(result.context.revisionDirRelative);
    return;
  }
  if (parsed.command === "review-pr") {
    const result = yield* runPrReview(parsed);
    presentation.outcome(
      result.outcome === "blocked" ? "BLOCKED" : "SUCCESS",
      `PR #${parsed.prNumber}`,
      result.outcome,
    );
    presentation.artifact(result.context.reviewDirRelative);
    return;
  }
  if (parsed.command === "status") {
    console.log(yield* renderStatus(parsed));
    return;
  }
  if (parsed.command === "workspace") {
    yield* nativeWorkspace.runWorkspaceCommand(parsed);
    return;
  }
  if (parsed.command === "remove") {
    if (parsed.targets.length > 0) {
      yield* nativeWorkspace.runRemoveCommand(parsed);
      return;
    }
    const managedWorkspaces = yield* nativeWorkspace.listManagedWorkspaces({
      workspace: parsed.workspace,
      repo: parsed.repo,
      cwd: parsed.cwd,
    });
    if (managedWorkspaces.length === 0) {
      console.log("No managed workspaces found.");
      return;
    }
    const selection = yield* resolveInteractiveWorkspaceRemoval({
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
    yield* nativeWorkspace.runRemoveCommand({ ...parsed, targets });
    return;
  }
  const context = yield* Effect.try({
    try: () => createWorkflowContext(parsed),
    catch: (cause) =>
      new CliInputError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const observer = yield* createFileRunObserver(context);
  presentation.line(`Run directory: ${context.runDirRelative}`);
  if (parsed.command === "do") {
    for (const line of formatDoLocalModeStartMessage(parsed.issue).split("\n"))
      presentation.line(line);
    const result = yield* nativePhases
      .runFullWorkflow(context, {})
      .pipe(Effect.provideService(RunObservation, observer));
    yield* printDoLocalModeReadyMessageIfReady(context, (message) => {
      presentation.line(message);
    });
    presentation.outcome(
      workflowOutcomeStatus(result.status),
      `#${context.issueNumber}`,
      result.status,
    );
  } else {
    yield* nativePhases
      .runSinglePhase(context, parsed.command)
      .pipe(Effect.provideService(RunObservation, observer));
    presentation.outcome(
      "SUCCESS",
      `#${context.issueNumber}`,
      `${parsed.command} complete`,
    );
  }
  presentation.artifact(context.runDirRelative);
});
export const presentAutorunOutcome = Effect.fn("presentAutorunOutcome")(
  function* (result: AutorunAttemptResult) {
    const presentation = yield* Presentation;
    const status =
      result.outcome === "published"
        ? "SUCCESS"
        : result.outcome === "continuation-stopped" ||
            result.outcome === "triage-stopped" ||
            result.outcome === "planning-stopped" ||
            result.outcome === "execution-stopped"
          ? "STOPPED"
          : "FAILED";
    presentation.outcome(
      status,
      `#${result.issueNumber}`,
      result.outcomeDetail ?? result.outcome,
    );
    if (result.report) presentation.outcomeReport(result.report);
  },
);
export function workflowOutcomeStatus(
  status: WorkflowTerminalStatus["status"],
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
const packageVersionSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String }),
);
const readPackageVersion = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(
    fileURLToPath(new URL("./package.json", import.meta.url)),
  );
  const value = yield* Schema.decodeUnknownEffect(packageVersionSchema)(
    raw,
  ).pipe(
    Effect.mapError(
      () =>
        new CliInputError({
          message: "package.json is missing a string version.",
        }),
    ),
  );
  return value.version;
});
const commandExecutionLayer = Layer.succeed(
  CommandExecution,
  CommandExecution.of({
    execute: main,
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
  const exitCode = yield* commands.execute(argv).pipe(
    Effect.as(0),
    Effect.catchCauseIf(
      (cause) => !Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause);
          const command = presentation.currentCommand() ?? argv[0];
          if (isLongRunningCommand(command))
            presentation.outcome(
              "FAILED",
              presentation.currentTarget() ??
                (argv.length === 0 ? command : displayArgvTarget(argv)),
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
    Effect.catchCauseIf(
      (cause) => !Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      () =>
        Effect.sync(() => {
          presentation.error(
            "Warning: Roark could not deliver the exit notification.",
          );
        }),
    ),
  );
  return exitCode;
});
export class CliInputError extends Schema.TaggedError<CliInputError>()(
  "CliInputError",
  { message: Schema.String },
) {}
const parseCliArguments = Effect.fnUntraced(function* (argv: string[]) {
  return yield* Effect.try({
    try: () => parseArgs(argv),
    catch: (cause) =>
      new CliInputError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

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
