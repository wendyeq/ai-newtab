import { DEFAULTS } from "./schemas";
import type { GetHistoryResult, RawSiteMetadata, SiteBucket, SiteDigest } from "./types";

const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
const EXPLORE_POOL_MULTIPLIER = 3;

export interface BuildHistoryDigestOptions {
  daysToAnalyze: number;
  maxResults: number;
  totalSitesSeen?: number;
  now?: number;
  random?: () => number;
}

/**
 * Collapse raw history into something that fits in a context window.
 *
 * Raw history can carry thousands of domains with uncapped `titles[]`/`urls[]` —
 * millions of tokens. It goes back to the model inline as a tool result, so it
 * is ranked, capped and stripped of URLs here, where that costs nothing.
 *
 * To prevent the same top-scoring domains from locking every build, slots are
 * split across three buckets when the history pool is large enough:
 * - `core`: top-scoring habitual sites (~50% of maxResults)
 * - `recent`: non-core sites visited in the last 48h, ordered by recency (~25%)
 * - `explore`: random sample from the next rank tier (~25%)
 */
export function buildHistoryDigest(
  sites: RawSiteMetadata[],
  opts: BuildHistoryDigestOptions,
): GetHistoryResult {
  const ranked = [...sites].sort((a, b) => b.relevanceScore - a.relevanceScore);
  const selected = selectBucketedSites(ranked, opts);

  const digest: SiteDigest[] = selected.map(({ site, bucket }) => ({
    domain: site.domain,
    visits: site.totalVisits,
    pages: site.uniquePages,
    lastVisit: new Date(site.lastVisitTime).toISOString(),
    score: Number(site.relevanceScore.toFixed(3)),
    bucket,
    sampleTitles: site.titles.slice(0, DEFAULTS.sampleTitles),
  }));

  return {
    windowDays: opts.daysToAnalyze,
    // Tell the model what was truncated. Hand it 30 of 3,400 domains without
    // saying so and it reasons as though it has seen everything.
    totalSitesSeen: opts.totalSitesSeen ?? sites.length,
    sites: digest,
  };
}

function selectBucketedSites(
  ranked: RawSiteMetadata[],
  opts: BuildHistoryDigestOptions,
): Array<{ site: RawSiteMetadata; bucket: SiteBucket }> {
  const max = Math.max(0, opts.maxResults);
  if (ranked.length <= max) {
    const coreCap = Math.max(1, Math.ceil(max * 0.5));
    const recentCutoff = (opts.now ?? Date.now()) - RECENT_WINDOW_MS;
    return ranked.map((site, index) => ({
      site,
      bucket:
        index < coreCap
          ? "core"
          : site.lastVisitTime >= recentCutoff
            ? "recent"
            : "explore",
    }));
  }

  const coreCount = Math.max(1, Math.round(max * 0.5));
  const recentTarget = Math.floor((max - coreCount) / 2);
  const recentCutoff = (opts.now ?? Date.now()) - RECENT_WINDOW_MS;
  const random = opts.random ?? Math.random;

  const picked: Array<{ site: RawSiteMetadata; bucket: SiteBucket }> = [];
  const used = new Set<string>();

  for (const site of ranked.slice(0, coreCount)) {
    picked.push({ site, bucket: "core" });
    used.add(site.domain);
  }

  const recentCandidates = ranked
    .slice(coreCount)
    .filter((site) => site.lastVisitTime >= recentCutoff)
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime || b.relevanceScore - a.relevanceScore);

  for (const site of recentCandidates.slice(0, recentTarget)) {
    picked.push({ site, bucket: "recent" });
    used.add(site.domain);
  }

  const remainingSlots = max - picked.length;
  if (remainingSlots > 0) {
    const explorePoolSize = Math.max(remainingSlots * EXPLORE_POOL_MULTIPLIER, max);
    const exploreCandidates = ranked
      .slice(coreCount)
      .filter((site) => !used.has(site.domain))
      .slice(0, explorePoolSize);

    for (const site of sampleWithoutReplacement(exploreCandidates, remainingSlots, random)) {
      picked.push({ site, bucket: "explore" });
      used.add(site.domain);
    }
  }

  if (picked.length < max) {
    for (const site of ranked) {
      if (picked.length >= max) break;
      if (used.has(site.domain)) continue;
      picked.push({ site, bucket: "explore" });
      used.add(site.domain);
    }
  }

  return picked;
}

function sampleWithoutReplacement<T>(items: T[], count: number, random: () => number): T[] {
  if (count >= items.length) return [...items];
  const pool = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

/** Filename-safe slug for a URL, used to build a readable mount path. */
export function slugifyUrl(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // fall through — a malformed URL still gets a stable slug
  }
  const slug = host.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return slug || "page";
}
