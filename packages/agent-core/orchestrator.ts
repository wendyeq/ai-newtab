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

  const trimmedBaseUrl = baseUrl.trim();
  const baseUrlError = "baseUrl must be an http or https URL without userinfo";
  let endpoint: URL;
  try {
    endpoint = new URL(trimmedBaseUrl);
  } catch {
    throw new Error(baseUrlError);
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error(baseUrlError);
  }
  if (!model.trim()) throw new Error("model must be nonempty");
  if (!apiKey.trim()) throw new Error("apiKey must be nonempty");
  const completionsUrl = `${trimmedBaseUrl.replace(/\/+$/, "")}/chat/completions`;

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
        const daysToAnalyze = (input.daysToAnalyze as number | undefined) ?? DEFAULTS.daysToAnalyze;
        const maxResults = (input.maxResults as number | undefined) ?? DEFAULTS.maxResults;
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
        callbacks?.onPhase?.("scraping", `${input.urls.length} pages`);
        const allowed: string[] = [];
        const failed: GetPageHtmlResult["failed"] = [];
        for (const url of input.urls) {
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
        const source = typeof input.source === "string" ? stripFence(input.source) : "";
        if (
          !source.includes("PersonalizedHomepage") ||
          !/(?:from\s*["']react["']|import\s+React\b)/.test(source) ||
          source.includes(apiKey)
        ) {
          return { error: "source must be a PersonalizedHomepage React component" };
        }
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
    if (!assistant.tool_calls?.length) throw new Error("the model stopped without submitHomepage");

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

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[^\r\n`]*\r?\n([\s\S]*?)\r?\n?```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}
