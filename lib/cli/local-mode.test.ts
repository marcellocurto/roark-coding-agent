import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkflowContext, writeArtifact } from "../workflow/artifacts.ts";
import {
  formatDoLocalModeStartMessage,
  printDoLocalModeReadyMessageIfReady,
} from "./local-mode.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("do local/manual mode messaging", () => {
  test("announces that do mode does not perform managed publishing actions", () => {
    const message = formatDoLocalModeStartMessage("29");

    expect(message).toContain("Local/manual do mode");
    expect(message).toContain("will not create/switch branches");
    expect(message).toContain("claim");
    expect(message).toContain("push");
    expect(message).toContain("open a PR");
    expect(message).toContain("bun run auto 29");
  });

  test("prints ready-for-pr reminder after local do mode", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "roark-local-mode-"));
    tempDirs.push(cwd);
    const context = createWorkflowContext({
      command: "do",
      issue: "29",
      cwd,
      outDir: ".roark/runs",
      force: false,
      yes: false,
      maxFixPasses: 1,
    });
    await writeArtifact(context, "readiness", "# PR Readiness\n\n## Status\nready-for-pr\n");

    const logs: string[] = [];
    await printDoLocalModeReadyMessageIfReady(context, (message) => logs.push(message));

    expect(logs.join("\n")).toContain("no PR was opened because this was local/manual do mode");
  });
});
