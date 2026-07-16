import type { AutorunClaimPlan } from "../autorun/claim.ts";
import { runProcessOrThrow } from "../cli/process.ts";
import { postIssueComment } from "./comments.ts";

export interface ParsedIssueRef {
  issueNumber: string;
  repo?: string | undefined  ;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | undefined;
  state?: string | undefined;
  labels?: { name: string }[] | undefined;
  assignees?: { login: string }[] | undefined;
  milestone?: { title: string } | null | undefined;
  url?: string | undefined  ;
  comments?: {
    author?: { login: string } | undefined;
    body?: string | undefined;
    createdAt?: string | undefined;
  }[];
}

export interface GitHubIssueListItem {
  number: number;
  title: string;
  body?: string | undefined;
  url?: string | undefined  ;
  createdAt?: string | undefined;
  labels?: { name: string }[] | undefined;
}

export interface GitHubIssueDependency {
  number: number;
  title: string;
  url?: string | undefined  ;
  state: string;
  stateReason?: string | null | undefined;
  closedAt?: string | null | undefined;
}

export interface GitHubIssueDependenciesSummary {
  blockedBy: number;
  blocking: number;
  totalBlockedBy: number;
  totalBlocking: number;
}

export interface BodyDeclaredBlocker {
  raw: string;
  repo: string;
  number: number;
  verified: boolean;
  title?: string | undefined;
  url?: string | undefined  ;
  state?: string | undefined;
  stateReason?: string | null | undefined;
  closed?: boolean | undefined;
  closedAt?: string | null | undefined;
  unavailableReason?: string | undefined;
}

export interface GitHubIssueRelationships {
  fetchedAt: string;
  repo?: string | undefined  ;
  nativeDependenciesAvailable: boolean;
  issueDependenciesSummary?: GitHubIssueDependenciesSummary | undefined;
  blockedBy: GitHubIssueDependency[];
  blocking: GitHubIssueDependency[];
  bodyDeclaredBlockers: BodyDeclaredBlocker[];
  unavailableReason?: string | undefined;
}

interface BodyBlockerRef {
  raw: string;
  repo: string;
  number: number;
}

export function parseIssueRef(input: string, explicitRepo?: string): ParsedIssueRef {
  const urlMatch = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i.exec(input);
  if (urlMatch?.[1] && urlMatch[2]) return { repo: explicitRepo ?? urlMatch[1], issueNumber: urlMatch[2] };

  const shorthandMatch = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(input);
  if (shorthandMatch?.[1] && shorthandMatch[2]) {
    return { repo: explicitRepo ?? shorthandMatch[1], issueNumber: shorthandMatch[2] };
  }

  const numberMatch = /^#?(\d+)$/.exec(input);
  if (numberMatch?.[1]) return { repo: explicitRepo, issueNumber: numberMatch[1] };

  throw new Error(`Could not parse issue '${input}'. Use a number, GitHub issue URL, or owner/repo#123.`);
}

export async function listOpenGitHubIssues(options: { cwd: string; repo?: string | undefined; limit: number }): Promise<GitHubIssueListItem[]> {
  const args = [
    "gh",
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(options.limit),
    "--json",
    "number,title,body,url,createdAt,labels",
  ];
  if (options.repo) args.push("--repo", options.repo);

  const stdout = await runProcessOrThrow(args, { cwd: options.cwd, label: "gh issue list" });
  return JSON.parse(stdout) as GitHubIssueListItem[];
}

export async function getCurrentGitHubLogin(options: { cwd: string }): Promise<string> {
  return (await runProcessOrThrow(["gh", "api", "user", "--jq", ".login"], { cwd: options.cwd, label: "gh api user" })).trim();
}

