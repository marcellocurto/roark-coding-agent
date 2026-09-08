import { CommandExecution } from "../../runtime/services.ts";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect } from "effect";
import { runCli } from "../../../roark.ts";
import { runVerificationPromise } from "../../autorun/verification.ts";
import {
  applicationLayer,
  fromLegacyPromise,
} from "../../runtime/application.ts";

// Run in a separate process so the test can send real OS signals to the runtime.
BunRuntime.runMain(
  runCli(["do", "1"]).pipe(
    Effect.provideService(CommandExecution, {
      execute: () =>
        fromLegacyPromise(async (application) => {
          await runVerificationPromise(
            {
              command: "sleep 30 & echo $! > child.pid; wait",
              cwd: process.cwd(),
            },
            application,
          );
        }),
    }),
    Effect.provide(applicationLayer),
  ),
);
