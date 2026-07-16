import { presenter, type AgentDisplayContext, type Presenter } from "../presentation/presenter.ts";
import { summarizeToolCall } from "./tool-log.ts";

export type AgentPresentationEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; args: unknown; startedAt?: number | undefined }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; endedAt?: number | undefined };

export interface CompletedToolRun {
  args: unknown;
  durationMs: number;
}

export class ToolRunTracker {
  private readonly starts = new Map<string, { args: unknown; startedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  start(toolCallId: string, args: unknown, startedAt = this.now()): void {
    this.starts.set(toolCallId, { args, startedAt });
  }

  complete(toolCallId: string, endedAt = this.now()): CompletedToolRun | undefined {
    const started = this.starts.get(toolCallId);
    this.starts.delete(toolCallId);
    if (!started) return undefined;
    return { args: started.args, durationMs: Math.max(0, endedAt - started.startedAt) };
  }
}

/** Collects the exact assistant response independently from its terminal presentation. */
export class AgentOutputCollector {
  private streamedText = "";

  constructor(
    private readonly display: AgentDisplayContext,
    private readonly presentation: Presenter = presenter(),
    private readonly now: () => number = Date.now,
    private readonly pathRoots: readonly string[] = [],
    private readonly tools: ToolRunTracker = new ToolRunTracker(now),
  ) {}

  event(event: AgentPresentationEvent): CompletedToolRun | undefined {
    if (event.type === "text_delta") {
      this.streamedText += event.delta;
      return undefined;
    }
    if (event.type === "tool_start") {
      this.tools.start(event.toolCallId, event.args, event.startedAt ?? this.now());
      return undefined;
    }

    const completed = this.tools.complete(event.toolCallId, event.endedAt ?? this.now());
    this.presentation.activity(this.display, summarizeToolCall(event.toolName, completed?.args, this.pathRoots), {
      failed: event.isError,
      durationMs: completed?.durationMs ?? 0,
    });
    return completed;
  }

  finish(collectedResponse?: string): string {
    const response = collectedResponse === undefined || collectedResponse === "" ? this.streamedText.trim() : collectedResponse;
    this.presentation.verboseAgentResponse(response);
    return response;
  }
}
