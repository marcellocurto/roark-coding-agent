import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";
import type { AttemptMetadata } from "../autorun/attempts.ts";
import type { VerificationResult } from "../autorun/verification.ts";
import type { FormatPrBodyFollowUpIssue } from "../autorun/publish.ts";

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
}

export interface PrBodyUpdatePromptInput extends PrPublishingPromptInput {
  prUrl: string;
  followUpIssues?: FormatPrBodyFollowUpIssue[] | undefined;
}

export function prPublishingSystemPrompt(): string {
  return "You are the Roark PR authoring and publishing agent. Turn workflow artifacts into a reviewer-friendly pull request, create or update it with gh, and report machine-readable results.";
}

export function prCreatePrompt(input: PrPublishingPromptInput): string {
  return `<workflow_phase name="create_pull_request">
  <role>You are the approved PR authoring and publishing agent for Roark.</role>
  <source_issue>${formatSourceIssue(input.sourceIssue)}</source_issue>
  <target_repo>${input.repo ?? "Use gh's current default repository after preflight."}</target_repo>
  <branch>${input.branchName}</branch>
  <base_branch>${input.baseBranch}</base_branch>
  <run_directory>${input.context.runDirRelative}</run_directory>
  <artifact_paths>
${formatArtifactPaths(input.artifactPaths)}
  </artifact_paths>
  <verification>${formatVerification(input.verification)}</verification>
  <attempt>${formatAttempt(input.attemptMetadata, input.attemptMetadataPath)}</attempt>
  <instructions>
    <instruction>Preflight gh, authentication, and target repository before creating the PR.</instruction>
    <instruction>Read the source issue and workflow artifacts needed to understand what changed. Start with ${artifactRelativePath(input.context, "issue")}, ${artifactRelativePath(input.context, "implementationPlan")}, ${artifactRelativePath(input.context, "implementationLog")}, ${artifactRelativePath(input.context, "readiness")}, and ${artifactRelativePath(input.context, "verification")} when present.</instruction>
    <instruction>Write the final PR title and body yourself. Do not copy a deterministic PR body template or artifact dump as the final body.</instruction>
    <instruction>Before the regular PR body sections, add a top-level \`## Simple summary\` section for a busy maintainer. Use simple technical language and explain what Roark did, what happened, what changed, the result, and what the human should do next if anything.</instruction>
    <instruction>Write for a human code reviewer. Lead with what changed, why it changed, how to review it, verification, and risks/non-goals. Put automation details and artifact links at the bottom in a collapsed details block.</instruction>
    <instruction>Do not invent facts, scope, tests, files, risks, or follow-up work. If the artifacts are thin, say so plainly and keep the body concise.</instruction>
    <instruction>Add a standalone \`Closes #${input.sourceIssue.number}\` line for the source issue. Add one standalone \`Closes #N\` line for every additional same-repository issue that the implementation actually completes and that is supported by the source issue or workflow artifacts.</instruction>
    <instruction>Keep closing references outside code blocks and collapsed details so GitHub recognizes them. Do not close parent, blocker, dependency, contextual, or follow-up issues unless this PR actually completes them.</instruction>
    <instruction>Create the PR with gh using base ${input.baseBranch} and head ${input.branchName}. Use a body file or safe shell quoting for the authored body.</instruction>
  </instructions>
  <suggested_body_structure>Summary; What changed; How to review; Verification; Risks / non-goals; Follow-up issues; Automation details.</suggested_body_structure>
  <response_contract>Return only JSON with keys: url, title, number, stdout. url is required when creation succeeds. number is optional. Do not wrap in Markdown fences.</response_contract>
</workflow_phase>`;
}

export function prBodyUpdatePrompt(input: PrBodyUpdatePromptInput): string {
  return `<workflow_phase name="update_pull_request_body">
  <role>You are the approved PR body update agent for Roark.</role>
  <pull_request>${input.prUrl}</pull_request>
  <source_issue>${formatSourceIssue(input.sourceIssue)}</source_issue>
  <target_repo>${input.repo ?? "Use gh's current default repository after preflight."}</target_repo>
  <run_directory>${input.context.runDirRelative}</run_directory>
  <follow_up_issues>
${formatFollowUpIssues(input.followUpIssues)}
  </follow_up_issues>
  <artifact_paths>
${formatArtifactPaths(input.artifactPaths)}
  </artifact_paths>
  <verification>${formatVerification(input.verification)}</verification>
  <attempt>${formatAttempt(input.attemptMetadata, input.attemptMetadataPath)}</attempt>
  <instructions>
    <instruction>Fetch the current PR title/body with gh before editing.</instruction>
    <instruction>Preserve the existing human-authored PR explanation unless it is clearly stale according to the workflow artifacts.</instruction>
    <instruction>Before the regular PR body sections, add or update a top-level \`## Simple summary\` section for a busy maintainer. Use simple technical language and explain what Roark did, what happened, what changed, the result, and what the human should do next if anything.</instruction>
    <instruction>Update the Follow-up issues section with the follow-up issues listed above. If there are none, state that none were created at PR creation time.</instruction>
    <instruction>Preserve or add a standalone \`Closes #${input.sourceIssue.number}\` line for the source issue. Preserve or add one standalone \`Closes #N\` line for every additional same-repository issue that the implementation actually completes according to the source issue or workflow artifacts.</instruction>
    <instruction>Keep closing references outside code blocks and collapsed details so GitHub recognizes them. Never use closing references for parent, blocker, dependency, contextual, or follow-up issues unless this PR actually completes them.</instruction>
    <instruction>Update or add collapsed automation details for current run metadata, verification, ledger comments, and key workflow artifacts.</instruction>
    <instruction>Do not replace the PR body with a deterministic template or artifact dump.</instruction>
    <instruction>Edit the PR body with gh. Use a body file or safe shell quoting for the updated body.</instruction>
  </instructions>
  <response_contract>Return only JSON with keys: updated, message. updated must be true when the PR edit succeeds. Do not wrap in Markdown fences.</response_contract>
</workflow_phase>`;
}

function formatSourceIssue(issue: { number: number; title: string; url?: string | undefined }): string {
  return `#${issue.number} ${issue.title}${issue.url ? ` (${issue.url})` : ""}`;
}

function formatArtifactPaths(paths: string[]): string {
  return paths.length > 0 ? paths.map((artifactPath) => `    <path>${artifactPath}</path>`).join("\n") : "    <none />";
}

function formatVerification(verification: VerificationResult | undefined): string {
  if (!verification) return "not run";
  return `${verification.ok ? "passed" : "failed"}: ${verification.command} (exit ${verification.exitCode})`;
}

function formatAttempt(attempt: AttemptMetadata | undefined, attemptMetadataPath: string | undefined): string {
  if (!attempt) return "not recorded";
  return `attempt ${attempt.attempt}; branch ${attempt.branch}; started ${attempt.startedAt}; ended ${attempt.endedAt ?? "not recorded"}${attemptMetadataPath ? `; metadata ${attemptMetadataPath}` : ""}`;
}

function formatFollowUpIssues(issues: FormatPrBodyFollowUpIssue[] | undefined): string {
  if (!issues || issues.length === 0) return "    <none />";
  return issues.map((issue) => {
    const label = issue.number !== undefined ? `#${issue.number}` : issue.title;
    return `    <issue>${label}${issue.url ? ` ${issue.url}` : ""}</issue>`;
  }).join("\n");
}
