import { expect, test } from "bun:test";
import { runHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

const source = [
  'import React from "react";',
  "export default function PersonalizedHomepage() {",
  '  return <a href="https://news.ycombinator.com/item?id=1">DISTINCT_TOKEN</a>;',
  "}",
].join("\n");

const pageHtml = "<main><h1>Hacker News</h1><p>bridge-page-body</p></main>";

test("runs history, page HTML, and submitHomepage as chat completions", async () => {
  const sites = fixtureHistory();
  const seen: Array<{ authorization: string | null; pathname: string; method: string; messages: Array<{ role: string; tool_call_id?: string; content?: string }> }> = [];
  const turns = [
    { id: "h-1", name: "getHistory", arguments: "{}" },
    { id: "p-2", name: "getPageHtml", arguments: JSON.stringify({ urls: ["https://news.ycombinator.com/"] }) },
    { id: "s-3", name: "submitHomepage", arguments: JSON.stringify({ source: "```tsx\n" + source + "\n```" }) },
  ];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.json() as { messages: typeof seen[number]["messages"] };
      seen.push({
        authorization: request.headers.get("authorization"),
        pathname: url.pathname,
        method: request.method,
        messages: body.messages,
      });
      const call = turns[seen.length - 1] ?? turns[2]!;
      return Response.json({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
          },
        }],
      });
    },
  });

  const bridge: BrowserBridge = {
    async getHistory() {
      return { sites, totalSitesSeen: sites.length };
    },
    async getPageHtml({ urls }) {
      expect(urls).toEqual(["https://news.ycombinator.com/"]);
      return {
        pages: [{ url: urls[0]!, title: "Hacker News", html: pageHtml }],
        failed: [],
      };
    },
  };

  try {
    const result = await runHomepageBuild({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "test-only-placeholder",
      model: "test-model",
      bridge,
    });

    expect(result.code).toBe(source);
    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request.method).toBe("POST");
      expect(request.authorization).toBe("Bearer test-only-placeholder");
      expect(request.pathname.endsWith("/chat/completions")).toBe(true);
    }

    const historyTool = seen[1]!.messages.find((message) => message.role === "tool" && message.tool_call_id === "h-1");
    expect(historyTool).toBeDefined();
    expect(JSON.parse(historyTool!.content!).sites[0].domain).toBe(sites[0]!.domain);

    const pageTool = seen[2]!.messages.find((message) => message.role === "tool" && message.tool_call_id === "p-2");
    expect(pageTool).toBeDefined();
    expect(JSON.parse(pageTool!.content!).pages[0].html).toBe(pageHtml);
  } finally {
    server.stop(true);
  }
});
