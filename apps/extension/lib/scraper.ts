import { isPrivateAddress, type BrowserBridge, type ScrapedPage } from "@homepage/agent-core";
import sanitizeHtml from "sanitize-html";

type ScrapeReport = Awaited<ReturnType<BrowserBridge["getPageHtml"]>>;

/** What entrypoints/scraper.content.ts returns from inside the page. */
interface ScraperResult {
  url: string;
  title: string;
  html: string;
}

interface ScrapeOptions {
  loadDelay?: number; // Delay in ms after page load completes
  maxRetries?: number; // Maximum number of retry attempts
  retryDelay?: number; // Initial retry delay in ms
  timeout?: number; // Maximum time to wait for a page in ms
  extractTimeout?: number; // Maximum time for one content-script extraction in ms
  concurrentTabs?: number; // Number of tabs to process concurrently
  challengeTimeout?: number; // How long to wait for an anti-bot check to resolve
  onLog?: (line: string) => void; // Progress notes for the build log
}

const DEFAULT_OPTIONS: Required<Omit<ScrapeOptions, "onLog">> = {
  loadDelay: 8000, // 8 seconds default delay after load
  maxRetries: 3,
  retryDelay: 1000, // 1 second initial retry delay
  timeout: 30000, // 30 seconds timeout
  extractTimeout: 20000, // 20 seconds per extraction attempt
  concurrentTabs: 3, // Process up to 3 tabs at once
  challengeTimeout: 45000, // 45 seconds for a JS anti-bot check to run
};

type ScrapeOpts = Required<Omit<ScrapeOptions, "onLog">> & Pick<ScrapeOptions, "onLog">;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Title or visible text of an interactive verification page (Cloudflare, Turnstile, custom gates). */
const CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking (your browser|if the site)/i,
  /verify you are human/i,
  /one more step/i,
  /attention required/i,
  /security check/i,
  /ddos guard/i,
  /请稍候/,
  /安全验证/,
  /正在验证/,
  /人机验证/,
  /验证您/,
];
/** Challenge shells carry little visible text; a real article under these titles is never this thin. */
const CHALLENGE_TEXT_LIMIT = 2000;
/** Markers in the markup of the usual JS-gated shells. */
const CHALLENGE_HTML_MARKERS = ["cf-chl", "turnstile", "challenge-platform"];

interface PageProbe {
  title: string;
  bodyText: string;
  /** The markup needed to spot challenge shells, not the whole page. */
  headHtml: string;
  visibility: string;
}

/** A small read of title/text/visibility used to spot an anti-bot gate. */
async function probeTab(tabId: number): Promise<PageProbe | null> {
  return browser.scripting
    .executeScript({
      target: { tabId },
      func: () => ({
        title: document.title ?? "",
        bodyText: (document.body?.innerText ?? "").slice(0, 4000),
        headHtml: (
          (document.documentElement?.innerHTML ?? "") .slice(0, 6000) +
          (document.body?.innerHTML ?? "").slice(0, 6000)
        ),
        visibility: document.visibilityState,
      }),
    })
    .then((r) => (r?.[0]?.result as PageProbe | undefined) ?? null)
    .catch(() => null);
}

function probeLooksLikeChallenge(probe: PageProbe | null): boolean {
  if (!probe) return false;
  const haystack = `${probe.title}\n${probe.bodyText}`;
  if (probe.bodyText.trim().length > CHALLENGE_TEXT_LIMIT) return false;
  return (
    CHALLENGE_PATTERNS.some((p) => p.test(haystack)) ||
    CHALLENGE_HTML_MARKERS.some((m) => probe.headHtml.includes(m))
  );
}

function looksLikeChallenge(result: ScraperResult): boolean {
  if (CHALLENGE_PATTERNS.some((p) => p.test(result.title ?? ""))) return true;
  const text = result.html.replace(/<[^>]*>/g, " ");
  if (CHALLENGE_PATTERNS.some((p) => p.test(text)) && text.trim().length <= CHALLENGE_TEXT_LIMIT)
    return true;
  return CHALLENGE_HTML_MARKERS.some((m) => result.html.slice(0, 6000).includes(m));
}

/** Only one tab can be active per window, so challenge recovery runs one at a time. */
let challengeLock: Promise<void> = Promise.resolve();

/**
 * A scraper tab is never focused, so its timers are throttled and a JS anti-bot
 * check can stall forever. Make the tab active and shrink the window so the
 * check can run and the user could click an interactive gate; if it still
 * reports itself hidden (occluded on screen), focus the window for a moment so
 * the check's timers run.
 */
