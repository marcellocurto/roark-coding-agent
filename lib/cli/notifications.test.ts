import { describe, expect, test } from "bun:test";
import {
  deliverMacNotification,
  formatNotificationContent,
  notificationTimeoutMs,
  sendExitNotification,
  type NotificationContent,
} from "./notifications.ts";

const content: NotificationContent = { title: "Roark finished", body: "status · repository" };

function completedProcess(exitCode = 0): { exited: Promise<number>; kill(): void } {
  return { exited: Promise.resolve(exitCode), kill() { return; } };
}

describe("sendExitNotification", () => {
  test("dispatches once only when a valid repository config opts in", async () => {
    const spawned: string[][] = [];
    const warnings: string[] = [];
    await sendExitNotification(
      { argv: ["status", "--all", "--cwd", "/requested/repo"], succeeded: true },
      {
        platform: "darwin",
        cwd: "/fallback",
        resolveWorkspace: (cwd) => {
          expect(cwd).toBe("/requested/repo");
          return Promise.resolve("/work/roark-coding-agent");
        },
        loadConfig: () => Promise.resolve({ notifications: { onExit: true } }),
        spawn: (args) => {
          spawned.push(args);
          return completedProcess();
        },
        warn: (message) => warnings.push(message),
      },
    );

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(spawned[0]?.slice(-2)).toEqual(["Roark finished", "status · roark-coding-agent"]);
    expect(warnings).toEqual([]);

    let disabledSpawnCount = 0;
    await sendExitNotification(
      { argv: ["status", "--all"], succeeded: true },
      {
        platform: "darwin",
        resolveWorkspace: () => Promise.resolve("/work/repository"),
        loadConfig: () => Promise.resolve({ notifications: { onExit: false } }),
        spawn: () => {
          disabledSpawnCount++;
          return completedProcess();
        },
      },
    );
    expect(disabledSpawnCount).toBe(0);
  });

  test("silently suppresses lookup failures and invalid configs", async () => {
    const warnings: string[] = [];
    let spawnCount = 0;
    const dependencies = {
      platform: "darwin" as const,
      resolveWorkspace: () => Promise.resolve("/work/repository"),
      loadConfig: () => Promise.reject(new Error("invalid config containing SECRET")),
      spawn: () => {
        spawnCount++;
        return completedProcess();
      },
      warn: (message: string) => warnings.push(message),
    };

    await sendExitNotification({ argv: ["review-pr", "12"], succeeded: false }, dependencies);
    await sendExitNotification(
      { argv: ["status", "--all"], succeeded: true },
      { ...dependencies, resolveWorkspace: () => Promise.reject(new Error("outside git")) },
    );

    expect(spawnCount).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("is a silent no-op on non-macOS hosts", async () => {
    let lookupCount = 0;
    await sendExitNotification(
      { argv: ["do", "95"], succeeded: true },
      {
        platform: "linux",
        resolveWorkspace: () => {
          lookupCount++;
          return Promise.resolve("/work/repository");
        },
      },
    );
    expect(lookupCount).toBe(0);
  });
});

describe("notification content", () => {
  test("uses fixed titles and only normalized command, target, and repository context", () => {
    const success = formatNotificationContent(
      {
        argv: ["do", "owner/repo#95", "--model", "SECRET", "--cwd", "/private/users/person/project"],
        succeeded: true,
      },
      "/private/users/person/roark coding agent",
    );
    expect(success).toEqual({ title: "Roark finished", body: "do #95 · roark-coding-agent" });
    expect(success.body).not.toContain("SECRET");
    expect(success.body).not.toContain("/private/");

    const failure = formatNotificationContent(
      { argv: ["review-pr", "#42", "raw error: password=hunter2"], succeeded: false },
      "/work/répo",
    );
    expect(failure).toEqual({ title: "Roark failed", body: "review-pr #42 · répo" });
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
      body: "line 1 with \"quotes\" and Unicode ✅\nend run\ndisplay dialog \"owned\"",
    };
    let args: string[] | undefined;
    await deliverMacNotification(special, {
      platform: "darwin",
      spawn: (spawnArgs) => {
        args = spawnArgs;
        return completedProcess();
      },
    });

    expect(args?.[0]).toBe("/usr/bin/osascript");
    expect(args?.[1]).toBe("-e");
    expect(args?.[2]).not.toContain(special.title);
    expect(args?.[2]).not.toContain(special.body);
    expect(args?.slice(-2)).toEqual([special.title, special.body]);
    expect(args?.[2]).not.toContain("sound name");
  });

  test("warns once for launch failure or a nonzero exit", async () => {
    for (const spawn of [
      () => { throw new Error("launch failed with SECRET"); },
      () => completedProcess(7),
    ]) {
      const warnings: string[] = [];
      await deliverMacNotification(content, { platform: "darwin", spawn, warn: (message) => warnings.push(message) });
      expect(warnings).toEqual(["Warning: Roark could not deliver the exit notification."]);
      expect(warnings[0]).not.toContain("SECRET");
    }
  });

  test("forcibly terminates a stuck notifier without waiting indefinitely for it to exit", async () => {
    expect(notificationTimeoutMs).toBe(2_000);
    const warnings: string[] = [];
    let killSignal: NodeJS.Signals | number | undefined;
    const exited = new Promise<number>(() => {
      // Simulate a process handle that never reports completion, even after kill.
    });

    const delivery = deliverMacNotification(content, {
      platform: "darwin",
      timeoutMs: 5,
      spawn: () => ({
        exited,
        kill(signal) {
          killSignal = signal;
        },
      }),
      warn: (message) => warnings.push(message),
    });
    const result = await Promise.race([
      delivery.then(() => "completed"),
      Bun.sleep(100).then(() => "stalled"),
    ]);

    expect(result).toBe("completed");
    expect(killSignal).toBe("SIGKILL");
    expect(warnings).toEqual(["Warning: Roark could not deliver the exit notification."]);
  });
});
