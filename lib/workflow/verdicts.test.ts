import { describe, expect, test } from "bun:test";
import { decideReadiness, hasBlockedReview, needsFix } from "./verdicts.ts";

const triage = "# Triage\n\n## Verdict\nproceed\n";
const plan = "# Implementation Plan\n\n## Ready For Implementation\nyes\n";
const approveNoLedger = "# Review A\n\n## Verdict\napprove\n";
const finalReady = "# Final Review\n\n## Verdict\nready-for-pr\n";

function review(verdict: "approve" | "fixes-required" | "blocked", entries: string): string {
  return `# Review A\n\n## Verdict\n${verdict}\n\n## Findings Ledger\n${entries}\n`;
}

function entry(id: string, classification: string, title = "Finding"): string {
  return `- Identifier: ${id}\n- Classification: ${classification}\n- Title: ${title}\n- Severity: medium\n- Confidence: high\n- Evidence: file.ts:1\n- Current-issue impact: Impact.\n- Recommended handling: Handle.\n`;
}

describe("classification-aware verdict decisions", () => {
  test("keeps broad verdict fallback for old approve reviews", () => {
    const decision = decideReadiness({ triage, plan, reviewA: approveNoLedger, reviewB: approveNoLedger, finalReview: "" });

    expect(needsFix(approveNoLedger, approveNoLedger)).toBe(false);
    expect(decision.status).toBe("ready-for-pr");
  });

  test("keeps broad verdict fallback for old fixes-required reviews", () => {
    const oldFix = "# Review A\n\n## Verdict\nfixes-required\n";

    expect(needsFix(oldFix, approveNoLedger)).toBe(true);
    expect(decideReadiness({ triage, plan, reviewA: oldFix, reviewB: approveNoLedger, finalReview: "" }).status).toBe("not-ready");
    expect(decideReadiness({ triage, plan, reviewA: oldFix, reviewB: approveNoLedger, finalReview: finalReady }).status).toBe("ready-for-pr");
  });

  test("follow-up and suggestion findings do not trigger fixes or block readiness", () => {
    const reviewA = review("approve", `${entry("F1", "follow-up", "Track separately")}\n${entry("S1", "suggestion", "Optional polish")}`);

    expect(needsFix(reviewA, approveNoLedger)).toBe(false);
    expect(hasBlockedReview(reviewA, approveNoLedger)).toBe(false);
    const decision = decideReadiness({ triage, plan, reviewA, reviewB: approveNoLedger, finalReview: "" });
    expect(decision.status).toBe("ready-for-pr");
    expect(decision.followUpFindings).toHaveLength(1);
    expect(decision.suggestions).toHaveLength(1);
  });

  test("must-fix-current findings trigger fix behavior and require a final ready review", () => {
    const reviewA = review("fixes-required", entry("F1", "must-fix-current"));

    expect(needsFix(reviewA, approveNoLedger)).toBe(true);
    expect(hasBlockedReview(reviewA, approveNoLedger)).toBe(false);
    expect(decideReadiness({ triage, plan, reviewA, reviewB: approveNoLedger, finalReview: "" }).status).toBe("not-ready");
    expect(decideReadiness({ triage, plan, reviewA, reviewB: approveNoLedger, finalReview: finalReady }).status).toBe("ready-for-pr");
  });

  test("final review verdict gates readiness after a verification-driven fix", () => {
    const finalFixesRequired = "# Final Review\n\n## Verdict\nfixes-required\n";
    const finalBlocked = "# Final Review\n\n## Verdict\nblocked\n";

    expect(decideReadiness({ triage, plan, reviewA: approveNoLedger, reviewB: approveNoLedger, finalReview: finalFixesRequired }).status).toBe("not-ready");
    expect(decideReadiness({ triage, plan, reviewA: approveNoLedger, reviewB: approveNoLedger, finalReview: finalBlocked }).status).toBe("not-ready");
    expect(decideReadiness({ triage, plan, reviewA: approveNoLedger, reviewB: approveNoLedger, finalReview: finalReady }).status).toBe("ready-for-pr");
  });

  test("external-blocker findings block workflow without invoking fix work", () => {
    const reviewA = review("blocked", entry("B1", "external-blocker"));

    expect(needsFix(reviewA, approveNoLedger)).toBe(false);
    expect(hasBlockedReview(reviewA, approveNoLedger)).toBe(true);
    const decision = decideReadiness({ triage, plan, reviewA, reviewB: approveNoLedger, finalReview: finalReady });
    expect(decision.status).toBe("not-ready");
    expect(decision.externalBlockers).toHaveLength(1);
  });

  test("unknown classifications are surfaced and prevent readiness", () => {
    const reviewA = review("approve", entry("X1", "mystery"));
    const decision = decideReadiness({ triage, plan, reviewA, reviewB: approveNoLedger, finalReview: "" });

    expect(needsFix(reviewA, approveNoLedger)).toBe(false);
    expect(decision.status).toBe("not-ready");
    expect(decision.rejectedFindings).toHaveLength(1);
    expect(decision.parserWarnings[0]).toContain("Unknown finding classification");
  });

  test("prefers ledger classifications and warns when verdict conflicts", () => {
    const reviewA = review("fixes-required", entry("F1", "follow-up"));
    const decision = decideReadiness({ triage, plan, reviewA, reviewB: approveNoLedger, finalReview: "" });

    expect(needsFix(reviewA, approveNoLedger)).toBe(false);
    expect(decision.status).toBe("ready-for-pr");
    expect(decision.parserWarnings.some((warning) => warning.includes("verdict is fixes-required"))).toBe(true);
  });
});
