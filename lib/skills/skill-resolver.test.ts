import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubIssueCreateRequiredFiles,
  resolveBundledRoarkSkillPath,
  resolveGithubIssueCreateSkillPath,
} from "./skill-resolver.ts";

const tempDirs: string[] = [];

const bundledGithubIssueCreateSkillPath = resolveBundledRoarkSkillPath("github-issue-create");

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Roark skill resolver", () => {
  test("resolves the bundled github issue creation skill from an unrelated workspace", async () => {
    const workspaceRoot = await tempWorkspace();

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).resolves.toBe(bundledGithubIssueCreateSkillPath);
  });

  test("resolves a repo override before the bundled github issue creation skill", async () => {
    const workspaceRoot = await tempWorkspaceWithOverrideSkill();

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).resolves.toBe(path.join(workspaceRoot, ".roark", "skills", "github-issue-create"));
  });

  test("ignores legacy workspace skills and falls back to the bundled skill", async () => {
    const workspaceRoot = await tempWorkspaceWithLegacySkill();

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).resolves.toBe(bundledGithubIssueCreateSkillPath);
  });

  test("resolves when override supporting templates, examples, and references are absent", async () => {
    const workspaceRoot = await tempWorkspaceWithOverrideSkill();

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).resolves.toBe(path.join(workspaceRoot, ".roark", "skills", "github-issue-create"));
  });

  test("fails clearly when an override skill exists but SKILL.md is missing", async () => {
    const workspaceRoot = await tempWorkspace();
    const overridePath = path.join(workspaceRoot, ".roark", "skills", "github-issue-create");
    await mkdir(overridePath, { recursive: true });

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).rejects.toThrow("Repo override skill 'github-issue-create' is missing or incomplete");
    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).rejects.toThrow("SKILL.md");
  });

  test("fails when override SKILL.md does not declare the expected skill name", async () => {
    const workspaceRoot = await tempWorkspaceWithOverrideSkill({ skillMarkdown: "---\nname: other-skill\ndescription: test\n---\n" });

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).rejects.toThrow("frontmatter must include 'name: github-issue-create'");
  });

  test("fails when override SKILL.md does not declare a non-empty description", async () => {
    const workspaceRoot = await tempWorkspaceWithOverrideSkill({ skillMarkdown: "---\nname: github-issue-create\n---\n# Skill\n" });

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).rejects.toThrow("frontmatter must include a non-empty 'description'");
  });

  test("fails when override SKILL.md frontmatter is not valid YAML", async () => {
    const workspaceRoot = await tempWorkspaceWithOverrideSkill({ skillMarkdown: "---\nname: github-issue-create\ndescription: test\nbad: [unclosed\n---\n# Skill\n" });

    expect(resolveGithubIssueCreateSkillPath(workspaceRoot)).rejects.toThrow("frontmatter must be valid YAML");
  });
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-skills-"));
  tempDirs.push(dir);
  return dir;
}

async function tempWorkspaceWithOverrideSkill(options: { skillMarkdown?: string } = {}): Promise<string> {
  const workspaceRoot = await tempWorkspace();
  await writeSkill(path.join(workspaceRoot, ".roark", "skills", "github-issue-create"), options.skillMarkdown);
  return workspaceRoot;
}

async function tempWorkspaceWithLegacySkill(): Promise<string> {
  const workspaceRoot = await tempWorkspace();
  await writeSkill(path.join(workspaceRoot, "skills", "github-issue-create"));
  return workspaceRoot;
}

async function writeSkill(skillDir: string, skillMarkdown?: string): Promise<void> {
  for (const relativePath of githubIssueCreateRequiredFiles) {
    const filePath = path.join(skillDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = skillMarkdown ?? "---\nname: github-issue-create\ndescription: test\n---\n# Skill\n";
    await writeFile(filePath, content, "utf8");
  }
}
