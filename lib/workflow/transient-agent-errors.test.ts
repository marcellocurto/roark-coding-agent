import { describe, expect, test } from "bun:test";
import { isTransientAgentConnectionError } from "./transient-agent-errors.ts";

const transientMessages = [
  "openai-codex/gpt-5.5 failed: WebSocket closed 1006 Connection ended",
  "ECONNRESET while streaming response",
  "ETIMEDOUT waiting for provider",
  "EPIPE writing request body",
  "socket hang up",
  "fetch failed",
  "connection reset by peer",
  "connection closed before response completed",
  "gateway timeout",
  "service unavailable",
];

const nonTransientMessages = [
  "quota exhausted",
  "invalid api key",
  "unauthorized",
  "model not found: openai-codex/gpt-5.5",
  "Git working tree has changes outside .roark. Commit/stash them or pass --yes.",
  "triage failed output contract: artifact is empty",
];

describe("isTransientAgentConnectionError", () => {
  for (const message of transientMessages) {
    test(`matches transient error: ${message}`, () => {
      expect(isTransientAgentConnectionError(new Error(message))).toBe(true);
    });
  }

  for (const message of nonTransientMessages) {
    test(`does not match non-transient error: ${message}`, () => {
      expect(isTransientAgentConnectionError(new Error(message))).toBe(false);
    });
  }
});
