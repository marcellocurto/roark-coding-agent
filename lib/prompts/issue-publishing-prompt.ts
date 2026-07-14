import { artifactRelativePath, type WorkflowContext } from "../workflow/artifacts.ts";
import { escapePromptXmlText } from "./xml.ts";

export interface IssuePublishingPromptItem {
  planItemId: string;
  kind: "blocking" | "external-blocker" | "follow-up" | "suggestion";
  suggestedTitle: string;
  labels: string[];
}

export function issuePublishingSystemPrompt(): string {
  return "You are the Roark issue-authoring agent. Turn approved reviewer findings into structured, maintainer-friendly issue drafts. Roark owns Markdown rendering and GitHub publishing.";
}

export function issuePublishingPrompt(input: {
  context: WorkflowContext;
  sourcePlanPath?: string | undefined;
  approvalReason?: string | undefined;
  allowedItems: IssuePublishingPromptItem[];
}): string {
  const sourcePlanPath = input.sourcePlanPath ?? artifactRelativePath(input.context, "issueCurationPlan");
  const escapedSourcePlanPath = escapePromptXmlText(sourcePlanPath);
  const allowedItemsJson = escapePromptXmlText(JSON.stringify(input.allowedItems, null, 2));

  return `<workflow_phase name="author_reviewer_generated_issues">
  <role>You are the approved issue-authoring agent for Roark.</role>
  <approval_boundary>${escapePromptXmlText(input.approvalReason ?? "The user passed --yes")}. This approves publishing only the accepted plan items listed below.</approval_boundary>
  <source_of_truth>The curation plan at \`${escapedSourcePlanPath}\` is the source of truth for what may be drafted and for the facts you may use. Do not draft issues for rejected candidates, duplicate groups, plan warnings, reviewer suggestions outside the accepted plan items, or newly discovered ideas.</source_of_truth>
  <target_repo>${escapePromptXmlText(input.context.repo ?? "GitHub's current default repository")}</target_repo>
  <allowed_plan_items_json>
${allowedItemsJson}
  </allowed_plan_items_json>
  <instructions>
    <instruction>Read \`${escapedSourcePlanPath}\` and submit exactly one structured draft for every allowed planItemId above.</instruction>
    <instruction>Write the final issue title and content from the structured context in the curation plan: source issue, related PR, reviewer finding IDs, classification, evidence, impact, recommended handling, non-goals, and run artifacts.</instruction>
    <instruction>Use simple technical language in simpleSummary. Explain what the issue is, why it matters, and what should happen next.</instruction>
    <instruction>Do not copy proposedBody as final content. It is legacy display text, not machine authority.</instruction>
    <instruction>Do not invent facts, severity, requirements, labels, relationships, acceptance criteria, blockers, or implementation details. Empty arrays are valid when there is nothing truthful to add.</instruction>
    <instruction>Prefer one small vertical slice with a complete, independently verifiable outcome. For a genuinely wide migration, describe expand, migrate, and contract stages in that order.</instruction>
    <instruction>Use outcome-focused acceptance criteria. Avoid prescribed file paths, code snippets, or generic restatements.</instruction>
    <instruction>Use additionalSections only when important maintainer information does not fit the standard fields.</instruction>
    <instruction>Finish by calling submit_issue_drafts. Do not write Markdown headings, return JSON text, invoke gh, search GitHub, create relationships, or publish anything yourself.</instruction>
  </instructions>
  <completion_contract>Call submit_issue_drafts exactly once as the final action. Roark validates complete plan-item coverage, renders Markdown, checks exact-title duplicates, applies approved labels, and invokes GitHub.</completion_contract>
</workflow_phase>`;
}
