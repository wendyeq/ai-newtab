import type { BrowserBridge } from "@homepage/agent-core";
import { getFlatBookmarks } from "./bookmarks";
import { getHistorySites } from "./history";
import { scrapeUrls } from "./scraper";

/**
 * The capabilities only a real browser has, implemented over chrome.history,
 * chrome.bookmarks, and chrome.tabs. Runs in the service worker, in-process with the agent loop.
 */
export const browserBridge: BrowserBridge = {
  getHistory: ({ daysToAnalyze, maxResults }) => getHistorySites(daysToAnalyze, maxResults),
  getBookmarks: () => getFlatBookmarks(),
  getPageHtml: ({ urls, loadDelayMs, onLog }) =>
    scrapeUrls(urls, { loadDelay: loadDelayMs, onLog }),
};
