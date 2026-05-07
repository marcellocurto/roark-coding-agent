import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter as parsePiFrontmatter } from "@mariozechner/pi-coding-agent";

export const githubIssueCreateSkillName = "github-issue-create";

export const githubIssueCreateRequiredFiles = ["SKILL.md"] as const;

export async function resolveGithubIssueCreateSkillPath(cwd: string): Promise<string> {
  return resolveProjectSkillPath(cwd, githubIssueCreateSkillName);
}

export async function resolveProjectSkillPath(cwd: string, skillName: string): Promise<string> {
  if (skillName !== githubIssueCreateSkillName) {
    throw new Error(`Unknown project skill '${skillName}'.`);
  }

  const skillPath = path.resolve(cwd, "skills", skillName);
  const missing: string[] = [];

  for (const relativePath of githubIssueCreateRequiredFiles) {
    const filePath = path.join(skillPath, relativePath);
    if (!await isFile(filePath)) missing.push(relativePath);
  }

  if (missing.length > 0) {
    throw new Error(`Project skill '${skillName}' is missing or incomplete at ${skillPath}: missing ${missing.join(", ")}.`);
  }

  const skillMarkdown = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  const frontmatter = parseSkillFrontmatter(skillMarkdown, skillName, skillPath);
  if (frontmatter.name !== skillName) {
    throw new Error(`Project skill '${skillName}' is malformed at ${skillPath}: SKILL.md frontmatter must include 'name: ${skillName}'.`);
  }
  if (!frontmatter.description.trim()) {
    throw new Error(`Project skill '${skillName}' is malformed at ${skillPath}: SKILL.md frontmatter must include a non-empty 'description'.`);
  }

  return skillPath;
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

function parseSkillFrontmatter(markdown: string, skillName: string, skillPath: string): { name?: string; description: string } {
  try {
    const { frontmatter } = parsePiFrontmatter(markdown);
    if (!isRecord(frontmatter)) return { name: undefined, description: "" };
    return {
      name: typeof frontmatter.name === "string" ? frontmatter.name : undefined,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Project skill '${skillName}' is malformed at ${skillPath}: SKILL.md frontmatter must be valid YAML. ${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
