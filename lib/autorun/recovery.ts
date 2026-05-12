import { AgentTaskRunError } from "../workflow/tasks.ts";
import { isTransientAgentConnectionError } from "../workflow/transient-agent-errors.ts";

export interface ContinueCommandInput {
  issueNumber: number | string;
  cwd?: string | undefined  ;
  repo?: string | undefined  ;
  attempt?: number | undefined;
  yes?: boolean | undefined;
}

export function formatContinueCommand(input: ContinueCommandInput): string {
  return formatContinueArgs(input).map(shellQuote).join(" ");
}

export function formatPublicContinueCommand(input: Omit<ContinueCommandInput, "cwd">): string {
  return formatContinueArgs(input).map(shellQuote).join(" ");
}

function formatContinueArgs(input: ContinueCommandInput): string[] {
  const args = ["roark", "continue", String(input.issueNumber)];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.repo) args.push("--repo", input.repo);
  if (input.attempt !== undefined) args.push("--attempt", String(input.attempt));
  if (input.yes === true) args.push("--yes");
  return args;
}

export function shouldRecoverWithYes(error: unknown): boolean {
  return error instanceof AgentTaskRunError &&
    error.phase === "agent-error" &&
    isWritableAgentArtifact(error) &&
    isTransientAgentConnectionError(error.originalMessage);
}

function isWritableAgentArtifact(error: AgentTaskRunError): boolean {
  const artifact = error.artifact;
  return artifact === "implementationLog" || (typeof artifact !== "string" && artifact.name === "fixLog");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
