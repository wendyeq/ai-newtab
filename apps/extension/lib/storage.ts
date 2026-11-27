import { DEFAULT_BLOCKED_SITES } from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  baseUrl: "baseUrl",
  apiKey: "apiKey",
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  model: "model",
  autoRebuild: "autoRebuild",
  dailyTidy: "dailyTidy",
  tidyBatchSize: "tidyBatchSize",
  /** ISO timestamp of the last build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
  /** Last failure still waiting for the user. Cleared on success or dismiss. */
  lastBuildFailure: "lastBuildFailure",
  /** Daily bookmark-tidy run: when it last ran, where the pass stands. */
  lastTidyAttempt: "lastTidyAttempt",
  tidyPass: "tidyPass",
  /** A generated plan waiting for the user to apply or dismiss. */
  tidyPendingPlan: "tidyPendingPlan",
  /** Undo data for the most recent apply. */
  tidyUndo: "tidyUndo",
  /** Last tidy-run failure, cleared on the next successful run. */
  tidyFailure: "tidyFailure",
} as const;

/** Stable id so a new failure replaces the previous notification instead of stacking. */
export const FAILURE_NOTIFICATION_ID = "homepage-build-failure";

export interface BuildFailure {
  message: string;
  /** ISO timestamp of when this failure was recorded. */
  at: string;
  /** False when the build was only interrupted and will retry on its own. */
  needsAttention: boolean;
}

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface Settings {
  baseUrl: string;
  apiKey: string | null;
  systemPrompt: string;
  blockedSites: string[];
  model: string;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  /** Unset means on — tidy a small bookmark batch daily. */
  dailyTidy: boolean;
  /** Bookmarks reviewed per tidy run; default 15, clamped 5–50. */
  tidyBatchSize: number;
}

export const extensionStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.baseUrl,
    KEYS.apiKey,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.model,
    KEYS.autoRebuild,
    KEYS.dailyTidy,
    KEYS.tidyBatchSize,
  ]);
  return {
    baseUrl: (s[KEYS.baseUrl] as string | undefined) ?? "",
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    model: (s[KEYS.model] as string | undefined) ?? "",
    autoRebuild: s[KEYS.autoRebuild] !== false,
    dailyTidy: s[KEYS.dailyTidy] !== false,
    tidyBatchSize: (s[KEYS.tidyBatchSize] as number | undefined) ?? 15,
  };
}

export async function saveSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}

export async function loadBuildFailure(): Promise<BuildFailure | undefined> {
  return extensionStore.get<BuildFailure>(KEYS.lastBuildFailure);
}

export async function saveBuildFailure(failure: BuildFailure): Promise<void> {
  await extensionStore.set(KEYS.lastBuildFailure, failure);
}

export async function clearBuildFailure(): Promise<void> {
  await extensionStore.remove(KEYS.lastBuildFailure);
}
