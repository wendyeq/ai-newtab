import { expect, test } from "bun:test";
import { executeGeneratedHomepage } from "./run-agent";

test("generated source cannot read the API key from process.env", () => {
  const keyName = "AI_NEWTAB_API_KEY";
  const saved = process.env[keyName];
  const key = "test-only-placeholder";
  process.env[keyName] = key;
  try {
    const html = executeGeneratedHomepage([
      'import React from "react";',
      "export default function PersonalizedHomepage() {",
      '  const fromProcess = typeof process === "undefined" ? "" : process.env.AI_NEWTAB_API_KEY || "";',
      "  const fromGlobal = globalThis.process?.env?.AI_NEWTAB_API_KEY || \"\";",
      '  return <p>{fromProcess || fromGlobal ? "leaked" : "hidden"}</p>;',
      "}",
    ].join("\n"));
    expect(html.includes("leaked")).toBe(false);
    expect(html.includes(key)).toBe(false);
    expect(html.includes("hidden")).toBe(true);
  } finally {
    if (saved === undefined) delete process.env[keyName];
    else process.env[keyName] = saved;
  }
});
