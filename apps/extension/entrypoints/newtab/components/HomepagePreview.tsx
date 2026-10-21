import { useEffect, useRef } from "react";

const SOURCE = "ai-newtab-preview";

/**
 * Renders the agent's component in a sandboxed extension page. The code is
 * model-generated, so it never runs in the new-tab page and never leaves the machine.
 */
export function HomepagePreview({ code }: { code: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const lightCode = code
    .replaceAll("useState('dark')", "useState('light')")
    .replaceAll('useState("dark")', "useState('light')");

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const send = () => iframe.contentWindow?.postMessage({ source: SOURCE, code: lightCode }, "*");
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { source?: string; ready?: boolean } | null;
      if (data?.source === SOURCE && data.ready) send();
    };
    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", send);
    send();
    return () => {
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", send);
    };
  }, [lightCode]);

  return (
    <iframe
      ref={frame}
      src={browser.runtime.getURL("/sandbox.html")}
      title="Homepage"
      style={{ width: "100%", height: "100vh", border: "none", display: "block" }}
    />
  );
}
