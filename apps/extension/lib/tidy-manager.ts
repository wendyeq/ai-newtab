import { runTidy, shouldTidyNow, type TidyPass, type TidyStore } from "@homepage/agent-core";
import {
  applyTidyPlan,
  decorateOps,
  folderPaths,
  getBookmarkTree,
  indexTree,
  undoTidyApply,
  type PendingTidyPlan,
  type TidyApplyResult,
  type TidyUndoLog,
} from "./bookmarks";
import { KEYS, extensionStore, loadSettings } from "./storage";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/** A new plan or an apply result wakes new tabs to show it. */
export const TIDY_NOTIFICATION_ID = "bookmark-tidy";

/** What new-tab pages mirror; the plan itself is read from storage. */
export interface TidyStatus {
  running: boolean;
  /** True while a plan waits in storage for the user. */
  hasPlan: boolean;
  progress: { done: number; total: number; pass: number } | null;
  /** Last apply/undo summary the user saw; cleared on the next run. */
  lastResult: { applied: boolean; moved: number; errors: string[] } | null;
  error: string | null;
}

export const IDLE_TIDY_STATUS: TidyStatus = {
  running: false,
  hasPlan: false,
  progress: null,
  lastResult: null,
  error: null,
};

const KEEPALIVE_INTERVAL_MS = 20_000;

/** chrome.storage-backed cursor store for runTidy. */
const tidyStore: TidyStore = {
  async loadPass() {
    return (await extensionStore.get<TidyPass>(KEYS.tidyPass)) ?? null;
  },
  async savePass(pass) {
    await extensionStore.set(KEYS.tidyPass, pass);
  },
};

/**
 * Owns bookmark tidying: a daily small-batch run that produces a plan for the
 * user to approve, plus the apply/undo/dismiss actions on that plan. Shares the
 * page port with BuildManager — it only handles messages of its own kind.
 */
