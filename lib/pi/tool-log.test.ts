import { describe, expect, test } from "bun:test";
import { formatCompletedToolLine, formatToolDuration, formatToolRunSummary, summarizeToolCall } from "./tool-log.ts";

describe("Pi compact tool logs", () => {
  test("formats representative completed tool lines", () => {
    expect(formatCompletedToolLine({ toolName: "grep", args: { pattern: "runPiAgent", path: "lib" }, durationMs: 84, isError: false }))
      .toBe("• grep /runPiAgent/ in lib (84ms)");
    expect(formatCompletedToolLine({ toolName: "read", args: { path: "lib/pi/agent.ts", offset: 1, limit: 120 }, durationMs: 31, isError: false }))
      .toBe("• read lib/pi/agent.ts:1-120 (31ms)");
    expect(formatCompletedToolLine({ toolName: "bash", args: { command: "bun test" }, durationMs: 2400, isError: false }))
      .toBe("• bash \"bun test\" (2.4s)");
  });

  test("marks failed tools without dumping results", () => {
    expect(formatCompletedToolLine({ toolName: "bash", args: { command: "bun run typecheck" }, durationMs: 1800, isError: true }))
      .toBe("✗ bash \"bun run typecheck\" (1.8s)");
  });

  test("summarizes supported tool arguments compactly", () => {
    expect(summarizeToolCall("edit", { path: "lib/pi/agent.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }))
      .toBe("edit lib/pi/agent.ts (2 edits)");
    expect(summarizeToolCall("write", { path: "tmp/output.txt", content: "hello" }))
      .toBe("write tmp/output.txt (5 chars)");
    expect(summarizeToolCall("find", { pattern: "**/*.ts", path: "lib" }))
      .toBe("find **/*.ts in lib");
    expect(summarizeToolCall("ls", { path: "lib/pi" }))
      .toBe("ls lib/pi");
  });

  test("truncates long commands and normalizes whitespace", () => {
    const line = formatCompletedToolLine({
      toolName: "bash",
      args: { command: `bun test\n${"x".repeat(140)}` },
      durationMs: 1,
      isError: false,
    });

    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("x".repeat(100));
  });

  test("does not include write content or edit replacement text", () => {
    const writeLine = formatCompletedToolLine({
      toolName: "write",
      args: { path: "secrets.txt", content: "secret".repeat(100) },
      durationMs: 2,
      isError: false,
    });
    const editLine = formatCompletedToolLine({
      toolName: "edit",
      args: { path: "secrets.txt", edits: [{ oldText: "secret-old", newText: "secret-new" }] },
      durationMs: 3,
      isError: false,
    });

    expect(writeLine).toBe("• write secrets.txt (600 chars) (2ms)");
    expect(writeLine).not.toContain("secretsecret");
    expect(editLine).toBe("• edit secrets.txt (1 edit) (3ms)");
    expect(editLine).not.toContain("secret-old");
    expect(editLine).not.toContain("secret-new");
  });

  test("formats durations and final per-run summary counts", () => {
    expect(formatToolDuration(999)).toBe("999ms");
    expect(formatToolDuration(1000)).toBe("1s");
    expect(formatToolDuration(1234)).toBe("1.2s");
    expect(formatToolRunSummary([])).toBe("tools: none · 0ms");
    expect(formatToolRunSummary([
      { toolName: "grep", durationMs: 84 },
      { toolName: "read", durationMs: 31 },
      { toolName: "read", durationMs: 85 },
      { toolName: "bash", durationMs: 2400 },
    ])).toBe("tools: grep 1, read 2, bash 1 · 2.6s");
  });
});
