import { describe, expect, test } from "bun:test";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveThinkingLevel } from "./thinking-level.ts";

const registry = ModelRegistry.create(AuthStorage.create());

function model(provider: string, id: string) {
  const resolved = registry.find(provider, id);
  if (!resolved) throw new Error(`test model missing from Pi catalog: ${provider}/${id}`);
  return resolved;
}

describe("thinking level resolution", () => {
  test("keeps max for a model that supports it", () => {
    expect(resolveThinkingLevel(model("openai-codex", "gpt-5.6-sol"), "max")).toMatchObject({
      requested: "max",
      effective: "max",
      clamped: false,
    });
  });

  test("clamps unsupported max to the highest supported level", () => {
    expect(resolveThinkingLevel(model("openai-codex", "gpt-5.5"), "max")).toMatchObject({
      requested: "max",
      effective: "xhigh",
      clamped: true,
    });
  });
});
