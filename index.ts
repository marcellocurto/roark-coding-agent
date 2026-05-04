#!/usr/bin/env bun
import { AuthStorage, createAgentSession, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";

export async function runPiAgent(prompt: string) {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find("openai-codex", "gpt-5.5");

  if (!model) {
    throw new Error("OpenAI Codex model not found");
  }

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "xhigh",
    settingsManager: SettingsManager.inMemory(),
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(prompt);
    console.log("\n\n--- messages ---");
    session.messages.forEach((msg) => console.log(msg));
    console.log();
  } finally {
    session.dispose();
  }
}

if (import.meta.main) {
  const prompt = Bun.argv.slice(2).join(" ") || "What files are in the current directory?";
  await runPiAgent(prompt);
}
