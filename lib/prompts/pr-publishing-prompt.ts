import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";
import type { AttemptMetadata } from "../autorun/attempts.ts";
import type { VerificationResult } from "../autorun/verification.ts";
import { escapePromptXmlText } from "./xml.ts";

export interface PrPublishingPromptInput {
  context: WorkflowContext;
  repo?: string | undefined;
  sourceIssue: { number: number; title: string; url?: string | undefined };
  branchName: string;
  baseBranch: string;
  verification?: VerificationResult | undefined;
  attemptMetadata?: AttemptMetadata | undefined;
  attemptMetadataPath?: string | undefined;
  artifactPaths: string[];
  changedFiles: string[];
}

export function prPublishingSystemPrompt(): string {
  return "You are the Roark PR authoring agent. Read workflow evidence and submit a structured, reviewer-friendly pull request draft. Roark owns Markdown rendering and GitHub publishing.";
}

export function prCreatePrompt(input: PrPublishingPromptInput): string {
  return `<workflow_phase name="author_pull_request">
  <role>You are the approved PR authoring agent for Roark.</role>
  <source_issue>${formatSourceIssue(input.sourceIssue)}</source_issue>
  <target_repo>${escapePromptXmlText(input.repo ?? "GitHub's current default repository")}</target_repo>
  <branch>${escapePromptXmlText(input.branchName)}</branch>
  <base_branch>${escapePromptXmlText(input.baseBranch)}</base_branch>
  <run_directory>${escapePromptXmlText(input.context.runDirRelative)}</run_directory>
  <artifact_paths>
${formatArtifactPaths(input.artifactPaths)}
  </artifact_paths>
  <deterministic_facts>
    <changed_files>
${formatChangedFiles(input.changedFiles)}
    </changed_files>
    <verification>${formatVerification(input.verification)}</verification>
  </deterministic_facts>
  <attempt>${formatAttempt(input.attemptMetadata, input.attemptMetadataPath)}</attempt>
  <instructions>
    <instruction>Read the source issue and the workflow artifacts needed to understand what changed. Start with ${escapePromptXmlText(artifactRelativePath(input.context, "issue"))}, ${escapePromptXmlText(artifactRelativePath(input.context, "implementationPlan"))}, ${escapePromptXmlText(artifactRelativePath(input.context, "implementationLog"))}, ${escapePromptXmlText(artifactRelativePath(input.context, "readiness"))}, and ${escapePromptXmlText(artifactRelativePath(input.context, "verification"))} when present.</instruction>
    <instruction>Treat structured JSON artifacts as authoritative workflow state. Rendered Markdown companions are human-readable views only. Treat changed_files and verification above as deterministic repository facts.</instruction>
    <instruction>Author the PR content as structured fields and finish by calling submit_pr_draft. Do not write Markdown headings, return JSON text, invoke gh, or publish anything yourself.</instruction>
    <instruction>Write for a human code reviewer. Explain what changed, why, the most useful review path, verification, and risks or non-goals.</instruction>
    <instruction>Use simple technical language in simpleSummary. State what Roark did, the result, and any human action that remains.</instruction>
    <instruction>Do not invent facts, scope, tests, files, risks, or follow-up work. Empty arrays are valid when a section has nothing truthful to add.</instruction>
    <instruction>Use additionalSections only when important reviewer information does not fit the standard fields.</instruction>
    <instruction>List an issue number in additionalClosingIssueNumbers only when this PR fully completes that same-repository issue. Do not include the source issue; Roark adds it.</instruction>
  </instructions>
  <completion_contract>Call submit_pr_draft exactly once as the final action. Roark validates the object, renders the Markdown body, adds closing references and automation provenance, and invokes GitHub.</completion_contract>
</workflow_phase>`;
}

function formatSourceIssue(issue: { number: number; title: string; url?: string | undefined }): string {
  return escapePromptXmlText(`#${issue.number} ${issue.title}${issue.url ? ` (${issue.url})` : ""}`);
}

function formatArtifactPaths(paths: string[]): string {
  return paths.length > 0 ? paths.map((artifactPath) => `    <path>${escapePromptXmlText(artifactPath)}</path>`).join("\n") : "    <none />";
}

function formatChangedFiles(paths: string[]): string {
  return paths.length > 0 ? paths.map((file) => `      <file>${escapePromptXmlText(file)}</file>`).join("\n") : "      <none />";
}

function formatVerification(verification: VerificationResult | undefined): string {
  if (!verification) return "not run";
  return escapePromptXmlText(`${verification.ok ? "passed" : "failed"}: ${verification.command} (exit ${verification.exitCode})`);
}

function formatAttempt(attempt: AttemptMetadata | undefined, attemptMetadataPath: string | undefined): string {
  if (!attempt) return "not recorded";
  return escapePromptXmlText(`attempt ${attempt.attempt}; branch ${attempt.branch}; started ${attempt.startedAt}; ended ${attempt.endedAt ?? "not recorded"}${attemptMetadataPath ? `; metadata ${attemptMetadataPath}` : ""}`);
}
