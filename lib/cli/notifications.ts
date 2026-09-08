import { Effect, FileSystem, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runProcess } from "./process.ts";
import path from "node:path";
import { isWorkflowCommand } from "./args.ts";
import { decodeRoarkConfig, workspaceFromGitResult } from "./hydrate.ts";

export const notificationTimeoutMs = 2_000;

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

export interface NotificationDependencies {
  platform?: NodeJS.Platform;
  cwd?: string;
  resolveWorkspace?: typeof resolveNotificationWorkspace;
  loadConfig?: typeof loadNotificationConfig;
  warn?: (message: string) => void;
  timeoutMs?: number;
}

export function sendExitNotification(
  request: ExitNotificationRequest,
  dependencies: NotificationDependencies = {},
) {
  return Effect.gen(function*() {
    if ((dependencies.platform ?? process.platform) !== "darwin") return;
    const lookup = yield* Effect.gen(function*() {
      const cwd = notificationCwd(request.argv, dependencies.cwd ?? process.cwd());
      const workspace = yield* (dependencies.resolveWorkspace ?? resolveNotificationWorkspace)(cwd);
      const config = yield* (dependencies.loadConfig ?? loadNotificationConfig)(workspace);
      return { workspace, config };
    }).pipe(Effect.option);
    // Notification opt-in is available only through a valid repository config.
    if (Option.isNone(lookup) || lookup.value.config.notifications?.onExit !== true) return;
    yield* deliverMacNotification(formatNotificationContent(request, lookup.value.workspace), dependencies);
  });
}

function resolveNotificationWorkspace(cwd: string) {
  const absoluteStart = path.resolve(cwd);
  return runProcess(["git", "rev-parse", "--show-toplevel"], { cwd: absoluteStart }).pipe(
    Effect.flatMap((result) => Effect.try(() => workspaceFromGitResult(absoluteStart, result))),
  );
}

function loadNotificationConfig(workspace: string) {
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const configPath = path.join(workspace, ".roark", "config.json");
    const content = yield* fs.readFileString(configPath);
    return yield* Effect.try(() => decodeRoarkConfig(JSON.parse(content), configPath));
  });
}

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

export function deliverMacNotification(
  content: NotificationContent,
  dependencies: NotificationDependencies = {},
) {
  return Effect.gen(function*() {
    if ((dependencies.platform ?? process.platform) !== "darwin") return;
    const delivered = yield* Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("/usr/bin/osascript", [
        "-e", notificationScript, content.title, content.body,
      ], { stdin: "ignore", stdout: "ignore", stderr: "ignore", killSignal: "SIGKILL" }));
      return (yield* child.exitCode) === 0;
    })).pipe(
      Effect.timeoutOption(dependencies.timeoutMs ?? notificationTimeoutMs),
      Effect.map((result) => Option.isSome(result) && result.value),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!delivered) {
      const warn = dependencies.warn ?? ((message: string) => { console.error(message); });
      warn("Warning: Roark could not deliver the exit notification.");
    }
  });
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
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) return "version";
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

  if (isWorkflowCommand(command) && !["init", "workspace", "review-pr", "revise-pr"].includes(command)) {
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
