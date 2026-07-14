import { describe, expect, test } from "bun:test";
import {
  ChangeReportOutputContractError,
  formatChangeReportMarkdown,
  parseChangeReportJson,
  requireAddressedFindingIds,
} from "./result.ts";
import { changeReport } from "../testing/change-reports.ts";

describe("change reports", () => {
  test("rejects paths that escape the repository", () => {
    const report = changeReport({
      changedFiles: [{ path: "../outside.ts", description: "Invalid path." }],
    });

    expect(() => parseChangeReportJson(JSON.stringify(report))).toThrow(ChangeReportOutputContractError);
  });

  test("requires a fix report to identify every and only required finding", () => {
    const report = changeReport({ addressedFindingIds: ["review-a:missing-validation", "review-b:unsafe-boundary"] });

    expect(() => requireAddressedFindingIds(report, ["review-a:missing-validation", "review-b:unclear-contract"]))
      .toThrow("unknown IDs: review-b:unsafe-boundary; missing required IDs: review-b:unclear-contract");
  });

  test("renders the validated structure as human-readable Markdown", () => {
    const markdown = formatChangeReportMarkdown(changeReport({
      summary: "Fixed structured publishing.",
      addressedFindingIds: ["review-a:missing-validation"],
    }), "Fix Log Pass 1");

    expect(markdown).toContain("# Fix Log Pass 1");
    expect(markdown).toContain("- `lib/example.ts` — Implemented the requested behavior.");
    expect(markdown).toContain("- review-a:missing-validation");
  });
});
