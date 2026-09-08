import assert from "node:assert/strict";
import { Effect } from "effect";
import { parseVerificationArtifact, runVerification, writeVerificationArtifact } from "../../lib/autorun/verification.ts";
import { applicationLayer } from "../../lib/runtime/application.ts";
import { createWorkflowContext, readArtifact } from "../../lib/workflow/artifacts.ts";

process.env["CI"] = "1";
const cwd = process.cwd();
const context = createWorkflowContext({
  command: "do",
  issue: "1",
  cwd,
  outDir: ".roark/runs",
  force: false,
  yes: false,
  maxFixPasses: 1,
});

const timedOut = await Effect.runPromise(Effect.gen(function*() {
  const passed = yield* runVerification({ command: "printf installed-output", cwd });
  assert.equal(passed.ok, true);
  assert.equal(passed.stdout, "installed-output");

  const failed = yield* runVerification({ command: "printf installed-error >&2; exit 7", cwd });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderr, "installed-error");

  const result = yield* runVerification({ command: "printf before-timeout; sleep 30", cwd, timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 137);
  assert.equal(result.stdout, "before-timeout");
  return result;
}).pipe(Effect.provide(applicationLayer)));

await writeVerificationArtifact(context, timedOut);
const persisted = parseVerificationArtifact(await readArtifact(context, "verification"));
assert(persisted, "Installed verification must produce a readable artifact");
assert.equal(persisted.timedOut, true);
assert.match(await readArtifact(context, "verificationFull"), /before-timeout/);
