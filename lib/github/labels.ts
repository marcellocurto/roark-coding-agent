import { GitHubRequestError } from "./errors.ts";
import { Effect } from "effect";
import { Presentation } from "../runtime/services.ts";
import type { GitHubError, GitHubRequirements } from "./errors.ts";

import { runProcess, runProcessOrThrow } from "../cli/process.ts";

export interface RequiredGitHubLabel {
  name: string;
  role: string;
  color: string;
  description: string;
}

export interface EnsureGitHubLabelsOptions {
  cwd: string;
  repo?: string | undefined;
  labels: readonly RequiredGitHubLabel[];
  dryRun?: boolean | undefined;
}

export interface EnsureGitHubLabelsResult {
  existing: string[];
  missing: RequiredGitHubLabel[];
  created: RequiredGitHubLabel[];
}

export function buildListGitHubLabelsArgv(options: { repo: string }): string[] {
  return [
    "gh",
    "api",
    `repos/${options.repo}/labels`,
    "--paginate",
    "--jq",
    ".[].name",
  ];
}

export function buildCreateGitHubLabelArgv(options: {
  repo: string;
  label: RequiredGitHubLabel;
}): string[] {
  return [
    "gh",
    "label",
    "create",
    options.label.name,
    "--repo",
    options.repo,
    "--color",
    normalizeColor(options.label.color),
    "--description",
    options.label.description,
  ];
}

export const ensureGitHubLabels = Effect.fn("GitHub.ensureGitHubLabels")(
  function* (
    options: EnsureGitHubLabelsOptions,
  ): Effect.fn.Return<
    EnsureGitHubLabelsResult,
    GitHubError,
    GitHubRequirements
  > {
    if (!options.repo) {
      return yield* Effect.fail(
        new GitHubRequestError({
          message:
            "Could not ensure GitHub labels because the repository was not resolved.",
        }),
      );
    }

    const required = uniqueRequiredLabels(options.labels);
    if (required.length === 0)
      return { existing: [], missing: [], created: [] };

    const existing = yield* listGitHubLabelNames({
      cwd: options.cwd,
      repo: options.repo,
    });
    const existingSet = normalizedSet(existing);
    const missing = required.filter(
      (label) => !existingSet.has(normalizeLabelName(label.name)),
    );

    if (options.dryRun === true) {
      if (missing.length > 0) {
        (yield* Presentation).line("Required GitHub labels missing:");
        for (const label of missing)
          (yield* Presentation).line(`- ${label.name} (${label.role})`);
        (yield* Presentation).line(
          "Dry run: would create these labels before a real autorun",
        );
      }
      return { existing, missing, created: [] };
    }

    const created: RequiredGitHubLabel[] = [];
    const failures: string[] = [];

    for (const label of missing) {
      const create = yield* runProcess(
        buildCreateGitHubLabelArgv({ repo: options.repo, label }),
        { cwd: options.cwd },
      );
      if (create.exitCode === 0) {
        created.push(label);
        continue;
      }

      const refreshed = yield* listGitHubLabelNames({
        cwd: options.cwd,
        repo: options.repo,
      });
      if (normalizedSet(refreshed).has(normalizeLabelName(label.name)))
        continue;

      failures.push(
        `- ${label.name} (${label.role}): ${create.stderr || create.stdout || `exit code ${create.exitCode}`}`.trim(),
      );
    }

    if (failures.length > 0) {
      return yield* Effect.fail(
        new GitHubRequestError({
          message: [
            "Missing required GitHub labels and could not create them:",
            ...failures,
            "",
            "No issue was claimed and no agent workflow was started.",
          ].join("\n"),
        }),
      );
    }

    if (created.length > 0) {
      (yield* Presentation).line("Created required GitHub labels:");
      for (const label of created)
        (yield* Presentation).line(`- ${label.name} (${label.role})`);
    }

    return { existing, missing, created };
  },
);

export const listGitHubLabelNames = Effect.fn("GitHub.listGitHubLabelNames")(
  function* (options: {
    cwd: string;
    repo: string;
  }): Effect.fn.Return<string[], GitHubError, GitHubRequirements> {
    const stdout = yield* runProcessOrThrow(
      buildListGitHubLabelsArgv({ repo: options.repo }),
      {
        cwd: options.cwd,
        label: "gh api labels list",
      },
    );
    return parseGitHubLabelNames(stdout);
  },
);

export function parseGitHubLabelNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueRequiredLabels(
  labels: readonly RequiredGitHubLabel[],
): RequiredGitHubLabel[] {
  const seen = new Set<string>();
  const result: RequiredGitHubLabel[] = [];
  for (const label of labels) {
    const name = label.name.trim();
    if (!name) continue;
    const key = normalizeLabelName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...label, name });
  }
  return result;
}

function normalizedSet(labels: readonly string[]): Set<string> {
  return new Set(labels.map(normalizeLabelName));
}

function normalizeLabelName(label: string): string {
  return label.trim().toLowerCase();
}

function normalizeColor(color: string): string {
  return color.trim().replace(/^#/, "");
}

export const addIssueLabel = Effect.fn("GitHub.addIssueLabel")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    issueNumber: number;
    label: string;
  }) {
    yield* runProcessOrThrow(
      [
        "gh",
        "issue",
        "edit",
        String(input.issueNumber),
        "--add-label",
        input.label,
        ...(input.repo ? ["--repo", input.repo] : []),
      ],
      { cwd: input.cwd, label: "gh issue edit --add-label" },
    );
  },
);

export const removeIssueLabel = Effect.fn("GitHub.removeIssueLabel")(
  function* (input: {
    cwd: string;
    repo?: string | undefined;
    issueNumber: number;
    label: string;
  }) {
    yield* runProcessOrThrow(
      [
        "gh",
        "issue",
        "edit",
        String(input.issueNumber),
        "--remove-label",
        input.label,
        ...(input.repo ? ["--repo", input.repo] : []),
      ],
      { cwd: input.cwd, label: "gh issue edit --remove-label" },
    );
  },
);
