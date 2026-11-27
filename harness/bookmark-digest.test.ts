import { describe, expect, test } from "bun:test";
import {
  buildBookmarkDigest,
  isBlocked,
  isIntranetFolderPath,
  runHomepageBuild,
  type BrowserBridge,
  type RawBookmark,
} from "@homepage/agent-core";

function bm(
  title: string,
  url: string,
  folderPath = "Bookmarks Bar / Reading",
  dateAdded?: number,
): RawBookmark {
  return { title, url, folderPath, dateAdded };
}

describe("isIntranetFolderPath", () => {
  test("detects Chinese and English intranet folder names", () => {
    for (const path of [
      "书签栏 / 公司内网",
      "书签栏 / 公司内网 / 监控",
      "书签栏 / 内网工具",
      "书签栏 / 公司 / 文档",
      "Bookmarks Bar / Intranet / Wiki",
      "Bookmarks Bar / Corp / Tools",
      "Bookmarks Bar / Internal / Dashboards",
      "Bookmarks Bar / VPN",
      "Bookmarks Bar / OA",
    ]) {
      expect(isIntranetFolderPath(path)).toBe(true);
    }
  });

  test("does not false-positive on normal reading or tech folders", () => {
    for (const path of [
      "",
      "Bookmarks Bar / Reading",
      "Bookmarks Bar / Internationalization",
      "Bookmarks Bar / Corporate Finance",
      "Bookmarks Bar / Tech / Blogs",
      "书签栏 / 技术博客",
      "书签栏 / 开源项目",
    ]) {
      expect(isIntranetFolderPath(path)).toBe(false);
    }
  });
});

describe("buildBookmarkDigest", () => {
  test("excludes private/intranet hosts, intranet folders, non-http URLs, and blocked sites", () => {
    const raw: RawBookmark[] = [
      bm("Local Dev", "http://localhost:3000/app"),
      bm("LAN Router", "http://192.168.1.1/"),
      bm("Private 10", "http://10.0.2.15/wiki"),
      bm("Corp TLD", "https://portal.acme.corp/"),
      bm("Intranet TLD", "https://hr.acme.intranet/"),
      bm("Bare host", "http://jira/browse/ABC-1"),
      bm("Intranet folder", "https://docs.public-saas.com/secret", "书签栏 / 公司内网 / 文档"),
      bm("Company folder", "https://notion.so/team", "书签栏 / 公司 / 常用"),
      bm("User blocked", "https://wiki.mycompany.com/eng", "Bookmarks Bar / Tech"),
      bm("Bookmarklet", "javascript:void(0)"),
      bm("Chrome page", "chrome://extensions"),
      bm("Public blog", "https://jvns.ca/blog/"),
      bm("Rust blog", "https://blog.rust-lang.org/"),
    ];

    const digest = buildBookmarkDigest(raw, {
      maxResults: 10,
      blockedSites: ["*.mycompany.com"],
      random: () => 0.5,
    });

    expect(digest.totalBookmarksSeen).toBe(2);
    expect(digest.bookmarks.map((b) => b.url).sort()).toEqual([
      "https://blog.rust-lang.org/",
      "https://jvns.ca/blog/",
    ]);
  });

  test("blocks .corp and .intranet via isBlocked", () => {
    expect(isBlocked("https://git.acme.corp/repo", [])).toBe(true);
    expect(isBlocked("https://oa.acme.intranet/", [])).toBe(true);
  });

  test("deduplicates identical URLs and emits ISO dates", () => {
    const ts = Date.UTC(2026, 4, 1, 12, 0, 0);
    const raw = [
      bm("First", "https://example.com/a", "Reading", ts),
      bm("Duplicate", "https://example.com/a", "Other", ts),
      bm("No date", "https://example.org/b", "Reading"),
    ];
    const digest = buildBookmarkDigest(raw, { maxResults: 10, blockedSites: [], random: () => 0.1 });
    expect(digest.totalBookmarksSeen).toBe(2);
    const byUrl = new Map(digest.bookmarks.map((b) => [b.url, b]));
    expect(byUrl.get("https://example.com/a")?.dateAdded).toBe("2026-05-01T12:00:00.000Z");
    expect(byUrl.get("https://example.org/b")?.dateAdded).toBeNull();
  });

  test("prefers distinct domains before repeating a domain", () => {
    const raw: RawBookmark[] = [
      ...Array.from({ length: 10 }, (_, i) => bm(`GH ${i}`, `https://github.com/org/repo-${i}`)),
      bm("Blog A", "https://a.example.com/post"),
      bm("Blog B", "https://b.example.com/post"),
      bm("Blog C", "https://c.example.com/post"),
    ];
    const digest = buildBookmarkDigest(raw, { maxResults: 4, blockedSites: [], random: () => 0.3 });
    expect(digest.bookmarks).toHaveLength(4);
    const uniqueDomains = new Set(digest.bookmarks.map((b) => b.domain));
    expect(uniqueDomains.size).toBe(4);
  });

  test("fills remaining slots from leftover bookmarks when unique domains < maxResults", () => {
    const raw: RawBookmark[] = [
      bm("GH 1", "https://github.com/org/1"),
      bm("GH 2", "https://github.com/org/2"),
      bm("GH 3", "https://github.com/org/3"),
      bm("Blog", "https://jvns.ca/"),
    ];
    const digest = buildBookmarkDigest(raw, { maxResults: 3, blockedSites: [], random: () => 0.4 });
    expect(digest.bookmarks).toHaveLength(3);
    expect(digest.totalBookmarksSeen).toBe(4);
  });
});

