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
  onClose,
  onSave,
}: {
  initialPrompt: string;
  blockedSites: string[];
  baseUrl: string;
  model: string;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[], baseUrl: string, model: string, apiKey: string) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl);
  const [modelDraft, setModelDraft] = useState(model);
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
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
          One per line. Subdomains are included. Use *.example.com for wildcards.
        </p>
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Base URL
          <input
            type="text"
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            placeholder="https://gate.wendyeq.top/v1"
            style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: "8px 12px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
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
            style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: "8px 12px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          />
        </label>
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Model
          <input
            type="text"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: "8px 12px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
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
          Rebuild automatically each morning
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension builds one morning edition a day in the background (first time
          Chrome is open between 5am and noon), so your next tab shows a fresh one (uses your API key).
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button
            disabled={!baseUrlDraft.trim() || !modelDraft.trim()}
            onClick={() => onSave(draft, normalizeBlockList(blockedDraft.split("\n")), baseUrlDraft.trim(), modelDraft.trim(), apiKeyDraft.trim())}
            style={btn}
          >
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
