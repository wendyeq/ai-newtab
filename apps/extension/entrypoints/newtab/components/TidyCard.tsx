import { useEffect, useState } from "react";
import type { TidyOp } from "@homepage/agent-core";
import type { PendingTidyPlan } from "@/lib/bookmarks";
import { KEYS, extensionStore } from "@/lib/storage";
import type { TidyStatus } from "@/lib/tidy-manager";
import { btn } from "./ui";

/** Display-only fields decorateOps adds to raw plan ops. */
type DecoratedOp = TidyOp & {
  title?: string;
  fromPath?: string;
  toPath?: string;
  parentPath?: string;
};

function opLabel(op: DecoratedOp): string {
  switch (op.kind) {
    case "moveItem":
      return `${op.title ?? op.itemId} → ${op.toNewFolder ?? op.toPath ?? "?"}${op.fromPath ? `  (from ${op.fromPath || "top level"})` : ""}`;
    case "createFolder":
      return `New folder “${op.title}”${op.parentPath ? ` in ${op.parentPath}` : ""}`;
    case "renameFolder":
      return `Rename “${op.fromPath}” → “${op.title}”`;
    case "mergeFolders":
      return `Merge “${op.fromPath}” into “${op.toPath}”`;
    default:
      return JSON.stringify(op);
  }
}

const KIND_ORDER: Record<string, number> = { moveItem: 0, createFolder: 1, renameFolder: 2, mergeFolders: 3 };

/**
 * The bookmark-tidy dock: pending plan review, run progress, last result.
 * Sits bottom-left, opposite the build dock.
 */
export function TidyCard({
  tidy,
  send,
}: {
  tidy: TidyStatus;
  send: (kind: "tidyStart" | "tidyApply" | "tidyDismiss" | "tidyUndo") => void;
}) {
  const [plan, setPlan] = useState<PendingTidyPlan | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    let gone = false;
    const read = async () => {
      const [p, u] = await Promise.all([
        extensionStore.get<PendingTidyPlan>(KEYS.tidyPendingPlan),
        extensionStore.get(KEYS.tidyUndo),
      ]);
      if (!gone) {
        setPlan(p ?? null);
        setCanUndo(Boolean(u));
      }
    };
    void read();
    const onChange = (
      changes: { [key: string]: { newValue?: unknown } },
      area: string,
    ) => {
      if (area !== "local") return;
      if (KEYS.tidyPendingPlan in changes || KEYS.tidyUndo in changes) void read();
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      gone = true;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const quiet = !tidy.running && !tidy.hasPlan && !tidy.error && !tidy.lastResult;
  if (quiet) return null;

  const ops = [...((plan?.ops ?? []) as DecoratedOp[])].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );

  return (
    <div className="tidy-dock">
      <div className="tidy-card">
        <div className="tidy-head" onClick={() => plan && setExpanded((v) => !v)} role={plan ? "button" : undefined}>
          <span className="tidy-title">
            {tidy.running
              ? "Tidying bookmarks…"
              : plan
                ? `Bookmark tidy plan · ${ops.length} changes`
                : "Bookmark tidy"}
          </span>
          {plan && <span className="tidy-caret">{expanded ? "▾" : "▸"}</span>}
        </div>

        {tidy.running && <div className="tidy-line">Reviewing today’s batch — a plan will show up here.</div>}

        {plan && (
          <>
            <div className="tidy-line">{plan.summary}</div>
            {expanded && (
              <ul className="tidy-ops">
                {ops.map((op, i) => (
                  <li key={i}>{opLabel(op)}</li>
                ))}
              </ul>
            )}
            {plan.progress && (
              <div className="tidy-line dim">
                Pass {plan.progress.pass}: {plan.progress.done}/{plan.progress.total} reviewed
              </div>
            )}
            <div className="tidy-actions">
              <button style={{ ...btn, padding: "5px 12px", fontSize: 13 }} onClick={() => send("tidyApply")}>
                Apply
              </button>
              <button
                style={{ ...btn, padding: "5px 12px", fontSize: 13, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
                onClick={() => send("tidyDismiss")}
              >
                Dismiss
              </button>
            </div>
          </>
        )}

        {tidy.lastResult && (
          <div className="tidy-line">
            {tidy.lastResult.applied ? "Applied" : "Undone"}: {tidy.lastResult.moved} items moved
            {tidy.lastResult.errors.length ? ` — ${tidy.lastResult.errors[0]}` : ""}
            {tidy.lastResult.applied && canUndo && (
              <>
                {" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    send("tidyUndo");
                  }}
                >
                  undo
                </a>
              </>
            )}
          </div>
        )}

        {tidy.error && (
          <div className="tidy-line dim">
            Tidy failed: {tidy.error}{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                send("tidyStart");
              }}
            >
              retry
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