describe("orchestrator getBookmarks tool", () => {
  test("samples bookmarks via bridge, applies blockedSites, and logs count", async () => {
    const source =
      'import React from "react"; export default function PersonalizedHomepage() { return <main />; }';
    const toolResults: Array<{ tool_call_id: string; content: string }> = [];
    const logs: string[] = [];
    let turn = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
        };
        turn++;
        const last = body.messages.at(-1);
        if (last?.role === "tool" && last.tool_call_id && last.content) {
          toolResults.push({ tool_call_id: last.tool_call_id, content: last.content });
        }
        const call =
          turn === 1
            ? { id: "bm-1", name: "getBookmarks", arguments: JSON.stringify({ maxResults: 5 }) }
            : { id: "sub-2", name: "submitHomepage", arguments: JSON.stringify({ source }) };
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
              },
            },
          ],
        });
      },
    });

    const bridge: BrowserBridge = {
      async getHistory() {
        return { sites: [], totalSitesSeen: 0 };
      },
      async getBookmarks() {
        return [
          bm("Public Gem", "https://jvns.ca/", "Bookmarks Bar / Blogs"),
          bm("Company Intranet", "https://oa.mycorp.com/", "Bookmarks Bar / Tech"),
          bm("Intranet Folder", "https://notion.so/secret", "书签栏 / 公司内网"),
        ];
      },
      async getPageHtml() {
        return { pages: [], failed: [] };
      },
    };

    try {
      const result = await runHomepageBuild({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-only-placeholder",
        model: "test-model",
        bridge,
        blockedSites: ["mycorp.com"],
        callbacks: { onLog: (line) => logs.push(line) },
      });

      expect(result.code).toBe(source);
      expect(toolResults).toHaveLength(1);
      const parsed = JSON.parse(toolResults[0]!.content);
      expect(parsed.totalBookmarksSeen).toBe(1);
      expect(parsed.bookmarks).toHaveLength(1);
      expect(parsed.bookmarks[0].url).toBe("https://jvns.ca/");
      expect(logs).toContain("bookmarks: 1 of 1 bookmarks");
    } finally {
      server.stop(true);
    }
  });
});