export async function claimGitHubIssue(options: { cwd: string; repo?: string | undefined; plan: AutorunClaimPlan; postComment?: boolean }): Promise<void> {
  const issueNumber = String(options.plan.issueNumber);
  const repoArgs = options.repo ? ["--repo", options.repo] : [];

  await transitionGitHubIssueLabels({
    cwd: options.cwd,
    repo: options.repo,
    issueNumber: options.plan.issueNumber,
    nextLabel: options.plan.inProgressLabel,
    removeLabels: options.plan.removeLabels,
  });

  if (options.plan.assignee) {
    await runProcessOrThrow(
      ["gh", "issue", "edit", issueNumber, "--add-assignee", options.plan.assignee, ...repoArgs],
      { cwd: options.cwd, label: "gh issue edit --add-assignee" },
    );
  }

  if (options.postComment === false) return;

  await postIssueComment({ cwd: options.cwd, repo: options.repo, issueNumber, body: options.plan.commentBody });
}

export async function transitionGitHubIssueLabels(options: {
  cwd: string;
  repo?: string | undefined;
  issueNumber: string | number;
  nextLabel: string;
  removeLabels: readonly string[];
}): Promise<void> {
  const issueNumber = String(options.issueNumber);
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  const labelArgs = options.removeLabels
    .filter((candidate) => candidate !== options.nextLabel)
    .flatMap((label) => ["--remove-label", label]);
  await runProcessOrThrow(
    ["gh", "issue", "edit", issueNumber, "--add-label", options.nextLabel, ...labelArgs, ...repoArgs],
    { cwd: options.cwd, label: "gh issue edit --transition-label" },
  );
}

export function buildIssueDependenciesSummaryArgv(repo: string, issueNumber: string | number): string[] {
  return ["gh", "api", `repos/${repo}/issues/${issueNumber}`];
}

export function buildIssueBlockedByDependenciesArgv(repo: string, issueNumber: string | number): string[] {
  return ["gh", "api", `repos/${repo}/issues/${issueNumber}/dependencies/blocked_by`];
}

export function buildIssueBlockingDependenciesArgv(repo: string, issueNumber: string | number): string[] {
  return ["gh", "api", `repos/${repo}/issues/${issueNumber}/dependencies/blocking`];
}

export function buildBodyBlockerViewArgv(ref: Pick<BodyBlockerRef, "repo" | "number">): string[] {
  return [
    "gh",
    "issue",
    "view",
    String(ref.number),
    "--repo",
    ref.repo,
    "--json",
    "number,title,state,stateReason,closed,closedAt,url",
  ];
}

export async function fetchGitHubIssue(input: string, options: { cwd: string; repo?: string  | undefined}): Promise<{
  issue: GitHubIssue;
  issueNumber: string;
  repo?: string | undefined  ;
  relationships: GitHubIssueRelationships;
}> {
  const parsed = parseIssueRef(input, options.repo);
  const args = [
    "gh",
    "issue",
    "view",
    parsed.issueNumber,
    "--json",
    "number,title,body,state,labels,assignees,milestone,url,comments",
  ];
  if (parsed.repo) args.push("--repo", parsed.repo);

  const stdout = await runProcessOrThrow(args, { cwd: options.cwd, label: "gh issue view" });
  const issue = JSON.parse(stdout) as GitHubIssue;
  const repo = await resolveGitHubIssueRepo({ cwd: options.cwd, explicitRepo: parsed.repo, issueUrl: issue.url });
  const relationships = await fetchGitHubIssueRelationships({
    cwd: options.cwd,
    repo,
    issueNumber: parsed.issueNumber,
    body: issue.body ?? "",
  });

  return {
    issue,
    issueNumber: parsed.issueNumber,
    repo,
    relationships,
  };
}

