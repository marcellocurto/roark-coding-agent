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
    const report = changeReport({ addressedFindingIds: ["review-a:A-001", "review-b:B-002"] });

    expect(() => requireAddressedFindingIds(report, ["review-a:A-001", "review-b:B-001"]))
      .toThrow("unknown IDs: review-b:B-002; missing required IDs: review-b:B-001");
  });

  test("renders the validated structure as human-readable Markdown", () => {
    const markdown = formatChangeReportMarkdown(changeReport({
      summary: "Fixed structured publishing.",
      addressedFindingIds: ["review-a:A-001"],
    }), "Fix Log Pass 1");

    expect(markdown).toContain("# Fix Log Pass 1");
    expect(markdown).toContain("- `lib/example.ts` — Implemented the requested behavior.");
    expect(markdown).toContain("- review-a:A-001");
  });
});
