import { describe, expect, test } from "bun:test";
import { defaultAutorunFailureLabel } from "../autorun/failure.ts";
import { defaultAutorunRemote, defaultAutorunSuccessLabel } from "../autorun/publish.ts";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultAutorunVerifyCommand } from "../autorun/verification.ts";
import { defaultAutorunBaseBranch } from "../autorun/branch.ts";
import { defaultMaxFixPasses, parseArgs } from "./args.ts";

describe("parseArgs", () => {
  test("parses auto defaults", () => {
    const parsed = parseArgs(["auto"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("auto");
    if (parsed.command !== "auto") throw new Error("expected auto options");
    expect(parsed.readyLabel).toBe(defaultAutorunReadyLabel);
    expect(parsed.skipLabels).toEqual([...defaultAutorunSkipLabels]);
    expect(parsed.limit).toBe(1);
    expect(parsed.inProgressLabel).toBe(defaultAutorunInProgressLabel);
    expect(parsed.noAssign).toBe(false);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.baseBranch).toBe(defaultAutorunBaseBranch);
    expect(parsed.verifyCommand).toBe(defaultAutorunVerifyCommand);
    expect(parsed.failureLabel).toBe(defaultAutorunFailureLabel);
    expect(parsed.successLabel).toBe(defaultAutorunSuccessLabel);
    expect(parsed.remote).toBe(defaultAutorunRemote);
    expect(parsed.maxFixPasses).toBe(defaultMaxFixPasses);
    expect(parsed.force).toBe(false);
    expect(parsed.yes).toBe(false);
  });

  test("parses auto options", () => {
    const parsed = parseArgs([
      "auto",
      "--repo",
      "owner/repo",
      "--label",
      "roark-ready",
      "--skip-label",
      "blocked",
      "--skip-labels",
      "needs-human,wontfix",
      "--limit",
      "2",
      "--in-progress-label",
      "custom-in-progress",
      "--assignee",
      "roark-codes",
      "--dry-run",
      "--base-branch",
      "develop",
      "--verify",
      "bun install --frozen-lockfile && bun run typecheck",
      "--failure-label",
      "custom-failed",
      "--success-label",
      "custom-pr-opened",
      "--remote",
      "upstream",
      "--model",
      "provider/model",
      "--thinking",
      "high",
      "--max-fix-passes",
      "3",
      "--force",
      "--yes",
    ]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;
    if (parsed.command !== "auto") throw new Error("expected auto options");

    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.readyLabel).toBe("roark-ready");
    expect(parsed.skipLabels).toEqual(["blocked", "needs-human", "wontfix"]);
    expect(parsed.limit).toBe(2);
    expect(parsed.inProgressLabel).toBe("custom-in-progress");
    expect(parsed.assignee).toBe("roark-codes");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.baseBranch).toBe("develop");
    expect(parsed.verifyCommand).toBe("bun install --frozen-lockfile && bun run typecheck");
    expect(parsed.failureLabel).toBe("custom-failed");
    expect(parsed.successLabel).toBe("custom-pr-opened");
    expect(parsed.remote).toBe("upstream");
    expect(parsed.model).toBe("provider/model");
    expect(parsed.thinkingLevel).toBe("high");
    expect(parsed.maxFixPasses).toBe(3);
    expect(parsed.force).toBe(true);
    expect(parsed.yes).toBe(true);
  });

  test("rejects issue arguments for auto", () => {
    expect(() => parseArgs(["auto", "123"])).toThrow("does not take an issue argument");
  });

  test("rejects conflicting auto assignment options", () => {
    expect(() => parseArgs(["auto", "--assignee", "roark-codes", "--no-assign"])).toThrow(
      "--assignee cannot be combined with --no-assign",
    );
  });

  test("parses continue command options", () => {
    const parsed = parseArgs([
      "continue",
      "123",
      "--repo",
      "owner/repo",
      "--attempt",
      "2",
      "--verify",
      "bun test",
      "--failure-label",
      "failed",
      "--success-label",
      "opened",
      "--in-progress-label",
      "busy",
      "--remote",
      "upstream",
      "--max-fix-passes",
      "4",
      "--yes",
    ]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;
    expect(parsed.command).toBe("continue");
    if (parsed.command !== "continue") throw new Error("expected continue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.attempt).toBe(2);
    expect(parsed.verifyCommand).toBe("bun test");
    expect(parsed.failureLabel).toBe("failed");
    expect(parsed.successLabel).toBe("opened");
    expect(parsed.inProgressLabel).toBe("busy");
    expect(parsed.remote).toBe("upstream");
    expect(parsed.maxFixPasses).toBe(4);
    expect(parsed.yes).toBe(true);
  });

  test("still parses issue workflow commands", () => {
    const parsed = parseArgs(["do", "123", "--repo", "owner/repo", "--max-fix-passes", "3", "--attempt", "2"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("do");
    if (parsed.command === "auto") throw new Error("expected issue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.maxFixPasses).toBe(3);
    expect(parsed.attempt).toBe(2);
  });

  test("parses curate-issues as a standalone issue workflow command", () => {
    const parsed = parseArgs(["curate-issues", "123", "--repo", "owner/repo", "--attempt", "2"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("curate-issues");
    if (parsed.command === "auto" || parsed.command === "continue") throw new Error("expected issue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.attempt).toBe(2);
  });

  test("parses create-issues with repo, attempt, and approval", () => {
    const parsed = parseArgs(["create-issues", "123", "--repo", "owner/repo", "--attempt", "2", "--yes"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("create-issues");
    if (parsed.command === "auto" || parsed.command === "continue") throw new Error("expected issue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.attempt).toBe(2);
    expect(parsed.yes).toBe(true);
  });
});
