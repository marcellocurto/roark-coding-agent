import { describe, expect, test } from "bun:test";
import { redactLocalPaths } from "./public-output.ts";

describe("redactLocalPaths", () => {
  test("redacts obvious POSIX local paths", () => {
    expect(redactLocalPaths("see /Users/alice/repo and /home/alice/repo and /tmp/roark/repo")).toBe(
      "see [local path redacted] and [local path redacted] and [local path redacted]",
    );
  });

  test("redacts delimiter-adjacent POSIX paths", () => {
    expect(redactLocalPaths("path:/Users/alice/repo [ /home/alice/repo ] [/tmp/roark/repo]")).toBe(
      "path:[local path redacted] [ [local path redacted] ] [[local path redacted]]",
    );
  });

  test("redacts Windows paths", () => {
    expect(redactLocalPaths("C:\\Users\\alice\\repo and C:/Users/alice/repo")).toBe(
      "[local path redacted] and [local path redacted]",
    );
  });

  test("preserves web URLs", () => {
    expect(redactLocalPaths("https://github.com/owner/repo/issues/1")).toBe("https://github.com/owner/repo/issues/1");
  });
});
