import { Effect, Exit, Cause } from "effect";
import { describe, expect, test } from "bun:test";
import { type PullRequestMetadata } from "../github/pr.ts";
import { validatePrBranchSafety } from "./branch.ts";
const basePr: PullRequestMetadata = {
  number: 12,
  title: "Draft work",
  body: "",
  state: "OPEN",
  baseRefName: "main",
  headRefName: "feature/pr-12",
  baseRefOid: "base123",
  headRefOid: "head123",
  baseRepository: "owner/repo",
  headRepository: "owner/repo",
};
describe("PR revision branch safety", () => {
  test("accepts open same-repository non-base head branch", () => {
    expect(
      Exit.isSuccess(
        Effect.runSyncExit(validatePrBranchSafety(basePr, "owner/repo")),
      ),
    ).toBe(true);
  });
  test("rejects unsafe PR states and branches as expected failures", () => {
    for (const [pr, message] of [
      [{ ...basePr, state: "CLOSED" }, "must be open"],
      [{ ...basePr, headRefName: "main" }, "matches base branch"],
      [
        { ...basePr, baseRefName: "develop", headRefName: "main" },
        "unsafe shared/base branch",
      ],
      [{ ...basePr, headRepository: "someone/fork" }, "Fork PR revision"],
    ] as const) {
      const exit = Effect.runSyncExit(validatePrBranchSafety(pr, "owner/repo"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Cause.pretty(exit.cause)).toContain(message);
      }
    }
  });
});
