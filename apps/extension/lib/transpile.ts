import { transform } from "sucrase";

export type CompileResult =
  | { ok: true; code: string }
  | { ok: false; error: string };

/**
 * Turn the agent's TSX into CommonJS the sandbox page can evaluate.
 * Never falls back to raw TSX — uncompiled `import` statements fail inside
 * the sandbox's `new Function` with a misleading module error.
 */
export function compileHomepage(tsx: string): CompileResult {
  try {
    const code = transform(tsx, { transforms: ["typescript", "imports", "jsx"] }).code.replace(
      `"use strict";`,
      "",
    );
    return { ok: true, code };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[transpile] sucrase failed:", err);
    return { ok: false, error };
  }
}

export function validateHomepageTsx(source: string): string | null {
  const result = compileHomepage(source);
  return result.ok ? null : `TSX compile error: ${result.error}`;
}
