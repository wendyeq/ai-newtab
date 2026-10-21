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

  const js = transform(result.code, {
    transforms: ["typescript", "jsx", "imports"],
    jsxRuntime: "classic",
  }).code;
  const module_ = { exports: {} as any };
  const require_ = (name: string) => {
    if (name === "react") return React;
    throw new Error("component may only import React");
  };
  new Function("require", "module", "exports", "React", js)(
    require_,
    module_,
    module_.exports,
    React,
  );
  const Component = module_.exports.default ?? module_.exports.PersonalizedHomepage;
  if (typeof Component !== "function") throw new Error("no default-exported component found");
  const html = renderToString(React.createElement(Component));
  if (html.includes(apiKey)) throw new Error("rendered homepage contains the API key");

  mkdirSync(OUT_DIR, { recursive: true });
  const htmlPath = join(OUT_DIR, "homepage.html");
  writeFileSync(OUT_PATH, result.code);
  writeFileSync(htmlPath, html);
  console.log(`${Buffer.byteLength(result.code)} bytes: ${relative(process.cwd(), OUT_PATH)}`);
  console.log(`${Buffer.byteLength(html)} bytes: ${relative(process.cwd(), htmlPath)}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`build failed: ${apiKey ? message.split(apiKey).join("[redacted]") : message}`);
  process.exit(1);
});
