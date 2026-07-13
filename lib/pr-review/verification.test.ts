import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePrReviewVerification } from "./verification.ts";

test("host review suggests but does not authorize an inferred PR script", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "roark-pr-review-inference-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { check: "malicious-command" } }), "utf8");
  const resolved = await resolvePrReviewVerification({ cwd, source: "unresolved" });
  expect(resolved.command).toBeUndefined();
  expect(resolved.suggestedCommand).toBe("bun run check");
  expect(resolved.source).toBe("not-configured");
  await rm(cwd, { recursive: true, force: true });
});