export async function resolveGitHubIssueRepo(options: { cwd: string; explicitRepo?: string | undefined; issueUrl?: string  | undefined}): Promise<string | undefined> {
  if (options.explicitRepo) return options.explicitRepo;
  const fromUrl = repoFromIssueUrl(options.issueUrl);
  if (fromUrl) return fromUrl;

  try {
    return (await runProcessOrThrow(
      ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: options.cwd, label: "gh repo view" },
    )).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchGitHubIssueRelationships(options: {
  cwd: string;
  repo?: string | undefined  ;
  issueNumber: string | number;
  body: string;
}): Promise<GitHubIssueRelationships> {
  const fetchedAt = new Date().toISOString();
  const native = options.repo
    ? await fetchNativeRelationshipsBestEffort({ cwd: options.cwd, repo: options.repo, issueNumber: options.issueNumber })
    : {
      nativeDependenciesAvailable: false,
      blockedBy: [] as GitHubIssueDependency[],
      blocking: [] as GitHubIssueDependency[],
      unavailableReason: "repository could not be resolved for dependency API requests",
    };

  const bodyDeclaredBlockers = options.repo
    ? await verifyBodyDeclaredBlockers({ cwd: options.cwd, refs: parseBodyDeclaredBlockerRefs(options.body, options.repo) })
    : [];

  return {
    fetchedAt,
    repo: options.repo,
    nativeDependenciesAvailable: native.nativeDependenciesAvailable,
    issueDependenciesSummary: native.issueDependenciesSummary,
    blockedBy: native.blockedBy,
    blocking: native.blocking,
    bodyDeclaredBlockers,
    unavailableReason: native.unavailableReason,
  };
}

export function parseBodyDeclaredBlockerRefs(body: string, currentRepo: string): BodyBlockerRef[] {
  const lines = body.split(/\r?\n/);
  const refs: BodyBlockerRef[] = [];
  let inFence = false;
  let inDependencySection = false;

  for (const line of lines) {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^\s*#{2,3}\s*(?:Blocked by|Depends on)\s*$/i.test(line)) {
      inDependencySection = true;
      continue;
    }

    if (inDependencySection && /^\s*#{1,6}\s+/.test(line)) {
      inDependencySection = false;
    }

    const inlineMatch = /^\s*(?:[-*]\s*)?(?:Blocked by|Depends on)\s*:?\s*(.+)$/i.exec(line);
    if (inlineMatch?.[1]) refs.push(...extractExplicitIssueRefsFromStart(inlineMatch[1], currentRepo));
    else if (inDependencySection) refs.push(...extractExplicitIssueRefsFromStart(line.replace(/^\s*[-*]\s*/, ""), currentRepo));
  }

  return dedupeBodyBlockerRefs(refs);
}

export function normalizeGitHubIssueDependency(value: unknown): GitHubIssueDependency | undefined {
  if (!isRecord(value)) return undefined;
  const number = numericField(value, "number");
  if (number === undefined) return undefined;
  return {
    number,
    title: stringField(value, "title") ?? "",
    url: stringField(value, "url") ?? stringField(value, "html_url"),
    state: normalizeIssueState(stringField(value, "state")),
    stateReason: nullableStringField(value, "stateReason") ?? nullableStringField(value, "state_reason"),
    closedAt: nullableStringField(value, "closedAt") ?? nullableStringField(value, "closed_at"),
  };
}

async function fetchNativeRelationshipsBestEffort(options: { cwd: string; repo: string; issueNumber: string | number }): Promise<{
  nativeDependenciesAvailable: boolean;
  issueDependenciesSummary?: GitHubIssueDependenciesSummary | undefined;
  blockedBy: GitHubIssueDependency[];
  blocking: GitHubIssueDependency[];
  unavailableReason?: string | undefined;
}> {
  try {
    const [issueRaw, blockedByRaw, blockingRaw] = await Promise.all([
      runProcessOrThrow(buildIssueDependenciesSummaryArgv(options.repo, options.issueNumber), { cwd: options.cwd, label: "gh api issue dependency summary" }),
      runProcessOrThrow(buildIssueBlockedByDependenciesArgv(options.repo, options.issueNumber), { cwd: options.cwd, label: "gh api issue dependencies blocked_by" }),
      runProcessOrThrow(buildIssueBlockingDependenciesArgv(options.repo, options.issueNumber), { cwd: options.cwd, label: "gh api issue dependencies blocking" }),
    ]);

    const issuePayload = JSON.parse(issueRaw) as unknown;
    const blockedBy = normalizeDependencyList(JSON.parse(blockedByRaw) as unknown);
    const blocking = normalizeDependencyList(JSON.parse(blockingRaw) as unknown);
    const issueDependenciesSummary = normalizeIssueDependenciesSummary(issuePayload, blockedBy, blocking);

    return { nativeDependenciesAvailable: true, issueDependenciesSummary, blockedBy, blocking };
  } catch (error) {
    return {
      nativeDependenciesAvailable: false,
      blockedBy: [],
      blocking: [],
      unavailableReason: formatError(error),
    };
  }
}