async function resolveChallenge(
  tabId: number,
  windowId: number,
  deadlineMs: number
): Promise<boolean> {
  const run = challengeLock.then(async () => {
    try {
      await browser.tabs.update(tabId, { active: true });
      await browser.windows.update(windowId, {
        focused: false,
        state: "normal",
        ...(await scraperWindowPlacement(480, 360)),
      });
    } catch {
      return false;
    }
    const deadline = Date.now() + deadlineMs;
    let nudged = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const probe = await probeTab(tabId);
      if (!probe) continue; // navigating between the gate and the real page
      if (!probeLooksLikeChallenge(probe)) return true;
      if (!nudged && probe.visibility === "hidden") {
        nudged = true;
        // A moment of real focus unthrottles an occluded window; steal it back
        // quickly and keep the window small so the interruption stays minor.
        await browser.windows.update(windowId, { focused: true }).catch(() => {});
        await sleep(1500);
        await browser.windows.update(windowId, { focused: false }).catch(() => {});
      }
    }
    return false;
  });
  challengeLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Scroll-and-snapshot extraction, retried, with a plain DOM snapshot as the
 * last resort. Returns the page, or null when nothing usable came back.
 */
async function extractContent(
  tabId: number,
  opts: ScrapeOpts
): Promise<ScraperResult | null> {
  let result: ScraperResult | null = null;
  let retryCount = 0;
  let currentDelay = opts.retryDelay;

  while (retryCount <= opts.maxRetries && !result) {
    try {
      // Scrolls to trigger lazy content, then returns { title, html }.
      // A page can stall the script indefinitely (throttled timers, a busy
      // main thread), and nothing else would ever end the build's scrape step.
      const injectionResults = await withTimeout(
        browser.scripting.executeScript({
          target: { tabId },
          files: ["/content-scripts/scraper.js"],
        }),
        opts.extractTimeout,
        `Extracting tab ${tabId}`
      );

      if (
        injectionResults &&
        injectionResults[0] &&
        injectionResults[0].result
      ) {
        result = injectionResults[0].result as ScraperResult;

        // Validate result has content
        if (!result.html || result.html.trim() === "") {
          result = null;
          throw new Error("Empty content extracted");
        }
      }
    } catch (error) {
      console.warn(`Attempt ${retryCount + 1} failed for tab ${tabId}:`, error);
      // A page that timed out will time out again; don't spend the budget twice.
      if (error instanceof TimeoutError) break;

      if (retryCount < opts.maxRetries) {
        // Wait before retry with exponential backoff
        await sleep(currentDelay);
        currentDelay *= 2; // Exponential backoff
      }
    }

    retryCount++;
  }

  // Fall back to the page as it stands, without the scroll pass, rather than
  // losing it: on a busy machine a background tab's timers can be throttled
  // far past the extraction budget.
  if (!result) {
    result = await withTimeout(
      browser.scripting.executeScript({
        target: { tabId },
        func: () => ({ url: location.href, title: document.title, html: document.body?.innerHTML ?? "" }),
      }),
      SNAPSHOT_TIMEOUT_MS,
      `Snapshotting tab ${tabId}`
    )
      .then((injection) => {
        const snapshot = injection?.[0]?.result as ScraperResult | undefined;
        return snapshot?.html?.trim() ? snapshot : null;
      })
      .catch(() => null);
  }
  return result;
}

interface ScrapeOutcome {
  page?: ScrapedPage;
  reason?: string;
}

/**
 * The address the extension's own API requests connect to. A private one means a
 * proxy (or similar) sits in the path, so the address a scraped page arrives from
 * says nothing about the page's host and is not reported.
 */
let apiAddress: string | undefined;
const recordApiAddress = (details: { ip?: string }) => {
  apiAddress = details.ip;
};

export function armProxyProbe(baseUrl: string) {
  const origin = new URL(baseUrl.trim()).origin;
  apiAddress = undefined;
  browser.webRequest.onResponseStarted.removeListener(recordApiAddress);
  browser.webRequest.onResponseStarted.addListener(recordApiAddress, {
    urls: [`${origin}/*`],
    tabId: -1,
  });
}

/** Keep content and links; drop scripts, styles, attributes and empty wrappers. */
function cleanHtmlForLLM(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      // Text content
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "a",
      "em",
      "strong",
      "b",
      "i",
      "blockquote",
      "code",
      "pre",
      // Lists
      "ul",
      "ol",
      "li",
      // Tables
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      // Media
      "img",
      "figure",
      "figcaption",
      // Structure
      "div",
      "span",
      "br",
      "hr",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    // Remove empty tags
    exclusiveFilter: (frame) => {
      return !frame.text.trim() && !frame.tag.match(/^(img|br|hr)$/);
    },
  });
}

/** Bottom-right placement anchored on the focused window's bounds, so the
 * scraper window sits out of the way but stays on screen — a fully occluded
 * window reports visibilityState "hidden" and its timers stay throttled. */
async function scraperWindowPlacement(
  width: number,
  height: number
): Promise<{ width: number; height: number; left?: number; top?: number }> {
  try {
    const anchor = await browser.windows.getLastFocused();
    if (anchor.left === undefined || anchor.top === undefined || !anchor.width || !anchor.height) {
      return { width, height };
    }
    const margin = 24;
    return {
      width,
      height,
      left: Math.max(anchor.left, anchor.left + anchor.width - width - margin),
      top: Math.max(anchor.top, anchor.top + anchor.height - height - margin),
    };
  } catch {
    return { width, height };
  }
}

