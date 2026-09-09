export type WorkspaceStrategy = "clone";

export interface WorkspaceCloneConfig {
  filter?: string | null | undefined;
  depth?: number | null | undefined;
}

export interface WorkspaceConfig {
  root: string;
  strategy: WorkspaceStrategy;
  cloneRemote: string;
  clone: WorkspaceCloneConfig;
  copyToWorktree: string[];
}

export interface LifecycleHooksConfig {
  afterCreate?: string | undefined;
  beforeRun?: string | undefined;
  beforeVerify?: string | undefined;
  afterRun?: string | undefined;
  beforeRemove?: string | undefined;
  timeoutMs: number;
}

export const defaultWorkspaceConfig: WorkspaceConfig = {
  root: "~/.roark/workspaces",
  strategy: "clone",
  cloneRemote: "origin",
  clone: { filter: "blob:none", depth: null },
  copyToWorktree: [],
};
export const defaultLifecycleHooks: LifecycleHooksConfig = {
  timeoutMs: 600_000,
};
