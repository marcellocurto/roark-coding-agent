import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";

export interface IssuePublishingPromptItem {
  planItemId: string;
  kind: "blocking" | "external-blocker" | "follow-up" | "suggestion";
  title: string;
  labels: string[];
}

export function issuePublishingSystemPrompt(): string {
  return "You are the Roark issue-publishing agent. Create only approved GitHub issues from the curation plan and report machine-readable results.";
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

  return `<workflow_phase name="create_issues">
  <role>You are the approved issue-publishing agent for Roark.</role>
  <approval_boundary>${input.approvalReason ?? "The user passed --yes"}. This approves publishing only the accepted plan items listed below.</approval_boundary>
  <resolved_skill>Read and follow the available \`github-issue-create\` skill before taking any GitHub mutation. Use its duplicate-search, label, body-file, parent/sub-issue, blocked-by relationship, and relationship-reporting rules.</resolved_skill>
  <source_of_truth>The curation plan at \`${sourcePlanPath}\` is the only source of truth for what may be created. Do not create issues for rejected candidates, duplicate groups, parser warnings, reviewer suggestions outside the accepted plan items, or any newly discovered idea.</source_of_truth>
  <target_repo>${input.context.repo ?? "Use gh's current default repository after preflight."}</target_repo>
  <allowed_plan_items_json>
${allowedItemsJson}
  </allowed_plan_items_json>
  <instructions>
    <instruction>Read \`${sourcePlanPath}\` and create issues only for the allowed planItemId values above.</instruction>
    <instruction>Before creating each issue, perform the duplicate search required by the resolved skill.</instruction>
    <instruction>Use the issue bodies and labels from the plan. Preserve the human-review labels (\`needs-triage\`, \`needs-human\`) and classification labels (\`external-blocker\`, \`follow-up\`, \`suggestion\`).</instruction>
    <instruction>Use body files for \`gh issue create\` rather than putting long bodies directly in shell arguments.</instruction>
    <instruction>Create approved native GitHub parent/sub-issue and blocked-by relationships only when the plan explicitly approves them; body links are not a substitute for native relationships.</instruction>
    <instruction>Report relationship creation and verification outcomes in the JSON response. Each relationship outcome must include planItemId, status, and message.</instruction>
    <instruction>Do not edit files outside temporary body files needed for publishing, and do not edit workflow artifacts. Roark will write \`${resultPath}\` from your response.</instruction>
  </instructions>
  <response_contract>Return only JSON with keys: created, failed, relationshipOutcomes. Every allowed planItemId must appear exactly once across created and failed. Each created entry must include planItemId and may include url, number, stdout. Each failed entry must include planItemId and message. Each relationshipOutcomes entry must include planItemId, status, and message, and may include relationship, targetPlanItemId, sourceIssueNumber, targetIssueNumber, or url. Do not wrap in Markdown fences.</response_contract>
</workflow_phase>`;
}