/** Scrape in a separate unfocused window so tabs don't flash in front of the user. */
async function createScraperWindow(): Promise<number> {
  const win = await browser.windows.create({
    focused: false,
    state: "normal",
    ...(await scraperWindowPlacement(1200, 800)),
  });
  if (win?.id === undefined) throw new Error("Could not open the scraper window");
  return win.id;
}

/** A plain read of the DOM, used when the scrolling extraction doesn't finish. */
const SNAPSHOT_TIMEOUT_MS = 5000;

class TimeoutError extends Error {}

/** Reject if `promise` hasn't settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function scrapeUrl(
  url: string,
  windowId: number,
  opts: ScrapeOpts,
  addressOf: (tabId: number) => string | undefined
): Promise<ScrapeOutcome> {
  let tabId: number | undefined;
  try {
    // Create a new tab in the scraper window
    const tab = await browser.tabs.create({
      url,
      active: false,
      windowId,
    });
    tabId = tab.id!;

    // Wait for the tab to load with timeout
    const loadComplete = await waitForTabLoad(tabId, opts.timeout);

    if (!loadComplete) {
      console.error(`Timeout waiting for ${url} to load`);
      return { reason: "failed to load within timeout" };
    }

    // Additional delay for dynamic content
    await sleep(opts.loadDelay);

    let result = await extractContent(tabId, opts);

    // An anti-bot shell returns "successfully": it is a normal page that
    // finishes loading, but its JS check stalls in a never-focused tab.
    if (result && looksLikeChallenge(result)) {
      opts.onLog?.(`verification page on ${new URL(url).hostname}; waiting for it to clear`);
      const cleared = await resolveChallenge(tabId, windowId, opts.challengeTimeout);
      if (!cleared) {
        return { reason: "anti-bot verification did not finish; open the site in your browser to clear it" };
      }
      await waitForTabLoad(tabId, 10000);
      await sleep(opts.loadDelay);
      result = await extractContent(tabId, opts);
      if (result && looksLikeChallenge(result)) {
        return { reason: "anti-bot verification did not finish; open the site in your browser to clear it" };
      }
    }

    // The address of the document just extracted.
    const ip = addressOf(tabId);

    if (result) {
      return {
        page: {
          url,
          finalUrl: result.url,
          ip,
          title: result.title,
          html: cleanHtmlForLLM(result.html),
        },
      };
    }
    console.error(
      `Failed to extract content from ${url} after ${opts.maxRetries} retries`
    );
    return { reason: "failed to load or extract within timeout" };
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return { reason: "failed to load or extract within timeout" };
  } finally {
    // Close the tab, even if it already went away.
    if (tabId !== undefined) await browser.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * Load each URL in the user's real (logged-in) browser and return sanitized HTML,
 * reporting failures rather than dropping them — the model needs to know which
 * of the pages it asked for didn't come back.
 */
export async function scrapeUrls(
  urls: string[],
  options?: ScrapeOptions
): Promise<ScrapeReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pages: ScrapedPage[] = [];
  const failed: ScrapeReport["failed"] = [];

  // Create a separate window for scraping
  const windowId = await createScraperWindow();

  // Before any tab loads: the address each tab's document was served from, last response wins.
  // Keyed by tab and read only for the scraper's own tabs: a windowId filter matches nothing
  // here, since these events report no windowId.
  const addresses = new Map<number, string | undefined>();
  const recordAddress = (details: { tabId: number; ip?: string }) => {
    addresses.set(details.tabId, details.ip);
  };
  const direct = apiAddress !== undefined && !isPrivateAddress(apiAddress);
  if (direct) {
    browser.webRequest.onResponseStarted.addListener(recordAddress, {
      urls: ["http://*/*", "https://*/*"],
      types: ["main_frame"],
    });
  }
  const addressOf = (tabId: number) => addresses.get(tabId);

  try {
    // Keep up to `concurrentTabs` pages loading at once; a slow page holds up
    // only its own slot, not a whole batch.
    const outcomes: ScrapeOutcome[] = new Array(urls.length).fill({});
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const i = next++;
        outcomes[i] = await scrapeUrl(urls[i], windowId, opts, addressOf);
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrentTabs, urls.length) }, worker));

    urls.forEach((url, i) => {
      const outcome = outcomes[i];
      if (outcome.page) pages.push(outcome.page);
      else failed.push({ url, reason: outcome.reason ?? "failed to load or extract within timeout" });
    });
  } finally {
    browser.webRequest.onResponseStarted.removeListener(recordAddress);
    // Close the scraper window
    try {
      await browser.windows.remove(windowId);
    } catch (error) {
      console.error("Failed to close scraper window:", error);
    }
  }

  return { pages, failed };
}

async function waitForTabLoad(
  tabId: number,
  timeout: number
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const listener = (changedTabId: number, changeInfo: { status?: string }) => {
      if (changedTabId === tabId && changeInfo.status === "complete") {
        browser.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
        resolve(true);
      }
    };

    // Set timeout
    timeoutId = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeout);

    browser.tabs.onUpdated.addListener(listener);

    // The tab may have finished loading before the listener was attached.
    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") listener(tabId, { status: "complete" });
      })
      .catch(() => {});
  });
}
