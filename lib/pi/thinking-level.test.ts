import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { thinkingLevels } from "../cli/args.ts";
import { resolveThinkingLevel } from "./thinking-level.ts";

const registry = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});

function model(provider: string, id: string) {
  const resolved = registry.getModel(provider, id);
  if (!resolved)
    throw new Error(`test model missing from Pi catalog: ${provider}/${id}`);
  return resolved;
}

describe("thinking level resolution", () => {
  test.each([...thinkingLevels])(
    "serializes Astra %s to a supported provider effort",
    async (requested) => {
      const astra = model("openai-codex", "gpt-6-astra");
      const resolution = resolveThinkingLevel(astra, requested);
      if (resolution.effective === "off")
        throw new Error("Astra requires reasoning");
      let payload: unknown;
      const tokenPayload = Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
        }),
      ).toString("base64url");
      const response = await streamSimple(
        astra,
        {
          messages: [
            { role: "user", content: "Inspect the change.", timestamp: 0 },
          ],
        },
        {
          apiKey: `test.${tokenPayload}.test`,
          reasoning: resolution.effective,
          transport: "sse",
          onPayload: (body) => {
            payload = body;
            // Stop before transport: exercise the shipped serializer without an API call.
            throw new Error("request inspected");
          },
        },
      ).result();

      expect(response.errorMessage).toBe("request inspected");
      expect(payload).toMatchObject({
        model: "gpt-6-astra",
        reasoning: {
          effort:
            requested === "off" || requested === "minimal" ? "low" : requested,
        },
      });
      expect(payload).not.toHaveProperty("temperature");
      expect(payload).not.toHaveProperty("prompt_cache_retention");
    },
  );

  test("keeps max for a model that supports it", () => {
    expect(
      resolveThinkingLevel(model("openai-codex", "gpt-6-astra"), "max"),
    ).toMatchObject({
      requested: "max",
      effective: "max",
      clamped: false,
    });
  });

  test("clamps unsupported max to the highest supported level", () => {
    expect(
      resolveThinkingLevel(model("openai-codex", "gpt-5.5"), "max"),
    ).toMatchObject({
      requested: "max",
      effective: "xhigh",
      clamped: true,
    });
  });
});
