import type { ThinkingLevel } from "../cli/args.ts";
import type { RunObserver } from "../observability/observer.ts";

export interface AgentRunRequest {
  cwd: string;
  model?: string | undefined  ;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  fileEditingToolsEnabled: boolean;
  skillPaths?: string[] | undefined;
  observer?: RunObserver | undefined;
  phase?: string | undefined;
}

export type AgentRunner = (request: AgentRunRequest) => Promise<string>;
