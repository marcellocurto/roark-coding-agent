import { describe, expect, test } from "bun:test";
import { formatToolDuration, summarizeToolCall } from "./tool-log.ts";

describe("Pi compact tool logs", () => {
  test("summarizes supported tool arguments compactly", () => {
    expect(summarizeToolCall("grep", { pattern: "runPiAgent", path: "lib" }))
      .toBe("grep /runPiAgent/ in lib");
    expect(summarizeToolCall("read", { path: "lib/pi/agent.ts", offset: 1, limit: 120 }))
      .toBe("read lib/pi/agent.ts:1-120");
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
    const summary = summarizeToolCall("bash", { command: `bun test\n${"x".repeat(140)}` });

    expect(summary).toContain("…");
    expect(summary).not.toContain("\n");
    expect(summary).not.toContain("x".repeat(100));
  });

  test("does not include write content or edit replacement text", () => {
    const writeSummary = summarizeToolCall("write", { path: "secrets.txt", content: "secret".repeat(100) });
    const editSummary = summarizeToolCall("edit", {
      path: "secrets.txt",
      edits: [{ oldText: "secret-old", newText: "secret-new" }],
    });

    expect(writeSummary).toBe("write secrets.txt (600 chars)");
    expect(writeSummary).not.toContain("secretsecret");
    expect(editSummary).toBe("edit secrets.txt (1 edit)");
    expect(editSummary).not.toContain("secret-old");
    expect(editSummary).not.toContain("secret-new");
  });

  test("formats durations", () => {
    expect(formatToolDuration(999)).toBe("999ms");
    expect(formatToolDuration(1000)).toBe("1s");
    expect(formatToolDuration(1234)).toBe("1.2s");
  });
});
