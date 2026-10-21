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

const cleanSource = [
  'import React from "react";',
  "export default function PersonalizedHomepage() {",
  "  return <main />;",
  "}",
].join("\n");

const apiKey = "test-only-placeholder";

function submitCall(sourceText: string, id = "submit") {
  return {
    id,
    type: "function" as const,
    function: { name: "submitHomepage", arguments: JSON.stringify({ source: sourceText }) },
  };
}

function bridge(overrides: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    async getHistory() {
      return { sites: [], totalSitesSeen: 0 };
    },
    async getPageHtml() {
      return { pages: [], failed: [] };
    },
    ...overrides,
  };
}

function serve(handler: (request: Request, hits: number) => Response | Promise<Response>) {
  const seen: string[] = [];
  const bodies: Array<{ messages: Array<{ role: string; tool_call_id?: string; content?: string | null }> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push(request.url);
      const body = await request.json() as (typeof bodies)[number];
      bodies.push(body);
      return handler(request, seen.length);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { server, seen, bodies, base };
}

test("joins a base path once and keeps an existing completions path", async () => {
  const { server, seen, base } = serve(() => Response.json({
    choices: [{ message: { content: null, tool_calls: [submitCall(cleanSource)] } }],
  }));
  try {
    for (const baseUrl of [
      `${base}/v1/`,
      `${base}/v1/chat/completions`,
      `${base}/v1/chat/completions/`,
    ]) {
      const result = await runHomepageBuild({ baseUrl, apiKey, model: "test-model", bridge: bridge() });
      expect(result.code).toBe(cleanSource);
    }
    expect(seen.map((url) => new URL(url).pathname)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
    ]);
  } finally {
    server.stop(true);
  }
});

test("rejects a base URL that carries a query or a hash", async () => {
  const { server, seen, base } = serve(() => new Response("no", { status: 500 }));
  try {
    await expect(runHomepageBuild({
      baseUrl: `${base}/v1?x=1`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    })).rejects.toThrow("baseUrl must be an http or https URL without userinfo, query, or hash");
    await expect(runHomepageBuild({
      baseUrl: `${base}/v1#frag`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    })).rejects.toThrow("baseUrl must be an http or https URL without userinfo, query, or hash");
    expect(seen).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("clamps history bounds and keeps at most 8 page urls", async () => {
  let historyArgs: { daysToAnalyze: number; maxResults: number } | undefined;
  let pageUrls: string[] = [];
  const urls = Array.from({ length: 9 }, (_, index) => `https://example.com/${index}`);
  const { server, base } = serve((_request, hits) => {
    const call = hits === 1
      ? {
          id: "both",
          type: "function" as const,
          function: {
            name: "getHistory",
            arguments: JSON.stringify({ daysToAnalyze: 100, maxResults: -5 }),
          },
        }
      : hits === 2
        ? {
            id: "pages",
            type: "function" as const,
            function: { name: "getPageHtml", arguments: JSON.stringify({ urls }) },
          }
        : submitCall(cleanSource);
    return Response.json({ choices: [{ message: { content: null, tool_calls: [call] } }] });
  });
  try {
    await runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge({
        async getHistory(input) {
          historyArgs = input;
          return { sites: [], totalSitesSeen: 0 };
        },
        async getPageHtml(input) {
          pageUrls = input.urls;
          return { pages: [], failed: [] };
        },
      }),
    });
    expect(historyArgs).toEqual({ daysToAnalyze: 90, maxResults: 1 });
    expect(pageUrls).toEqual(urls.slice(0, 8));
  } finally {
    server.stop(true);
  }
});

test("returns every tool result from the same turn before the next request", async () => {
  const { server, bodies, base } = serve((_request, hits) => {
    if (hits === 1) {
      return Response.json({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: "h", type: "function", function: { name: "getHistory", arguments: "{}" } },
              {
                id: "p",
                type: "function",
                function: {
                  name: "getPageHtml",
                  arguments: JSON.stringify({ urls: ["https://example.com/a"] }),
                },
              },
            ],
          },
        }],
      });
    }
    return Response.json({ choices: [{ message: { content: null, tool_calls: [submitCall(cleanSource)] } }] });
  });
  try {
    const result = await runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge({
        async getPageHtml({ urls }) {
          return { pages: [{ url: urls[0]!, title: "A", html: "<p>a</p>" }], failed: [] };
        },
      }),
    });
    expect(result.code).toBe(cleanSource);
    const tools = bodies[1]!.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.tool_call_id)).toEqual(["h", "p"]);
    expect(JSON.parse(tools[1]!.content!).pages[0].html).toBe("<p>a</p>");
  } finally {
    server.stop(true);
  }
});

