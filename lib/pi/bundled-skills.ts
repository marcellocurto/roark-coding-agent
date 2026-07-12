import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const bundledSkillNames = [
  "next-best-practices",
  "vercel-react-best-practices",
  "vercel-composition-patterns",
  "design-system-ui",
  "convex-migration-helper",
  "convex-performance-audit",
] as const;

export type BundledSkillName = (typeof bundledSkillNames)[number];

export const bundledSkillsRoot = fileURLToPath(new URL("../../skills", import.meta.url));

export function bundledSkillPaths(): string[] {
  return bundledSkillNames.map((name) => path.join(bundledSkillsRoot, name));
}

export function agentSkillPaths(additionalSkillPaths: readonly string[] = []): string[] {
  return [...new Set([...bundledSkillPaths(), ...additionalSkillPaths.map((skillPath) => path.resolve(skillPath))])];
}

export function assertBundledSkillsPresent(): void {
  const missing = bundledSkillPaths().filter((skillPath) => !existsSync(path.join(skillPath, "SKILL.md")));
  if (missing.length === 0) return;
  throw new Error(`Roark package is missing bundled skill(s): ${missing.join(", ")}`);
}
