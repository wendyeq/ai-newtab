import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isIntranetFolderPath, normalizeBlockList } from "./site-filter";
import type { BookmarkSample, GetBookmarksResult, RawBookmark } from "./types";

const TITLE_CAP = 100;
const URL_CAP = 300;
const FOLDER_PATH_CAP = 150;

export interface BuildBookmarkDigestOptions {
  maxResults: number;
  blockedSites?: string[];
  random?: () => number;
}

/**
 * Filter out intranet, private, non-HTTP(S), and user-blocked bookmarks, then
 * draw a randomized, domain-diverse sample so the homepage can surface saved
 * gems without sending the entire bookmark library into the prompt.
 */
export function buildBookmarkDigest(
  bookmarks: RawBookmark[],
  opts: BuildBookmarkDigestOptions,
): GetBookmarksResult {
  const blockedSites = normalizeBlockList(opts.blockedSites ?? DEFAULT_BLOCKED_SITES);
  const random = opts.random ?? Math.random;
  const max = Math.max(0, opts.maxResults);

  const seenUrls = new Set<string>();
  const eligible: Array<RawBookmark & { domain: string }> = [];

  for (const bookmark of bookmarks) {
    const url = bookmark.url.trim();
    if (!url || seenUrls.has(url)) continue;
    if (isIntranetFolderPath(bookmark.folderPath)) continue;
    if (!isAllowedUrl(url, blockedSites)) continue;

    let domain: string;
    try {
      domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }

    seenUrls.add(url);
    eligible.push({ ...bookmark, url, domain });
  }

  const sampled = sampleDiverseByDomain(eligible, max, random);

  const result: BookmarkSample[] = sampled.map((item) => ({
    title: item.title.trim().slice(0, TITLE_CAP),
    url: item.url.slice(0, URL_CAP),
    domain: item.domain,
    folderPath: item.folderPath.trim().slice(0, FOLDER_PATH_CAP),
    dateAdded: item.dateAdded ? new Date(item.dateAdded).toISOString() : null,
  }));

  return {
    totalBookmarksSeen: eligible.length,
    bookmarks: result,
  };
}

/**
 * Prefer distinct domains first (one random bookmark per randomly chosen domain),
 * then fill any remaining slots from leftover bookmarks if fewer unique domains
 * exist than `count`.
 */
function sampleDiverseByDomain<T extends { domain: string }>(
  items: T[],
  count: number,
  random: () => number,
): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count >= items.length) return shuffle(items, random);

  const byDomain = new Map<string, T[]>();
  for (const item of items) {
    const bucket = byDomain.get(item.domain);
    if (bucket) bucket.push(item);
    else byDomain.set(item.domain, [item]);
  }

  const domains = shuffle([...byDomain.keys()], random);
  const picked: T[] = [];
  const leftovers: T[] = [];

  for (const domain of domains) {
    const group = shuffle(byDomain.get(domain)!, random);
    if (picked.length < count) {
      picked.push(group[0]!);
      leftovers.push(...group.slice(1));
    } else {
      leftovers.push(...group);
    }
  }

  if (picked.length < count && leftovers.length > 0) {
    picked.push(...shuffle(leftovers, random).slice(0, count - picked.length));
  }

  return picked;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool;
}
