import { credentialNeedle, runHomepageBuild, type RunPhase } from "@homepage/agent-core";
import { REBUILD_AFTER_HOURS, shouldAutoRebuild } from "./auto-rebuild";
import { browserBridge } from "./browser-bridge";
import {
  INITIAL_BUILD_STATE,
  LOG_RETENTION,
  stepForPhase,
  type BuildMsg,
  type BuildState,
  type PageMsg,
} from "./protocol";
import { armProxyProbe } from "./scraper";
import {
  FAILURE_NOTIFICATION_ID,
  KEYS,
  clearBuildFailure,
  extensionStore,
  loadBuildFailure,
  loadHomepage,
  loadSettings,
  saveBuildFailure,
  saveHomepage,
} from "./storage";
import { validateHomepageTsx } from "./transpile";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/**
 * While a turn is active, ping a cheap chrome API on this interval to reset the
 * ~30s MV3 idle-unload timer.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** Storage snapshots are throttled so narration deltas don't flood chrome.storage. */
const SNAPSHOT_THROTTLE_MS = 2_000;
/** A late-joining tab doesn't need the whole narration, just enough to look alive. */
const NARRATION_STORAGE_CAP = 2_000;

/**
 * Owns the single build. Runs `runHomepageBuild` in the worker, holds live state,
 * enforces a single-flight lock, broadcasts progress to every connected tab,
 * and mirrors a throttled snapshot to storage.
 *
 * There is one instance per service worker — i.e. one per browser profile — so
 * single-flight is per-profile, which is the right grain.
 */
