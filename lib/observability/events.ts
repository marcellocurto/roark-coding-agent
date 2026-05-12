import { appendFile, mkdir } from "node:fs/promises";
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
  write(event: ObservabilityEvent): Promise<void>;
}

export interface EventWriterOptions {
  now?: (() => Date) | undefined;
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

export function createEventWriter(runDir: string, options: EventWriterOptions = {}): EventWriter {
  const eventsPath = path.join(runDir, "events.jsonl");
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? defaultWarn;

  return {
    eventsPath,
    async write(event) {
      try {
        await mkdir(runDir, { recursive: true });
        const sanitized = sanitizeEvent({ timestamp: now().toISOString(), ...event });
        await appendFile(eventsPath, `${JSON.stringify(sanitized)}\n`, "utf8");
      } catch (error) {
        warn(`observability event write failed: ${formatError(error)}`);
      }
    },
  };
}

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
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item));
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
