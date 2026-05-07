import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter as parsePiFrontmatter } from "@mariozechner/pi-coding-agent";

export const githubIssueCreateSkillName = "github-issue-create";

export const githubIssueCreateRequiredFiles = ["SKILL.md"] as const;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function resolveGithubIssueCreateSkillPath(workspaceRoot: string): Promise<string> {
  return resolveRoarkSkillPath(workspaceRoot, githubIssueCreateSkillName);
}

export async function resolveRoarkSkillPath(workspaceRoot: string, skillName: string): Promise<string> {
  assertKnownRoarkSkill(skillName);

  const repoOverridePath = path.resolve(workspaceRoot, ".roark", "skills", skillName);
  if (await pathExists(repoOverridePath)) {
    return validateSkillPath(repoOverridePath, skillName, "Repo override skill");
  }

  return validateSkillPath(resolveBundledRoarkSkillPath(skillName), skillName, "Bundled Roark skill");
}

export function resolveBundledRoarkSkillPath(skillName: string): string {
  assertKnownRoarkSkill(skillName);
  return path.join(packageRoot, "skills", skillName);
}

function assertKnownRoarkSkill(skillName: string): void {
  if (skillName !== githubIssueCreateSkillName) {
    throw new Error(`Unknown Roark skill '${skillName}'.`);
  }
}

async function validateSkillPath(skillPath: string, skillName: string, sourceLabel: string): Promise<string> {
  const missing: string[] = [];

  for (const relativePath of githubIssueCreateRequiredFiles) {
    const filePath = path.join(skillPath, relativePath);
    if (!await isFile(filePath)) missing.push(relativePath);
  }

  if (missing.length > 0) {
    throw new Error(`${sourceLabel} '${skillName}' is missing or incomplete at ${skillPath}: missing ${missing.join(", ")}.`);
  }

  const skillMarkdown = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  const frontmatter = parseSkillFrontmatter(skillMarkdown, skillName, skillPath, sourceLabel);
  if (frontmatter.name !== skillName) {
    throw new Error(`${sourceLabel} '${skillName}' is malformed at ${skillPath}: SKILL.md frontmatter must include 'name: ${skillName}'.`);
  }
  if (!frontmatter.description.trim()) {
    throw new Error(`${sourceLabel} '${skillName}' is malformed at ${skillPath}: SKILL.md frontmatter must include a non-empty 'description'.`);
  }

  return skillPath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function parseSkillFrontmatter(markdown: string, skillName: string, skillPath: string, sourceLabel: string): { name?: string; description: string } {
  try {
    const { frontmatter } = parsePiFrontmatter(markdown);
    if (!isRecord(frontmatter)) return { name: undefined, description: "" };
    return {
      name: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceLabel} '${skillName}' is malformed at ${skillPath}: SKILL.md frontmatter must be valid YAML. ${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
