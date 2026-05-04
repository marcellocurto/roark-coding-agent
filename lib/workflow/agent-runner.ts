export type AgentRunRequest = {
  cwd: string;
  model?: string;
  systemPrompt: string;
  prompt: string;
  writable: boolean;
};

export type AgentRunner = (request: AgentRunRequest) => Promise<string>;
