import { runHomepageBuild } from "@homepage/agent-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { transform } from "sucrase";
import { OUT_DIR, OUT_PATH, nodeBridge } from "./node-bridge";

const apiKey = process.env.AI_NEWTAB_API_KEY;

async function main() {
  const baseUrl = process.env.AI_NEWTAB_BASE_URL;
  const model = process.env.AI_NEWTAB_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Set AI_NEWTAB_BASE_URL, AI_NEWTAB_API_KEY, and AI_NEWTAB_MODEL");
  }

  const result = await runHomepageBuild({
    baseUrl,
    apiKey,
    model,
    bridge: nodeBridge,
    userSystemPrompt: process.env.HOMEPAGE_PROMPT,
    callbacks: {
      onPhase: (phase) => console.log(`[${phase}]`),
    },
  });
  if (result.code.includes(apiKey)) throw new Error("generated source contains the API key");

  const html = executeGeneratedHomepage(result.code);
  if (html.includes(apiKey)) throw new Error("rendered homepage contains the API key");

  mkdirSync(OUT_DIR, { recursive: true });
  const htmlPath = join(OUT_DIR, "homepage.html");
  writeFileSync(OUT_PATH, result.code);
  writeFileSync(htmlPath, html);
  console.log(`${Buffer.byteLength(result.code)} bytes: ${relative(process.cwd(), OUT_PATH)}`);
  console.log(`${Buffer.byteLength(html)} bytes: ${relative(process.cwd(), htmlPath)}`);
}

/** Generated source runs as a function. Hide the harness key from `process` and from `globalThis`. */
export function executeGeneratedHomepage(code: string): string {
  const js = transform(code, {
    transforms: ["typescript", "jsx", "imports"],
    jsxRuntime: "classic",
  }).code;
  const module_ = { exports: {} as { default?: unknown; PersonalizedHomepage?: unknown } };
  const require_ = (name: string) => {
    if (name === "react") return React;
    throw new Error("component may only import React");
  };
  const keyName = "AI_NEWTAB_API_KEY";
  const saved = process.env[keyName];
  delete process.env[keyName];
  try {
    new Function("require", "module", "exports", "React", "process", js)(
      require_,
      module_,
      module_.exports,
      React,
      { env: {} },
    );
    const Component = module_.exports.default ?? module_.exports.PersonalizedHomepage;
    if (typeof Component !== "function") throw new Error("no default-exported component found");
    return renderToString(React.createElement(Component as React.FunctionComponent));
  } finally {
    if (saved !== undefined) process.env[keyName] = saved;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`build failed: ${apiKey ? message.split(apiKey).join("[redacted]") : message}`);
    process.exit(1);
  });
}
