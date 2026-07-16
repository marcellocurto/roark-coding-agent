import { describe, expect, test } from "bun:test";
import { implementationPlanResult } from "../testing/workflow-results.ts";
import {
  formatImplementationPlanMarkdown,
  parseImplementationPlanResultJson,
} from "./result.ts";

describe("structured implementation plans", () => {
  test("preserves problem-specific sections without weakening standard plan fields", () => {
    const result = parseImplementationPlanResultJson(JSON.stringify(implementationPlanResult(true, {
      additionalSections: [{
        heading: "Compatibility discovery",
        items: ["The existing adapter also serves the migration command, so its behavior must remain unchanged."],
      }],
    })));

    expect(result.additionalSections).toEqual([{
      heading: "Compatibility discovery",
      items: ["The existing adapter also serves the migration command, so its behavior must remain unchanged."],
    }]);
    expect(formatImplementationPlanMarkdown(result, "final")).toContain(
      "## Compatibility discovery\n\n- The existing adapter also serves the migration command",
    );
    expect(result.readyForImplementation).toBe(true);
  });

  test("rejects additional sections that impersonate authoritative plan fields", () => {
    expect(() => parseImplementationPlanResultJson(JSON.stringify(implementationPlanResult(true, {
      additionalSections: [{ heading: "Ready For Implementation", items: ["no"] }],
    })))).toThrow("duplicates reserved heading");
  });
});
