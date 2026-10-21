import { expect, test } from "bun:test";
import { isBlocked, isPrivateAddress, normalizeBlockList, runHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

test("normalizes pasted hosts and URLs", () => {
  expect(normalizeBlockList([" HTTPS://WWW.Google.COM/path ", "", " # comment", "*.Example.COM", "google.com"])).toEqual(["google.com", "*.example.com"]);
});

test("matches hosts and subdomains without matching lookalikes", () => {
  for (const host of ["google.com", "mail.google.com", "https://WWW.GOOGLE.COM./path"]) {
    expect(isBlocked(host, ["google.com"])).toBe(true);
  }
  expect(isBlocked("deep.sub.example.com", ["*.example.com"])).toBe(true);
  expect(isBlocked("example.com", ["*.example.com"])).toBe(true);
  for (const url of ["https:/mail.google.com", "https:\\mail.google.com", "HTTPS://user:pw@Mail.Google.com:443/x"]) {
    expect(isBlocked(url, ["google.com"])).toBe(true);
  }
  expect(isBlocked("localhost:3000", ["localhost"])).toBe(true);
  expect(isBlocked("notgoogle.com", ["google.com"])).toBe(false);
  expect(isBlocked("google.com.evil.test", ["google.com"])).toBe(false);
});

async function runTools(
  urls: string[],
  blockedSites?: string[] | (() => Promise<string[]>),
  afterHistory?: () => void,
  scrape?: BrowserBridge["getPageHtml"],
) {
  const results: Array<{ role: string; tool_call_id: string; content: string }> = [];
  const calls: string[][] = [];
  const logs: string[] = [];
  let requests = 0;
  const source = 'import React from "react"; export default function PersonalizedHomepage() { return <main />; }';
  const steps = [
    { id: "history", name: "getHistory", input: { maxResults: 1 } },
    { id: "pages", name: "getPageHtml", input: { urls } },
    { id: "submit", name: "submitHomepage", input: { source } },
  ];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/chat/completions");
      const body = await request.json() as { messages: typeof results };
      requests++;
      const last = body.messages.at(-1)!;
      if (last.role === "tool") {
        results.push(last);
        if (last.tool_call_id === "history") afterHistory?.();
      }
      const next = steps[requests - 1] ?? steps[2]!;
      return Response.json({ choices: [{ message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: next.id, type: "function", function: { name: next.name, arguments: JSON.stringify(next.input) } }],
      } }] });
    },
  });
  const bridge: BrowserBridge = {
    getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
    getPageHtml: async (args) => {
      calls.push(args.urls);
      if (scrape) return scrape(args);
      return { pages: [], failed: args.urls.map(url => ({ url, reason: "unavailable" })) };
    },
  };
  try {
    await runHomepageBuild({
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: "test-only-placeholder",
      model: "test-model",
      bridge,
      blockedSites,
      callbacks: { onLog: line => logs.push(line) },
    });
    expect(requests).toBe(3);
    expect(results.map(result => result.tool_call_id)).toEqual(["history", "pages"]);
    return { results, calls, logs };
  } finally {
    server.stop(true);
  }
}

test("filters history before capping and excludes blocked sites from the count", async () => {
  const { results } = await runTools([], ["news.ycombinator.com"]);
  const digest = JSON.parse(results[0].content);
  expect(digest.totalSitesSeen).toBe(46);
  expect(digest.sites).toHaveLength(1);
  expect(JSON.stringify(digest)).not.toContain("news.ycombinator.com");
});

test("uses newly saved blocked sites for the next tool call in an active build", async () => {
  let savedSites: string[] = [];
  const { results, calls } = await runTools(
    ["https://news.ycombinator.com"],
    async () => savedSites,
    () => { savedSites = ["news.ycombinator.com"]; },
  );
  expect(results[0].content).toContain("news.ycombinator.com");
  expect(calls).toEqual([]);
  expect(JSON.parse(results[1].content)).toEqual({
    pages: [],
    failed: [{ url: "https://news.ycombinator.com", reason: "blocked by the user's settings" }],
  });
});

test("never forwards blocked or non-http URLs", async () => {
  const urls = ["https://bank.test", "https://sub.bank.test", "https:/bank.test", "https:\\bank.test", "file:///secret", "chrome://settings", "javascript:alert(1)", "not a url"];
  const { results, calls, logs } = await runTools(urls, ["bank.test"]);
  expect(calls).toEqual([]);
  expect(JSON.parse(results[1].content)).toEqual({ pages: [], failed: urls.map(url => ({ url, reason: "blocked by the user's settings" })) });
  expect(logs).toContain("blocked: 8 url(s)");
});

