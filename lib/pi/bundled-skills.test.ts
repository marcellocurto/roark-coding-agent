import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  agentSkillPaths,
  assertBundledSkillsPresent,
  bundledSkillNames,
  bundledSkillPaths,
  bundledSkillsRoot,
} from "./bundled-skills.ts";

describe("bundled skills", () => {
  test("ships the exact default React, Next.js, and Convex skill set", () => {
    expect(bundledSkillNames).toEqual([
      "next-best-practices",
      "vercel-react-best-practices",
      "vercel-composition-patterns",
      "design-system-ui",
      "convex-migration-helper",
      "convex-performance-audit",
    ]);
    expect(bundledSkillNames).not.toContain("design-taste-frontend" as never);
    expect(() => {
      assertBundledSkillsPresent();
    }).not.toThrow();
  });

  test("resolves bundled skills from the installed package instead of the user home directory", () => {
    expect(bundledSkillPaths()).toEqual(bundledSkillNames.map((name) => path.join(bundledSkillsRoot, name)));
    expect(bundledSkillsRoot).toBe(path.resolve(import.meta.dir, "../../skills"));
  });

  test("keeps bundled skills when explicit additional skills are supplied", () => {
    const additional = path.resolve("custom-skills/project-specific");
    expect(agentSkillPaths([additional])).toEqual([...bundledSkillPaths(), additional]);
  });

  test("includes skills in the published package manifest", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../package.json"), "utf8")) as {
      files?: string[];
    };
    expect(packageJson.files).toContain("skills");
  });
});
