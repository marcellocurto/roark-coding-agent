import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { implementationPlanResult } from "../testing/workflow-results.ts";
import {
  formatImplementationPlanMarkdown,
  parseImplementationPlanResultJson,
} from "./result.ts";
describe("structured implementation plans", () => {
  test("rejects a ready plan with a material unanswered question", () => {
    expect(() =>
      Effect.runSync(
        parseImplementationPlanResultJson(
          JSON.stringify(
            implementationPlanResult(true, {
              blockingQuestions: ["May existing customer data be deleted?"],
            }),
          ),
        ),
      ),
    ).toThrow("cannot contain blocking questions or external blockers");
  });
  test("rejects a ready plan with a verified external blocker", () => {
    expect(() =>
      Effect.runSync(
        parseImplementationPlanResultJson(
          JSON.stringify(
            implementationPlanResult(true, {
              externalBlockers: [
                "Issue #5 remains open and must ship first; verified via gh.",
              ],
            }),
          ),
        ),
      ),
    ).toThrow("cannot contain blocking questions or external blockers");
  });
  test("requires an actionable stop instead of an unexplained non-ready flag", () => {
    expect(() =>
      Effect.runSync(
        parseImplementationPlanResultJson(
          JSON.stringify(
            implementationPlanResult(false, { blockingQuestions: [] }),
          ),
        ),
      ),
    ).toThrow("list the questions or blockers that need to be resolved");
  });
  test("accepts an honest stop before executable steps are known", () => {
    const plan = implementationPlanResult(false, {
      proposedChanges: [],
      detailedSteps: [],
      filesLikelyToChange: [],
      testsAndValidation: [],
    });
    expect(
      Effect.runSync(parseImplementationPlanResultJson(JSON.stringify(plan))),
    ).toEqual(plan);
  });
  test("preserves an existing plan's source, sequencing, and justified technical corrections", () => {
    const plan = implementationPlanResult(true, {
      source: "Issue body: Approved migration plan",
      detailedSteps: [
        "Add the nullable column.",
        "Backfill without deleting source data.",
        "Switch reads only after the backfill completes.",
      ],
      adaptations: [
        {
          change: "Use lib/storage.ts instead of the removed lib/db.ts.",
          evidence:
            "The existing migration entry point imports lib/storage.ts.",
        },
      ],
      resolvedQuestions: [
        {
          question: "Which module owns migrations?",
          resolution: "lib/storage.ts",
          evidence: "Migration entry point import.",
        },
      ],
    });
    expect(
      Effect.runSync(parseImplementationPlanResultJson(JSON.stringify(plan))),
    ).toEqual(plan);
  });
  test("preserves problem-specific sections without weakening standard plan fields", () => {
    const result = Effect.runSync(
      parseImplementationPlanResultJson(
        JSON.stringify(
          implementationPlanResult(true, {
            additionalSections: [
              {
                heading: "Compatibility discovery",
                items: [
                  "The existing adapter also serves the migration command, so its behavior must remain unchanged.",
                ],
              },
            ],
          }),
        ),
      ),
    );
    expect(result.additionalSections).toEqual([
      {
        heading: "Compatibility discovery",
        items: [
          "The existing adapter also serves the migration command, so its behavior must remain unchanged.",
        ],
      },
    ]);
    expect(formatImplementationPlanMarkdown(result, "final")).toContain(
      "## Compatibility discovery\n\n- The existing adapter also serves the migration command",
    );
    expect(result.readyForImplementation).toBe(true);
  });
  test("rejects additional sections that impersonate authoritative plan fields", () => {
    expect(() =>
      Effect.runSync(
        parseImplementationPlanResultJson(
          JSON.stringify(
            implementationPlanResult(true, {
              additionalSections: [
                { heading: "Ready For Implementation", items: ["no"] },
              ],
            }),
          ),
        ),
      ),
    ).toThrow("duplicates reserved heading");
  });
});
