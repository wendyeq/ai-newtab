/**
 * Contracts shared by every host that can drive the homepage agent.
 *
 * The orchestrator is deliberately ignorant of *where* it runs. The extension
 * supplies a bridge backed by `chrome.history` / `chrome.tabs`; the Node test
 * harness supplies one backed by fixtures and `fetch`. Nothing in this package
 * may import `chrome`, `browser`, or `node:*`.
 */

/** One domain's worth of browsing history, narrowed to fit in a context window. */
export interface SiteDigest {
  domain: string;
  visits: number;
  pages: number;
  /** ISO 8601 — the model reasons about dates, not epoch milliseconds. */
  lastVisit: string;
  score: number;
  /** Capped. `urls[]` is dropped entirely. */
  sampleTitles: string[];
}

export interface GetHistoryResult {
  windowDays: number;
  /** What the model is *not* seeing. Without this it assumes the digest is exhaustive. */
  totalSitesSeen: number;
  sites: SiteDigest[];
}

export interface GetPageHtmlResult {
  pages: Array<{ url: string; title: string; html: string; truncated: boolean }>;
  /** Surfaced, never swallowed: partial failure is information the model needs. */
  failed: Array<{ url: string; reason: string }>;
}

/** Raw per-domain history, as a BrowserBridge returns it — before `buildHistoryDigest` narrows it. */
export interface RawSiteMetadata {
  domain: string;
  totalVisits: number;
  uniquePages: number;
  lastVisitTime: number;
  averageVisitsPerDay: number;
  titles: string[];
  urls: string[];
  relevanceScore: number;
}

export interface ScrapedPage {
  url: string;
  /** Where the page ended up after redirects, when the host can tell. */
  finalUrl?: string;
  /** The address the browser connected to for the page, when the host can tell it is not a proxy's. */
  ip?: string;
  title: string;
  html: string;
}

/** The two capabilities supplied by the host browser. */
export interface BrowserBridge {
  getHistory(args: {
    daysToAnalyze: number;
    maxResults: number;
  }): Promise<{ sites: RawSiteMetadata[]; totalSitesSeen: number }>;

  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;
}

export type RunPhase =
  | "setup"
  | "history"
  | "scraping"
  | "analyzing"
  | "writing"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  /** Assistant narration, for a progress panel. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface HomepageBuildResult {
  code: string;
}
