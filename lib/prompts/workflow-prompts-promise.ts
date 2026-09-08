import * as native from "./workflow-prompts.ts";
import {
  runApplicationPromise,
  type ApplicationExecution,
} from "../runtime/application.ts";

export function reviewAPromptPromise(
  context: Parameters<typeof native.reviewAPrompt>[0],
  pass: Parameters<typeof native.reviewAPrompt>[1] = 0,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.reviewAPrompt(context, pass),
    application,
  );
}

export function reviewBPromptPromise(
  context: Parameters<typeof native.reviewBPrompt>[0],
  pass: Parameters<typeof native.reviewBPrompt>[1] = 0,
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.reviewBPrompt(context, pass),
    application,
  );
}

export function codeRefinementPromptPromise(
  context: Parameters<typeof native.codeRefinementPrompt>[0],
  pass: Parameters<typeof native.codeRefinementPrompt>[1],
  source: Parameters<typeof native.codeRefinementPrompt>[2] = pass === 0
    ? "initial"
    : "fix",
  application?: ApplicationExecution,
) {
  return runApplicationPromise(
    native.codeRefinementPrompt(context, pass, source),
    application,
  );
}

export function fixPromptPromise(
  context: Parameters<typeof native.fixPrompt>[0],
  pass: Parameters<typeof native.fixPrompt>[1],
  application?: ApplicationExecution,
) {
  return runApplicationPromise(native.fixPrompt(context, pass), application);
}
