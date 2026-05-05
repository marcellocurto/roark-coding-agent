import { describe, expect, test } from "bun:test";
import {
  defaultAutorunInProgressLabel,
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
} from "../autorun/selection.ts";
import { defaultAutorunBaseBranch, defaultAutorunWorktreeRoot } from "../autorun/worktree.ts";
import { parseArgs } from "./args.ts";

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
    expect(parsed.worktreeRoot).toBe(defaultAutorunWorktreeRoot);
    expect(parsed.maxFixPasses).toBe(1);
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
      "--worktree-root",
      ".tmp/worktrees",
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
    expect(parsed.worktreeRoot).toBe(".tmp/worktrees");
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

  test("still parses issue workflow commands", () => {
    const parsed = parseArgs(["do", "123", "--repo", "owner/repo", "--max-fix-passes", "3"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("do");
    if (parsed.command === "auto") throw new Error("expected issue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.maxFixPasses).toBe(3);
  });
});
