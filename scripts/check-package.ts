import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessOrThrowPromise } from "../lib/cli/process-promise.ts";
import packageJson from "../package.json";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "roark-package-check-"),
);

try {
  console.log(
    "Packing Roark and installing into a temporary npm global prefix...",
  );
  await runProcessOrThrowPromise(
    ["npm", "pack", "--pack-destination", temporaryRoot],
    { cwd: projectRoot },
  );
  const tarballs = (await readdir(temporaryRoot)).filter((file) =>
    file.endsWith(".tgz"),
  );
  const [tarball] = tarballs;
  assert(
    tarballs.length === 1 && tarball,
    "Expected exactly one package tarball",
  );

  const prefix = path.join(temporaryRoot, "install");
  await runProcessOrThrowPromise(
    [
      "npm",
      "install",
      "--global",
      "--prefix",
      prefix,
      path.join(temporaryRoot, tarball),
    ],
    { cwd: temporaryRoot },
  );
  const globalRoot = (
    await runProcessOrThrowPromise(
      ["npm", "root", "--global", "--prefix", prefix],
      {
        cwd: temporaryRoot,
      },
    )
  ).trim();
  const installedRoot = path.join(globalRoot, packageJson.name);
  assert(
    !(await readdir(installedRoot)).includes("repos"),
    "Vendored development references must not ship in the package",
  );
  const executable = path.join(prefix, "bin", "roark");
  const target = path.join(temporaryRoot, "target");
  await mkdir(target);
  await runProcessOrThrowPromise(["git", "init", "--quiet", target], {
    cwd: temporaryRoot,
  });

  console.log("Checking the installed CLI outside the source checkout...");
  assert.equal(
    (
      await runProcessOrThrowPromise([executable, "--version"], { cwd: target })
    ).trim(),
    packageJson.version,
  );
  assert.match(
    await runProcessOrThrowPromise([executable, "--help"], { cwd: target }),
    /roark <command>/,
  );
  assert.equal(
    (
      await runProcessOrThrowPromise(
        [
          executable,
          "status",
          "--all",
          "--cwd",
          target,
          "--repo",
          "owner/repo",
        ],
        { cwd: target },
      )
    ).trim(),
    "No observability summaries found.",
  );

  // Copy only development fixtures, preserving their relative imports into the
  // installed package. Product code and dependencies come exclusively from npm.
  const installedChecks = path.join(installedRoot, "scripts", "package-checks");
  await cp(
    path.join(projectRoot, "scripts", "package-checks"),
    installedChecks,
    { recursive: true },
  );
  for (const [fixture, description] of [
    ["skills.ts", "bundled skill resolution"],
    ["models.ts", "Astra model support without local model configuration"],
    [
      "verification.ts",
      "Effect verification and artifacts in a noninteractive target",
    ],
  ] as const) {
    console.log(`Checking installed ${description}...`);
    await runProcessOrThrowPromise(
      [process.execPath, path.join(installedChecks, fixture)],
      { cwd: target },
    );
  }

  // Compare all supporting files, so npm ignore rules cannot silently truncate a skill.
  // Include new, uncommitted resources while excluding ignored local files such as .DS_Store.
  const skillFiles = await runProcessOrThrowPromise(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "skills/",
    ],
    { cwd: projectRoot },
  );
  const resources = ["LICENSE", ...skillFiles.split("\0").filter(Boolean)];
  for (const resource of resources) {
    const [source, installed] = await Promise.all([
      readFile(path.join(projectRoot, resource)),
      readFile(path.join(installedRoot, resource)),
    ]);
    assert(source.equals(installed), `Installed resource differs: ${resource}`);
  }
  console.log(
    `Package check passed on Bun ${Bun.version}: CLI, Astra profiles, Effect verification, bundled skill resolution, and ${resources.length} resource files.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
