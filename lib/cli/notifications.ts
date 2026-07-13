import path from "node:path";
import { isWorkflowCommand } from "./args.ts";
import type { RoarkConfig } from "./hydrate.ts";
import { loadRoarkConfig, resolveWorkspace } from "./hydrate.ts";

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

interface NotifierProcess {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface NotificationDependencies {
  platform?: NodeJS.Platform;
  cwd?: string;
  resolveWorkspace?: (cwd: string) => Promise<string>;
  loadConfig?: (workspace: string) => Promise<RoarkConfig>;
  spawn?: (args: string[]) => NotifierProcess;
  warn?: (message: string) => void;
  timeoutMs?: number;
}

export async function sendExitNotification(
  request: ExitNotificationRequest,
  dependencies: NotificationDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") return;

  let workspace: string;
  let config: RoarkConfig;
  try {
    const cwd = notificationCwd(request.argv, dependencies.cwd ?? process.cwd());
    workspace = await (dependencies.resolveWorkspace ?? resolveWorkspace)(cwd);
    config = await (dependencies.loadConfig ?? loadRoarkConfig)(workspace);
  } catch {
    // Notification opt-in is available only through a valid repository config.
    return;
  }

  if (config.notifications?.onExit !== true) return;

  const content = formatNotificationContent(request, workspace);
  await deliverMacNotification(content, dependencies);
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

export async function deliverMacNotification(
  content: NotificationContent,
  dependencies: NotificationDependencies = {},
): Promise<void> {
  if ((dependencies.platform ?? process.platform) !== "darwin") return;

  const spawn = dependencies.spawn ?? spawnNotifier;
  const warn = dependencies.warn ?? ((message: string) => {
    console.error(message);
  });
  const timeoutMs = dependencies.timeoutMs ?? notificationTimeoutMs;
  let child: NotifierProcess;

  try {
    child = spawn(["/usr/bin/osascript", "-e", notificationScript, content.title, content.body]);
  } catch {
    warn("Warning: Roark could not deliver the exit notification.");
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => {
          resolve({ kind: "timeout" });
        }, timeoutMs);
      }),
    ]);

    if (result.kind === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited while the timeout was being handled.
      }
      // Bun reaps the forcibly terminated child through this promise. Do not
      // await it: notifier cleanup must not extend the delivery timeout.
      void child.exited.catch(() => undefined);
      warn("Warning: Roark could not deliver the exit notification.");
      return;
    }

    if (result.exitCode !== 0) warn("Warning: Roark could not deliver the exit notification.");
  } catch {
    warn("Warning: Roark could not deliver the exit notification.");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function spawnNotifier(args: string[]): NotifierProcess {
  return Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
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
