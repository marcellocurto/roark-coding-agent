import { describe, expect, test } from "bun:test";
import type { PullRequestMetadata } from "../github/pr.ts";
import { buildPrCheckoutArgv, validatePrBranchSafety } from "./branch.ts";

const basePr: PullRequestMetadata = {
  number: 12,
  title: "Draft work",
  body: "",
  state: "OPEN",
  baseRefName: "main",
  headRefName: "feature/pr-12",
  baseRepository: "owner/repo",
  headRepository: "owner/repo",
};

describe("PR revision branch safety", () => {
  test("accepts open same-repository non-base head branch", () => {
    expect(() => validatePrBranchSafety(basePr, "owner/repo")).not.toThrow();
  });

  test("rejects unsafe PR states and branches", () => {
    expect(() => validatePrBranchSafety({ ...basePr, state: "CLOSED" }, "owner/repo")).toThrow("must be open");
    expect(() => validatePrBranchSafety({ ...basePr, headRefName: "main" }, "owner/repo")).toThrow("matches base branch");
    expect(() => validatePrBranchSafety({ ...basePr, baseRefName: "develop", headRefName: "main" }, "owner/repo")).toThrow("unsafe shared/base branch");
    expect(() => validatePrBranchSafety({ ...basePr, headRepository: "someone/fork" }, "owner/repo")).toThrow("Fork PR revision");
  });

  test("builds gh pr checkout argv", () => {
    expect(buildPrCheckoutArgv({ prNumber: 12, repo: "owner/repo" })).toEqual([
      "gh",
      "pr",
      "checkout",
      "12",
      "--repo",
      "owner/repo",
    ]);
  });
});
