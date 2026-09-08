import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessOrThrow } from "../lib/cli/process.ts";
import packageJson from "../package.json";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "roark-package-check-"));

try {
  console.log("Packing Roark and installing into a temporary npm global prefix...");
  await runProcessOrThrow(["npm", "pack", "--pack-destination", temporaryRoot], { cwd: projectRoot });
  const tarballs = (await readdir(temporaryRoot)).filter((file) => file.endsWith(".tgz"));
  const [tarball] = tarballs;
  assert(tarballs.length === 1 && tarball, "Expected exactly one package tarball");

  const prefix = path.join(temporaryRoot, "install");
  await runProcessOrThrow([
    "npm", "install", "--global", "--prefix", prefix, path.join(temporaryRoot, tarball),
  ], { cwd: temporaryRoot });
  const globalRoot = (await runProcessOrThrow(["npm", "root", "--global", "--prefix", prefix], {
    cwd: temporaryRoot,
  })).trim();
  const installedRoot = path.join(globalRoot, packageJson.name);
  const executable = path.join(prefix, "bin", "roark");
  const target = path.join(temporaryRoot, "target");
  await mkdir(target);
  await runProcessOrThrow(["git", "init", "--quiet", target], { cwd: temporaryRoot });

  console.log("Checking the installed CLI outside the source checkout...");
  assert.equal((await runProcessOrThrow([executable, "--version"], { cwd: target })).trim(), packageJson.version);
  assert.match(await runProcessOrThrow([executable, "--help"], { cwd: target }), /roark <command>/);
  assert.equal((await runProcessOrThrow([
    executable, "status", "--all", "--cwd", target, "--repo", "owner/repo",
  ], { cwd: target })).trim(), "No observability summaries found.");

  // Exercise resource resolution from the installed module, not the checkout's module.
  await runProcessOrThrow([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { realpathSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const root = realpathSync(Bun.argv[1]);
    const skills = await import(pathToFileURL(path.join(root, "lib/pi/bundled-skills.ts")).href);
    skills.assertBundledSkillsPresent();
    assert.equal(realpathSync(skills.bundledSkillsRoot), path.join(root, "skills"));
  `, installedRoot], { cwd: target });

  console.log("Checking installed Astra model support without local model configuration...");
  await runProcessOrThrow([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const root = Bun.argv[1];
    const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
    const { ModelRuntime } = await import(import.meta.resolve("@earendil-works/pi-coding-agent", path.join(root, "package.json")));
    const { InMemoryCredentialStore } = await import(import.meta.resolve("@earendil-works/pi-ai", path.join(root, "package.json")));
    const { requestedModelSpec, resolveModel } = await load("lib/pi/agent.ts");
    const { resolveThinkingLevel } = await load("lib/pi/thinking-level.ts");
    const { workflowThinkingProfiles } = await load("lib/workflow/thinking.ts");
    const { effectiveModelForStage } = await load("lib/workflow/model-routing.ts");
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const model = resolveModel(runtime, requestedModelSpec());
    assert.equal(model.id, "gpt-6-astra");
    assert.equal(model.api, "openai-codex-responses");
    for (const profile of Object.values(workflowThinkingProfiles)) {
      for (const [stage, level] of Object.entries(profile)) {
        assert.equal(effectiveModelForStage(undefined, stage), requestedModelSpec());
        assert.equal(resolveThinkingLevel(model, level).clamped, false);
      }
    }
    assert.equal(resolveThinkingLevel(model, "max").effective, "max");
  `, installedRoot], { cwd: target });

  console.log("Checking installed Effect verification and artifacts in a noninteractive target...");
  await runProcessOrThrow([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    process.env.CI = "1";
    const root = Bun.argv[1];
    const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
    const { runCli } = await load("roark.ts");
    const { runVerification, writeVerificationArtifact, parseVerificationArtifact } = await load("lib/autorun/verification.ts");
    const { createWorkflowContext, readArtifact } = await load("lib/workflow/artifacts.ts");
    assert.equal(await runCli(["status", "--all"], {
      execute: async () => {
        const context = createWorkflowContext({ command: "do", issue: "1", cwd: process.cwd(), outDir: ".roark/runs", force: false, yes: false, maxFixPasses: 1 });
        const passed = await runVerification({ command: "printf installed-output", cwd: process.cwd() });
        assert.equal(passed.ok, true);
        assert.equal(passed.stdout, "installed-output");
        const failed = await runVerification({ command: "printf installed-error >&2; exit 7", cwd: process.cwd() });
        assert.equal(failed.exitCode, 7);
        const timedOut = await runVerification({ command: "printf before-timeout; sleep 30", cwd: process.cwd(), timeoutMs: 100 });
        assert.equal(timedOut.timedOut, true);
        assert.equal(timedOut.exitCode, 137);
        assert.equal(timedOut.stdout, "before-timeout");
        await writeVerificationArtifact(context, timedOut);
        assert.equal(parseVerificationArtifact(await readArtifact(context, "verification")).timedOut, true);
        assert.match(await readArtifact(context, "verificationFull"), /before-timeout/);
      },
      notify: () => Promise.resolve(),
    }), 0);
  `, installedRoot], { cwd: target });

  // Compare all supporting files, so npm ignore rules cannot silently truncate a skill.
  // Include new, uncommitted resources while excluding ignored local files such as .DS_Store.
  const skillFiles = await runProcessOrThrow([
    "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "skills/",
  ], { cwd: projectRoot });
  const resources = ["LICENSE", ...skillFiles.split("\0").filter(Boolean)];
  for (const resource of resources) {
    const [source, installed] = await Promise.all([
      readFile(path.join(projectRoot, resource)),
      readFile(path.join(installedRoot, resource)),
    ]);
    assert(source.equals(installed), `Installed resource differs: ${resource}`);
  }
  console.log(`Package check passed on Bun ${Bun.version}: CLI, Astra profiles, Effect verification, bundled skill resolution, and ${resources.length} resource files.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
