export type ReviewFindingSource = "review-a" | "review-b";

export type FindingClassification =
  | "must-fix-current"
  | "external-blocker"
  | "follow-up"
  | "suggestion";

export type NormalizedReviewerFinding = {
  source: ReviewFindingSource;
  sourceLocalId: string;
  workflowId: string;
  title: string;
  classification: FindingClassification;
  severity: string;
  confidence: string;
  evidence: string;
  currentIssueImpact: string;
  recommendedHandling: string;
  suggestedIssueTitle?: string;
  warnings: string[];
  rawExcerpt: string;
};

export type RejectedReviewerFinding = {
  source: ReviewFindingSource;
  sourceLocalId?: string;
  workflowId?: string;
  classification?: string;
  reason: string;
  rawExcerpt: string;
};

export type ParsedReviewFindings = {
  source: ReviewFindingSource;
  hasLedger: boolean;
  findings: NormalizedReviewerFinding[];
  rejected: RejectedReviewerFinding[];
  warnings: string[];
};

export type ParsedReviewFindingsPair = {
  reviewA: ParsedReviewFindings;
  reviewB: ParsedReviewFindings;
};

const classifications = new Set<FindingClassification>([
  "must-fix-current",
  "external-blocker",
  "follow-up",
  "suggestion",
]);

const requiredFields = [
  "title",
  "severity",
  "confidence",
  "evidence",
  "currentIssueImpact",
  "recommendedHandling",
] as const;

type FieldKey =
  | "identifier"
  | "classification"
  | "title"
  | "severity"
  | "confidence"
  | "evidence"
  | "currentIssueImpact"
  | "recommendedHandling"
  | "suggestedIssueTitle";

type RawEntry = {
  fields: Partial<Record<FieldKey, string>>;
  raw: string;
};

export function parseReviewPairFindings(input: { reviewA: string; reviewB: string }): ParsedReviewFindingsPair {
  return {
    reviewA: parseReviewFindings(input.reviewA, "review-a"),
    reviewB: parseReviewFindings(input.reviewB, "review-b"),
  };
}

export function parseReviewFindings(markdown: string, source: ReviewFindingSource): ParsedReviewFindings {
  const ledger = extractFindingsLedger(markdown);
  if (ledger === undefined) {
    return { source, hasLedger: false, findings: [], rejected: [], warnings: [] };
  }

  const trimmedLedger = ledger.trim();
  if (!trimmedLedger || isNoFindingsLedger(trimmedLedger)) {
    return { source, hasLedger: true, findings: [], rejected: [], warnings: [] };
  }

  const rawEntries = parseRawEntries(trimmedLedger);
  const warnings: string[] = [];
  const findings: NormalizedReviewerFinding[] = [];
  const rejected: RejectedReviewerFinding[] = [];
  const idCounts = new Map<string, number>();

  if (rawEntries.length === 0) {
    warnings.push(`${source}: Findings Ledger is present but contains no parseable finding entries.`);
    rejected.push({
      source,
      reason: "Findings Ledger contains no parseable finding entries.",
      rawExcerpt: excerpt(trimmedLedger),
    });
    return { source, hasLedger: true, findings, rejected, warnings };
  }

  rawEntries.forEach((entry, index) => {
    const entryWarnings: string[] = [];
    const explicitId = clean(entry.fields.identifier);
    const sourceLocalId = explicitId || `finding-${index + 1}`;
    if (!explicitId) entryWarnings.push("missing Identifier; generated a source-local identifier");

    const workflowId = allocateWorkflowId(source, sourceLocalId, idCounts);
    if (idCounts.get(sourceLocalId) !== 1) {
      entryWarnings.push(`duplicate Identifier '${sourceLocalId}' within ${source}; workflow id namespaced as '${workflowId}'`);
    }

    const rawClassification = clean(entry.fields.classification).toLowerCase();
    const classification = normalizeClassification(rawClassification);
    if (!classification) {
      const reason = rawClassification
        ? `Unknown finding classification '${rawClassification}'.`
        : "Missing finding classification.";
      warnings.push(`${source}:${sourceLocalId}: ${reason}`);
      rejected.push({
        source,
        sourceLocalId,
        workflowId,
        classification: rawClassification || undefined,
        reason,
        rawExcerpt: excerpt(entry.raw),
      });
      return;
    }

    for (const field of requiredFields) {
      if (!clean(entry.fields[field])) entryWarnings.push(`missing ${displayField(field)}`);
    }

    warnings.push(...entryWarnings.map((warning) => `${source}:${sourceLocalId}: ${warning}`));
    findings.push({
      source,
      sourceLocalId,
      workflowId,
      title: clean(entry.fields.title) || "(untitled finding)",
      classification,
      severity: clean(entry.fields.severity) || "unspecified",
      confidence: clean(entry.fields.confidence) || "unspecified",
      evidence: clean(entry.fields.evidence) || "unspecified",
      currentIssueImpact: clean(entry.fields.currentIssueImpact) || "unspecified",
      recommendedHandling: clean(entry.fields.recommendedHandling) || "unspecified",
      suggestedIssueTitle: clean(entry.fields.suggestedIssueTitle) || undefined,
      warnings: entryWarnings,
      rawExcerpt: excerpt(entry.raw),
    });
  });

  return { source, hasLedger: true, findings, rejected, warnings };
}