test("only forwards allowed URLs in mixed batches and logs blocks before the bridge call", async () => {
  const order: string[] = [];
  const { results, calls, logs } = await runTools(
    ["https://bank.test", "https://public.test"],
    ["bank.test"],
    undefined,
    async ({ urls }) => {
      order.push("bridge");
      return { pages: [], failed: urls.map(url => ({ url, reason: "unavailable" })) };
    },
  );
  expect(calls).toEqual([["https://public.test"]]);
  expect(logs).toContain("blocked: 1 url(s)");
  expect(order).toEqual(["bridge"]);
  expect(JSON.parse(results[1].content).failed).toEqual([
    { url: "https://bank.test", reason: "blocked by the user's settings" },
    { url: "https://public.test", reason: "unavailable" },
  ]);
});

test("uses defaults when unset and honors an explicitly empty list", async () => {
  expect((await runTools(["https://mail.google.com"])).calls).toEqual([]);
  expect((await runTools(["https://mail.google.com"], [])).calls).toEqual([["https://mail.google.com"]]);
});

test("always blocks loopback, private and local-network hosts", () => {
  for (const url of [
    "http://localhost:5173", "http://127.0.0.2/", "http://0.0.0.0:8080", "http://2130706433/",
    "http://[::1]:3000/", "http://[::ffff:127.0.0.1]/", "http://[fd12::1]/", "http://[fe80::1]/",
    "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.100.1.1/", "http://router/", "http://printer.local/", "https://wiki.corp.internal/",
    "http://nas.lan/", "http://box.home.arpa/",
  ]) {
    expect(isBlocked(url, [])).toBe(true);
  }
  for (const url of ["https://8.8.8.8/", "https://172.32.0.1/", "https://192.169.0.1/", "https://news.ycombinator.com/", "https://[2606:4700::1111]/"]) {
    expect(isBlocked(url, [])).toBe(false);
  }
});

test("drops pages that redirected to a blocked host from the tool JSON", async () => {
  const redirector = "https://www.google.com/url?q=https://mail.google.com/";
  const { results } = await runTools([redirector, "https://public.test/"], ["mail.google.com"], undefined, async ({ urls }) => ({
    pages: [
      { url: urls[0]!, finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox", html: "<p>secret</p>" },
      { url: urls[1]!, finalUrl: "https://public.test/", title: "Public", html: "<p>news</p>" },
    ],
    failed: [],
  }));
  const out = JSON.parse(results[1].content);
  expect(out.pages).toEqual([{ url: "https://public.test/", title: "Public", html: "<p>news</p>", truncated: false }]);
  expect(out.failed).toEqual([{ url: redirector, reason: "blocked by the user's settings" }]);
  expect(results[1].content).not.toContain("Inbox");
  expect(results[1].content).not.toContain("<p>secret</p>");
});

test("classifies the addresses webRequest reports", () => {
  for (const ip of ["127.0.0.1", "192.168.179.1", "10.0.0.5", "::1", "::ffff:127.0.0.1", "fe80::1", "fd12::1"]) {
    expect(isPrivateAddress(ip)).toBe(true);
  }
  for (const ip of ["160.79.104.10", "8.8.8.8", "2606:4700::1111", "not an address"]) {
    expect(isPrivateAddress(ip)).toBe(false);
  }
});

test("drops private-address pages but keeps pages with no reported address", async () => {
  const urls = ["http://fritz.box/", "https://public.test/", "https://unknown.test/"];
  const { results } = await runTools(urls, [], undefined, async ({ urls }) => ({
    pages: [
      { url: urls[0]!, finalUrl: urls[0], ip: "192.168.179.1", title: "FRITZ!Box", html: "<p>router</p>" },
      { url: urls[1]!, finalUrl: urls[1], ip: "160.79.104.10", title: "Public", html: "<p>news</p>" },
      { url: urls[2]!, finalUrl: urls[2], title: "No address", html: "<p>kept</p>" },
    ],
    failed: [],
  }));
  const out = JSON.parse(results[1].content);
  expect(out.pages).toEqual([
    { url: "https://public.test/", title: "Public", html: "<p>news</p>", truncated: false },
    { url: "https://unknown.test/", title: "No address", html: "<p>kept</p>", truncated: false },
  ]);
  expect(out.failed).toEqual([{ url: "http://fritz.box/", reason: "blocked by the user's settings" }]);
  expect(results[1].content).not.toContain("FRITZ!Box");
  expect(results[1].content).not.toContain("<p>router</p>");
});

test("rechecks the blocklist after the bridge returns", async () => {
  let savedSites: string[] = [];
  const { results, calls } = await runTools(
    ["https://public.test/"],
    async () => savedSites,
    undefined,
    async () => {
      savedSites = ["public.test"];
      return { pages: [{ url: "https://public.test/", title: "Newly blocked", html: "<p>private content</p>" }], failed: [] };
    },
  );
  expect(calls).toEqual([["https://public.test/"]]);
  expect(JSON.parse(results[1].content)).toEqual({
    pages: [],
    failed: [{ url: "https://public.test/", reason: "blocked by the user's settings" }],
  });
  expect(results[1].content).not.toContain("Newly blocked");
  expect(results[1].content).not.toContain("private content");
});
