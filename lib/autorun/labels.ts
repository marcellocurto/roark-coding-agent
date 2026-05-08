import { ensureGitHubLabels, type EnsureGitHubLabelsResult, type RequiredGitHubLabel } from "../github/labels.ts";

export type AutorunLabelContractInput = {
  readyLabel?: string;
  inProgressLabel: string;
  failureLabel: string;
  successLabel: string;
};

export type EnsureAutorunLabelContractOptions = AutorunLabelContractInput & {
  cwd: string;
  repo?: string;
  dryRun?: boolean;
};

export const autorunBlockedLabel = "blocked";
export const autorunNeedsHumanLabel = "needs-human";

export function buildRequiredAutorunLabels(input: AutorunLabelContractInput): RequiredGitHubLabel[] {
  return uniqueLabels([
    input.readyLabel
      ? {
        role: "ready",
        name: input.readyLabel,
        color: "0E8A16",
        description: "Roark autorun eligibility label. Issues with this label may be selected for autorun.",
      }
      : undefined,
    {
      role: "in-progress",
      name: input.inProgressLabel,
      color: "5319E7",
      description: "Roark lifecycle label. Applied when Roark claims an issue and is actively working it.",
    },
    {
      role: "failure",
      name: input.failureLabel,
      color: "B60205",
      description: "Roark lifecycle label. Applied when readiness or verification fails.",
    },
    {
      role: "success",
      name: input.successLabel,
      color: "1D76DB",
      description: "Roark lifecycle label. Applied after Roark opens a draft pull request.",
    },
    {
      role: "triage-blocked",
      name: autorunBlockedLabel,
      color: "D93F0B",
      description: "Status label for issues blocked by dependencies or external conditions.",
    },
    {
      role: "triage-needs-human",
      name: autorunNeedsHumanLabel,
      color: "FBCA04",
      description: "Status label for issues requiring human review, decision, or clarification.",
    },
  ]);
}

export async function ensureAutorunLabelContract(options: EnsureAutorunLabelContractOptions): Promise<EnsureGitHubLabelsResult> {
  return ensureGitHubLabels({
    cwd: options.cwd,
    repo: options.repo,
    dryRun: options.dryRun,
    labels: buildRequiredAutorunLabels(options),
  });
}

export function mergeLifecycleSkipLabels(input: {
  skipLabels: readonly string[];
  inProgressLabel: string;
  failureLabel: string;
  successLabel: string;
}): string[] {
  return uniqueLabelNames([
    ...input.skipLabels,
    input.inProgressLabel,
    input.failureLabel,
    input.successLabel,
    autorunBlockedLabel,
    autorunNeedsHumanLabel,
  ]);
}

function uniqueLabels(labels: Array<RequiredGitHubLabel | undefined>): RequiredGitHubLabel[] {
  const seen = new Set<string>();
  const result: RequiredGitHubLabel[] = [];
  for (const label of labels) {
    if (!label) continue;
    const name = label.name.trim();
    if (!name) continue;
    const key = normalizeLabel(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...label, name });
  }
  return result;
}

function uniqueLabelNames(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const name = label.trim();
    if (!name) continue;
    const key = normalizeLabel(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
