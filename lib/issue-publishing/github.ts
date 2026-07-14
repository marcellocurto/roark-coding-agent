import { runProcess, runProcessOrThrow } from "../cli/process.ts";

export interface IssuePublishRequest {
  cwd: string;
  repo?: string | undefined;
  title: string;
  body: string;
  labels: readonly string[];
}

export interface IssuePublishResult {
  url: string;
  number?: number | undefined;
  stdout?: string | undefined;
}

export type IssuePublisher = (request: IssuePublishRequest) => Promise<IssuePublishResult>;

export async function publishIssueWithGitHub(request: IssuePublishRequest): Promise<IssuePublishResult> {
  const repoArgs = request.repo ? ["--repo", request.repo] : [];
  const duplicateSearch = await runProcess([
    "gh", "issue", "list",
    "--state", "all",
    "--search", `\"${request.title}\" in:title`,
    "--json", "number,title,url",
    "--limit", "20",
    ...repoArgs,
  ], { cwd: request.cwd });
  if (duplicateSearch.exitCode !== 0) {
    throw new Error(`gh issue duplicate search failed with exit code ${duplicateSearch.exitCode}:\n${duplicateSearch.stderr || duplicateSearch.stdout}`);
  }
  const duplicate = exactTitleMatch(duplicateSearch.stdout, request.title);
  if (duplicate) throw new Error(`An issue with the same title already exists: ${duplicate.url ?? `#${duplicate.number ?? "unknown"}`}`);

  const stdout = await runProcessOrThrow([
    "gh", "issue", "create",
    "--title", request.title,
    "--body-file", "-",
    ...request.labels.flatMap((label) => ["--label", label]),
    ...repoArgs,
  ], { cwd: request.cwd, label: "gh issue create", input: request.body });
  const url = /https?:\/\/\S+\/issues\/\d+/.exec(stdout)?.[0]?.replace(/[),.;]+$/, "");
  if (!url) throw new Error("gh issue create succeeded but did not return an issue URL.");
  const number = Number.parseInt(/\/issues\/(\d+)/.exec(url)?.[1] ?? "", 10);
  return { url, ...(Number.isInteger(number) ? { number } : {}), stdout };
}

function exactTitleMatch(output: string, title: string): { number?: number; title?: string; url?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Could not parse gh issue duplicate search response: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("gh issue duplicate search response was not an array.");
  const normalizedTitle = normalizeTitle(title);
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate["title"] !== "string" || normalizeTitle(candidate["title"]) !== normalizedTitle) continue;
    return {
      title: candidate["title"],
      ...(typeof candidate["url"] === "string" ? { url: candidate["url"] } : {}),
      ...(typeof candidate["number"] === "number" && Number.isInteger(candidate["number"])
        ? { number: candidate["number"] }
        : {}),
    };
  }
  return undefined;
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
