import { describe, expect, test } from "bun:test";
import { parseReviewFindings, parseReviewPairFindings } from "./findings.ts";

const ledgerEntry = (overrides = "") => `- Identifier: F1
- Classification: must-fix-current
- Title: Broken behavior
- Severity: high
- Confidence: high
- Evidence: lib/example.ts:1
- Current-issue impact: The current issue is not complete.
- Recommended handling: Fix it now.
${overrides}`;

describe("parseReviewFindings", () => {
  test("handles an empty findings ledger", () => {
    const parsed = parseReviewFindings("# Review A\n\n## Verdict\napprove\n\n## Findings Ledger\nNone\n", "review-a");

    expect(parsed.hasLedger).toBe(true);
    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected).toEqual([]);
  });

  test("reports a missing ledger without producing warnings", () => {
    const parsed = parseReviewFindings("# Review A\n\n## Verdict\napprove\n", "review-a");

    expect(parsed.hasLedger).toBe(false);
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  test("normalizes stable finding fields", () => {
    const parsed = parseReviewFindings(`# Review A\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${ledgerEntry()}`, "review-a");

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      source: "review-a",
      sourceLocalId: "F1",
      workflowId: "review-a:F1",
      classification: "must-fix-current",
      severity: "high",
      confidence: "high",
      evidence: "lib/example.ts:1",
      currentIssueImpact: "The current issue is not complete.",
      recommendedHandling: "Fix it now.",
    });
  });

  test("normalizes fields whose Markdown emphasis includes the colon", () => {
    const emphasized = `${ledgerEntry().replaceAll(/- ([^:\n]+):/g, "- **$1:**")}\n### F2\n\n${ledgerEntry().replace("F1", "F2").replaceAll(/- ([^:\n]+):/g, "- **$1:**")}`;
    const parsed = parseReviewFindings(`# Review A\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${emphasized}`, "review-a");

    expect(parsed.rejected).toEqual([]);
    expect(parsed.findings[0]).toMatchObject({
      sourceLocalId: "F1",
      classification: "must-fix-current",
      title: "Broken behavior",
      recommendedHandling: "Fix it now.",
    });
    expect(parsed.findings[0]?.recommendedHandling).not.toContain("F2");
    expect(parsed.findings[1]?.sourceLocalId).toBe("F2");
  });

  test("normalizes common field aliases and vertical table rows", () => {
    const ledger = `| Finding ID | F1 |
| Type | must-fix-current |
| Summary | Broken behavior |
| Priority | high |
| Certainty | high |
| Proof | lib/example.ts:1 |
| Impact | The current issue is not complete. |
| Remediation | Fix it now. |`;
    const parsed = parseReviewFindings(`# Review A\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${ledger}`, "review-a");

    expect(parsed.rejected).toEqual([]);
    expect(parsed.findings[0]).toMatchObject({
      sourceLocalId: "F1",
      classification: "must-fix-current",
      title: "Broken behavior",
      severity: "high",
      evidence: "lib/example.ts:1",
      currentIssueImpact: "The current issue is not complete.",
      recommendedHandling: "Fix it now.",
    });
  });

  test("rejects a malformed finding entry without crashing", () => {
    const parsed = parseReviewFindings("# Review A\n\n## Verdict\napprove\n\n## Findings Ledger\nThis is not a fielded finding.\n", "review-a");

    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("no parseable finding entries");
  });

  test("rejects an unknown classification without treating it as non-blocking", () => {
    const parsed = parseReviewFindings(`# Review A\n\n## Verdict\napprove\n\n## Findings Ledger\n${ledgerEntry().replace("must-fix-current", "maybe-later")}`, "review-a");

    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected[0]?.classification).toBe("maybe-later");
    expect(parsed.warnings[0]).toContain("Unknown finding classification");
  });

  test("keeps duplicate source-local IDs unique within one reviewer", () => {
    const parsed = parseReviewFindings(`# Review A\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${ledgerEntry()}\n${ledgerEntry("- Suggested issue title (optional): Later\n")}`, "review-a");

    expect(parsed.findings.map((finding) => finding.workflowId)).toEqual(["review-a:F1", "review-a:F1#2"]);
    expect(parsed.warnings).toEqual([]);
  });

  test("does not deduplicate duplicate-looking findings across reviewers", () => {
    const parsed = parseReviewPairFindings({
      reviewA: `# Review A\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${ledgerEntry()}`,
      reviewB: `# Review B\n\n## Verdict\nfixes-required\n\n## Findings Ledger\n${ledgerEntry()}`,
    });

    expect(parsed.reviewA.findings[0]?.workflowId).toBe("review-a:F1");
    expect(parsed.reviewB.findings[0]?.workflowId).toBe("review-b:F1");
  });
});
