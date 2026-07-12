import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ResolvedPrReviewVerification {
  command?: string | undefined;
  source: "explicit" | "config" | "inferred" | "not-configured";
}

export async function resolvePrReviewVerification(input: {
  cwd: string;
  command?: string | undefined;
  source: "explicit" | "config" | "unresolved";
}): Promise<ResolvedPrReviewVerification> {
  if (input.command) return { command: input.command, source: input.source === "config" ? "config" : "explicit" };
  const inferred = await inferVerificationCommand(input.cwd);
  return inferred ? { command: inferred, source: "inferred" } : { source: "not-configured" };
}

async function inferVerificationCommand(cwd: string): Promise<string | undefined> {
  const packagePath = path.join(cwd, "package.json");
  if (!existsSync(packagePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["scripts"])) return undefined;
  const scripts = parsed["scripts"];
  const script = ["check", "verify", "test"].find((candidate) => typeof scripts[candidate] === "string" && scripts[candidate].trim().length > 0);
  if (!script) return undefined;
  const runner = existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))
    ? "bun run"
    : existsSync(path.join(cwd, "pnpm-lock.yaml"))
      ? "pnpm run"
      : existsSync(path.join(cwd, "yarn.lock"))
        ? "yarn"
        : "npm run";
  return `${runner} ${script}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
