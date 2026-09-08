import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect } from "effect";
import { runCli } from "../../../roark.ts";
import { runVerificationPromise } from "../../autorun/verification.ts";
import { applicationLayer } from "../../runtime/application.ts";

// Run in a separate process so the test can send real OS signals to the runtime.
BunRuntime.runMain(runCli(["do", "1"], {
  execute: async (_argv, application) => {
    await runVerificationPromise({
      command: "sleep 30 & echo $! > child.pid; wait",
      cwd: process.cwd(),
    }, application);
  },
  notify: () => Effect.void,
}).pipe(Effect.provide(applicationLayer)));
