import { buildHistoryDigest } from "./history-digest";
import { HOMEPAGE_SYSTEM_PROMPT, buildKickoffMessage } from "./prompt";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, isPrivateAddress, normalizeBlockList } from "./site-filter";
import { DEFAULTS, GET_HISTORY_SCHEMA, GET_PAGE_HTML_SCHEMA, type ToolInputSchema } from "./schemas";
import type {
  BrowserBridge,
  GetPageHtmlResult,
  HomepageBuildResult,
  RunCallbacks,
} from "./types";

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Tool {
  description: string;
  parameters: ToolInputSchema;
  run(input: Record<string, unknown>, blockedSites: string[]): Promise<unknown>;
}

export interface RunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  bridge: BrowserBridge;
  userSystemPrompt?: string;
  /** Re-read before every tool call so settings saved mid-build take effect. */
  blockedSites?: string[] | (() => Promise<string[]>);
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  now?: Date;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { baseUrl, apiKey, model, bridge, callbacks, signal } = opts;
  callbacks?.onPhase?.("setup");

  const completionsUrl = chatCompletionsUrl(baseUrl);
  if (!model.trim()) throw new Error("model must be nonempty");
  if (!apiKey.trim()) throw new Error("apiKey must be nonempty");

  const redact = (text: string) => text.split(apiKey).join("[redacted]");
  const readBlockedSites = async () => {
    const listed = typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites;
    return normalizeBlockList(listed ?? DEFAULT_BLOCKED_SITES);
  };
  let code: string | undefined;

  const registry: Record<string, Tool> = {
    getHistory: {
      description: "Returns a ranked digest of the user's most-visited domains. Call this first, once.",
      parameters: GET_HISTORY_SCHEMA,
      async run(input, blockedSites) {
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
        const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
        const digest = buildHistoryDigest(allowed, {
          daysToAnalyze,
          maxResults,
          totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
        });
        callbacks?.onLog?.(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
        return digest;
      },
    },
    getPageHtml: {
      description: "Loads URLs in the user's logged-in browser and returns sanitized HTML inline, possibly truncated, plus failures.",
      parameters: GET_PAGE_HTML_SCHEMA,
      async run(input, blockedSites): Promise<GetPageHtmlResult> {
        if (!Array.isArray(input.urls) || !input.urls.every((url) => typeof url === "string")) {
          throw new Error("getPageHtml requires a urls array of strings");
        }
        const urls = input.urls.slice(0, schemaNumber(GET_PAGE_HTML_SCHEMA, "urls", "maxItems"));
        callbacks?.onPhase?.("scraping", `${urls.length} pages`);
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
        const error = homepageSourceError(source, apiKey);
        if (error) return { error };
        code = source;
        callbacks?.onPhase?.("writing");
        return { accepted: true };
      },
    },
  };
  const tools = Object.entries(registry).map(([name, tool]) => ({
    type: "function",
    function: { name, description: tool.description, parameters: tool.parameters },
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: HOMEPAGE_SYSTEM_PROMPT },
    { role: "user", content: buildKickoffMessage({ now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt }) },
  ];
  let plainReplyNudges = 0;

  for (let turn = 0; turn < 16; turn++) {
    if (signal?.aborted) throw new Error("aborted");
    callbacks?.onPhase?.("analyzing");
    const response = await fetch(completionsUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal,
    });
    if (!response.ok) throw new Error(`chat completions failed: HTTP ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("chat completions returned no message");
    const assistant: Extract<ChatMessage, { role: "assistant" }> = {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
    messages.push(assistant);
    if (!assistant.tool_calls?.length) {
      const action = plainReplyAction(assistant.content, apiKey, plainReplyNudges);
      if (action.type === "accept") {
        callbacks?.onPhase?.("writing");
        return { code: action.source };
      }
      if (action.type === "stop") throw new Error("the model stopped without submitHomepage");
      plainReplyNudges += 1;
      messages.push({ role: "user", content: action.message });
      continue;
    }

    for (const call of assistant.tool_calls) {
      if (signal?.aborted) throw new Error("aborted");
      let result: unknown;
      try {
        const blockedSites = await readBlockedSites();
        const name = call.function.name;
        if (!Object.hasOwn(registry, name)) throw new Error(`unknown tool: ${name}`);
        let input: unknown;
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          throw new Error(`invalid JSON arguments for tool: ${name}`);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error(`arguments must be a JSON object for tool: ${name}`);
        }
        result = await registry[name].run(input as Record<string, unknown>, blockedSites);
      } catch (error) {
        result = { error: redact(error instanceof Error ? error.message : String(error)) };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (signal?.aborted) throw new Error("aborted");
    if (code !== undefined) return { code };
    if (assistant.content) callbacks?.onText?.(redact(assistant.content));
  }
  throw new Error("tool loop exceeded 16 turns");
}

function chatCompletionsUrl(baseUrl: string): string {
  const baseUrlError = "baseUrl must be an http or https URL without userinfo, query, or hash";
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl.trim());
  } catch {
    throw new Error(baseUrlError);
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(baseUrlError);
  }
  const path = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return endpoint.href;
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
  secret: string,
  nudgesUsed: number,
): { type: "accept"; source: string } | { type: "nudge"; message: string } | { type: "stop" } {
  const source = prepareHomepageSource(content ?? "");
  const looksLike = looksLikeHomepageSource(source);
  const error = looksLike ? homepageSourceError(source, secret) : null;
  if (looksLike && !error) return { type: "accept", source };
  if (nudgesUsed >= MAX_PLAIN_REPLY_NUDGES) return { type: "stop" };
  return { type: "nudge", message: error ? `${error}\n${SUBMIT_NUDGE}` : SUBMIT_NUDGE };
}

function homepageSourceError(source: string, secret: string): string | null {
  const problems: string[] = [];
  if (!source.includes("PersonalizedHomepage")) problems.push("missing PersonalizedHomepage");
  if (!REACT_IMPORT.test(source)) problems.push("missing react import");
  if (secret.length > 0 && source.includes(secret)) problems.push("contains the API key");
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