export class BuildManager {
  private state: BuildState = { ...INITIAL_BUILD_STATE };
  private readonly ports = new Set<Port>();
  private controller: AbortController | null = null;
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- port lifecycle ------------------------------------------------------

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        this.send(port, { kind: "snapshot", state: this.state });
        break;
      case "startBuild":
        void this.startBuild();
        break;
      case "cancel":
        this.cancel();
        break;
    }
  }

  private send(port: Port, msg: BuildMsg) {
    try {
      port.postMessage(msg);
    } catch {
      // Port went away between the has-check and the post; drop it.
      this.ports.delete(port);
    }
  }

  private broadcast(msg: BuildMsg) {
    for (const port of [...this.ports]) this.send(port, msg);
  }

  // ---- heartbeat -----------------------------------------------------------

  async tick() {
    if (this.running) {
      // A run is live but the worker may have just woken; make sure the
      // self-keepalive is ticking so the active turn stays warm.
      this.startKeepalive();
      return;
    }

    const interrupted = await this.clearStaleRunningSnapshot();
    await this.surfaceStoredError();
    const started = await this.maybeAutoRebuild();
    if (interrupted && !started) {
      const settings = await loadSettings();
      const willRetry = settings.autoRebuild && Boolean(settings.baseUrl && settings.apiKey && settings.model);
      const message = willRetry
        ? "The build stopped before it finished. It will retry " +
          REBUILD_AFTER_HOURS +
          " hours after it started. Rebuild now if you want it sooner."
        : "The build stopped before it finished. Automatic rebuild is off, so it stays stopped until you rebuild.";
      await this.recordFailure(message, {
        stampAttempt: false,
        title: "Homepage build stopped",
        needsAttention: false,
      });
    }
  }

  /** True when a rebuild was started. */
  private async maybeAutoRebuild(): Promise<boolean> {
    const [settings, homepage, lastAttempt] = await Promise.all([
      loadSettings(),
      loadHomepage(),
      extensionStore.get<string>(KEYS.lastAutoBuildAttempt),
    ]);
    const now = new Date();

    if (
      !shouldAutoRebuild({
        enabled: settings.autoRebuild,
        hasApiKey: Boolean(settings.baseUrl && settings.apiKey && settings.model),
        isRunning: this.running,
        lastBuildTimestamp: homepage?.timestamp,
        lastAutoAttemptTimestamp: lastAttempt,
        now,
      })
    ) {
      return false;
    }

    // Stamp the attempt before starting. A killed worker never reaches the
    // failure path, and this stops the next heartbeat from starting another one
    // before 6 hours have passed.
    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    void this.startBuild();
    return true;
  }

  // ---- the build -----------------------------------------------------------

  async startBuild() {
    if (this.running) {
      console.log("[BuildManager] startBuild ignored — a build is already running");
      return; // single-flight: a second start just attaches.
    }

    // Claim the lock before the first await. On wake, tick() fires from several
    // listeners at once (top level, onStartup, onInstalled, the alarm); if the
    // lock waited for loadSettings, each of them would start its own build.
    this.running = true;
    this.controller = new AbortController();

    let apiKey: string | null = null;
    let apiBase = "";
    try {
      // Manual builds stamp here too. A cancel or a kill then waits 6 hours
      // instead of the next heartbeat starting another one immediately.
      await extensionStore.set(KEYS.lastAutoBuildAttempt, new Date().toISOString());
      await this.clearFailureNotice();

      const settings = await loadSettings();
      const { baseUrl, systemPrompt, model } = settings;
      apiKey = settings.apiKey;
      apiBase = baseUrl;
      if (!baseUrl.trim() || !apiKey?.trim() || !model.trim()) {
        await this.recordFailure(
          "Missing base URL, API key, or model. Complete your API settings and try again.",
        );
        return;
      }

      this.state = { ...INITIAL_BUILD_STATE, running: true, phase: "setup" };
      this.broadcast({ kind: "snapshot", state: this.state });
      this.startKeepalive();
      console.log("[BuildManager] build started");
      armProxyProbe(baseUrl);

      const result = await runHomepageBuild({
        baseUrl,
        apiKey,
        model,
        bridge: browserBridge,
        userSystemPrompt: systemPrompt,
        blockedSites: async () => (await loadSettings()).blockedSites,
        validateSource: validateHomepageTsx,
        signal: this.controller.signal,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

      // Persist the raw TSX; the page transpiles it for preview.
      await saveHomepage(result.code);
      await this.clearFailureNotice();

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", code: result.code });
      await this.mirror(true);
      console.log("[BuildManager] build done", { bytes: result.code.length });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const needle = apiKey ? credentialNeedle(apiBase, apiKey) : "";
      const message = needle ? raw.split(needle).join("[redacted]") : raw;
      if (message === "aborted") {
        this.state = { ...INITIAL_BUILD_STATE };
        this.broadcast({ kind: "snapshot", state: this.state });
        await this.mirror(true);
        return;
      }
      await this.recordFailure(message);
      console.error("[BuildManager] build failed", message);
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  async cancel() {
    if (this.controller) {
      this.controller.abort();
      return;
    }
    await this.publishIdle();
  }

  // ---- callback fan-out ----------------------------------------------------

  private onPhase(phase: RunPhase, detail?: string) {
    const mapped = stepForPhase(phase);
    const stepIndex =
      mapped === undefined ? this.state.stepIndex : Math.max(this.state.stepIndex, mapped);
    this.state = { ...this.state, phase, stepIndex, detail: detail ?? "" };
    this.broadcast({ kind: "phase", phase, stepIndex, detail: detail ?? "" });
    void this.mirror(false);
  }

  private onText(chunk: string) {
    this.state = { ...this.state, narration: this.state.narration + chunk };
    this.broadcast({ kind: "text", chunk });
    void this.mirror(false);
  }

  private onLog(line: string) {
    this.state = { ...this.state, logs: [...this.state.logs.slice(-LOG_RETENTION), line] };
    this.broadcast({ kind: "log", line });
    void this.mirror(false);
  }

  // A killed worker never reaches the build's catch, so storage can still say running.
  private async clearStaleRunningSnapshot(): Promise<boolean> {
    if (this.running || this.controller) return false;
    const snap = await extensionStore.get<BuildState>(KEYS.buildSnapshot);
    if (this.running || this.controller || !snap?.running) return false;
    await this.publishIdle();
    return true;
  }

  private async publishIdle() {
    if (this.running || this.controller) return;
    const idle: BuildState = { ...INITIAL_BUILD_STATE };
    this.state = idle;
    this.broadcast({ kind: "snapshot", state: idle });
    await extensionStore.set(KEYS.buildSnapshot, idle);
    if (this.running) await this.mirror(true);
  }

  // ---- storage mirror ------------------------------------------------------

  /**
   * Mirror a lightweight snapshot to storage so a tab that opens while the worker
   * is asleep paints last-known state instantly; the heartbeat then revives the
   * live run. Deltas go over the port; storage only gets a throttled snapshot.
   */
  private async mirror(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = null;
        void this.mirror(true);
      }, SNAPSHOT_THROTTLE_MS);
      return;
    }

    this.lastSnapshotAt = now;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const trimmed: BuildState = {
      ...this.state,
      narration: this.state.narration.slice(-NARRATION_STORAGE_CAP),
      logs: this.state.logs.slice(-LOG_RETENTION),
    };
    await extensionStore.set(KEYS.buildSnapshot, trimmed);
  }

  // ---- worker keepalive ----------------------------------------------------

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      // A cheap chrome API call resets the ~30s idle-unload timer while a turn is
      // in flight (the in-flight model fetch does most of the work; this covers
      // the gaps between requests).
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  // ---- failure surfacing ---------------------------------------------------

  /** A failure from before this notice existed still sits on the build snapshot. */
  private async surfaceStoredError() {
    if (await loadBuildFailure()) return;
    const snap = await extensionStore.get<BuildState>(KEYS.buildSnapshot);
    if (!snap?.error || snap.running || snap.error === "aborted") return;
    const at = (await extensionStore.get<string>(KEYS.lastAutoBuildAttempt)) ?? new Date().toISOString();
    await saveBuildFailure({ message: snap.error, at, needsAttention: true });
    await extensionStore.set(KEYS.buildSnapshot, { ...snap, error: null, phase: null });
    this.notifyFailure(snap.error, "Homepage build failed — needs you", true);
  }

  private async recordFailure(
    message: string,
    options?: { stampAttempt?: boolean; title?: string; needsAttention?: boolean },
  ) {
    const needsAttention = options?.needsAttention !== false;
    if (options?.stampAttempt !== false) {
      await extensionStore.set(KEYS.lastAutoBuildAttempt, new Date().toISOString());
    }
    await saveBuildFailure({ message, at: new Date().toISOString(), needsAttention });
    this.state = { ...this.state, running: false, phase: "error", error: message };
    this.broadcast({ kind: "error", message });
    await this.mirror(true);
    this.notifyFailure(message, options?.title ?? "Homepage build failed — needs you", needsAttention);
  }

  private async clearFailureNotice() {
    await clearBuildFailure();
    try {
      await browser.notifications.clear(FAILURE_NOTIFICATION_ID);
    } catch {
      // The notification API or this id may already be gone.
    }
  }

  private notifyFailure(message: string, title: string, needsAttention: boolean) {
    // Always notify. An open new tab is easy to miss, and a headless failure
    // used to vanish when the worker went back to sleep.
    const retry = needsAttention
      ? " It will not retry for " + REBUILD_AFTER_HOURS + " hours."
      : "";
    try {
      browser.notifications.create(FAILURE_NOTIFICATION_ID, {
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title,
        message: (message + retry).slice(0, 220),
        requireInteraction: true,
        priority: 2,
      });
    } catch {
      // notifications permission missing or API unavailable — the new tab still shows it.
    }
  }
}
