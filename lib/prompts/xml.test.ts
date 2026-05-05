import { describe, expect, test } from "bun:test";
import { escapePromptXmlAttribute, escapePromptXmlText } from "./xml.ts";

describe("prompt XML escaping", () => {
  test("escapes XML text delimiters", () => {
    expect(escapePromptXmlText("A & B < C > D")).toBe("A &amp; B &lt; C &gt; D");
  });

  test("escapes double quotes for attributes", () => {
    expect(escapePromptXmlAttribute('A "quoted" & <tag>')).toBe("A &quot;quoted&quot; &amp; &lt;tag&gt;");
  });
});
