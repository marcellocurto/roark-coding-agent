import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubIssueCreateRequiredFiles,
  resolveGithubIssueCreateSkillPath,
} from "./project-skills.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("project skills", () => {
  test("resolves the repo-pinned github issue creation skill", async () => {
    const cwd = await tempProjectWithSkill();

    await expect(resolveGithubIssueCreateSkillPath(cwd)).resolves.toBe(path.join(cwd, "skills", "github-issue-create"));
  });

  test("fails clearly when the pinned skill is missing", async () => {
    const cwd = await tempProject();

    await expect(resolveGithubIssueCreateSkillPath(cwd)).rejects.toThrow("Project skill 'github-issue-create' is missing or incomplete");
    await expect(resolveGithubIssueCreateSkillPath(cwd)).rejects.toThrow("SKILL.md");
  });

  test("resolves when supporting templates, examples, and references are absent", async () => {
    const cwd = await tempProjectWithSkill();

    await expect(resolveGithubIssueCreateSkillPath(cwd)).resolves.toBe(path.join(cwd, "skills", "github-issue-create"));
  });

  test("fails when SKILL.md does not declare the expected skill name", async () => {
    const cwd = await tempProjectWithSkill({ skillMarkdown: "---\nname: other-skill\ndescription: test\n---\n" });

    await expect(resolveGithubIssueCreateSkillPath(cwd)).rejects.toThrow("frontmatter must include 'name: github-issue-create'");
  });

  test("fails when SKILL.md does not declare a non-empty description", async () => {
    const cwd = await tempProjectWithSkill({ skillMarkdown: "---\nname: github-issue-create\n---\n# Skill\n" });

    await expect(resolveGithubIssueCreateSkillPath(cwd)).rejects.toThrow("frontmatter must include a non-empty 'description'");
  });

  test("fails when SKILL.md frontmatter is not valid YAML", async () => {
    const cwd = await tempProjectWithSkill({ skillMarkdown: "---\nname: github-issue-create\ndescription: test\nbad: [unclosed\n---\n# Skill\n" });

    await expect(resolveGithubIssueCreateSkillPath(cwd)).rejects.toThrow("frontmatter must be valid YAML");
  });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roark-skills-"));
  tempDirs.push(dir);
  return dir;
}

async function tempProjectWithSkill(options: { skillMarkdown?: string } = {}): Promise<string> {
  const cwd = await tempProject();
  const skillDir = path.join(cwd, "skills", "github-issue-create");
  for (const relativePath of githubIssueCreateRequiredFiles) {
    const filePath = path.join(skillDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, relativePath === "SKILL.md"
      ? options.skillMarkdown ?? "---\nname: github-issue-create\ndescription: test\n---\n# Skill\n"
      : `${relativePath}\n`, "utf8");
  }
  return cwd;
}
