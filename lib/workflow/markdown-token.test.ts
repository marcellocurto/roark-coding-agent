import { describe, expect, test } from "bun:test";
import { artifactOutcome, extractMarkdownToken, requireMarkdownToken } from "./markdown-token.ts";

describe("Markdown section tokens", () => {
  test("extracts normalized verdicts and statuses", () => {
    expect(artifactOutcome("## Verdict\nAPPROVE\n")).toBe("approve");
    expect(artifactOutcome("## Verdict\n`approve` with explanation\n")).toBe("approve");
    expect(artifactOutcome("## Status\nready-for-pr\n")).toBe("ready-for-pr");
    expect(artifactOutcome("No structured outcome")).toBe("completed");
  });

  test("validates allowed tokens", () => {
    expect(requireMarkdownToken("## Status\nrevise", "Status", ["revise", "blocked"] as const)).toBe("revise");
    expect(requireMarkdownToken("## Status\nunknown", "Status", ["revise", "blocked"] as const)).toBeUndefined();
    expect(extractMarkdownToken("## Ver.dict\napprove", "Ver.dict")).toBe("approve");
  });
});
