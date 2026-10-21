import { useState } from "react";
import { btn } from "./ui";

export function ApiKeySetup({ onSave }: { onSave: (settings: { baseUrl: string; apiKey: string; model: string }) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const valid = Boolean(baseUrl.trim() && apiKey.trim() && model.trim());
  const inputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    marginTop: 8,
    padding: 12,
    fontSize: 14,
    borderRadius: 4,
    border: "1px solid #ddd",
    fontFamily: "ui-monospace, monospace",
  };

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your API</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        Connect an OpenAI-compatible API. Your key is stored in <code>chrome.storage.local</code>
        {" "}on this machine and sent only to the base URL you entered.
      </p>
      <label style={{ display: "block", marginTop: 16 }}>
        Base URL
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://gate.wendyeq.top/v1"
          style={inputStyle}
        />
      </label>
      <label style={{ display: "block", marginTop: 16 }}>
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          style={inputStyle}
        />
      </label>
      <label style={{ display: "block", marginTop: 16 }}>
        Model
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={inputStyle}
        />
      </label>
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid}
        onClick={() => onSave({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() })}
      >
        Save settings
      </button>
    </div>
  );
}
