import { describe, expect, test } from "bun:test";
import { compileHomepage, validateHomepageTsx } from "../apps/extension/lib/transpile";

describe("compileHomepage", () => {
  test("compiles valid TSX into CommonJS without raw import statements", () => {
    const source = [
      'import React from "react";',
      "export default function PersonalizedHomepage() {",
      '  return <main><a href="https://example.com">Hello</a></main>;',
      "}",
    ].join("\n");

    const result = compileHomepage(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("require('react')");
      expect(result.code).not.toMatch(/^\s*import\b/m);
    }
    expect(validateHomepageTsx(source)).toBeNull();
  });

  test("returns the real sucrase syntax error instead of falling back to raw TSX", () => {
    const broken = [
      'import React from "react";',
      "export default function PersonalizedHomepage() {",
      '  return <main className="card" <span />;',
      "}",
    ].join("\n");

    const result = compileHomepage(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Expected either /> or > at the end of the tag");
    }
    expect(validateHomepageTsx(broken)).toContain("TSX compile error:");
  });
});
