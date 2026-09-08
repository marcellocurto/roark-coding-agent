import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { requestedModelSpec, resolveModel } from "../../lib/pi/agent.ts";
import { resolveThinkingLevel } from "../../lib/pi/thinking-level.ts";
import { effectiveModelForStage } from "../../lib/workflow/model-routing.ts";
import { workflowThinkingProfiles, workflowThinkingStages } from "../../lib/workflow/thinking.ts";

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
});
const model = resolveModel(runtime, requestedModelSpec());
assert.equal(model.id, "gpt-6-astra");
assert.equal(model.api, "openai-codex-responses");
for (const profile of Object.values(workflowThinkingProfiles)) {
  for (const stage of workflowThinkingStages) {
    assert.equal(effectiveModelForStage(undefined, stage), requestedModelSpec());
    assert.equal(resolveThinkingLevel(model, profile[stage]).clamped, false);
  }
}
assert.equal(resolveThinkingLevel(model, "max").effective, "max");
