import { describe, expect, test } from "bun:test";
import {
  defaultAutorunReadyLabel,
  defaultAutorunSkipLabels,
  isEligibleIssue,
  selectEligibleIssues,
  type AutorunIssueCandidate,
} from "./selection.ts";

function issue(
  number: number,
  createdAt: string,
  labels: string[],
  title = `Issue ${number}`,
): AutorunIssueCandidate {
  return {
    number,
    title,
    createdAt,
    labels: labels.map((name) => ({ name })),
  };
}

describe("autorun issue selection", () => {
  test("requires the configured ready label", () => {
    expect(
      isEligibleIssue(issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]), {
        readyLabel: defaultAutorunReadyLabel,
        skipLabels: defaultAutorunSkipLabels,
        limit: 1,
      }),
    ).toBe(true);

    expect(
      isEligibleIssue(issue(2, "2026-01-01T00:00:00Z", ["enhancement"]), {
        readyLabel: defaultAutorunReadyLabel,
        skipLabels: defaultAutorunSkipLabels,
        limit: 1,
      }),
    ).toBe(false);
  });

  test("skips issues with configured skip labels", () => {
    for (const skipLabel of defaultAutorunSkipLabels) {
      expect(
        isEligibleIssue(issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel, skipLabel]), {
          readyLabel: defaultAutorunReadyLabel,
          skipLabels: defaultAutorunSkipLabels,
          limit: 1,
        }),
      ).toBe(false);
    }
  });

  test("selects the oldest eligible issue", () => {
    const selected = selectEligibleIssues(
      [
        issue(1, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
        issue(2, "2026-01-01T00:00:00Z", ["enhancement"]),
        issue(3, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
        issue(4, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel, "roark-in-progress"]),
      ],
      {
        readyLabel: defaultAutorunReadyLabel,
        skipLabels: defaultAutorunSkipLabels,
        limit: 1,
      },
    );

    expect(selected.map((candidate) => candidate.number)).toEqual([3]);
  });

  test("limits selected issues after filtering and sorting", () => {
    const selected = selectEligibleIssues(
      [
        issue(3, "2026-01-03T00:00:00Z", [defaultAutorunReadyLabel]),
        issue(1, "2026-01-01T00:00:00Z", [defaultAutorunReadyLabel]),
        issue(2, "2026-01-02T00:00:00Z", [defaultAutorunReadyLabel]),
      ],
      {
        readyLabel: defaultAutorunReadyLabel,
        skipLabels: defaultAutorunSkipLabels,
        limit: 2,
      },
    );

    expect(selected.map((candidate) => candidate.number)).toEqual([1, 2]);
  });

  test("matches labels case-insensitively", () => {
    expect(
      isEligibleIssue(issue(1, "2026-01-01T00:00:00Z", ["AFK"]), {
        readyLabel: "afk",
        skipLabels: defaultAutorunSkipLabels,
        limit: 1,
      }),
    ).toBe(true);
  });
});
