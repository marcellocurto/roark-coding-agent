import { describe, expect, test } from "bun:test";
import { formatTerminalTitle, normalizeTerminalText, sanitizeTerminalLine, setTerminalTitle, type TerminalStream } from "./terminal.ts";

function stream(isTTY: boolean, columns = 80) {
  let output = "";
  const value: TerminalStream = {
    isTTY,
    columns,
    write(chunk) { output += chunk; },
  };
  return { stream: value, output: () => output };
}

describe("terminal title safety", () => {
  test("suppresses control sequences for redirected output and opt-out", () => {
    const redirected = stream(false);
    expect(setTerminalTitle(redirected.stream, { target: "#140", phase: "Triage" })).toBe(false);
    expect(redirected.output()).toBe("");

    const optedOut = stream(true);
    expect(setTerminalTitle(optedOut.stream, { target: "#140", phase: "Triage" }, { enabled: false })).toBe(false);
    expect(optedOut.output()).toBe("");
  });

  test("removes hostile controls and bounds target-first titles", () => {
    const output = stream(true);
    setTerminalTitle(output.stream, {
      target: "#140\u001b]0;owned\u0007\nnext",
      phase: `Implementation ${"x".repeat(100)}`,
      pass: 2,
      repository: "owner/repository-that-is-low-priority",
    }, { env: { TERM: "xterm" } });

    const emitted = output.output();
    expect(emitted.startsWith("\u001b]0;#140")).toBe(true);
    expect(emitted.endsWith("\u0007")).toBe(true);
    expect(emitted.slice(4, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(Array.from(emitted.slice(4, -1)).length).toBeLessThanOrEqual(80);
    expect(emitted).not.toContain("repository-that-is-low-priority");
  });

  test("bounds hostile long revision and pass values", () => {
    const title = formatTerminalTitle({
      target: "#140",
      phase: "Implementation",
      revision: "r".repeat(200),
      pass: "p".repeat(200),
      repository: "owner/repo",
    });

    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    expect(title.startsWith("#140 · Implementation")).toBe(true);
    expect(title).toContain(" · r");
    expect(title).toContain(" · p");
    expect(title).not.toContain("repo");
  });

  test("keeps target, phase, and pass ahead of repository", () => {
    const title = formatTerminalTitle({ target: "PR #42", phase: "Revision review", pass: 3, repository: "owner/repo" });
    expect(title).toBe("PR #42 · Revision review · p3 · repo");
    expect(normalizeTerminalText("a\rb\nc\u001bd")).toBe("a b c d");
    expect(sanitizeTerminalLine("two  spaces\nand indentation")).toBe("two  spaces and indentation");
  });
});
