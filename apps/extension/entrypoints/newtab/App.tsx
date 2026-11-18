import { useCallback, useEffect, useState } from "react";
import { DEFAULT_BLOCKED_SITES } from "@homepage/agent-core";
import { BUILD_STEPS } from "@/lib/protocol";
import {
  FAILURE_NOTIFICATION_ID,
  KEYS,
  clearBuildFailure,
  loadBuildFailure,
  loadHomepage,
  loadSettings,
  saveSetting,
  type BuildFailure,
} from "@/lib/storage";
import { compileHomepage } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildFailureBanner } from "./components/BuildFailureBanner";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { SettingsModal } from "./components/SettingsModal";
import { btn, errorBox } from "./components/ui";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [model, setModel] = useState("");
  const [autoRebuild, setAutoRebuild] = useState(true);
  /** Transpiled homepage, ready for the sandbox. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  /** Real TSX compile error if a saved homepage failed to transpile. */
  const [compileError, setCompileError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** Failure kept in storage, so it is still here after the worker restarts. */
  const [failure, setFailure] = useState<BuildFailure | null>(null);

  const applyHomepageSource = useCallback((source: string) => {
    const compiled = compileHomepage(source);
    if (compiled.ok) {
      setRenderedCode(compiled.code);
      setCompileError(null);
      return;
    }
    setRenderedCode(null);
    setCompileError(compiled.error);
  }, []);

  const { state, build, cancel } = useHomepageBuild(applyHomepageSource);

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, homepage] = await Promise.all([loadSettings(), loadHomepage()]);
        setBaseUrl(settings.baseUrl);
        setApiKey(settings.apiKey);
        setSystemPrompt(settings.systemPrompt);
        setBlockedSites(settings.blockedSites);
        setModel(settings.model);
        setAutoRebuild(settings.autoRebuild);
        if (homepage?.code) applyHomepageSource(homepage.code);
      } finally {
        setLoading(false);
      }
    })();
  }, [applyHomepageSource]);

  const saveKey = useCallback(async (settings: { baseUrl: string; apiKey: string; model: string }) => {
    await Promise.all([
      saveSetting("baseUrl", settings.baseUrl),
      saveSetting("apiKey", settings.apiKey),
      saveSetting("model", settings.model),
    ]);
    setBaseUrl(settings.baseUrl);
    setApiKey(settings.apiKey);
    setModel(settings.model);
  }, []);

  const savePrompt = useCallback(
    async (next: { prompt: string; blockedSites: string[]; baseUrl: string; model: string; apiKey: string }) => {
      const writes = [
        saveSetting("systemPrompt", next.prompt),
        saveSetting("blockedSites", next.blockedSites),
        saveSetting("baseUrl", next.baseUrl),
        saveSetting("model", next.model),
      ];
      if (next.apiKey) writes.push(saveSetting("apiKey", next.apiKey));
      await Promise.all(writes);
      setBaseUrl(next.baseUrl);
      setModel(next.model);
      if (next.apiKey) setApiKey(next.apiKey);
      setBlockedSites(next.blockedSites);
      setSystemPrompt(next.prompt);
      setShowSettings(false);
      setRenderedCode(null);
      setCompileError(null);
      build();
    },
    [build],
  );

  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);

  useEffect(() => {
    let gone = false;
    void loadBuildFailure().then((found) => {
      if (!gone) setFailure(found ?? null);
    });
    const onChange = (changes: { [key: string]: { newValue?: unknown } }, area: string) => {
      if (area !== "local" || !(KEYS.lastBuildFailure in changes)) return;
      setFailure((changes[KEYS.lastBuildFailure]?.newValue as BuildFailure | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      gone = true;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const dismissFailure = useCallback(() => {
    setFailure(null);
    void clearBuildFailure();
    void browser.notifications.clear(FAILURE_NOTIFICATION_ID).catch(() => undefined);
  }, []);

  const failureBanner =
    failure && !state.running ? (
      <BuildFailureBanner failure={failure} onRetry={() => build()} onDismiss={dismissFailure} />
    ) : null;

  if (loading) return <div style={{ padding: 20, textAlign: "center" }}>Loading…</div>;
  if (!baseUrl.trim() || !apiKey?.trim() || !model.trim()) return <ApiKeySetup onSave={saveKey} />;

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!renderedCode || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={renderedCode ? () => setViewProgress(false) : undefined}
      />
    );
  }

  if (!renderedCode) {
    return (
      <div style={{ maxWidth: 560, margin: "14vh auto", padding: 24, fontFamily: "system-ui" }}>
        <h1 style={{ fontSize: 26 }}>
          {compileError ? "Saved homepage failed to compile" : "Build your homepage"}
        </h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          {compileError
            ? "The saved homepage source has a TSX syntax error and could not be compiled. Rebuild to generate a working page."
            : "The agent reads your browsing history, opens the pages you actually follow, and writes a homepage from what it finds today."}
        </p>
        {compileError && (
          <pre
            style={{
              ...errorBox,
              margin: "16px 0",
              padding: 12,
              borderRadius: 4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {compileError}
          </pre>
        )}
        {failureBanner}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button style={btn} onClick={() => build()}>
            {compileError ? "Rebuild now" : "Build today\u2019s homepage"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      {failureBanner}
      <div className={state.running ? "dock busy" : "dock"}>
        {state.running ? (
          // A build is running in the background (from here, another tab, or the
          // scheduled rebuild). Let the user watch it without losing this page.
          <button className="dock-btn" onClick={() => setViewProgress(true)} title="View build progress">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#0a7",
                animation: "hb-pulse 1.2s ease-in-out infinite",
              }}
            />
            Building… {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
          </button>
        ) : (
          <button className="dock-btn" onClick={() => build()} title="Rebuild now" aria-label="Rebuild now">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 4v5h-5" />
            </svg>
          </button>
        )}
        <button
          className="dock-btn"
          onClick={() => setShowSettings(true)}
          title="Customize homepage"
          aria-label="Customize homepage"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <HomepagePreview code={renderedCode} />

      {showSettings && (
        <SettingsModal
          initialPrompt={systemPrompt}
          blockedSites={blockedSites}
          baseUrl={baseUrl}
          model={model}
          autoRebuild={autoRebuild}
          onToggleAutoRebuild={toggleAutoRebuild}
          onClose={() => setShowSettings(false)}
          onSave={savePrompt}
        />
      )}
    </div>
  );
}
