import type { ThinkingLevel } from "../cli/args.ts";

export type AgentRunRequest = {
  cwd: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  writable: boolean;
};

export type AgentRunner = (request: AgentRunRequest) => Promise<string>;
