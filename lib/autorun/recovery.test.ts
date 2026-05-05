import { describe, expect, test } from "bun:test";
import { formatContinueCommand } from "./recovery.ts";

describe("formatContinueCommand", () => {
  test("formats the command needed to continue a specific attempt", () => {
    expect(formatContinueCommand({ issueNumber: 11, repo: "owner/repo", attempt: 1 })).toBe(
      "bun run roark-coding-agent.ts continue 11 --repo owner/repo --attempt 1",
    );
  });

  test("quotes shell-sensitive values", () => {
    expect(formatContinueCommand({ issueNumber: "owner/repo#11", repo: "owner/repo", attempt: 1 })).toContain(
      "'owner/repo#11'",
    );
  });
});
