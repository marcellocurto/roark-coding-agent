import type { ThinkingLevel } from "../cli/args.ts";
import type { RunObserver } from "../observability/observer.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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
  customTools?: ToolDefinition[] | undefined;
}

export type AgentRunner = (request: AgentRunRequest) => Promise<string>;
