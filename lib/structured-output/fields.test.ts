import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  validateChangeReport,
  requireAddressedFindingIds,
} from "../change-report/result.ts";
import { validateRevisionExecutionResult } from "../pr-revision/execution.ts";
import { validateTriageResult } from "../triage/result.ts";
import { validateImplementationPlanResult } from "../implementation-plan/result.ts";
import { changeReport } from "../testing/change-reports.ts";
import { revisionExecutionResult } from "../testing/revision-executions.ts";
import {
  triageResult,
  implementationPlanResult,
} from "../testing/workflow-results.ts";

for (const kind of ["change report", "revision execution"] as const) {
  describe(`${kind} work fields`, () => {
    const fixture = () =>
      kind === "change report" ? changeReport() : revisionExecutionResult();
    const decode = Effect.fnUntraced(function* (value: unknown) {
      return kind === "change report"
        ? yield* validateChangeReport(value)
        : yield* validateRevisionExecutionResult(value);
    });
    test("normalizes text, portable paths, and validation entries", () => {
      const result = Effect.runSync(
        decode({
          ...fixture(),
          summary: "  Completed work.\n",
          changedFiles: [
            { path: " .\\lib\\example.ts ", description: " Fixed behavior.\n" },
          ],
          validation: [
            {
              command: " bun test\n",
              status: "passed",
              details: " Tests passed. ",
            },
          ],
        }),
      );
      expect(result.summary).toBe("Completed work.");
      expect(result.changedFiles).toEqual([
        { path: "lib/example.ts", description: "Fixed behavior." },
      ]);
      expect(result.validation).toEqual([
        { command: "bun test", status: "passed", details: "Tests passed." },
      ]);
    });
    test.each([
      "../escape.ts",
      "lib/../escape.ts",
      "/absolute.ts",
      "C:\\repo\\file.ts",
    ])("rejects unsafe repository path %s", (path) => {
      expect(() =>
        Effect.runSync(
          decode({
            ...fixture(),
            changedFiles: [{ path, description: "Changed." }],
          }),
        ),
      ).toThrow(/repository-relative|escape the repository/);
    });
    test("detects duplicate paths after normalization", () => {
      expect(() =>
        Effect.runSync(
          decode({
            ...fixture(),
            changedFiles: [
              { path: "./lib/example.ts", description: "First" },
              { path: "lib\\example.ts", description: "Second" },
            ],
          }),
        ),
      ).toThrow("duplicates: lib/example.ts");
    });
    test("retains a useful field path for blank validation details", () => {
      expect(() =>
        Effect.runSync(
          decode({
            ...fixture(),
            validation: [
              { command: "bun test", status: "passed", details: "  " },
            ],
          }),
        ),
      ).toThrow(/must not be blank[\s\S]*validation[\s\S]*details/);
    });
  });
}

test("triage and plan scalars retain their distinct whitespace normalization", () => {
  const triage = Effect.runSync(
    validateTriageResult(
      triageResult("proceed", { reasoning: "  ", recommendedNextStep: "\t" }),
    ),
  );
  expect(triage.reasoning).toBe("");
  expect(triage.recommendedNextStep).toBe("");
  const plan = Effect.runSync(
    validateImplementationPlanResult(
      implementationPlanResult(true, { issue: " ", goal: "\n" }),
    ),
  );
  expect(plan.issue).toBe("");
  expect(plan.goal).toBe("");
  expect(() =>
    Effect.runSync(
      validateTriageResult(triageResult("proceed", { evidence: [" "] })),
    ),
  ).toThrow(/must not be blank[\s\S]*evidence/);
  expect(() =>
    Effect.runSync(
      validateImplementationPlanResult(
        implementationPlanResult(true, { detailedSteps: [" "] }),
      ),
    ),
  ).toThrow(/must not be blank[\s\S]*detailedSteps/);
});

test("checking finding linkage does not normalize a decoded report again", () => {
  const report = Effect.runSync(
    validateChangeReport(
      changeReport({
        changedFiles: [{ path: "././lib/example.ts", description: "Changed." }],
        addressedFindingIds: ["review-a:fix"],
      }),
    ),
  );
  expect(report.changedFiles[0]?.path).toBe("./lib/example.ts");
  expect(
    Effect.runSync(requireAddressedFindingIds(report, ["review-a:fix"])),
  ).toEqual(report);
});
