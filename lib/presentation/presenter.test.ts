import { describe, expect, test } from "bun:test";
import { Presenter, presenter as currentPresenter, renderMarkdownPlain, runWithPresenter, type AgentDisplayContext } from "./presenter.ts";
import type { TerminalStream } from "./terminal.ts";

function capture(columns = 80) {
  let output = "";
  const stream: TerminalStream = { isTTY: false, columns, write(chunk) { output += chunk; } };
  return { stream, output: () => output };
}

function captureTty(columns = 80) {
  let output = "";
  const stream: TerminalStream = { isTTY: true, columns, write(chunk) { output += chunk; } };
  const presenterOptions = { stream, env: { TERM: "xterm" }, titleEnabled: false };
  return { stream, presenterOptions, output: () => output };
}

const display: AgentDisplayContext = {
  command: "do",
  repository: "owner/repo",
  target: "#140",
  phaseId: "implementation",
  phaseLabel: "Implementation",
  expectedArtifact: ".roark/runs/issue/140/implementation-log.md",
  operation: "edit",
};

describe("operational presentation", () => {
  test("normalizes consecutive tool boundaries without blank rows", () => {
    const captured = capture();
    const times = [100, 112, 130];
    const presenter = new Presenter({ stream: captured.stream, now: () => times.shift() ?? 130 });
    presenter.phaseStarted(display);
    presenter.activity(display, "read lib/pi/agent.ts", { failed: false, durationMs: 12 });
    presenter.activity(display, "grep /phase/ in lib", { failed: false, durationMs: 8 });
    presenter.phaseCompleted(display, { artifact: display.expectedArtifact });

    expect(captured.output()).not.toContain("\n\n");
    expect(captured.output()).not.toContain("•");
    expect(captured.output()).toContain("  Implementation · read lib/pi/agent.ts");
    expect(captured.output()).toContain("DONE #140 · Implementation");
    expect(captured.output()).toContain("  artifact: .roark/runs/issue/140/implementation-log.md");
  });

  test("preserves phase wall time at narrow terminal widths", () => {
    const captured = captureTty(40);
    const times = [0, 1_250];
    const presenter = new Presenter({ ...captured.presenterOptions, now: () => times.shift() ?? 1_250 });
    presenter.phaseStarted(display);
    presenter.phaseCompleted(display, { outcome: "completed with an intentionally long result" });

    expect(captured.output()).toContain("  elapsed: 1.3s · 0 tools\n");
    expect(captured.output().split("\n").filter(Boolean).every((line) => Array.from(line).length <= 40)).toBe(true);
  });

  test("keeps failures textual and separates wall time from verbose aggregate tool time", () => {
    const captured = capture();
    const times = [0, 1_000];
    const presenter = new Presenter({ stream: captured.stream, verbose: true, now: () => times.shift() ?? 1_000 });
    presenter.phaseStarted(display);
    presenter.activity(display, "bash bun test", { failed: true, durationMs: 300 });
    presenter.phaseCompleted(display, { outcome: "tests failed", failed: true });

    expect(captured.output()).toContain("FAILED Implementation · bash bun test");
    expect(captured.output()).toContain("FAILED #140 · Implementation · tests failed · 1 tool · 1s");
    expect(captured.output()).toContain("aggregate tool execution 300ms");
  });

  test("preserves subordinate indentation and the relevant end of failure diagnostics", () => {
    const captured = captureTty(40);
    const presenter = new Presenter(captured.presenterOptions);
    presenter.verification({
      command: "bun test",
      ok: false,
      exitCode: 1,
      elapsedMs: 50,
      reason: "tests failed",
      diagnostic: `${"old output ".repeat(10)}FINAL_ERROR`,
    });

    expect(captured.output()).toContain("\n  reason: tests failed\n");
    expect(captured.output()).toContain("  output: …");
    expect(captured.output()).toContain("FINAL_ERROR\n");
  });

  test("uses a discovered target for the final outcome", () => {
    const captured = capture();
    const presenter = new Presenter({ stream: captured.stream });
    presenter.run({ command: "auto", repository: "owner/repo" });
    presenter.updateTarget("#140");
    presenter.outcome("SUCCESS", undefined, "complete");

    expect(captured.output()).toContain("SUCCESS #140 · complete");
  });

  test("suppresses collected artifact bodies in normal mode", () => {
    const captured = capture();
    const presenter = new Presenter({ stream: captured.stream, verbose: false });
    presenter.verboseAgentResponse("# Secret artifact body\n\nconsumer-visible details");
    expect(captured.output()).toBe("");
  });

  test("preserves complete recovery commands", () => {
    const captured = capture(80);
    const presenter = new Presenter({ stream: captured.stream });
    const command = "roark continue 140 --cwd /Users/marcello/.roark/workspaces/owner-repo/issue-140 --repo owner/repo --attempt 1 --yes";

    presenter.recovery(command);

    expect(captured.output()).toBe(`  continue:\n    ${command}\n`);
  });

  test("preserves significant spaces in recovery commands", () => {
    const captured = capture();
    const presenter = new Presenter({ stream: captured.stream });
    presenter.recovery("roark continue 140 --cwd '/tmp/two  spaces/repo'");
    expect(captured.output()).toContain("'/tmp/two  spaces/repo'");
  });

  test("does not truncate redirected output", () => {
    const captured = capture(20);
    const presenter = new Presenter({ stream: captured.stream });
    const url = `https://example.test/${"evidence/".repeat(20)}`;
    presenter.line(url);
    presenter.phaseStarted(display);
    presenter.phaseCompleted(display, { outcome: url, artifact: `/tmp/${"deep/".repeat(30)}artifact.md` });
    presenter.verification({ command: url, ok: false, exitCode: 1, elapsedMs: 10, diagnostic: url });
    expect(captured.output()).toContain(`${url}\n`);
    expect(captured.output()).toContain(`DONE #140 · Implementation · ${url}`);
    expect(captured.output()).toContain(`${"deep/".repeat(30)}artifact.md`);
    expect(captured.output()).toContain(`VERIFY FAILED · ${url}`);
    expect(captured.output()).not.toContain("…");
  });

  test("treats CI pseudo-TTY streams as complete non-interactive logs", () => {
    const captured = captureTty(20);
    const presenter = new Presenter({ stream: captured.stream, env: { CI: "true", TERM: "xterm" } });
    const record = "123456789012345678901234567890";

    presenter.run({ command: "auto", repository: "owner/repo", target: "#140" });
    presenter.line(record);

    expect(captured.output()).toContain(`${record}\n`);
    expect(captured.output()).not.toContain("…");
    expect(captured.output()).not.toContain("\u001b]");
  });

  test("times deterministic operations and preserves their target and revision context", () => {
    const captured = capture();
    const times = [0, 1_250];
    const presenter = new Presenter({ stream: captured.stream, now: () => times.shift() ?? 1_250 });
    presenter.run({ command: "revise-pr", repository: "owner/repo", target: "PR #12" });
    presenter.transition("Revision preparation", "PR #12", { revision: 2, operation: "edit" });
    presenter.outcome("SUCCESS", "PR #12", "prepared");

    expect(captured.output()).toContain("PHASE PR #12 · Revision preparation · revision 2 · edit");
    expect(captured.output()).toContain("DONE PR #12 · Revision preparation · revision 2 · completed · 1.3s");
    expect(captured.output()).not.toContain("Revision preparation · pass 2");
    expect(captured.output()).not.toContain("0 tools");
  });

  test("does not width-truncate TERM=dumb pseudo-TTY output", () => {
    const captured = captureTty(20);
    const presenter = new Presenter({ stream: captured.stream, env: { TERM: "dumb" } });
    const record = "123456789012345678901234567890";

    presenter.line(record);

    expect(captured.output()).toBe(`${record}\n`);
  });

  test("preserves revision and pass context in verification titles", () => {
    const captured = captureTty();
    const presenter = new Presenter({ stream: captured.stream, env: { TERM: "xterm" } });
    const verificationDisplay = { target: "PR #12", repository: "owner/repo", revision: 2, pass: 1 };

    presenter.verificationStarted("bun test", verificationDisplay);
    presenter.verification({ command: "bun test", ok: true, exitCode: 0, elapsedMs: 50, display: verificationDisplay });

    expect(captured.output()).toContain("PR #12 · Verification · r2 · p1 · repo");
    expect(captured.output()).toContain("PR #12 · Verification passed · r2 · p1 · repo");
  });

  test("routes operational warnings to stderr", () => {
    const stdout = capture();
    const stderr = capture();
    const presenter = new Presenter({ stream: stdout.stream, errorStream: stderr.stream });
    presenter.warning("dependency unavailable");
    expect(stdout.output()).toBe("");
    expect(stderr.output()).toBe("WARNING dependency unavailable\n");
  });

  test("isolates presenters between concurrent async runs", async () => {
    const first = capture();
    const second = capture();
    await Promise.all([
      runWithPresenter(new Presenter({ stream: first.stream }), async () => {
        await Promise.resolve();
        currentPresenter().line("first");
      }),
      runWithPresenter(new Presenter({ stream: second.stream }), async () => {
        await Promise.resolve();
        currentPresenter().line("second");
      }),
    ]);
    expect(first.output()).toBe("first\n");
    expect(second.output()).toBe("second\n");
  });

  test("wraps verbose agent responses without discarding content", () => {
    const captured = captureTty(40);
    const presenter = new Presenter({ ...captured.presenterOptions, verbose: true });
    const paragraph = "This paragraph contains a decisive result and must preserve TRAILING_TOKEN";

    presenter.verboseAgentResponse(paragraph);

    const lines = captured.output().trimEnd().split("\n");
    expect({
      content: lines.join(" "),
      withinWidth: lines.every((line) => Array.from(line).length <= 40),
    }).toEqual({ content: paragraph, withinWidth: true });
  });

  test("preserves fenced code whitespace in verbose output", () => {
    const captured = captureTty(40);
    const presenter = new Presenter({ ...captured.presenterOptions, verbose: true });
    presenter.verboseAgentResponse("```ts\n  const aligned =  1;\n```");
    expect(captured.output()).toBe("  const aligned =  1;\n");
  });

  test("bounds primary output at narrow widths and renders completed verbose Markdown coherently", () => {
    const captured = captureTty(40);
    const presenter = new Presenter({ ...captured.presenterOptions, verbose: true });
    presenter.run({ command: "review-pr", repository: "owner/an-extremely-long-repository-name", target: "PR #123" });
    presenter.verboseAgentResponse("# Review\n\n## Verdict\n`approve`\n\n```text\nraw line\n```");

    expect(captured.output().split("\n").filter(Boolean).every((line) => Array.from(line).length <= 40)).toBe(true);
    expect(captured.output()).not.toContain("# Review");
    expect(captured.output()).not.toContain("```text");
    expect(renderMarkdownPlain("## Status\n**ready**")).toBe("Status\nready");
  });
});
