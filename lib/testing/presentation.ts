import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { Presentation } from "../runtime/services.ts";
import {
  applicationServicesLayer,
  fromLegacyPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";
import type { Presenter } from "../presentation/presenter.ts";

export function runWithPresenter<A>(
  presentation: Presenter,
  work: (application: ApplicationExecution) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    fromLegacyPromise(work).pipe(
      Effect.provide(applicationServicesLayer),
      Effect.provideService(Presentation, presentation),
      Effect.provide(BunServices.layer),
    ),
  );
}
