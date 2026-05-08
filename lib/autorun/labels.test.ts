import { describe, expect, test } from "bun:test";
import { buildRequiredAutorunLabels, mergeLifecycleSkipLabels } from "./labels.ts";

describe("autorun label contract", () => {
  test("builds the required labels Roark may apply or require", () => {
    const labels = buildRequiredAutorunLabels({
      readyLabel: "afk",
      inProgressLabel: "roark-in-progress",
      failureLabel: "roark-failed",
      successLabel: "roark-pr-opened",
    });

    expect(labels.map((label) => [label.role, label.name])).toEqual([
      ["ready", "afk"],
      ["in-progress", "roark-in-progress"],
      ["failure", "roark-failed"],
      ["success", "roark-pr-opened"],
      ["triage-blocked", "blocked"],
      ["triage-needs-human", "needs-human"],
    ]);
  });

  test("always merges lifecycle labels into the effective skip set", () => {
    expect(mergeLifecycleSkipLabels({
      skipLabels: ["custom-skip", "busy"],
      inProgressLabel: "busy",
      failureLabel: "failed",
      successLabel: "opened",
    })).toEqual(["custom-skip", "busy", "failed", "opened", "blocked", "needs-human"]);
  });
});
