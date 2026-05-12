import { describe, expect, test } from "bun:test";
import { redactLocalPaths, redactSecrets, sanitizePublicMarkdown, truncatePublicMarkdown } from "./public-output.ts";

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

  test("redacts POSIX file URIs", () => {
    expect(redactLocalPaths("at file:///Users/alice/repo/src/index.ts:10:2 then https://github.com/owner/repo")).toBe(
      "at [local path redacted] then https://github.com/owner/repo",
    );
  });

  test("redacts full paths containing spaces", () => {
    expect(redactLocalPaths("at /Users/John Doe/repo/src/index.ts and C:\\Users\\John Doe\\repo\\file.ts")).toBe(
      "at [local path redacted] and [local path redacted]",
    );
    expect(redactLocalPaths("cwd /Users/alice/My Repo failed")).toBe("cwd [local path redacted] failed");
  });

  test("preserves web URLs", () => {
    expect(redactLocalPaths("https://github.com/owner/repo/issues/1")).toBe("https://github.com/owner/repo/issues/1");
  });
});

describe("public markdown sanitization", () => {
  test("redacts obvious token assignments and authorization headers", () => {
    expect(redactSecrets("GITHUB_TOKEN=abc API_KEY: xyz Authorization: Bearer secret")).toBe(
      "GITHUB_TOKEN=[redacted] API_KEY: [redacted] Authorization: Bearer [redacted]",
    );
    expect(redactSecrets("GITHUB_TOKEN=\"abc\" API_KEY: 'xyz' Authorization: Bearer \"secret\"")).toBe(
      "GITHUB_TOKEN=[redacted] API_KEY: [redacted] Authorization: Bearer [redacted]",
    );
  });

  test("redacts unterminated quoted secrets", () => {
    expect(redactSecrets("TOKEN=\"abc123\nnext line")).toBe("TOKEN=[redacted]\nnext line");
    expect(redactSecrets("Authorization: Bearer 'abc123")).toBe("Authorization: Bearer [redacted]");
  });

  test("sanitizes paths and secrets together", () => {
    const sanitized = sanitizePublicMarkdown("cwd=/Users/alice/repo\nTOKEN=secret");
    expect(sanitized).toContain("[local path redacted]");
    expect(sanitized).toContain("TOKEN=[redacted]");
  });

  test("truncates with an explicit note", () => {
    expect(truncatePublicMarkdown("abcdef", 3)).toBe("abc\n\n... (truncated 3 later characters) ...");
  });
});
