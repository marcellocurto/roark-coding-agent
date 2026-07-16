import type { ChangeReport } from "../change-report/result.ts";
import type { AgentRunRequest } from "../workflow/agent-runner.ts";

export function changeReport(overrides: Partial<ChangeReport> = {}): ChangeReport {
  return {
    summary: "Completed the requested change.",
    changedFiles: [{ path: "lib/example.ts", description: "Implemented the requested behavior." }],
    validation: [{ command: "bun test", status: "passed", details: "Focused tests passed." }],
    deviations: [],
    addressedFindingIds: [],
    remainingConcerns: [],
    ...overrides,
  };
}

export async function submitChangeReport(request: AgentRunRequest, report: ChangeReport): Promise<string> {
  const tool = request.customTools?.find((candidate) => candidate.name === "submit_change_report");
  if (!tool) throw new Error("Request did not expose submit_change_report.");
  await tool.execute("test-submit-change-report", report, undefined, undefined, {} as never);
  return "";
}
