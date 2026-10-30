import { describe, expect, test } from "bun:test";
import { buildHistoryDigest, slugifyUrl } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

describe("buildHistoryDigest", () => {
  const sites = fixtureHistory();

  test("caps the site list at maxResults", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 5 });
    expect(digest.sites).toHaveLength(5);
  });

  test("reports what the model is not seeing", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 5 });
    expect(digest.totalSitesSeen).toBe(sites.length);
    expect(digest.totalSitesSeen).toBeGreaterThan(digest.sites.length);
  });

  test("ranks core bucket by relevance score descending and tags buckets", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 10 });
    const core = digest.sites.filter((s) => s.bucket === "core");
    expect(core).toHaveLength(5);
    const coreScores = core.map((s) => s.score);
    expect(coreScores).toEqual([...coreScores].sort((a, b) => b - a));
    expect(digest.sites[0].domain).toBe("news.ycombinator.com");
    expect(digest.sites.some((s) => s.bucket === "recent")).toBe(true);
    expect(digest.sites.some((s) => s.bucket === "explore")).toBe(true);
  });

  test("splits large history into core, recent (<=48h), and randomized explore buckets", () => {
    const now = 1_700_000_000_000;
    const hourMs = 60 * 60 * 1000;
    const pool = [
      // Top 4 core sites (high score)
      ...Array.from({ length: 4 }, (_, i) => ({
        domain: `core-${i}.example.com`,
        totalVisits: 100 - i,
        uniquePages: 20,
        lastVisitTime: now - 10 * hourMs,
        averageVisitsPerDay: 7,
        titles: [`Core ${i}`],
        urls: [`https://core-${i}.example.com`],
        relevanceScore: 0.95 - i * 0.02,
      })),
      // High-ish score but old (>48h ago) -> should land in explore pool, not recent
      ...Array.from({ length: 6 }, (_, i) => ({
        domain: `old-mid-${i}.example.com`,
        totalVisits: 40 - i,
        uniquePages: 8,
        lastVisitTime: now - (72 + i * 5) * hourMs,
        averageVisitsPerDay: 2,
        titles: [`Old Mid ${i}`],
        urls: [`https://old-mid-${i}.example.com`],
        relevanceScore: 0.65 - i * 0.02,
      })),
      // Lower total visits but visited in the last 48h -> should be picked for recent bucket
      {
        domain: "fresh-1.example.com",
        totalVisits: 3,
        uniquePages: 2,
        lastVisitTime: now - 2 * hourMs,
        averageVisitsPerDay: 0.2,
        titles: ["Fresh 1"],
        urls: ["https://fresh-1.example.com"],
        relevanceScore: 0.35,
      },
      {
        domain: "fresh-2.example.com",
        totalVisits: 4,
        uniquePages: 3,
        lastVisitTime: now - 12 * hourMs,
        averageVisitsPerDay: 0.3,
        titles: ["Fresh 2"],
        urls: ["https://fresh-2.example.com"],
        relevanceScore: 0.38,
      },
    ];

    const first = buildHistoryDigest(pool, {
      daysToAnalyze: 14,
      maxResults: 8,
      now,
      random: () => 0,
    });
    const second = buildHistoryDigest(pool, {
      daysToAnalyze: 14,
      maxResults: 8,
      now,
      random: () => 0.99,
    });

    expect(first.sites.filter((s) => s.bucket === "core").map((s) => s.domain)).toEqual([
      "core-0.example.com",
      "core-1.example.com",
      "core-2.example.com",
      "core-3.example.com",
    ]);
    expect(first.sites.filter((s) => s.bucket === "recent").map((s) => s.domain)).toEqual([
      "fresh-1.example.com",
      "fresh-2.example.com",
    ]);

    const firstExplore = first.sites.filter((s) => s.bucket === "explore").map((s) => s.domain);
    const secondExplore = second.sites.filter((s) => s.bucket === "explore").map((s) => s.domain);
    expect(firstExplore).toHaveLength(2);
    expect(secondExplore).toHaveLength(2);
    expect(firstExplore).not.toEqual(secondExplore);
  });

  test("drops urls[] entirely and caps sampleTitles", () => {
    const fat = [
      {
        domain: "example.com",
        totalVisits: 10,
        uniquePages: 9,
        lastVisitTime: Date.now(),
        averageVisitsPerDay: 1,
        titles: Array.from({ length: 50 }, (_, i) => `title ${i}`),
        urls: Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`),
        relevanceScore: 0.5,
      },
    ];
    const digest = buildHistoryDigest(fat, { daysToAnalyze: 14, maxResults: 10 });
    expect(digest.sites[0].sampleTitles).toHaveLength(5);
    expect(JSON.stringify(digest)).not.toContain("example.com/0");
  });

  test("emits ISO dates, not epoch millis", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 3 });
    for (const site of digest.sites) {
      expect(site.lastVisit).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("stays small enough to sit inline in a tool result", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 30 });
    // ~4 chars/token: a few thousand tokens, not millions.
    expect(JSON.stringify(digest).length).toBeLessThan(40_000);
  });
});

describe("slugifyUrl", () => {
  test("strips www and non-alphanumerics", () => {
    expect(slugifyUrl("https://www.news.ycombinator.com/news")).toBe("news_ycombinator_com");
  });

  test("survives a malformed url", () => {
    expect(slugifyUrl("not a url")).toBe("not_a_url");
  });

  test("never returns an empty slug", () => {
    expect(slugifyUrl("///")).toBe("page");
  });
});
