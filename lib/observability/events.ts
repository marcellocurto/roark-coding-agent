import { DateTime, Effect, FileSystem } from "effect";
import path from "node:path";

export interface ObservabilityEvent {
  type: string;
  timestamp?: string | undefined;
  issueNumber?: string | undefined;
  attempt?: number | undefined;
  [key: string]: unknown;
}

export interface EventWriter {
  readonly eventsPath: string;
  write(event: ObservabilityEvent): Effect.Effect<void>;
}

export interface EventWriterOptions {
  warn?: ((message: string) => void) | undefined;
}

const redactedKeys = new Set([
  "args",
  "arguments",
  "result",
  "results",
  "partialResult",
  "prompt",
  "systemPrompt",
  "issueBody",
  "comments",
  "body",
  "content",
  "text",
  "delta",
  "messages",
]);

export const createEventWriter = Effect.fn("createEventWriter")(function* (
  runDir: string,
  options: EventWriterOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const eventsPath = path.join(runDir, "events.jsonl");
  const warn = options.warn ?? defaultWarn;
  const write = Effect.fn("writeRunEvent")(
    function* (event: ObservabilityEvent) {
      yield* fs.makeDirectory(runDir, { recursive: true });
      const sanitized = sanitizeEvent({
        timestamp: DateTime.formatIso(yield* DateTime.now),
        ...event,
      });
      yield* fs.writeFileString(eventsPath, `${JSON.stringify(sanitized)}\n`, {
        flag: "a",
      });
    },
    Effect.catch((error) =>
      Effect.sync(() => {
        warn(`observability event write failed: ${error.message}`);
      }),
    ),
    Effect.uninterruptible,
  );
  return { eventsPath, write } satisfies EventWriter;
});

export function sanitizeEvent(event: ObservabilityEvent): ObservabilityEvent {
  const sanitized: ObservabilityEvent = { type: event.type };
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    if (redactedKeys.has(key)) continue;
    sanitized[key] = sanitizeValue(key, value);
  }
  return sanitized;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const maxLength = key.toLowerCase().includes("error") ? 1000 : 500;
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(key, item));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (redactedKeys.has(childKey)) continue;
      output[childKey] = sanitizeValue(childKey, childValue);
    }
    return output;
  }
  return value;
}

function defaultWarn(message: string): void {
  console.warn(`! ${message}`);
}
