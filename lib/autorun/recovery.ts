import { AgentTaskRunError } from "../workflow/tasks.ts";
import { isTransientAgentConnectionError } from "../workflow/transient-agent-errors.ts";

export type ContinueCommandInput = {
  issueNumber: number | string;
  cwd?: string;
  repo?: string;
  attempt?: number;
  yes?: boolean;
};

export function formatContinueCommand(input: ContinueCommandInput): string {
  const args = ["roark", "continue", String(input.issueNumber)];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.repo) args.push("--repo", input.repo);
  if (input.attempt !== undefined) args.push("--attempt", String(input.attempt));
  if (input.yes) args.push("--yes");
  return args.map(shellQuote).join(" ");
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