test("continues the loop after a tool throws", async () => {
  const { server, bodies, base } = serve((_request, hits) => Response.json({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          hits === 1
            ? { id: "h", type: "function", function: { name: "getHistory", arguments: "{}" } }
            : submitCall(cleanSource),
        ],
      },
    }],
  }));
  try {
    const result = await runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge({
        async getHistory() {
          throw new Error("history failed");
        },
      }),
    });
    expect(result.code).toBe(cleanSource);
    expect(JSON.parse(bodies[1]!.messages.at(-1)!.content!)).toEqual({ error: "history failed" });
  } finally {
    server.stop(true);
  }
});

test("continues the loop when tool arguments are not JSON", async () => {
  const { server, bodies, base } = serve((_request, hits) => Response.json({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          hits === 1
            ? { id: "h", type: "function", function: { name: "getHistory", arguments: "{" } }
            : submitCall(cleanSource),
        ],
      },
    }],
  }));
  try {
    const result = await runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    });
    expect(result.code).toBe(cleanSource);
    expect(JSON.parse(bodies[1]!.messages.at(-1)!.content!)).toEqual({
      error: "invalid JSON arguments for tool: getHistory",
    });
  } finally {
    server.stop(true);
  }
});

test("stops on a non-2xx chat completions response", async () => {
  const { server, base } = serve(() => new Response("secret-body", { status: 418 }));
  try {
    await expect(runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    })).rejects.toThrow(/^chat completions failed: HTTP 418$/);
  } finally {
    server.stop(true);
  }
});

test("stops when the model returns no tool calls", async () => {
  const { server, base } = serve(() => Response.json({
    choices: [{ message: { content: "plain text" } }],
  }));
  try {
    await expect(runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    })).rejects.toThrow("the model stopped without submitHomepage");
  } finally {
    server.stop(true);
  }
});

test("stops after 16 turns without submitHomepage", async () => {
  const { server, seen, base } = serve(() => Response.json({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "h", type: "function", function: { name: "getHistory", arguments: "{}" } }],
      },
    }],
  }));
  try {
    await expect(runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    })).rejects.toThrow("tool loop exceeded 16 turns");
    expect(seen).toHaveLength(16);
  } finally {
    server.stop(true);
  }
});

test("rejects homepage source that contains the API key and continues", async () => {
  const poisoned = cleanSource.replace("return <main />;", "return <main data-k=\"test-only-placeholder\" />;");
  const { server, bodies, base } = serve((_request, hits) => Response.json({
    choices: [{
      message: {
        content: null,
        tool_calls: [submitCall(hits === 1 ? poisoned : cleanSource, hits === 1 ? "bad" : "ok")],
      },
    }],
  }));
  try {
    const result = await runHomepageBuild({
      baseUrl: `${base}/v1`,
      apiKey,
      model: "test-model",
      bridge: bridge(),
    });
    expect(result.code).toBe(cleanSource);
    expect(result.code.includes(apiKey)).toBe(false);
    expect(JSON.parse(bodies[1]!.messages.find((message) => message.tool_call_id === "bad")!.content!)).toEqual({
      error: "source must be a PersonalizedHomepage React component",
    });
  } finally {
    server.stop(true);
  }
});
