import type { AgentRunRequest } from "../workflow/agent-runner.ts";
import type { AgentExecutionError } from "../pi/agent.ts";
import { Context, type Effect } from "effect";
import type { Presenter } from "../presentation/presenter.ts";
import type {
  VerificationRequest,
  VerificationResult,
} from "../autorun/verification.ts";
import type {
  InvalidProcessCommandError,
  ProcessExecutionError,
} from "../cli/process.ts";
import type { RoarkConfig, RoarkConfigError } from "../cli/config.ts";
import type {
  ExitNotificationRequest,
  NotificationContent,
} from "../cli/notifications.ts";
import type { ApplicationServices } from "./application.ts";
import type { PlatformError } from "effect";

export class Presentation extends Context.Service<Presentation, Presenter>()(
  "roark/presentation/Presentation",
) {}

export class RepositoryConfiguration extends Context.Service<
  RepositoryConfiguration,
  {
    load(
      workspace: string,
    ): Effect.Effect<
      RoarkConfig,
      RoarkConfigError | PlatformError.PlatformError
    >;
  }
>()("roark/cli/RepositoryConfiguration") {}

export class Verification extends Context.Service<
  Verification,
  {
    execute(
      request: VerificationRequest,
    ): Effect.Effect<
      VerificationResult,
      InvalidProcessCommandError | ProcessExecutionError
    >;
  }
>()("roark/autorun/Verification") {}

export class ExitNotifications extends Context.Service<
  ExitNotifications,
  {
    send(request: ExitNotificationRequest): Effect.Effect<void, Error>;
    deliver(content: NotificationContent): Effect.Effect<void, Error>;
  }
>()("roark/cli/ExitNotifications") {}

export class CommandExecution extends Context.Service<
  CommandExecution,
  {
    execute(argv: string[]): Effect.Effect<void, unknown, ApplicationServices>;
  }
>()("roark/cli/CommandExecution") {}

export class AgentExecution extends Context.Service<
  AgentExecution,
  {
    run(request: AgentRunRequest): Effect.Effect<string, AgentExecutionError>;
  }
>()("roark/agent/AgentExecution") {}
