/**
 * The shared chat-completions tool loop.
 *
 * Both agent runs (the homepage build and the bookmark tidy) are the same
 * shape: POST messages + tool specs, execute each returned tool call, append a
 * tool message, repeat until a submit tool marks the run done or the turn cap
 * hits. Host-specific work lives in the Tool registry the caller passes in;
 * this file knows nothing about history, pages, or bookmarks.
 */

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LoopTool {
  description: string;
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<unknown>;
}

export interface LoopCallbacks {
  onPhase?(phase: string, detail?: string): void;
  /** Assistant narration, for a progress panel. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface LoopOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  kickoff: string;
  registry: Record<string, LoopTool>;
  /**
   * Called when the assistant replies with text and no tool calls. Return a
   * nudge to push back as a user message, LOOP_DONE to accept the reply and
   * finish, or null to abort the run with `stopError`.
   */
  onPlainReply(content: string | null): Promise<string | null | typeof LOOP_DONE> | string | null | typeof LOOP_DONE;
  /** Abort the run without a submit call. */
  stopError: string;
  callbacks?: LoopCallbacks;
  signal?: AbortSignal;
  maxTurns?: number;
}

const MAX_TURNS = 16;
/** A tool returns this to end the run after its results are sent back. */
export const DONE: unique symbol = Symbol("tool-loop-done");
/** Returned by `onPlainReply` to accept a tool-call-free reply and end the run. */
export const LOOP_DONE: unique symbol = Symbol("tool-loop-plain-reply-done");

export async function runToolLoop(opts: LoopOptions): Promise<void> {
  const { baseUrl, apiKey, model, registry, callbacks, signal } = opts;
  const completionsUrl = chatCompletionsUrl(baseUrl);
  const needle = credentialNeedle(baseUrl, apiKey);
  const redact = (text: string) => (needle ? text.split(needle).join("[redacted]") : text);

  const tools = Object.entries(registry).map(([name, tool]) => ({
    type: "function",
    function: { name, description: tool.description, parameters: tool.parameters },
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.kickoff },
  ];

  for (let turn = 0; turn < (opts.maxTurns ?? MAX_TURNS); turn++) {
    if (signal?.aborted) throw new Error("aborted");
    callbacks?.onPhase?.("analyzing");
    const response = await fetch(completionsUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal,
    });
    if (!response.ok) throw new Error(`chat completions failed: HTTP ${response.status}`);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("chat completions returned no message");
    const assistant: Extract<ChatMessage, { role: "assistant" }> = {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
    messages.push(assistant);
    if (!assistant.tool_calls?.length) {
      const reply = await opts.onPlainReply(assistant.content);
      if (reply === LOOP_DONE) return;
      if (reply === null) throw new Error(opts.stopError);
      messages.push({ role: "user", content: reply });
      continue;
    }

    let done = false;
    for (const call of assistant.tool_calls) {
      if (signal?.aborted) throw new Error("aborted");
      let result: unknown;
      try {
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
        result = await registry[name].run(input as Record<string, unknown>);
      } catch (error) {
        result = { error: redact(error instanceof Error ? error.message : String(error)) };
      }
      if (result === DONE) done = true;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result === DONE ? JSON.stringify({ accepted: true }) : JSON.stringify(result),
      });
    }
    if (signal?.aborted) throw new Error("aborted");
    if (done) return;
    if (assistant.content) callbacks?.onText?.(redact(assistant.content));
  }
  throw new Error(`tool loop exceeded ${opts.maxTurns ?? MAX_TURNS} turns`);
}

export function chatCompletionsUrl(baseUrl: string): string {
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

export function credentialNeedle(baseUrl: string, apiKey: string): string {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  ) {
    return "";
  }
  return apiKey.length >= 8 ? apiKey : "";
}
