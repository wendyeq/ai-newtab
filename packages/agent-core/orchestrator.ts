import { buildBookmarkDigest } from "./bookmark-digest";
import { buildHistoryDigest } from "./history-digest";
import { HOMEPAGE_SYSTEM_PROMPT, buildKickoffMessage } from "./prompt";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, isPrivateAddress, normalizeBlockList } from "./site-filter";
import {
  DEFAULTS,
  GET_BOOKMARKS_SCHEMA,
  GET_HISTORY_SCHEMA,
  GET_PAGE_HTML_SCHEMA,
  type ToolInputSchema,
} from "./schemas";
import { DONE, LOOP_DONE, credentialNeedle, runToolLoop, type LoopTool } from "./tool-loop";
import type {
  BrowserBridge,
  GetPageHtmlResult,
  HomepageBuildResult,
  RunCallbacks,
} from "./types";

export { credentialNeedle };

export interface RunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  bridge: BrowserBridge;
  userSystemPrompt?: string;
  /** Re-read before every tool call so settings saved mid-build take effect. */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Optional host-provided source check (e.g. TSX compile) before accepting a submission. */
  validateSource?: (source: string) => string | null;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  now?: Date;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { baseUrl, apiKey, model, bridge, callbacks } = opts;
  callbacks?.onPhase?.("setup");

  if (!model.trim()) throw new Error("model must be nonempty");
  if (!apiKey.trim()) throw new Error("apiKey must be nonempty");

  const readBlockedSites = async () => {
    const listed = typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites;
    return normalizeBlockList(listed ?? DEFAULT_BLOCKED_SITES);
  };
  let code: string | undefined;

  const registry: Record<string, LoopTool> = {
    getHistory: {
      description: "Returns a ranked digest of the user's most-visited domains. Call this first, once.",
      parameters: GET_HISTORY_SCHEMA,
      async run(input) {
        const daysToAnalyze = clampInt(
          input.daysToAnalyze,
          schemaNumber(GET_HISTORY_SCHEMA, "daysToAnalyze", "minimum"),
          schemaNumber(GET_HISTORY_SCHEMA, "daysToAnalyze", "maximum"),
          DEFAULTS.daysToAnalyze,
        );
        const maxResults = clampInt(
          input.maxResults,
          schemaNumber(GET_HISTORY_SCHEMA, "maxResults", "minimum"),
          schemaNumber(GET_HISTORY_SCHEMA, "maxResults", "maximum"),
          DEFAULTS.maxResults,
        );
        callbacks?.onPhase?.("history", `${daysToAnalyze}d`);
        const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze, maxResults });
        const blockedSites = await readBlockedSites();
        const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
        const digest = buildHistoryDigest(allowed, {
          daysToAnalyze,
          maxResults,
          totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
          now: (opts.now ?? new Date()).getTime(),
        });
        callbacks?.onLog?.(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
        return digest;
      },
    },
    getBookmarks: {
      description:
        "Returns a randomized, domain-diverse sample of the user's bookmarks (excluding intranet and blocked sites). Call alongside getHistory.",
      parameters: GET_BOOKMARKS_SCHEMA,
      async run(input) {
        const maxResults = clampInt(
          input.maxResults,
          schemaNumber(GET_BOOKMARKS_SCHEMA, "maxResults", "minimum"),
          schemaNumber(GET_BOOKMARKS_SCHEMA, "maxResults", "maximum"),
          DEFAULTS.bookmarkSampleSize,
        );
        const raw = (await bridge.getBookmarks?.()) ?? [];
        const blockedSites = await readBlockedSites();
        const digest = buildBookmarkDigest(raw, { maxResults, blockedSites });
        callbacks?.onLog?.(`bookmarks: ${digest.bookmarks.length} of ${digest.totalBookmarksSeen} bookmarks`);
        return digest;
      },
    },
    getPageHtml: {
      description: "Loads URLs in the user's logged-in browser and returns sanitized HTML inline, possibly truncated, plus failures.",
      parameters: GET_PAGE_HTML_SCHEMA,
      async run(input): Promise<GetPageHtmlResult> {
        if (!Array.isArray(input.urls) || !input.urls.every((url) => typeof url === "string")) {
          throw new Error("getPageHtml requires a urls array of strings");
        }
        const urls = input.urls.slice(0, schemaNumber(GET_PAGE_HTML_SCHEMA, "urls", "maxItems"));
        callbacks?.onPhase?.("scraping", `${urls.length} pages`);
        const blockedSites = await readBlockedSites();
        const allowed: string[] = [];
        const failed: GetPageHtmlResult["failed"] = [];
        for (const url of urls) {
          if (isAllowedUrl(url, blockedSites)) allowed.push(url);
          else failed.push({ url, reason: "blocked by the user's settings" });
        }
        if (failed.length) callbacks?.onLog?.(`blocked: ${failed.length} url(s)`);

        const loaded = allowed.length
          ? await bridge.getPageHtml({
              urls: allowed,
              loadDelayMs: (input.loadDelayMs as number | undefined) ?? DEFAULTS.loadDelayMs,
              onLog: callbacks?.onLog,
            })
          : { pages: [], failed: [] };
        const currentBlockedSites = await readBlockedSites();
        const pages: GetPageHtmlResult["pages"] = [];
        const htmlLimit = 24_000;
        for (const page of loaded.pages) {
          if (!isAllowedUrl(page.finalUrl ?? page.url, currentBlockedSites) || (page.ip && isPrivateAddress(page.ip))) {
            failed.push({ url: page.url, reason: "blocked by the user's settings" });
            continue;
          }
          pages.push({
            url: page.url,
            title: page.title,
            html: page.html.slice(0, htmlLimit),
            truncated: page.html.length > htmlLimit,
          });
        }
        return { pages, failed: [...failed, ...loaded.failed] };
      },
    },
    submitHomepage: {
      description: "Submit the full PersonalizedHomepage React component source. This is the only way to finish the build.",
      parameters: {
        type: "object",
        properties: { source: { type: "string" } },
        required: ["source"],
      },
      async run(input) {
        const raw = typeof input.source === "string" ? input.source : "";
        const source = prepareHomepageSource(raw);
        const error = homepageSourceError(source, baseUrl, apiKey) ?? opts.validateSource?.(source) ?? null;
        if (error) return { error };
        code = source;
        callbacks?.onPhase?.("writing");
        return DONE;
      },
    },
  };

  let plainReplyNudges = 0;
  await runToolLoop({
    baseUrl,
    apiKey,
    model,
    systemPrompt: HOMEPAGE_SYSTEM_PROMPT,
    kickoff: buildKickoffMessage({ now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt }),
    registry,
    onPlainReply(content) {
      const action = plainReplyAction(content, baseUrl, apiKey, plainReplyNudges, opts.validateSource);
      if (action.type === "accept") {
        code = action.source;
        callbacks?.onPhase?.("writing");
        return LOOP_DONE;
      }
      if (action.type === "stop") return null;
      plainReplyNudges += 1;
      return action.message;
    },
    stopError: "the model stopped without submitHomepage",
    callbacks: callbacks ? {
      onPhase: callbacks.onPhase,
      onText: callbacks.onText,
      onLog: callbacks.onLog,
    } : undefined,
    signal: opts.signal,
  });
  if (code === undefined) throw new Error("the model stopped without submitHomepage");
  return { code };
}

