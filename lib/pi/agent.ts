import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  type ResourceDiagnostic,
  SessionManager,
  type Skill,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export const defaultRoarkModel = "openai-codex/gpt-5.5";
export const roarkPiSettings = {
  transport: "sse" as const,
  retry: { enabled: true, maxRetries: 2 },
};

const readOnlyTools = ["read", "bash", "grep", "find", "ls"];
const writableTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export function buildRoarkResourceLoaderSecurityOptions(skillPaths: readonly string[] = []) {
  return {
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    additionalSkillPaths: [...skillPaths],
  };
}

export async function runPiAgent(options: AgentRunRequest): Promise<string> {
  const modelSpec = requestedModelSpec(options.model);
  console.log(`model: ${modelSpec}`);
  console.log(`thinking: ${options.thinkingLevel}`);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = resolveModel(modelRegistry, modelSpec);
  const settingsManager = SettingsManager.inMemory(roarkPiSettings);

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    ...buildRoarkResourceLoaderSecurityOptions(options.skillPaths),
    appendSystemPromptOverride: (base) => [
      ...base,
      options.systemPrompt,
      "Do not edit files under .roark unless the user explicitly asks. For workflow artifacts, return the requested Markdown in your final assistant message instead.",
    ],
  });
  await loader.reload();
  const loadedSkills = loader.getSkills();
  assertNoResourceLoadErrors(loadedSkills.diagnostics, "skill");
  assertRequestedSkillsLoaded(loadedSkills.skills, options.skillPaths ?? [], loadedSkills.diagnostics);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: options.thinkingLevel,
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
    const agentError = extractAgentErrorMessage(session.messages);
    if (agentError) throw new Error(agentError);
    return extractLastAssistantText(session.messages) || streamedText.trim();
  } finally {
    session.dispose();
  }
}

export function requestedModelSpec(explicitModel?: string): string {
  return explicitModel ?? defaultRoarkModel;
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

export function assertNoResourceLoadErrors(diagnostics: readonly ResourceDiagnostic[], resourceType: string): void {
  const failures = diagnostics.filter((diagnostic) => diagnostic.type === "error" || diagnostic.type === "collision");
  if (failures.length === 0) return;

  const details = formatResourceDiagnostics(failures);
  throw new Error(`Pi ${resourceType} loading failed: ${details}`);
}

export function assertRequestedSkillsLoaded(
  loadedSkills: readonly Skill[],
  requestedSkillPaths: readonly string[],
  diagnostics: readonly ResourceDiagnostic[] = [],
): void {
  if (requestedSkillPaths.length === 0) return;

  const missing = requestedSkillPaths.filter((skillPath) => !loadedSkills.some((skill) => skillLoadedFromPath(skill, skillPath)));
  if (missing.length === 0) return;

  const relevantDiagnostics = diagnostics.filter((diagnostic) => diagnostic.path && missing.some((skillPath) => isSameOrWithin(diagnostic.path!, skillPath)));
  const diagnosticDetails = relevantDiagnostics.length > 0 ? ` Diagnostics: ${formatResourceDiagnostics(relevantDiagnostics)}` : "";
  throw new Error(`Pi skill loading failed: requested skill path(s) did not load: ${missing.join(", ")}.${diagnosticDetails}`);
}

function formatResourceDiagnostics(diagnostics: readonly ResourceDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`)
    .join("; ");
}

function skillLoadedFromPath(skill: Skill, requestedPath: string): boolean {
  return isSameOrWithin(skill.filePath, requestedPath) || isSameOrWithin(skill.baseDir, requestedPath);
}

function isSameOrWithin(candidatePath: string, parentPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const parent = path.resolve(parentPath);
  if (candidate === parent) return true;
  const parentWithSeparator = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate.startsWith(parentWithSeparator);
}

export function extractAgentErrorMessage(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; stopReason?: string; errorMessage?: unknown; provider?: string; model?: string };
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "error" && !message.errorMessage) continue;

    const providerModel = [message.provider, message.model].filter(Boolean).join("/");
    const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : "agent provider returned an error without a message";
    return providerModel ? `${providerModel} failed: ${detail}` : detail;
  }
  return undefined;
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
