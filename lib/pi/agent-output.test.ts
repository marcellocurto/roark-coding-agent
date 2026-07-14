import { describe, expect, test } from "bun:test";
import { Presenter, type AgentDisplayContext } from "../presentation/presenter.ts";
import type { TerminalStream } from "../presentation/terminal.ts";
import { AgentOutputCollector, ToolRunTracker } from "./agent-output.ts";

const display: AgentDisplayContext = {
  command: "do",
  repository: "owner/repo",
  target: "#140",
  phaseId: "implementation",
  phaseLabel: "Implementation",
  operation: "edit",
};

function capture(verbose: boolean) {
  let output = "";
  const stream: TerminalStream = { isTTY: false, columns: 80, write(chunk) { output += chunk; } };
  return { presenter: new Presenter({ stream, verbose }), output: () => output };
}

describe("AgentOutputCollector", () => {
  test("shares one tool timing record with presentation and observability", () => {
    const tracker = new ToolRunTracker(() => 20);
    tracker.start("1", { path: "lib/a.ts" }, 5);
    expect(tracker.complete("1", 20)).toEqual({ args: { path: "lib/a.ts" }, durationMs: 15 });
    expect(tracker.complete("1", 30)).toBeUndefined();
  });
  test("suppresses streamed assistant artifacts in normal output while returning the exact collected response", () => {
    const captured = capture(false);
    const collector = new AgentOutputCollector(display, captured.presenter, () => 20);
    collector.event({ type: "text_delta", delta: "# Generated" });
    collector.event({ type: "tool_start", toolCallId: "1", args: { path: "lib/a.ts" }, startedAt: 10 });
    collector.event({ type: "tool_end", toolCallId: "1", toolName: "read", isError: false, endedAt: 20 });
    collector.event({ type: "text_delta", delta: " artifact\n\nbody" });

    const response = "# Generated artifact\n\nbody\n";
    expect(collector.finish(response)).toBe(response);
    expect(captured.output()).toContain("Implementation · read lib/a.ts");
    expect(captured.output()).not.toContain("Generated artifact");
    expect(captured.output()).not.toContain("body");
  });

  test("renders absolute tool paths relative to the agent workspace", () => {
    const captured = capture(false);
    const workspace = "/tmp/managed/workspaces/owner/repository/issue-140";
    const collector = new AgentOutputCollector(display, captured.presenter, () => 20, [workspace]);
    collector.event({
      type: "tool_start",
      toolCallId: "1",
      args: { path: `${workspace}/deep/source/lib/important-file.ts` },
      startedAt: 10,
    });
    collector.event({ type: "tool_end", toolCallId: "1", toolName: "read", isError: false, endedAt: 20 });

    expect(captured.output()).toContain("read deep/source/lib/important-file.ts");
    expect(captured.output()).not.toContain(workspace);
    expect(captured.output().split("\n").filter(Boolean).every((line) => Array.from(line).length <= 80)).toBe(true);
  });

  test("renders the completed response once in verbose output instead of streaming partial Markdown", () => {
    const captured = capture(true);
    const collector = new AgentOutputCollector(display, captured.presenter);
    collector.event({ type: "text_delta", delta: "# Partial heading" });
    expect(captured.output()).toBe("");

    expect(collector.finish("# Final heading\n\n`value`")).toBe("# Final heading\n\n`value`");
    expect(captured.output()).toBe("Final heading\n\nvalue\n");
  });
});
