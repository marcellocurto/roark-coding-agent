import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Presenter } from "../presentation/presenter.ts";
import { CommandExecution, Presentation } from "../runtime/services.ts";
import { Cause, Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  applicationServicesLayer,
  type ApplicationServices,
} from "../runtime/application.ts";
import { runProcessOrThrowPromise } from "./process-promise.ts";
import { runCli } from "../../roark.ts";
import { singlePhaseCommands } from "../workflow/phase-vocabulary.ts";
import {
  deliverMacNotification,
  formatNotificationContent,
  sendExitNotification,
  NotificationSettings,
  type NotificationContent,
} from "./notifications.ts";

const content: NotificationContent = {
  title: "Roark finished",
  body: "status · repository",
};

function runWithNotifier<A, E>(
  effect: Effect.Effect<A, E, ApplicationServices>,
  options: {
    args?: string[][];
    platform?: NodeJS.Platform;
    cwd?: string;
    timeoutMs?: number;
    warnings?: string[];
    script?: string;
    executable?: string;
    onStart?: (pid: number) => void;
    signal?: AbortSignal;
  } = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) => {
        if (
          command._tag !== "StandardCommand" ||
          command.command !== "/usr/bin/osascript"
        )
          return live.spawn(command);
        options.args?.push([command.command, ...command.args]);
        return live
          .spawn(
            ChildProcess.make(
              options.executable ?? "sh",
              ["-c", options.script ?? "exit 0"],
              command.options,
            ),
          )
          .pipe(
            Effect.tap((child) =>
              Effect.sync(() => {
                options.onStart?.(child.pid);
              }),
            ),
          );
      });
      return yield* effect.pipe(
        Effect.provide(applicationServicesLayer),
        Effect.provideService(
          Presentation,
          new Presenter({
            errorStream: {
              isTTY: false,
              write(chunk) {
                options.warnings?.push(chunk.trimEnd());
              },
            },
          }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(NotificationSettings, {
          platform: options.platform ?? "darwin",
          cwd: options.cwd ?? process.cwd(),
          timeoutMs: options.timeoutMs ?? 2_000,
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
    { signal: options.signal },
  );
}

describe("sendExitNotification", () => {
  test("is silent outside a repository and on non-macOS hosts", async () => {
    const args: string[][] = [];
    const warnings: string[] = [];
    await runWithNotifier(
      sendExitNotification({
        argv: ["status", "--cwd", "/missing-roark-repository"],
        succeeded: true,
      }),
      { args, warnings },
    );
    await runWithNotifier(
      sendExitNotification({ argv: ["status"], succeeded: true }),
      { args, warnings, platform: "linux" },
    );
    expect(args).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("CLI notification uses native workspace and config lookup with the provided process service", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-native-notify-"));
    try {
      await runProcessOrThrowPromise(["git", "init", "--quiet", cwd]);
      await mkdir(path.join(cwd, ".roark"));
      await mkdir(path.join(cwd, "nested"));
      const configPath = path.join(cwd, ".roark", "config.json");
      const args: string[][] = [];
      const run = () =>
        runWithNotifier(
          runCli(["status", "--cwd", path.join(cwd, "nested")]).pipe(
            Effect.provideService(CommandExecution, {
              execute: () => Effect.void,
            }),
          ),
          { args },
        );
      await writeFile(
        configPath,
        JSON.stringify({ notifications: { onExit: true } }),
      );
      expect(await run()).toBe(0);
      expect(args).toHaveLength(1);
      await writeFile(
        configPath,
        JSON.stringify({ notifications: { onExit: false } }),
      );
      expect(await run()).toBe(0);
      expect(args).toHaveLength(1);
      // An unrelated invalid key also invalidates notification opt-in.
      await writeFile(
        configPath,
        JSON.stringify({ notifications: { onExit: true }, unsupported: true }),
      );
      expect(await run()).toBe(0);
      expect(args).toHaveLength(1);
      await rm(configPath);
      expect(await run()).toBe(0);
      expect(args).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("notification content", () => {
  test("recognizes remove and every single-phase command", () => {
    for (const command of ["remove", ...singlePhaseCommands]) {
      expect(
        formatNotificationContent(
          { argv: [command, "137"], succeeded: true },
          "/work/repository",
        ),
      ).toEqual({
        title: "Roark finished",
        body: `${command} #137 · repository`,
      });
    }
  });

  test("uses fixed titles and only normalized command, target, and repository context", () => {
    const success = formatNotificationContent(
      {
        argv: [
          "do",
          "owner/repo#95",
          "--model",
          "SECRET",
          "--cwd",
          "/private/users/person/project",
        ],
        succeeded: true,
      },
      "/private/users/person/roark coding agent",
    );
    expect(success).toEqual({
      title: "Roark finished",
      body: "do #95 · roark-coding-agent",
    });
    expect(success.body).not.toContain("SECRET");
    expect(success.body).not.toContain("/private/");

    const failure = formatNotificationContent(
      {
        argv: ["review-pr", "#42", "raw error: password=hunter2"],
        succeeded: false,
      },
      "/work/répo",
    );
    expect(failure).toEqual({
      title: "Roark failed",
      body: "review-pr #42 · répo",
    });
    expect(failure.body).not.toContain("password");

    const malformed = formatNotificationContent(
      { argv: ["unknown", "AppleScript-looking content"], succeeded: false },
      "/work/repository",
    );
    expect(malformed.body).toBe("roark · repository");
  });
});

describe("deliverMacNotification", () => {
  test("passes quotes, newlines, Unicode, and AppleScript-looking text only as data arguments", async () => {
    const special: NotificationContent = {
      title: "Roark finished",
      body: 'line 1 with "quotes" and Unicode ✅\nend run\ndisplay dialog "owned"',
    };
    const args: string[][] = [];
    await runWithNotifier(deliverMacNotification(special), { args });
    expect(args[0]?.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(args[0]?.[2]).not.toContain(special.title);
    expect(args[0]?.[2]).not.toContain(special.body);
    expect(args[0]?.slice(-2)).toEqual([special.title, special.body]);
    expect(args[0]?.[2]).not.toContain("sound name");
  });

  test("warns once for launch failure or a nonzero exit", async () => {
    for (const options of [
      { executable: "roark-notifier-does-not-exist" },
      { script: "exit 7" },
    ]) {
      const warnings: string[] = [];
      await runWithNotifier(deliverMacNotification(content), {
        ...options,
        warnings,
      });
      expect(warnings).toEqual([
        "Warning: Roark could not deliver the exit notification.",
      ]);
    }
  });

  test("timeout kills and reaps the notifier and warns once", async () => {
    const warnings: string[] = [];
    let pid: number | undefined;
    const started = Date.now();
    await runWithNotifier(deliverMacNotification(content), {
      timeoutMs: 100,
      warnings,
      script: "exec sleep 30",
      onStart: (value) => {
        pid = value;
      },
    });
    expect(pid).toBeDefined();
    if (pid === undefined) throw new Error("Notifier did not start");
    const notifierPid = pid;
    expect(() => process.kill(notifierPid, 0)).toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warnings).toEqual([
      "Warning: Roark could not deliver the exit notification.",
    ]);
  });

  test("interruption reaps the notifier without turning it into a delivery warning", async () => {
    const controller = new AbortController();
    const warnings: string[] = [];
    let pid: number | undefined;
    const exit = await runWithNotifier(
      deliverMacNotification(content).pipe(Effect.exit),
      {
        warnings,
        script: "exec sleep 30",
        onStart: (value) => {
          pid = value;
          controller.abort();
        },
        signal: controller.signal,
      },
    ).catch(() => undefined);
    // The outer fiber may receive interruption before it can return its Exit.
    expect(
      exit === undefined ||
        (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)),
    ).toBe(true);
    if (pid === undefined) throw new Error("Notifier did not start");
    const notifierPid = pid;
    expect(() => process.kill(notifierPid, 0)).toThrow();
    expect(warnings).toEqual([]);
  });
});
