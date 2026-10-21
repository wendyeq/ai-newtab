import React from "react";
import { createRoot, type Root } from "react-dom/client";

const SOURCE = "ai-newtab-preview";

let root: Root | null = null;

function requireModule(name: string): unknown {
  if (name === "react") return React;
  throw new Error(`only react can be imported, got ${name}`);
}

function mount(code: string) {
  const module = { exports: {} as { default?: unknown; PersonalizedHomepage?: unknown } };
  new Function("require", "module", "exports", "React", code)(
    requireModule,
    module,
    module.exports,
    React,
  );
  const Component = module.exports.default ?? module.exports.PersonalizedHomepage;
  if (typeof Component !== "function") throw new Error("PersonalizedHomepage export missing");
  const el = document.getElementById("root");
  if (!el) throw new Error("preview root missing");
  root?.unmount();
  root = createRoot(el);
  root.render(React.createElement(Component as React.FunctionComponent));
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data as { source?: string; code?: string } | null;
  if (data?.source !== SOURCE || typeof data.code !== "string") return;
  const el = document.getElementById("root");
  try {
    mount(data.code);
  } catch (error) {
    root?.unmount();
    root = null;
    if (el) el.textContent = error instanceof Error ? error.message : String(error);
  }
});

window.parent.postMessage({ source: SOURCE, ready: true }, "*");
