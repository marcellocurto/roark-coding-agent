import { Effect, FileSystem } from "effect";
import path from "node:path";
import { runProcessOrThrow } from "../cli/process.ts";
import {
  artifactExists,
  readArtifact,
  type WorkflowContext,
} from "../workflow/artifacts.ts";
import {
  parsePreImplementationBaseline,
  resetWorktreeToPreImplementationBaseline,
} from "../workflow/git.ts";
import { continuationHistoryDir } from "./checkpoint.ts";

export const backupRestartWork = Effect.fn("backupRestartWork")(function* (
  context: WorkflowContext,
  id: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(continuationHistoryDir(context, id), "workspace");
  yield* fs.makeDirectory(directory, { recursive: true });
  const head = (yield* runProcessOrThrow(["git", "rev-parse", "HEAD"], {
    cwd: context.agentCwd,
  })).trim();
  const baseline = (yield* artifactExists(context, "preImplementationBaseline"))
    ? (yield* parsePreImplementationBaseline(
        yield* readArtifact(context, "preImplementationBaseline"),
      )).head
    : head;
  yield* runProcessOrThrow(["git", "cat-file", "-e", `${baseline}^{commit}`], {
    cwd: context.agentCwd,
  });
  const ref = `refs/roark/restarts/issue-${context.issueNumber}/attempt-${context.attempt ?? 0}/${id}`;
  yield* runProcessOrThrow(["git", "update-ref", ref, head], {
    cwd: context.agentCwd,
  });
  for (const [filename, args] of [
    ["staged.patch", ["--cached"]],
    ["unstaged.patch", []],
  ] as const) {
    const patch = yield* runProcessOrThrow(
      ["git", "diff", "--binary", ...args, "--", ".", ":(exclude).roark"],
      { cwd: context.agentCwd },
    );
    yield* fs.writeFileString(path.join(directory, filename), patch);
  }
  const untracked = yield* runProcessOrThrow(
    [
      "git",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).roark",
    ],
    { cwd: context.agentCwd },
  );
  for (const filename of untracked.split("\0").filter(Boolean)) {
    const target = path.join(directory, "untracked", filename);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.copy(path.join(context.agentCwd, filename), target);
  }
  yield* fs.writeFileString(
    path.join(directory, "backup.json"),
    JSON.stringify({ head, baseline, ref }, null, 2),
  );
  return baseline;
});
export const restoreRestartBaseline = Effect.fn("restoreRestartBaseline")(
  function* (context: WorkflowContext, head: string) {
    // Keep .roark and ignored configuration files. The backup retains the old
    // commit, staged/unstaged patches, and untracked files before moving the branch.
    yield* runProcessOrThrow(["git", "reset", "--soft", head], {
      cwd: context.agentCwd,
    });
    yield* resetWorktreeToPreImplementationBaseline({
      cwd: context.agentCwd,
      baseline: { head, capturedAt: "restart", excludes: [".roark"] },
    });
  },
);
