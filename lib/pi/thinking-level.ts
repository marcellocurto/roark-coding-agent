import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../cli/args.ts";

export interface ThinkingLevelResolution {
  requested: ThinkingLevel;
  effective: ModelThinkingLevel;
  supported: readonly ModelThinkingLevel[];
  clamped: boolean;
}

export function resolveThinkingLevel(model: Model<Api>, requested: ThinkingLevel): ThinkingLevelResolution {
  const effective = clampThinkingLevel(model, requested);
  return {
    requested,
    effective,
    supported: getSupportedThinkingLevels(model),
    clamped: effective !== requested,
  };
}
