import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBundledSkillsPresent,
  bundledSkillsRoot,
} from "../../lib/pi/bundled-skills.ts";

const installedRoot = realpathSync(
  fileURLToPath(new URL("../../", import.meta.url)),
);
assertBundledSkillsPresent();
assert.equal(
  realpathSync(bundledSkillsRoot),
  path.join(installedRoot, "skills"),
);
