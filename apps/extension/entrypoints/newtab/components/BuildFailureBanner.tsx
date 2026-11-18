import { REBUILD_AFTER_HOURS } from "@/lib/auto-rebuild";
import type { BuildFailure } from "@/lib/storage";
import { btn } from "./ui";

export function BuildFailureBanner({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: BuildFailure;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const when = new Date(failure.at);
  const whenLabel = Number.isNaN(when.getTime()) ? "" : when.toLocaleString();
  const headline = failure.needsAttention
    ? "This will not fix itself. Automatic retry waits " +
      REBUILD_AFTER_HOURS +
      " hours. If it is an API key, model, or base URL problem, change it in Settings."
    : "";

  return (
    <div className={"failure-banner" + (failure.needsAttention ? " needs-attention" : "")} role="alert">
      <div className="failure-banner-text">
        <strong>{failure.needsAttention ? "Homepage build failed." : "Homepage build stopped."}</strong>
        {headline ? " " + headline : null}
        <span className="failure-banner-detail">{failure.message}</span>
        {whenLabel ? <span className="failure-banner-time">{whenLabel}</span> : null}
      </div>
      <div className="failure-banner-actions">
        <button style={btn} onClick={onRetry}>
          Rebuild now
        </button>
        <button className="failure-banner-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
