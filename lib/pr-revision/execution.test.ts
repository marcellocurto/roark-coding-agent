import { describe, expect, test } from "bun:test";
import {
  addressedRevisionItems,
  formatRevisionExecutionMarkdown,
  parseRevisionExecutionResultJson,
  RevisionExecutionOutputContractError,
  skippedRevisionItems,
} from "./execution.ts";
import { revisionExecutionResult } from "../testing/revision-executions.ts";

describe("structured PR revision execution", () => {
  test("rejects Markdown and repository-escaping changed-file paths", () => {
    expect(() => parseRevisionExecutionResultJson("# Revision Log\n")).toThrow(RevisionExecutionOutputContractError);
    expect(() => parseRevisionExecutionResultJson(JSON.stringify(revisionExecutionResult({
      changedFiles: [{ path: "../outside.ts", description: "Escapes the repository." }],
    })))).toThrow("must not escape the repository");
  });

  test("derives comment items and Markdown from validated fields", () => {
    const result = revisionExecutionResult({
      addressedItems: [{ item: "Required feedback", resolution: "Corrected the public behavior." }],
      skippedItems: [{ item: "Optional cleanup", reason: "Outside this PR revision." }],
      additionalSections: [{
        heading: "Discovery during validation",
        items: ["The same command also exercises the compatibility path."],
      }],
    });

    expect(addressedRevisionItems(result)).toEqual(["Required feedback — Corrected the public behavior."]);
    expect(skippedRevisionItems(result)).toEqual(["Optional cleanup — Outside this PR revision."]);
    const markdown = formatRevisionExecutionMarkdown(result, "Revision Log");
    expect(markdown).toContain("- Required feedback — Corrected the public behavior.");
    expect(markdown).toContain("- Optional cleanup — Outside this PR revision.");
    expect(markdown).toContain("## Discovery during validation");
  });
});
