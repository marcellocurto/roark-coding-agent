import { describe, expect, test } from "bun:test";
import { configurePresenter, type AgentDisplayContext } from "./presenter.ts";
import { runPresentedPhase } from "./phase.ts";

const display: AgentDisplayContext = {
  command: "do",
  target: "#1",
  phaseId: "test",
  phaseLabel: "Test phase",
  operation: "verify",
};

describe("runPresentedPhase", () => {
  test("presents successful and failed completion consistently", async () => {
    let output = "";
    configurePresenter({ stream: { isTTY: false, write(chunk) { output += chunk; } } });
    try {
      await runPresentedPhase(display, () => Promise.resolve("done"), (outcome) => ({ outcome, artifact: "result.md" }));
      expect(runPresentedPhase(display, () => Promise.reject(new Error("broken")), () => ({}))).rejects.toThrow("broken");
      expect(output).toContain("DONE #1 · Test phase · done");
      expect(output).toContain("artifact: result.md");
      expect(output).toContain("FAILED #1 · Test phase · broken");
    } finally {
      configurePresenter({});
    }
  });
});
