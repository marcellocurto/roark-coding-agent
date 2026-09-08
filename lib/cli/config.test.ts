import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Result } from "effect";
import {
  defaultLifecycleHooks,
  defaultWorkspaceConfig,
} from "../autorun/workspace.ts";
import { applicationLayer } from "../runtime/application.ts";
import {
  decodeRoarkConfig,
  decodeRoarkConfigJson,
  loadRoarkConfig,
  RoarkConfigError,
} from "./config.ts";

const configPath = "/repo/.roark/config.json";
const decode = (input: unknown) =>
  Effect.runPromise(decodeRoarkConfig(input, configPath));

describe("Roark config schema", () => {
  test("keeps absent sections absent and applies defaults only to supplied sections", async () => {
    expect(await decode({})).toEqual({});
    expect(
      await decode({
        workspace: {},
        hooks: {},
        sandbox: {},
        notifications: {},
      }),
    ).toEqual({
      workspace: defaultWorkspaceConfig,
      hooks: defaultLifecycleHooks,
      sandbox: { provider: "host" },
      notifications: { onExit: false },
    });
  });

  test("preserves nullish defaults, explicit clone nulls and string whitespace", async () => {
    const value = await decode({
      repo: " owner/repo ",
      verify: " bun test ",
      hooks: { beforeRun: " echo ready " },
      workspace: {
        root: null,
        strategy: null,
        cloneRemote: null,
        clone: { filter: null, depth: null },
      },
      notifications: { onExit: null },
    });
    expect(value.repo).toBe(" owner/repo ");
    expect(value.verify).toBe(" bun test ");
    expect(value.hooks?.beforeRun).toBe(" echo ready ");
    expect(value.workspace).toEqual({
      ...defaultWorkspaceConfig,
      clone: { filter: null, depth: null },
    });
    expect(value.notifications?.onExit).toBe(false);
  });

  test("normalizes literal copy paths without changing label values", async () => {
    const value = await decode({
      skipLabels: [" first ", "second", "second"],
      workspace: {
        copyToWorktree: [" local\\secrets//token ", "./cache/"],
        clone: { depth: 3 },
      },
    });
    expect(value.skipLabels).toEqual([" first ", "second", "second"]);
    expect(value.workspace?.copyToWorktree).toEqual([
      "local/secrets/token",
      "./cache",
    ]);
    expect(value.workspace?.clone).toEqual({ filter: "blob:none", depth: 3 });
  });

  test("requires positive safe integers for counts, clone depth, and timeouts", async () => {
    for (const value of [1, Number.MAX_SAFE_INTEGER]) {
      const config = await decode({
        maxFixPasses: value,
        workspace: { clone: { depth: value } },
        hooks: { timeoutMs: value },
      });
      expect(config.maxFixPasses).toBe(value);
      expect(config.workspace?.clone.depth).toBe(value);
      expect(config.hooks?.timeoutMs).toBe(value);
    }
    for (const value of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Infinity,
      NaN,
    ]) {
      for (const input of [
        { maxFixPasses: value },
        { workspace: { clone: { depth: value } } },
        { hooks: { timeoutMs: value } },
      ]) {
        const result = await Effect.runPromise(
          decodeRoarkConfig(input, configPath).pipe(Effect.result),
        );
        expect(Result.isFailure(result)).toBe(true);
      }
    }
  });

  test("rejects excess keys at every object level and distinguishes unsupported root keys", async () => {
    for (const [input, key] of [
      [{ surprise: true }, "surprise"],
      [{ workspace: { surprise: true } }, "workspace.surprise"],
      [
        { workspace: { clone: { surprise: true } } },
        "workspace.clone.surprise",
      ],
      [{ hooks: { surprise: true } }, "hooks.surprise"],
      [{ sandbox: { surprise: true } }, "sandbox.surprise"],
      [{ notifications: { surprise: true } }, "notifications.surprise"],
    ] as const) {
      const result = await Effect.runPromise(
        decodeRoarkConfig(input, configPath).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).toContain(
          `Unknown Roark config key '${key}'`,
        );
        expect(result.failure.message).toContain(configPath);
      }
    }
    for (const key of ["model", "thinking", "updateStrategy"]) {
      expect(decode({ [key]: "unsupported" })).rejects.toThrow(
        `Unsupported Roark config key '${key}'`,
      );
    }
  });

  test("rejects invalid values and dangerous copy paths without coercion", async () => {
    for (const input of [
      null,
      [],
      "config",
      { repo: " " },
      { skipLabels: ["ready", 2] },
      { maxFixPasses: 0 },
      { maxFixPasses: 1.5 },
      { maxFixPasses: "2" },
      { workspace: null },
      { workspace: { clone: null } },
      { workspace: { clone: { depth: 0 } } },
      { hooks: { timeoutMs: 0 } },
      { sandbox: { provider: null } },
      { notifications: { onExit: "true" } },
      ...[
        "../escape",
        "secrets/*",
        "/absolute",
        "C:\\absolute",
        ".git/config",
        "",
        42,
      ].map((entry) => ({ workspace: { copyToWorktree: [entry] } })),
    ]) {
      const result = await Effect.runPromise(
        decodeRoarkConfig(input, configPath).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toBeInstanceOf(RoarkConfigError);
    }
  });

  test("decodes JSON through Schema and retains the file context for syntax failures", async () => {
    expect(
      await Effect.runPromise(
        decodeRoarkConfigJson('{"notifications":{"onExit":true}}', configPath),
      ),
    ).toEqual({ notifications: { onExit: true } });
    const result = await Effect.runPromise(
      decodeRoarkConfigJson("{not-json", configPath).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.cause._tag).toBe("SchemaError");
      expect(result.failure.message).toContain(configPath);
    }
  });

  test("native file loading distinguishes a missing config from a read failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-config-schema-"));
    try {
      expect(
        await Effect.runPromise(
          loadRoarkConfig(cwd).pipe(Effect.provide(applicationLayer)),
        ),
      ).toEqual({});
      await mkdir(path.join(cwd, ".roark", "config.json"), { recursive: true });
      const result = await Effect.runPromise(
        loadRoarkConfig(cwd).pipe(
          Effect.result,
          Effect.provide(applicationLayer),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain(
          path.join(cwd, ".roark", "config.json"),
        );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
