import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

const readOnlyTools = ["read", "bash", "grep", "find", "ls"];
const writableTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export async function runPiAgent(options: AgentRunRequest): Promise<string> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = options.model ? resolveModel(modelRegistry, options.model) : undefined;
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 2 },
  });

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    appendSystemPromptOverride: (base) => [
      ...base,
      options.systemPrompt,
      "Do not edit files under .roark unless the user explicitly asks. For workflow artifacts, return the requested Markdown in your final assistant message instead.",
    ],
  });
  await loader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "xhigh",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager,
    tools: options.writable ? writableTools : readOnlyTools,
  });

  if (modelFallbackMessage) console.log(`! ${modelFallbackMessage}`);

  let streamedText = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      streamedText += delta;
      process.stdout.write(delta);
    }
    if (event.type === "tool_execution_start") {
      process.stdout.write(`\n[tool:${event.toolName}]\n`);
    }
  });

  try {
    await session.prompt(options.prompt, { expandPromptTemplates: false });
    return extractLastAssistantText(session.messages) || streamedText.trim();
  } finally {
    session.dispose();
  }
}

function resolveModel(modelRegistry: ModelRegistry, spec: string) {
  const separator = spec.includes("/") ? "/" : spec.includes(":") ? ":" : undefined;
  if (!separator) throw new Error(`Invalid --model '${spec}'. Use provider/model or provider:model.`);

  const [provider, ...idParts] = spec.split(separator);
  const id = idParts.join(separator);
  if (!provider || !id) throw new Error(`Invalid --model '${spec}'. Use provider/model or provider:model.`);
  const model = modelRegistry.find(provider, id);
  if (!model) throw new Error(`Model not found: ${spec}`);
  return model;
}

function extractLastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    return extractTextContent(message.content).trim();
  }
  return "";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return String(part.text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
