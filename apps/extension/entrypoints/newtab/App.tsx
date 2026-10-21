import { useCallback, useEffect, useState } from "react";
import { DEFAULT_BLOCKED_SITES } from "@homepage/agent-core";
import { BUILD_STEPS } from "@/lib/protocol";
import { loadHomepage, loadSettings, saveSetting } from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
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
  /** Transpiled homepage, ready for Sandpack. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const { state, build, cancel } = useHomepageBuild((code) => setRenderedCode(toRenderable(code)));

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
        if (homepage?.code) setRenderedCode(toRenderable(homepage.code));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
      build();
    },
    [build],
  );

  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);

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
        <h1 style={{ fontSize: 26 }}>Build your homepage</h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          The agent reads your browsing history, opens the pages you actually follow, and writes a
          homepage from what it finds today.
        </p>
        {state.error && (
          <div style={{ ...errorBox, margin: "16px 0", padding: 12, borderRadius: 4 }}>{state.error}</div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button style={btn} onClick={() => build()}>
            Build today&apos;s homepage
          </button>
        </div>
      </div>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <div style={{ position: "fixed", top: 20, right: 20, zIndex: 999, display: "flex", gap: 8 }}>
        {state.running ? (
          // A build is running in the background (from here, another tab, or the
          // scheduled rebuild). Let the user watch it without losing this page.
          <button
            style={{ ...btn, backgroundColor: "#0a7", display: "flex", alignItems: "center", gap: 8 }}
            onClick={() => setViewProgress(true)}
            title="View build progress"
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "white",
                animation: "hb-pulse 1.2s ease-in-out infinite",
              }}
            />
            Building… {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
          </button>
        ) : (
          <button style={btn} onClick={() => build()} title="Rebuild now">
            ↻ Rebuild
          </button>
        )}
        <button style={btn} onClick={() => setShowSettings(true)} title="Customize homepage">
          ⚙️ Settings
        </button>
      </div>

      {showError && (
        <div
          style={{
            ...errorBox,
            position: "fixed",
            top: 20,
            left: 20,
            right: 260,
            zIndex: 999,
            padding: "10px 14px",
            borderRadius: 6,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            <b>Build failed.</b> {state.error}
          </span>
          <button style={{ ...btn, padding: "4px 10px", backgroundColor: "#a02620" }} onClick={() => build()}>
            Retry
          </button>
          <button
            onClick={() => setDismissedError(state.error)}
            style={{
              background: "transparent",
              border: "none",
              color: "#a02620",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

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
