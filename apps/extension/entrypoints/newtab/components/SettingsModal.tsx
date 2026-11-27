import { useState } from "react";
import { normalizeBlockList } from "@homepage/agent-core";
import { btn } from "./ui";

export function SettingsModal({
  initialPrompt,
  blockedSites,
  baseUrl,
  model,
  autoRebuild,
  onToggleAutoRebuild,
  dailyTidy,
  tidyBatchSize,
  onToggleDailyTidy,
  onTidyBatchSize,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  blockedSites: string[];
  baseUrl: string;
  model: string;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  dailyTidy: boolean;
  tidyBatchSize: number;
  onToggleDailyTidy: (next: boolean) => void;
  onTidyBatchSize: (next: number) => void;
  onClose: () => void;
  onSave: (next: { prompt: string; blockedSites: string[]; baseUrl: string; model: string; apiKey: string }) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl);
  const [modelDraft, setModelDraft] = useState(model);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const fieldStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    marginTop: 8,
    padding: "8px 12px",
    fontSize: 14,
    borderRadius: 4,
    border: "1px solid #ddd",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1300,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Sites the agent never reads
          <textarea
            value={blockedDraft}
            onChange={(e) => setBlockedDraft(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 120, marginTop: 8, padding: 12, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="blocked-sites-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One per line. Applies to history, bookmarks, and page loads. Subdomains are included; use *.example.com for wildcards (e.g. company domains). Private IPs and intranet folders are skipped automatically.
        </p>
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Base URL
          <input
            type="text"
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            placeholder="https://gate.wendyeq.top/v1"
            style={fieldStyle}
          />
        </label>
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          API key
          <input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder="Leave blank to keep the saved key"
            autoComplete="off"
            style={fieldStyle}
          />
        </label>
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Model
          <input
            type="text"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            style={fieldStyle}
          />
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background once the current homepage is 6
          hours old. A failed attempt waits 6 hours, and the error stays on the new tab
          until you dismiss it (uses your API key). Chrome has to be open.
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={dailyTidy}
            onChange={(e) => onToggleDailyTidy(e.target.checked)}
          />
          Tidy a few bookmarks every day
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          Each day the agent reviews a small batch, then leaves a plan on the new tab
          for you to apply or dismiss — nothing moves without your click. A tidy plan
          waits for you; the next run only starts after it is handled.
        </p>
        {dailyTidy && (
          <label style={{ display: "block", marginTop: 10, color: "#333", fontSize: 14 }}>
            Bookmarks per day
            <input
              type="number"
              min={5}
              max={50}
              value={tidyBatchSize}
              onChange={(e) => onTidyBatchSize(Math.max(5, Math.min(50, Number(e.target.value) || 15)))}
              style={{ ...fieldStyle, width: 90 }}
            />
          </label>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button
            disabled={!baseUrlDraft.trim() || !modelDraft.trim()}
            onClick={() => onSave({
              prompt: draft,
              blockedSites: normalizeBlockList(blockedDraft.split("\n")),
              baseUrl: baseUrlDraft.trim(),
              model: modelDraft.trim(),
              apiKey: apiKeyDraft.trim(),
            })}
            style={btn}
          >
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