async function verifyBodyDeclaredBlockers(options: { cwd: string; refs: BodyBlockerRef[] }): Promise<BodyDeclaredBlocker[]> {
  const results: BodyDeclaredBlocker[] = [];
  for (const ref of options.refs) {
    try {
      const raw = await runProcessOrThrow(buildBodyBlockerViewArgv(ref), { cwd: options.cwd, label: "gh issue view body-declared blocker" });
      const parsed = JSON.parse(raw) as unknown;
      const dependency = normalizeGitHubIssueDependency(parsed);
      const closed = isRecord(parsed) ? booleanField(parsed, "closed") : undefined;
      results.push({
        raw: ref.raw,
        repo: ref.repo,
        number: dependency?.number ?? ref.number,
        verified: true,
        title: dependency?.title,
        url: dependency?.url,
        state: dependency?.state,
        stateReason: dependency?.stateReason,
        closed: closed ?? dependency?.state === "CLOSED",
        closedAt: dependency?.closedAt,
      });
    } catch (error) {
      results.push({
        raw: ref.raw,
        repo: ref.repo,
        number: ref.number,
        verified: false,
        unavailableReason: formatError(error),
      });
    }
  }
  return results;
}

function normalizeDependencyList(value: unknown): GitHubIssueDependency[] {
  const array = dependencyArray(value);
  return array.map(normalizeGitHubIssueDependency).filter((item): item is GitHubIssueDependency => item !== undefined);
}

function dependencyArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["blocked_by", "blockedBy", "blocking", "nodes", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeIssueDependenciesSummary(
  issuePayload: unknown,
  blockedBy: GitHubIssueDependency[],
  blocking: GitHubIssueDependency[],
): GitHubIssueDependenciesSummary {
  const summary = isRecord(issuePayload)
    ? recordField(issuePayload, "issue_dependencies_summary") ?? recordField(issuePayload, "issueDependenciesSummary")
    : undefined;

  return {
    blockedBy: numericField(summary, "blockedBy") ?? numericField(summary, "blocked_by") ?? activeIssueCount(blockedBy),
    blocking: numericField(summary, "blocking") ?? activeIssueCount(blocking),
    totalBlockedBy: numericField(summary, "totalBlockedBy") ?? numericField(summary, "total_blocked_by") ?? blockedBy.length,
    totalBlocking: numericField(summary, "totalBlocking") ?? numericField(summary, "total_blocking") ?? blocking.length,
  };
}

function activeIssueCount(issues: GitHubIssueDependency[]): number {
  return issues.filter((issue) => issue.state !== "CLOSED").length;
}

function extractExplicitIssueRefsFromStart(text: string, currentRepo: string): BodyBlockerRef[] {
  const refs: BodyBlockerRef[] = [];
  let remainder = text.trim();

  while (remainder.length > 0) {
    const match = /^(https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))/i.exec(remainder);
    if (!match?.[1]) break;

    const repo = match[2] ?? match[4] ?? currentRepo;
    const number = Number(match[3] ?? match[5] ?? match[6]);
    if (Number.isInteger(number) && number > 0) refs.push({ raw: match[1], repo, number });

    remainder = remainder.slice(match[1].length).trimStart();
    const separator = /^(?:[,;]|\band\b|&)\s*/i.exec(remainder);
    if (!separator?.[0]) break;
    remainder = remainder.slice(separator[0].length).trimStart();
  }

  return refs;
}

function dedupeBodyBlockerRefs(refs: BodyBlockerRef[]): BodyBlockerRef[] {
  const seen = new Set<string>();
  const result: BodyBlockerRef[] = [];
  for (const ref of refs) {
    const key = `${ref.repo.toLowerCase()}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function repoFromIssueUrl(url?: string): string | undefined {
  return url?.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i)?.[1];
}

function normalizeIssueState(value: string | undefined): string {
  return value?.toUpperCase() ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function nullableStringField(value: unknown, key: string): string | null | undefined {
  if (!isRecord(value) || !(key in value)) return undefined;
  const candidate = value[key];
  if (candidate === null) return null;
  return typeof candidate === "string" ? candidate : undefined;
}

function numericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
