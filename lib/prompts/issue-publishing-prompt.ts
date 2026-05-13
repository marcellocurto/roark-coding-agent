import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";

export interface IssuePublishingPromptItem {
  planItemId: string;
  kind: "blocking" | "external-blocker" | "follow-up" | "suggestion";
  suggestedTitle: string;
  labels: string[];
}

export function issuePublishingSystemPrompt(): string {
  return "You are the Roark issue-authoring and issue-publishing agent. Turn approved reviewer findings into human-readable GitHub issues, create them with gh, and report machine-readable results.";
}

export function issuePublishingPrompt(input: {
  context: WorkflowContext;
  sourcePlanPath?: string | undefined;
  resultPath?: string | undefined;
  approvalReason?: string | undefined;
  allowedItems: IssuePublishingPromptItem[];
}): string {
  const sourcePlanPath = input.sourcePlanPath ?? artifactRelativePath(input.context, "issueCurationPlan");
  const resultPath = input.resultPath ?? artifactRelativePath(input.context, "issueCreationResults");
  const allowedItemsJson = JSON.stringify(input.allowedItems, null, 2);

  return `<workflow_phase name="create_reviewer_generated_issues">
  <role>You are the approved issue-authoring and issue-publishing agent for Roark.</role>
  <approval_boundary>${input.approvalReason ?? "The user passed --yes"}. This approves publishing only the accepted plan items listed below.</approval_boundary>
  <source_of_truth>The curation plan at \`${sourcePlanPath}\` is the source of truth for what may be created and for the facts you may use. Do not create issues for rejected candidates, duplicate groups, parser warnings, reviewer suggestions outside the accepted plan items, or any newly discovered idea.</source_of_truth>
  <target_repo>${input.context.repo ?? "Use gh's current default repository after preflight."}</target_repo>
  <allowed_plan_items_json>
${allowedItemsJson}
  </allowed_plan_items_json>
  <issue_authoring_instructions>
    <instruction>Read \`${sourcePlanPath}\` and create issues only for the allowed planItemId values above.</instruction>
    <instruction>For each allowed item, write the final GitHub issue title and body yourself from the structured context in the curation plan: source issue, related PR, reviewer finding IDs, classification, evidence, impact, recommended handling, non-goals, and run artifacts.</instruction>
    <instruction>Do not copy the plan's proposedBody as the final body. Treat proposedBody, if present, only as legacy fallback context. The created GitHub issue should read like a maintainer-authored issue, not a stitched artifact dump.</instruction>
    <instruction>Do not invent facts, severity, requirements, labels, relationships, acceptance criteria, or implementation details. If the evidence is limited, say so plainly and keep the scope narrow.</instruction>
    <instruction>Use a concise, action-oriented title. The allowed item suggestedTitle is a starting point; improve it if a clearer title is obvious from the plan context.</instruction>
    <instruction>Use this body structure unless the finding clearly needs a small adjustment: Summary, Why this issue exists, Impact, Suggested fix, Acceptance criteria, Risks / non-goals, Context. Put source issue, related PR, reviewer finding IDs, classification, and run artifacts in Context near the bottom.</instruction>
    <instruction>Acceptance criteria must be specific to the finding. Avoid generic criteria like “address the behavior” unless the plan lacks enough detail to be more specific.</instruction>
    <instruction>Keep run artifacts collapsed in a details block when included. They are provenance, not the main issue.</instruction>
  </issue_authoring_instructions>
  <publishing_instructions>
    <instruction>Preflight gh, authentication, and target repository before creating issues.</instruction>
    <instruction>Before creating each issue, search likely duplicates using 2-4 distinctive nouns from the final title. If a likely duplicate exists, do not create a duplicate; report that plan item as failed with the duplicate URL in the message.</instruction>
    <instruction>Create each issue with the final title, the authored body, and the allowed labels for that plan item. Preserve the human-review labels (\`needs-triage\`, \`needs-human\`) and classification labels (\`external-blocker\`, \`follow-up\`, \`suggestion\`).</instruction>
    <instruction>Use body files or safe shell quoting for long issue bodies.</instruction>
    <instruction>Create native GitHub parent/sub-issue or blocked-by relationships only if the curation plan explicitly approves them. Body links are not a substitute for native relationships.</instruction>
    <instruction>Do not edit files outside temporary body files needed for publishing, and do not edit workflow artifacts. Roark will write \`${resultPath}\` from your response.</instruction>
  </publishing_instructions>
  <response_contract>Return only JSON with keys: created, failed, relationshipOutcomes. Every allowed planItemId must appear exactly once across created and failed. Each created entry must include planItemId and may include title, url, number, stdout. Each failed entry must include planItemId and message. Each relationshipOutcomes entry must include planItemId, status, and message, and may include relationship, targetPlanItemId, sourceIssueNumber, targetIssueNumber, or url. Do not wrap in Markdown fences.</response_contract>
</workflow_phase>`;
}
