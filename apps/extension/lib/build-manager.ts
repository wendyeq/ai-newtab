import { credentialNeedle, runHomepageBuild, type RunPhase } from "@homepage/agent-core";
import { shouldAutoRebuild } from "./auto-rebuild";
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
import { KEYS, extensionStore, loadHomepage, loadSettings, saveHomepage } from "./storage";

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

    await this.clearStaleRunningSnapshot();
    await this.maybeAutoRebuild();
  }

  /** Whether opening the day's first tab should already show a fresh homepage. */
  private async maybeAutoRebuild() {
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
      return;
    }

    // Stamp the attempt before starting so a second wake (or a cancel/failure)
    // doesn't re-trigger it this morning.
    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    void this.startBuild();
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
      const settings = await loadSettings();
      const { baseUrl, systemPrompt, model } = settings;
      apiKey = settings.apiKey;
      apiBase = baseUrl;
      if (!baseUrl.trim() || !apiKey?.trim() || !model.trim()) {
        const message = "Missing base URL, API key, or model. Complete your API settings and try again.";
        this.state = { ...INITIAL_BUILD_STATE, phase: "error", error: message };
        this.broadcast({ kind: "error", message });
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
        signal: this.controller.signal,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

      // Persist the raw TSX; the page transpiles it for preview.
      await saveHomepage(result.code);

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", code: result.code });
      await this.mirror(true);
      console.log("[BuildManager] build done", { bytes: result.code.length });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const needle = apiKey ? credentialNeedle(apiBase, apiKey) : "";
      const message = needle ? raw.split(needle).join("[redacted]") : raw;
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
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
  private async clearStaleRunningSnapshot() {
    if (this.running || this.controller) return;
    const snap = await extensionStore.get<BuildState>(KEYS.buildSnapshot);
    if (this.running || this.controller || !snap?.running) return;
    await this.publishIdle();
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

  private notifyFailure(message: string) {
    // Only ping when nobody is watching — an open tab already shows the error
    // inline. A headless daily build that fails otherwise vanishes silently.
    if (this.ports.size > 0) return;
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Homepage build failed",
        message: message.slice(0, 200),
      });
    } catch {
      // notifications permission missing or API unavailable — nothing else to do.
    }
  }
}
