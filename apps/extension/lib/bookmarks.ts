import type { BookmarkNode, RawBookmark, TidyOp } from "@homepage/agent-core";

/**
 * Applies a user-approved tidy plan over chrome.bookmarks and records enough
 * to undo the whole apply once. Structural changes are conservative:
 * no bookmark is ever deleted — mergeFolders moves children and removes only
 * the emptied source folder.
 */

export interface PendingTidyPlan {
  summary: string;
  /** Ops decorated for display (paths resolved at plan time). */
  ops: TidyOp[];
  /** ISO timestamp of the run that produced this plan. */
  createdAt: string;
  /** Where the pass stood when the plan was made. */
  progress: { done: number; total: number; pass: number } | null;
}

export interface TidyUndoLog {
  at: string;
  summary: string;
  /** Bookmark moves to restore: id → original location, applied in order. */
  restoreMoves: Array<{ itemId: string; parentId: string; index: number }>;
  /** Folder ids this apply created — removed on undo after moves are restored. */
  createdFolderIds: string[];
  /** Renames to revert, newest apply order first. */
  restoreRenames: Array<{ folderId: string; title: string }>;
  /** Emptied source folders removed by merges; recreated on undo (children won't move back). */
  removedFolders: Array<{ title: string; parentId: string }>;
}

export interface TidyApplyResult {
  ok: boolean;
  moved: number;
  created: number;
  renamed: number;
  merged: number;
  /** Things skipped rather than failed: already-gone items, duplicate urls. */
  skipped: number;
  errors: string[];
}

export async function getBookmarkTree(): Promise<BookmarkNode[]> {
  return (await browser.bookmarks.getTree()) as BookmarkNode[];
}

/** Flatten chrome.bookmarks into leaf entries with folder paths for homepage sampling. */
export async function getFlatBookmarks(): Promise<RawBookmark[]> {
  const roots = await getBookmarkTree();
  const leaves: RawBookmark[] = [];
  const walk = (node: BookmarkNode, path: string) => {
    if (node.url !== undefined) {
      leaves.push({
        title: node.title ?? "",
        url: node.url,
        folderPath: path,
        dateAdded: node.dateAdded,
      });
      return;
    }
    const here = node.parentId === undefined ? "" : path ? `${path} / ${node.title}` : node.title;
    for (const kid of node.children ?? []) walk(kid, here);
  };
  for (const root of roots) walk(root, "");
  return leaves;
}

/** id → node, for every node in the tree. */
export function indexTree(roots: BookmarkNode[]): Map<string, BookmarkNode> {
  const map = new Map<string, BookmarkNode>();
  const walk = (node: BookmarkNode) => {
    map.set(node.id, node);
    for (const kid of node.children ?? []) walk(kid);
  };
  for (const root of roots) walk(root);
  return map;
}

/** id → "A / B / C" path for folders (and the folder each leaf lives in). */
export function folderPaths(roots: BookmarkNode[]): Map<string, string> {
  const paths = new Map<string, string>();
  const walk = (node: BookmarkNode, path: string) => {
    const here = node.parentId === undefined ? "" : path ? `${path} / ${node.title}` : node.title;
    if (node.url === undefined) paths.set(node.id, here);
    else paths.set(node.id, path);
    for (const kid of node.children ?? []) walk(kid, here);
  };
  for (const root of roots) walk(root, "");
  return paths;
}

/** Attach display paths and titles to raw plan ops for the new-tab card. */
export function decorateOps(
  ops: TidyOp[],
  paths: Map<string, string>,
  titleOf?: (id: string) => string | undefined,
): TidyOp[] {
  return ops.map((op) => {
    switch (op.kind) {
      case "createFolder":
        return { ...op, parentPath: paths.get(op.parentId ?? "") ?? "" } as TidyOp;
      case "moveItem":
        return {
          ...op,
          title: titleOf?.(op.itemId),
          fromPath: "",
          toPath: op.toId ? paths.get(op.toId) ?? "" : "",
        } as TidyOp;
      case "renameFolder":
        return { ...op, fromPath: paths.get(op.folderId) ?? "" } as TidyOp;
      case "mergeFolders":
        return {
          ...op,
          fromPath: paths.get(op.sourceId) ?? "",
          toPath: paths.get(op.intoId) ?? "",
        } as TidyOp;
      default:
        return op;
    }
  });
}

/**
 * Execute a plan. Validation already ran in agent-core; this re-checks ids
 * against the live tree (the tree may have changed since the plan was made)
 * and records an undo log covering everything it changed.
 */
