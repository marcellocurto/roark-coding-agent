import { describe, expect, test } from "bun:test";
import { parseArgs, usage } from "./args.ts";

describe("parseArgs", () => {
  test("usage names the roark command", () => {
    expect(usage.startsWith("roark <command> [issue] [options]")).toBe(true);
  });

  test("parses init command options", () => {
    const parsed = parseArgs(["init", "--cwd", "/tmp/repo", "--repo", "owner/repo", "--force"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("init");
    if (parsed.command !== "init") throw new Error("expected init options");
    expect(parsed.cwd).toBe("/tmp/repo");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.force).toBe(true);
  });

  test("rejects unexpected init arguments", () => {
    expect(() => parseArgs(["init", "extra"])).toThrow("Unexpected argument 'extra'");
    expect(() => parseArgs(["init", "--out", "runs"])).toThrow("Unknown option '--out'");
  });

  test("parses raw auto command without applying defaults", () => {
    const parsed = parseArgs(["auto"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("auto");
    if (parsed.command !== "auto") throw new Error("expected auto options");
    expect(parsed).toEqual({ command: "auto", issue: undefined });
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

  test("parses targeted auto issue refs", () => {
    for (const issue of ["123", "#123", "https://github.com/owner/repo/issues/123", "owner/repo#123"]) {
      const parsed = parseArgs(["auto", issue]);
      expect("help" in parsed).toBe(false);
      if ("help" in parsed) return;
      if (parsed.command !== "auto") throw new Error("expected auto options");
      expect(parsed.issue).toBe(issue);
    }
  });

  test("parses targeted auto issue before or after options", () => {
    const before = parseArgs(["auto", "123", "--repo", "owner/repo", "--dry-run"]);
    const after = parseArgs(["auto", "--repo", "owner/repo", "--dry-run", "123"]);

    for (const parsed of [before, after]) {
      expect("help" in parsed).toBe(false);
      if ("help" in parsed) return;
      if (parsed.command !== "auto") throw new Error("expected auto options");
      expect(parsed.issue).toBe("123");
      expect(parsed.repo).toBe("owner/repo");
      expect(parsed.dryRun).toBe(true);
    }
  });

  test("rejects multiple targeted auto issue refs", () => {
    expect(() => parseArgs(["auto", "123", "456"])).toThrow("accepts at most one issue argument");
  });

  test("rejects conflicting auto assignment options", () => {
    expect(() => parseArgs(["auto", "--assignee", "roark-codes", "--no-assign"])).toThrow(
      "--assignee cannot be combined with --no-assign",
    );
  });

  test("parses status command options", () => {
    const parsed = parseArgs(["status", "123", "--repo", "owner/repo", "--attempt", "2", "--cwd", "/tmp/repo", "--out", "runs"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;
    expect(parsed.command).toBe("status");
    if (parsed.command !== "status") throw new Error("expected status options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.attempt).toBe(2);
    expect(parsed.cwd).toBe("/tmp/repo");
    expect(parsed.outDir).toBe("runs");
    expect(parsed.all).toBeUndefined();
  });

  test("parses status --all", () => {
    const parsed = parseArgs(["status", "--all"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;
    expect(parsed.command).toBe("status");
    if (parsed.command !== "status") throw new Error("expected status options");
    expect(parsed.all).toBe(true);
    expect(parsed.issue).toBeUndefined();
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

  test("parses workspace maintenance commands", () => {
    const list = parseArgs(["workspace", "list", "--cwd", "/repo", "--repo", "owner/repo"]);
    expect("help" in list).toBe(false);
    if ("help" in list) return;
    expect(list).toEqual({ command: "workspace", action: "list", cwd: "/repo", repo: "owner/repo" });

    const remove = parseArgs(["workspace", "remove", "--issue", "207", "--force"]);
    expect("help" in remove).toBe(false);
    if ("help" in remove) return;
    expect(remove).toEqual({ command: "workspace", action: "remove", issue: 207, cwd: undefined, repo: undefined, force: true });

    const prune = parseArgs(["workspace", "prune", "--older-than", "30d"]);
    expect("help" in prune).toBe(false);
    if ("help" in prune) return;
    expect(prune).toEqual({ command: "workspace", action: "prune", olderThan: "30d", cwd: undefined, repo: undefined, force: undefined });
  });

  test("rejects invalid workspace maintenance arguments", () => {
    expect(() => parseArgs(["workspace"])).toThrow("workspace requires one of");
    expect(() => parseArgs(["workspace", "remove"])).toThrow("workspace remove requires --issue");
    expect(() => parseArgs(["workspace", "prune"])).toThrow("workspace prune requires --older-than");
    expect(() => parseArgs(["workspace", "list", "--force"])).toThrow("workspace list only accepts");
  });

  test("parses revise-pr defaults and options", () => {
    const parsed = parseArgs([
      "revise-pr",
      "123",
      "--repo",
      "owner/repo",
      "--cwd",
      "/tmp/repo",
      "--out",
      "runs",
      "--model",
      "provider/model",
      "--thinking",
      "high",
      "--verify",
      "bun test",
      "--remote",
      "upstream",
      "--max-fix-passes",
      "2",
      "--force",
      "--yes",
      "--no-comment",
    ]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;
    expect(parsed.command).toBe("revise-pr");
    if (parsed.command !== "revise-pr") throw new Error("expected revise-pr options");
    expect(parsed.prNumber).toBe(123);
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.cwd).toBe("/tmp/repo");
    expect(parsed.outDir).toBe("runs");
    expect(parsed.model).toBe("provider/model");
    expect(parsed.thinkingLevel).toBe("high");
    expect(parsed.verifyCommand).toBe("bun test");
    expect(parsed.remote).toBe("upstream");
    expect(parsed.maxFixPasses).toBe(2);
    expect(parsed.force).toBe(true);
    expect(parsed.yes).toBe(true);
    expect(parsed.comment).toBe(false);
  });

  test("still parses issue workflow commands", () => {
    const parsed = parseArgs(["do", "123", "--repo", "owner/repo", "--max-fix-passes", "3", "--attempt", "2"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("do");
    if (parsed.command !== "do") throw new Error("expected issue options");
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
    if (parsed.command !== "curate-issues") throw new Error("expected issue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.attempt).toBe(2);
  });

  test("parses create-issues with repo, attempt, and approval", () => {
    const parsed = parseArgs(["create-issues", "123", "--repo", "owner/repo", "--attempt", "2", "--yes"]);
    expect("help" in parsed).toBe(false);
    if ("help" in parsed) return;

    expect(parsed.command).toBe("create-issues");
    if (parsed.command !== "create-issues") throw new Error("expected issue options");
    expect(parsed.issue).toBe("123");
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.attempt).toBe(2);
    expect(parsed.yes).toBe(true);
  });

  test("parses workflow thinking profile flags", () => {
    const doFast = parseArgs(["do", "123", "--fast"]);
    const doDeep = parseArgs(["do", "123", "--deep"]);
    const autoFast = parseArgs(["auto", "--fast"]);
    const continueDeep = parseArgs(["continue", "123", "--deep"]);

    if ("help" in doFast || "help" in doDeep || "help" in autoFast || "help" in continueDeep) throw new Error("expected options");
    expect(doFast.command).toBe("do");
    if (doFast.command !== "do") throw new Error("expected issue options");
    expect(doFast.thinkingProfile).toBe("fast");
    expect(doDeep.command).toBe("do");
    if (doDeep.command !== "do") throw new Error("expected issue options");
    expect(doDeep.thinkingProfile).toBe("deep");
    expect(autoFast.command).toBe("auto");
    if (autoFast.command !== "auto") throw new Error("expected auto options");
    expect(autoFast.thinkingProfile).toBe("fast");
    expect(continueDeep.command).toBe("continue");
    if (continueDeep.command !== "continue") throw new Error("expected continue options");
    expect(continueDeep.thinkingProfile).toBe("deep");
  });

  test("rejects ambiguous thinking profile combinations", () => {
    expect(() => parseArgs(["do", "123", "--fast", "--deep"])).toThrow("--fast cannot be combined with --deep");
    expect(() => parseArgs(["do", "123", "--fast", "--thinking", "high"])).toThrow("--thinking cannot be combined");
    expect(() => parseArgs(["do", "123", "--deep", "--thinking", "high"])).toThrow("--thinking cannot be combined");
  });
});