export class TidyManager {
  private readonly ports = new Set<Port>();
  private controller: AbortController | null = null;
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private status: TidyStatus = { ...IDLE_TIDY_STATUS };
  private hydrated = false;

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as { kind?: string };
      if (typeof msg.kind === "string" && msg.kind.startsWith("tidy")) {
        void this.onPageMessage(msg as TidyPageMsg);
      }
    });
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private async onPageMessage(msg: TidyPageMsg) {
    await this.hydrate();
    switch (msg.kind) {
      case "tidySubscribe":
        await this.broadcastStatus();
        break;
      case "tidyStart":
        void this.run();
        break;
      case "tidyApply":
        await this.apply();
        break;
      case "tidyDismiss":
        await this.dismiss();
        break;
      case "tidyUndo":
        await this.undo();
        break;
    }
  }

  /** First contact after a worker restart: reload pending plan + last failure. */
  private async hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    const [plan, failure] = await Promise.all([
      extensionStore.get<PendingTidyPlan>(KEYS.tidyPendingPlan),
      extensionStore.get<{ message: string }>(KEYS.tidyFailure),
    ]);
    this.status = {
      ...this.status,
      hasPlan: Boolean(plan),
      progress: plan?.progress ?? this.status.progress,
      error: failure?.message ?? null,
    };
  }

  private broadcast(msg: object) {
    for (const port of [...this.ports]) {
      try {
        port.postMessage(msg);
      } catch {
        this.ports.delete(port);
      }
    }
  }

  private setStatus(patch: Partial<TidyStatus>) {
    this.status = { ...this.status, ...patch };
    this.broadcast({ kind: "tidyStatus", status: this.status });
  }

  private async broadcastStatus() {
    this.broadcast({ kind: "tidyStatus", status: this.status });
  }

  // ---- heartbeat -----------------------------------------------------------

  async tick() {
    await this.hydrate();
    if (this.running) {
      this.startKeepalive();
      return;
    }
    const [settings, pending, lastAttempt] = await Promise.all([
      loadSettings(),
      extensionStore.get<PendingTidyPlan>(KEYS.tidyPendingPlan),
      extensionStore.get<string>(KEYS.lastTidyAttempt),
    ]);
    if (
      shouldTidyNow({
        enabled: settings.dailyTidy,
        hasApiKey: Boolean(settings.baseUrl && settings.apiKey && settings.model),
        isRunning: false,
        hasPendingPlan: Boolean(pending),
        lastAttemptTimestamp: lastAttempt,
        now: new Date(),
      })
    ) {
      await extensionStore.set(KEYS.lastTidyAttempt, new Date().toISOString());
      void this.run();
    }
  }

  // ---- the run -------------------------------------------------------------

  async run() {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    let apiKey: string | null = null;
    try {
      await extensionStore.set(KEYS.lastTidyAttempt, new Date().toISOString());
      const settings = await loadSettings();
      apiKey = settings.apiKey;
      if (!settings.baseUrl.trim() || !apiKey?.trim() || !settings.model.trim()) {
        this.setStatus({ running: false, error: "Missing API settings — set them up before tidying." });
        return;
      }
      this.setStatus({ running: true, error: null });
      this.startKeepalive();

      const result = await runTidy({
        baseUrl: settings.baseUrl,
        apiKey,
        model: settings.model,
        bridge: { getTree: getBookmarkTree, store: tidyStore },
        batchSize: settings.tidyBatchSize,
        signal: this.controller.signal,
        callbacks: {
          onLog: (line) => this.broadcast({ kind: "tidyLog", line }),
        },
      });

      await extensionStore.remove(KEYS.tidyFailure);
      if (result.plan && result.plan.ops.length) {
        // Decorate with display paths/titles so the card renders without a
        // second tree read — the tree may drift before the user applies.
        const tree = await getBookmarkTree();
        const paths = folderPaths(tree);
        const nodes = indexTree(tree);
        const ops = decorateOps(result.plan.ops, paths, (id) => nodes.get(id)?.title).map((op) =>
          op.kind === "moveItem"
            ? { ...op, fromPath: paths.get(nodes.get(op.itemId)?.parentId ?? "") ?? "" }
            : op,
        );
        const plan: PendingTidyPlan = {
          summary: result.plan.summary,
          ops,
          createdAt: new Date().toISOString(),
          progress: result.progress,
        };
        await extensionStore.set(KEYS.tidyPendingPlan, plan);
        this.setStatus({ running: false, hasPlan: true, progress: result.progress });
        this.notify("Bookmarks tidied — a plan is waiting", `${result.plan.ops.length} changes: ${result.plan.summary}`);
      } else {
        // Empty ops or empty tree: nothing to review, keep the cadence quiet.
        this.setStatus({ running: false, progress: result.progress });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "aborted") {
        await extensionStore.set(KEYS.tidyFailure, { message, at: new Date().toISOString() });
        this.setStatus({ running: false, error: message });
      } else {
        this.setStatus({ running: false });
      }
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  // ---- plan actions --------------------------------------------------------

  async apply() {
    const plan = await extensionStore.get<PendingTidyPlan>(KEYS.tidyPendingPlan);
    if (!plan) {
      await this.broadcastStatus();
      return;
    }
    const { result, undo } = await applyTidyPlan(plan);
    await extensionStore.remove(KEYS.tidyPendingPlan);
    if (result.moved + result.created + result.renamed + result.merged > 0) {
      await extensionStore.set(KEYS.tidyUndo, undo);
    }
    this.setStatus({
      hasPlan: false,
      lastResult: { applied: true, moved: result.moved, errors: result.errors },
    });
    this.notify(
      result.ok ? "Bookmark tidy applied" : "Bookmark tidy applied with errors",
      `${result.moved} moved, ${result.created} folders created` +
        (result.errors.length ? ` — ${result.errors[0]}` : ""),
    );
  }

  async dismiss() {
    await extensionStore.remove(KEYS.tidyPendingPlan);
    this.setStatus({ hasPlan: false });
  }

  async undo() {
    const undo = await extensionStore.get<TidyUndoLog>(KEYS.tidyUndo);
    if (!undo) {
      await this.broadcastStatus();
      return;
    }
    const result = await undoTidyApply(undo);
    await extensionStore.remove(KEYS.tidyUndo);
    this.setStatus({
      lastResult: { applied: false, moved: result.moved, errors: result.errors },
    });
  }

  // ---- misc ----------------------------------------------------------------

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private notify(title: string, message: string) {
    try {
      browser.notifications.create(TIDY_NOTIFICATION_ID, {
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title,
        message: message.slice(0, 220),
        priority: 0,
      });
    } catch {
      // notifications missing — the card on the new tab still shows the plan.
    }
  }
}

export type TidyPageMsg =
  | { kind: "tidySubscribe" }
  | { kind: "tidyStart" }
  | { kind: "tidyApply" }
  | { kind: "tidyDismiss" }
  | { kind: "tidyUndo" };

export type { PendingTidyPlan, TidyApplyResult, TidyUndoLog };