function schemaNumber(schema: ToolInputSchema, key: string, field: string): number {
  const prop = schema.properties[key];
  if (!prop || typeof prop !== "object") throw new Error(`missing schema for ${key}`);
  const value = (prop as Record<string, unknown>)[field];
  if (typeof value !== "number") throw new Error(`missing schema ${key}.${field}`);
  return value;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const MAX_PLAIN_REPLY_NUDGES = 2;
const SUBMIT_NUDGE = "只调用 submitHomepage，把完整源码放进 source";
const REACT_IMPORT = /(?:from\s*["']react(?:\/[^"']*)?["']|import\s+React\b)/;

function plainReplyAction(
  content: string | null,
  baseUrl: string,
  apiKey: string,
  nudgesUsed: number,
  validateSource?: (source: string) => string | null,
): { type: "accept"; source: string } | { type: "nudge"; message: string } | { type: "stop" } {
  const source = prepareHomepageSource(content ?? "");
  const looksLike = looksLikeHomepageSource(source);
  const error = looksLike
    ? homepageSourceError(source, baseUrl, apiKey) ?? validateSource?.(source) ?? null
    : null;
  if (looksLike && !error) return { type: "accept", source };
  if (nudgesUsed >= MAX_PLAIN_REPLY_NUDGES) return { type: "stop" };
  return { type: "nudge", message: error ? `${error}\n${SUBMIT_NUDGE}` : SUBMIT_NUDGE };
}

function homepageSourceError(source: string, baseUrl: string, apiKey: string): string | null {
  const problems: string[] = [];
  if (!source.includes("PersonalizedHomepage")) problems.push("missing PersonalizedHomepage");
  if (!REACT_IMPORT.test(source)) problems.push("missing react import");
  const needle = credentialNeedle(baseUrl, apiKey);
  if (needle && source.includes(needle)) problems.push("contains the API key");
  if (!problems.length) return null;
  return `source rejected: ${problems.join("; ")}`;
}

function looksLikeHomepageSource(source: string): boolean {
  return /(?:function|class|const|let|var)\s+PersonalizedHomepage\b|\bPersonalizedHomepage\s*=/.test(source);
}

function prepareHomepageSource(raw: string): string {
  return sliceToCode(extractFenced(raw) ?? raw).trim();
}

function extractFenced(text: string): string | null {
  const trimmed = text.trim();
  const open = /```[^\r\n`]*\r?\n/.exec(trimmed);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = trimmed.lastIndexOf("```");
  if (end < start) return trimmed.slice(start).trim();
  return trimmed.slice(start, end).trim();
}

function sliceToCode(text: string): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !codeLine(lines[start] ?? "")) start += 1;
  if (start === lines.length) return text.trim();
  let end = lines.length - 1;
  while (end > start && !codeLine(lines[end] ?? "")) end -= 1;
  return lines.slice(start, end + 1).join("\n");
}

function codeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("```")) return false;
  return /^(?:import\b|export\b|function\b|const\b|let\b|var\b|class\b|return\b|if\b|for\b|while\b|switch\b|type\b|interface\b|\/\/|\/\*|\*\/|[{}();<])/.test(trimmed)
    || trimmed.includes("PersonalizedHomepage")
    || trimmed.includes("=>");
}