export function findingsByClassification(
  findings: readonly NormalizedReviewerFinding[],
  classification: FindingClassification,
): NormalizedReviewerFinding[] {
  return findings.filter((finding) => finding.classification === classification);
}

function extractFindingsLedger(markdown: string): string | undefined {
  const heading = /^##\s*Findings Ledger\s*$/im.exec(markdown);
  if (!heading) return undefined;

  const afterHeadingStart = heading.index + heading[0].length;
  const afterHeading = markdown.slice(afterHeadingStart).replace(/^\r?\n/, "");
  const nextHeading = /^##\s+/m.exec(afterHeading);
  return nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
}

function isNoFindingsLedger(value: string): boolean {
  const normalized = value
    .replace(/[`*_]/g, "")
    .replace(/[.\s-]+$/g, "")
    .trim()
    .toLowerCase();
  return /^(none|no findings|no findings found|n\/a|not applicable|empty)$/.test(normalized);
}

function parseRawEntries(ledger: string): RawEntry[] {
  const entries: RawEntry[] = [];
  let current: RawEntry | undefined;
  let activeField: FieldKey | undefined;

  for (const line of ledger.split(/\r?\n/)) {
    const parsed = parseFieldLine(line);
    if (parsed) {
      if (parsed.key === "identifier" && current && hasAnyField(current)) {
        entries.push(current);
        current = undefined;
      }
      current ??= { fields: {}, raw: "" };
      current.raw += `${line}\n`;
      activeField = parsed.key;
      const existing = current.fields[parsed.key];
      current.fields[parsed.key] = existing ? `${existing}\n${parsed.value}` : parsed.value;
      continue;
    }

    if (current) {
      current.raw += `${line}\n`;
      if (activeField && line.trim()) {
        const existing = current.fields[activeField];
        current.fields[activeField] = existing ? `${existing}\n${line.trim()}` : line.trim();
      }
    }
  }

  if (current && hasAnyField(current)) entries.push(current);
  return entries;
}

function parseFieldLine(line: string): { key: FieldKey; value: string } | undefined {
  const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*)?\s*(Identifier|Classification|Title|Severity|Confidence|Evidence|Current[-\s]+issue impact|Recommended handling|Suggested issue title(?:\s*\(optional\))?)(?:\*\*)?\s*:\s*(.*)$/i);
  if (!match) return undefined;

  const label = match[1];
  const value = match[2] ?? "";
  if (!label) return undefined;

  return { key: labelToFieldKey(label), value: value.trim() };
}

function labelToFieldKey(label: string): FieldKey {
  const normalized = label.toLowerCase().replace(/\s*\(optional\)\s*/g, "").replace(/[\s-]+/g, " ").trim();
  if (normalized === "current issue impact") return "currentIssueImpact";
  if (normalized === "recommended handling") return "recommendedHandling";
  if (normalized === "suggested issue title") return "suggestedIssueTitle";
  return normalized as FieldKey;
}

function hasAnyField(entry: RawEntry): boolean {
  return Object.values(entry.fields).some((value) => value !== undefined && value.trim() !== "");
}

function normalizeClassification(value: string): FindingClassification | undefined {
  return classifications.has(value as FindingClassification) ? value as FindingClassification : undefined;
}

function allocateWorkflowId(source: ReviewFindingSource, sourceLocalId: string, counts: Map<string, number>): string {
  const nextCount = (counts.get(sourceLocalId) ?? 0) + 1;
  counts.set(sourceLocalId, nextCount);
  const base = `${source}:${sourceLocalId}`;
  return nextCount === 1 ? base : `${base}#${nextCount}`;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function excerpt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function displayField(field: typeof requiredFields[number]): string {
  if (field === "currentIssueImpact") return "Current-issue impact";
  if (field === "recommendedHandling") return "Recommended handling";
  return field.charAt(0).toUpperCase() + field.slice(1);
}
