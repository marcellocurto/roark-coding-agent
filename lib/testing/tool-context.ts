import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function unavailable(): never {
  throw new Error("This tool test does not provide an agent session.");
}

// Submission tools validate their input without using an agent session. Fail
// explicitly if a tool starts depending on session capabilities in these tests.
export const toolContext: ExtensionContext = {
  get ui() {
    return unavailable();
  },
  get sessionManager() {
    return unavailable();
  },
  get modelRegistry() {
    return unavailable();
  },
  mode: "print",
  hasUI: false,
  cwd: "/repo",
  model: undefined,
  scopedModels: [],
  signal: undefined,
  isIdle: () => true,
  isProjectTrusted: () => false,
  abort: unavailable,
  hasPendingMessages: () => false,
  shutdown: unavailable,
  getContextUsage: () => undefined,
  compact: unavailable,
  getSystemPrompt: () => "",
};
