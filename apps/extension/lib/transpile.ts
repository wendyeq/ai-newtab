import { transform } from "sucrase";

/**
 * Turn the agent's TSX into CommonJS the sandbox page can evaluate. If the
 * transform throws, fall back to the raw source and let the sandbox report it.
 */
export function toRenderable(tsx: string): string {
  try {
    return transform(tsx, { transforms: ["typescript", "imports", "jsx"] }).code.replace(`"use strict";`, "");
  } catch (err) {
    console.warn("[transpile] sucrase failed, using raw source", err);
    return tsx;
  }
}
