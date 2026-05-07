import type { ThinkingLevel } from "../cli/args.ts";

export type AgentRunRequest = {
  cwd: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  writable: boolean;
  skillPaths?: string[];
  observer?: import("../observability/observer.ts").RunObserver;
  phase?: string;
};

export type AgentRunner = (request: AgentRunRequest) => Promise<string>;