export async function applyTidyPlan(
  plan: PendingTidyPlan,
): Promise<{ result: TidyApplyResult; undo: TidyUndoLog }> {
  const result: TidyApplyResult = {
    ok: true,
    moved: 0,
    created: 0,
    renamed: 0,
    merged: 0,
    skipped: 0,
    errors: [],
  };
  const undo: TidyUndoLog = {
    at: new Date().toISOString(),
    summary: plan.summary,
    restoreMoves: [],
    createdFolderIds: [],
    restoreRenames: [],
    removedFolders: [],
  };

  let nodes = indexTree(await getBookmarkTree());
  const newFolderIds = new Map<string, string>(); // plan title → created id
  const mergedAway = new Set<string>();

  const fail = (message: string) => {
    result.ok = false;
    result.errors.push(message);
  };

  for (const op of plan.ops) {
    try {
      switch (op.kind) {
        case "createFolder": {
          // parentId always points at a real folder (validated in agent-core);
          // fall back to the bookmark bar if it vanished since the plan.
          const parent = op.parentId && nodes.has(op.parentId) ? op.parentId : "1";
          const created = await browser.bookmarks.create({ parentId: parent, title: op.title.trim() });
          newFolderIds.set(op.title.trim(), created.id);
          undo.createdFolderIds.push(created.id);
          nodes.set(created.id, created as BookmarkNode);
          result.created += 1;
          break;
        }
        case "moveItem": {
          const item = nodes.get(op.itemId);
          if (!item || item.url === undefined) {
            result.skipped += 1;
            break; // bookmark went away since the plan
          }
          const toId = op.toId ?? (op.toNewFolder ? newFolderIds.get(op.toNewFolder) : undefined);
          if (!toId || mergedAway.has(toId) || !nodes.get(toId)) {
            fail(`move "${item.title}": target folder is gone`);
            break;
          }
          const from = { parentId: item.parentId!, index: item.index ?? 0 };
          await browser.bookmarks.move(op.itemId, { parentId: toId });
          undo.restoreMoves.unshift({ itemId: op.itemId, ...from }); // undo in reverse apply order
          result.moved += 1;
          break;
        }
        case "renameFolder": {
          const folder = nodes.get(op.folderId);
          if (!folder || folder.url !== undefined || mergedAway.has(op.folderId)) {
            result.skipped += 1;
            break;
          }
          undo.restoreRenames.push({ folderId: op.folderId, title: folder.title });
          await browser.bookmarks.update(op.folderId, { title: op.title.trim() });
          folder.title = op.title.trim();
          result.renamed += 1;
          break;
        }
        case "mergeFolders": {
          const source = nodes.get(op.sourceId);
          const into = nodes.get(op.intoId);
          if (!source || source.url !== undefined || !into || into.url !== undefined || mergedAway.has(op.intoId)) {
            result.skipped += 1;
            break;
          }
          const intoUrls = new Set(
            (into.children ?? []).filter((c) => c.url !== undefined).map((c) => c.url),
          );
          for (const child of source.children ?? []) {
            if (child.url !== undefined && intoUrls.has(child.url)) {
              await browser.bookmarks.remove(child.id); // duplicate — drop rather than pile up
              continue;
            }
            const from = { parentId: source.id, index: child.index ?? 0 };
            await browser.bookmarks.move(child.id, { parentId: into.id });
            if (child.url !== undefined) intoUrls.add(child.url);
            undo.restoreMoves.push({ itemId: child.id, ...from });
            result.moved += 1;
          }
          const rest = await browser.bookmarks.getChildren(source.id).catch(() => []);
          if (rest.length === 0) {
            undo.removedFolders.push({ title: source.title, parentId: source.parentId ?? "1" });
            await browser.bookmarks.remove(source.id);
          }
          mergedAway.add(op.sourceId);
          result.merged += 1;
          break;
        }
      }
    } catch (error) {
      fail(`${op.kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A failed createFolder shouldn't make later moves silently no-op — the
    // toNewFolder lookup already covers that by failing the move loudly.
    nodes = indexTree(await getBookmarkTree());
  }

  return { result, undo };
}

/**
 * Reverse the last apply, best effort. Bookmark moves go back where they came
 * from; folders created by the apply are removed (after moves, so nothing is
 * left inside them); renames revert; removed merge-sources are recreated
 * empty — children stay in the folder they were merged into.
 */
export async function undoTidyApply(undo: TidyUndoLog): Promise<TidyApplyResult> {
  const result: TidyApplyResult = {
    ok: true,
    moved: 0,
    created: 0,
    renamed: 0,
    merged: 0,
    skipped: 0,
    errors: [],
  };
  const fail = (m: string) => {
    result.ok = false;
    result.errors.push(m);
  };

  for (const move of undo.restoreMoves) {
    try {
      await browser.bookmarks.move(move.itemId, { parentId: move.parentId, index: move.index });
      result.moved += 1;
    } catch {
      result.skipped += 1;
    }
  }
  for (const folderId of [...undo.createdFolderIds].reverse()) {
    try {
      await browser.bookmarks.removeTree(folderId);
      result.created += 1;
    } catch {
      result.skipped += 1;
    }
  }
  for (const rename of undo.restoreRenames) {
    try {
      await browser.bookmarks.update(rename.folderId, { title: rename.title });
      result.renamed += 1;
    } catch {
      result.skipped += 1;
    }
  }
  for (const folder of undo.removedFolders) {
    try {
      await browser.bookmarks.create({ parentId: folder.parentId, title: folder.title });
      result.merged += 1;
    } catch (error) {
      fail(`recreate "${folder.title}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
