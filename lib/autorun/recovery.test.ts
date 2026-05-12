import { describe, expect, test } from "bun:test";
import { AgentTaskRunError } from "../workflow/tasks.ts";
import { formatContinueCommand, formatPublicContinueCommand, shouldRecoverWithYes } from "./recovery.ts";

describe("formatContinueCommand", () => {
  test("formats the command needed to continue a specific attempt", () => {
    expect(formatContinueCommand({ issueNumber: 11, cwd: "/repo", repo: "owner/repo", attempt: 1 })).toBe(
      "roark continue 11 --cwd /repo --repo owner/repo --attempt 1",
    );
  });

  test("quotes shell-sensitive values", () => {
    expect(formatContinueCommand({ issueNumber: "owner/repo#11", repo: "owner/repo", attempt: 1 })).toContain(
      "'owner/repo#11'",
    );
  });

  test("appends --yes when dirty-tree recovery is expected", () => {
    expect(formatContinueCommand({ issueNumber: 11, cwd: "/repo", repo: "owner/repo", attempt: 1, yes: true })).toBe(
      "roark continue 11 --cwd /repo --repo owner/repo --attempt 1 --yes",
    );
  });

  test("formats a public recovery command without cwd", () => {
    expect(formatPublicContinueCommand({ issueNumber: 11, repo: "owner/repo", attempt: 1, yes: true })).toBe(
      "roark continue 11 --repo owner/repo --attempt 1 --yes",
    );
  });
});

describe("shouldRecoverWithYes", () => {
  test("returns true for exhausted transient implementation failures", () => {
    const error = new AgentTaskRunError({
      artifact: "implementationLog",
      label: "Implementation",
      phase: "agent-error",
      originalError: new Error("openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended"),
    });

    expect(shouldRecoverWithYes(error)).toBe(true);
  });

  test("returns true for exhausted transient fix failures", () => {
    const error = new AgentTaskRunError({
      artifact: { name: "fixLog", pass: 1 },
      label: "Fix pass 1",
      phase: "agent-error",
      originalError: new Error("openai-codex/gpt-5.5 failed: fetch failed"),
    });

    expect(shouldRecoverWithYes(error)).toBe(true);
  });

  test("returns false for non-transient writable failures", () => {
    const error = new AgentTaskRunError({
      artifact: "implementationLog",
      label: "Implementation",
      phase: "agent-error",
      originalError: new Error("model not found"),
    });

    expect(shouldRecoverWithYes(error)).toBe(false);
  });

  test("returns false for transient read-only failures", () => {
    const error = new AgentTaskRunError({
      artifact: "triage",
      label: "Triage",
      phase: "agent-error",
      originalError: new Error("WebSocket closed 1006 Connection ended"),
    });

    expect(shouldRecoverWithYes(error)).toBe(false);
  });
});
