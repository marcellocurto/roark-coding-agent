import { describe, expect, test } from "bun:test";
import { buildRequiredAutorunLabels, labelsToRemoveForAutorunTransition, mergeLifecycleSkipLabels } from "./labels.ts";

describe("autorun label contract", () => {
  test("builds the required labels Roark may apply or require", () => {
    const labels = buildRequiredAutorunLabels({
      readyLabel: "ready-for-agent",
      inProgressLabel: "agent-in-progress",
      failureLabel: "agent-failed",
      successLabel: "agent-pr-opened",
    });

    expect(labels.map((label) => [label.role, label.name])).toEqual([
      ["ready", "ready-for-agent"],
      ["in-progress", "agent-in-progress"],
      ["failure", "agent-failed"],
      ["success", "agent-pr-opened"],
      ["triage-blocked", "blocked"],
      ["triage-needs-human", "needs-human"],
      ["triage-rejected", "triage-rejected"],
    ]);
  });

  test("always merges lifecycle labels into the effective skip set", () => {
    expect(mergeLifecycleSkipLabels({
      skipLabels: ["custom-skip", "busy"],
      inProgressLabel: "busy",
      failureLabel: "failed",
      successLabel: "opened",
    })).toEqual(["custom-skip", "busy", "failed", "opened", "needs-triage", "blocked", "needs-human", "triage-rejected", "wont-fix"]);
  });

  test("removes prior workflow states without touching topic labels", () => {
    expect(labelsToRemoveForAutorunTransition({
      issueLabels: [
        { name: "ready-for-agent" },
        { name: "needs-triage" },
        { name: "agent-failed" },
        { name: "bug" },
      ],
      workflow: {
        readyLabel: "ready-for-agent",
        inProgressLabel: "agent-in-progress",
        failureLabel: "agent-failed",
        successLabel: "agent-pr-opened",
      },
      nextLabel: "agent-in-progress",
      knownPresent: ["agent-in-progress"],
    })).toEqual(["ready-for-agent", "needs-triage", "agent-failed"]);
  });
});
