export type ReviewFindingSource = "review-a" | "review-b";

export type FindingClassification =
  | "must-fix-current"
  | "external-blocker"
  | "follow-up"
  | "suggestion";

export interface NormalizedReviewerFinding {
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
  suggestedIssueTitle?: string | undefined  ;
  warnings: string[];
  rawExcerpt: string;
}

export interface RejectedReviewerFinding {
  source: ReviewFindingSource;
  sourceLocalId?: string | undefined;
  workflowId?: string | undefined;
  classification?: string | undefined  ;
  reason: string;
  rawExcerpt: string;
}

export interface ParsedReviewFindings {
  source: ReviewFindingSource;
  hasLedger: boolean;
  findings: NormalizedReviewerFinding[];
  rejected: RejectedReviewerFinding[];
  warnings: string[];
}

export interface ParsedReviewFindingsPair {
  reviewA: ParsedReviewFindings;
  reviewB: ParsedReviewFindings;
}

const classifications = new Set<FindingClassification>([
  "must-fix-current",
  "external-blocker",
  "follow-up",
  "suggestion",
]);

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

interface RawEntry {
  fields: Partial<Record<FieldKey, string>>;
  raw: string;
}

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
    const explicitId = clean(entry.fields.identifier);
    const sourceLocalId = explicitId || `finding-${index + 1}`;

    const workflowId = allocateWorkflowId(source, sourceLocalId, idCounts);

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
      warnings: [],
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
    if (/^\s*#{3,}\s+/.test(line)) {
      activeField = undefined;
      continue;
    }
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
  const content = line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "");
  const tableCells = content.startsWith("|") && content.endsWith("|")
    ? content.slice(1, -1).split("|").map((cell) => cell.trim())
    : [];
  const pair: [string, string] | undefined = tableCells.length >= 2
    ? [tableCells[0] ?? "", tableCells.slice(1).join("|")]
    : splitFieldPair(content);
  if (!pair) return undefined;

  const key = labelToFieldKey(pair[0]);
  if (!key) return undefined;
  return { key, value: stripMarkdownDecoration(pair[1]) };
}

function splitFieldPair(value: string): [string, string] | undefined {
  const colon = value.indexOf(":");
  if (colon > 0) return [value.slice(0, colon), value.slice(colon + 1)];
  const separator = /\s+[—–-]\s+/.exec(value);
  if (separator?.index !== undefined) {
    return [value.slice(0, separator.index), value.slice(separator.index + separator[0].length)];
  }
  return undefined;
}

function labelToFieldKey(label: string): FieldKey | undefined {
  const normalized = stripMarkdownDecoration(label)
    .toLowerCase()
    .replace(/\boptional\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const aliases: Record<string, FieldKey> = {
    identifier: "identifier",
    id: "identifier",
    "finding id": "identifier",
    classification: "classification",
    class: "classification",
    type: "classification",
    title: "title",
    summary: "title",
    severity: "severity",
    priority: "severity",
    confidence: "confidence",
    certainty: "confidence",
    evidence: "evidence",
    proof: "evidence",
    location: "evidence",
    "current issue impact": "currentIssueImpact",
    "current pr impact": "currentIssueImpact",
    "current impact": "currentIssueImpact",
    impact: "currentIssueImpact",
    "recommended handling": "recommendedHandling",
    recommendation: "recommendedHandling",
    "recommended fix": "recommendedHandling",
    remediation: "recommendedHandling",
    "suggested issue title": "suggestedIssueTitle",
    "follow up issue title": "suggestedIssueTitle",
  };
  return aliases[normalized];
}

function stripMarkdownDecoration(value: string): string {
  return value.trim().replace(/^[\s*_`]+|[\s*_`]+$/g, "").trim();
}

function hasAnyField(entry: RawEntry): boolean {
  return Object.values(entry.fields).some((value) => value.trim() !== "");
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
