import {
  ExitNotifications,
  Presentation,
  RepositoryConfiguration,
} from "../runtime/services.ts";
import { Context, Effect, Layer, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runProcess } from "./process.ts";
import path from "node:path";
import { isWorkflowCommand } from "./args.ts";
import { workspaceFromGitResult } from "./hydrate.ts";
export const notificationTimeoutMs = 2000;
const notificationScript = `on run argv
  set notificationTitle to item 1 of argv
  set notificationBody to item 2 of argv
  display notification notificationBody with title notificationTitle
end run`;
export interface ExitNotificationRequest {
  argv: string[];
  succeeded: boolean;
}
export interface NotificationContent {
  title: "Roark finished" | "Roark failed";
  body: string;
}
export const NotificationSettings = Context.Reference<{
  platform: NodeJS.Platform;
  cwd: string;
  timeoutMs: number;
}>("roark/cli/NotificationSettings", {
  defaultValue: () => ({
    platform: process.platform,
    cwd: process.cwd(),
    timeoutMs: notificationTimeoutMs,
  }),
});
export const exitNotificationsLayer = Layer.effect(
  ExitNotifications,
  Effect.gen(function* () {
    const configuration = yield* RepositoryConfiguration;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const presentation = yield* Presentation;
    const deliver = Effect.fn("deliverMacNotification")(function* (
      content: NotificationContent,
    ) {
      const settings = yield* NotificationSettings;
      if (settings.platform !== "darwin") return;
      const delivered = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              "/usr/bin/osascript",
              ["-e", notificationScript, content.title, content.body],
              {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                killSignal: "SIGKILL",
              },
            ),
          );
          return (yield* child.exitCode) === 0;
        }),
      ).pipe(
        Effect.timeoutOption(settings.timeoutMs),
        Effect.map((result) => Option.isSome(result) && result.value),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!delivered)
        presentation.error(
          "Warning: Roark could not deliver the exit notification.",
        );
    });
    const send = Effect.fn("sendExitNotification")(function* (
      request: ExitNotificationRequest,
    ) {
      const settings = yield* NotificationSettings;
      if (settings.platform !== "darwin") return;
      const lookup = yield* Effect.gen(function* () {
        const cwd = path.resolve(notificationCwd(request.argv, settings.cwd));
        const result = yield* runProcess(
          ["git", "rev-parse", "--show-toplevel"],
          { cwd },
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
        );
        const workspace = yield* workspaceFromGitResult(cwd, result);
        const config = yield* configuration.load(workspace);
        return { workspace, config };
      }).pipe(Effect.option);
      if (
        Option.isSome(lookup) &&
        lookup.value.config.notifications?.onExit === true
      ) {
        yield* deliver(
          formatNotificationContent(request, lookup.value.workspace),
        );
      }
    });
    return ExitNotifications.of({ send, deliver });
  }),
);
export const sendExitNotification = Effect.fnUntraced(function* (
  request: ExitNotificationRequest,
) {
  const notifications = yield* ExitNotifications;
  yield* notifications.send(request);
});
export const deliverMacNotification = Effect.fnUntraced(function* (
  content: NotificationContent,
) {
  const notifications = yield* ExitNotifications;
  yield* notifications.deliver(content);
});
export function formatNotificationContent(
  request: ExitNotificationRequest,
  workspace: string,
): NotificationContent {
  const title = request.succeeded ? "Roark finished" : "Roark failed";
  const command = commandIdentity(request.argv);
  const target = targetIdentity(command, request.argv);
  const repository = repositoryIdentity(workspace);
  return { title, body: `${command}${target} · ${repository}` };
}
function notificationCwd(argv: string[], fallback: string): string {
  for (let index = argv.length - 2; index >= 0; index--) {
    if (argv[index] !== "--cwd") continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) return value;
  }
  return fallback;
}
function commandIdentity(argv: string[]): string {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v"))
    return "version";
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const command = argv[0];
  return command && isWorkflowCommand(command) ? command : "roark";
}
function targetIdentity(command: string, argv: string[]): string {
  if (command === "review-pr" || command === "revise-pr") {
    const number = normalizedNumber(argv[1]);
    return number ? ` #${number}` : "";
  }
  if (command === "workspace" && argv[1] === "remove") {
    const issue = valueAfter(argv, "--issue");
    const pr = valueAfter(argv, "--pr");
    const number = normalizedNumber(issue ?? pr);
    return number ? ` #${number}` : "";
  }
  if (
    isWorkflowCommand(command) &&
    !["init", "workspace", "review-pr", "revise-pr"].includes(command)
  ) {
    const number = normalizedIssueNumber(argv[1]);
    return number ? ` #${number}` : "";
  }
  return "";
}
function normalizedIssueNumber(value: string | undefined): string | undefined {
  if (!value || value.startsWith("--")) return undefined;
  const match = /(?:^|#|\/issues\/)(\d+)$/.exec(value);
  return match?.[1];
}
function normalizedNumber(value: string | undefined): string | undefined {
  const match = /^#?(\d+)$/.exec(value ?? "");
  return match?.[1];
}
function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
function repositoryIdentity(workspace: string): string {
  const basename = path.basename(path.resolve(workspace));
  const normalized = basename
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "repository";
}
