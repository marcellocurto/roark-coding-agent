import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, type Scope } from "effect";
import { Presentation } from "../runtime/services.ts";
import {
  applicationServicesLayer,
  type ApplicationServices,
} from "../runtime/application.ts";
import type { Presenter } from "../presentation/presenter.ts";

export function runWithPresenter<A, E>(
  presentation: Presenter,
  work: Effect.Effect<A, E, ApplicationServices | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    work.pipe(
      Effect.scoped,
      Effect.provide(applicationServicesLayer),
      Effect.provideService(Presentation, presentation),
      Effect.provide(BunServices.layer),
    ),
  );
}
