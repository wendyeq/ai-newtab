import { describe, expect, test } from "bun:test";
import {
  buildQueue,
  flattenTree,
  nextBatch,
  runTidy,
  shouldTidyNow,
  TIDY_AFTER_MS,
  type BookmarkNode,
  type TidyPass,
  type TidyStore,
} from "@homepage/agent-core";

// ---- fixtures --------------------------------------------------------------

let leafSeq = 0;
function leaf(title: string, url: string, parentId = "1"): BookmarkNode {
  leafSeq += 1;
  return { id: `bm${leafSeq}`, title, url, parentId, index: leafSeq, dateAdded: 1_700_000_000_000 + leafSeq * 1000 };
}

/** A tree shaped like chrome.bookmarks.getTree: synthetic root → bar/other. */
function fixtureTree(): BookmarkNode[] {
  leafSeq = 0;
  return [
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          title: "Bookmarks bar",
          parentId: "0",
          children: [
            { id: "f-dev", title: "Dev", parentId: "1", children: [leaf("TypeScript docs", "https://ts.dev")] },
            { id: "f-news", title: "News", parentId: "1", children: [] },
            leaf("A cooking blog", "https://cook.example"),
            leaf("Some rust post", "https://rust.example/post"),
            leaf("Video: cats", "https://video.example/cats"),
          ],
        },
        { id: "2", title: "Other bookmarks", parentId: "0", children: [] },
      ],
    },
  ];
}

function memoryStore(): TidyStore & { pass: TidyPass | null } {
  const box: { pass: TidyPass | null } = { pass: null };
  return {
    get pass() {
      return box.pass;
    },
    set pass(v: TidyPass | null) {
      box.pass = v;
    },
    async loadPass() {
      return box.pass;
    },
    async savePass(p) {
      box.pass = p;
    },
  };
}

function serve(turns: Array<{ id: string; name: string; arguments: string }>) {
  const bodies: Array<{ messages: Array<{ role: string; tool_call_id?: string; content?: string }> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof bodies)[number];
      bodies.push(body);
      const call = turns[bodies.length - 1] ?? turns.at(-1)!;
      return Response.json({
        choices: [
          {
            message: call
              ? { content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] }
              : { content: "nothing" },
          },
        ],
      });
    },
  });
  return { server, bodies, base: `http://127.0.0.1:${server.port}` };
}

const apiKey = "test-only-placeholder";

// ---- runTidy end to end ----------------------------------------------------

describe("runTidy", () => {
  test("walks structure, batch, and submitTidyPlan as tool calls", async () => {
    const tree = fixtureTree();
    const { leaves } = flattenTree(tree);
    const plan = {
      summary: "把零散的书签分到已有文件夹",
      ops: [
        { kind: "moveItem", itemId: leaves[1]!.id, toId: "f-dev", toNewFolder: undefined },
        { kind: "createFolder", title: "Cooking", parentId: "1" },
      ],
    };
    const { server, bodies, base } = serve([
      { id: "s", name: "getFolderStructure", arguments: "{}" },
      { id: "b", name: "getTidyBatch", arguments: "{}" },
      { id: "p", name: "submitTidyPlan", arguments: JSON.stringify(plan) },
    ]);
    const store = memoryStore();
    try {
      const result = await runTidy({
        baseUrl: `${base}/v1`,
        apiKey,
        model: "test-model",
        bridge: { getTree: async () => tree, store },
        batchSize: 5,
      });
      expect(result.plan?.ops).toHaveLength(2);
      // batchSize clamps at 5, so all 4 fixture leaves go out in one batch.
      expect(result.progress?.done).toBe(4);
      expect(store.pass?.cursor).toBe(4);
      const batchMsg = bodies[2]!.messages.find((m) => m.tool_call_id === "b");
      const items = JSON.parse(batchMsg!.content!).items as Array<{ id: string; folderPath: string }>;
      expect(items).toHaveLength(4);
      expect(items[0]!.folderPath).toBe("Bookmarks bar / Dev");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a plan that references items outside the batch", async () => {
    const tree = fixtureTree();
    const { leaves } = flattenTree(tree);
    const badPlan = { summary: "bad", ops: [{ kind: "moveItem", itemId: "bm999", toId: "f-dev" }] };
    const goodPlan = { summary: "ok", ops: [{ kind: "moveItem", itemId: leaves[0]!.id, toId: "f-dev" }] };
    const { server, bodies, base } = serve([
      { id: "b", name: "getTidyBatch", arguments: "{}" },
      { id: "p1", name: "submitTidyPlan", arguments: JSON.stringify(badPlan) },
      { id: "p2", name: "submitTidyPlan", arguments: JSON.stringify(goodPlan) },
    ]);
    try {
      const result = await runTidy({
        baseUrl: `${base}/v1`,
        apiKey,
        model: "test-model",
        bridge: { getTree: async () => tree, store: memoryStore() },
        batchSize: 3,
      });
      expect(result.plan?.summary).toBe("ok");
      const rejected = bodies[2]!.messages.find((m) => m.tool_call_id === "p1");
      expect(JSON.parse(rejected!.content!).error).toContain("was not in today's batch");
    } finally {
      server.stop(true);
    }
  });

  test("returns no plan and resets the pass when the tree is empty", async () => {
    const tree: BookmarkNode[] = [{ id: "0", title: "", children: [{ id: "1", title: "Bar", parentId: "0", children: [] }] }];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("never") });
    const store = memoryStore();
    store.pass = { queue: ["stale"], cursor: 0, pass: 3 };
    try {
      const result = await runTidy({
        baseUrl: `${`http://127.0.0.1:${server.port}`}/v1`,
        apiKey,
        model: "test-model",
        bridge: { getTree: async () => tree, store },
        batchSize: 15,
      });
      expect(result.plan).toBeNull();
      expect(result.progress).toBeNull();
      expect(store.pass).toEqual({ queue: [], cursor: 0, pass: 0 });
    } finally {
      server.stop(true);
    }
  });
});

// ---- the pass cursor --------------------------------------------------------

describe("nextBatch", () => {
  test("hands out oldest-first batches and rolls into a new pass", async () => {
    const tree = fixtureTree();
    const { leaves } = flattenTree(tree);
    const store = memoryStore();
    const b1 = await nextBatch(store, leaves, 2);
    const b2 = await nextBatch(store, leaves, 2);
    const b3 = await nextBatch(store, leaves, 2); // 4 leaves → queue exhausted, new pass
    expect(b1!.items.map((i) => i.id)).toEqual(buildQueue(leaves).slice(0, 2));
    expect(b2!.done).toBe(2);
    expect(b3!.pass).toBe(b1!.pass + 1);
    expect(b3!.items).toHaveLength(2);
  });

  test("skips ids that vanished from the tree", async () => {
    const tree = fixtureTree();
    const { leaves } = flattenTree(tree);
    const store = memoryStore();
    const queue = buildQueue(leaves);
    store.pass = { queue: ["ghost-id", ...queue], cursor: 0, pass: 1 };
    const batch = await nextBatch(store, leaves, 2);
    expect(batch!.items.map((i) => i.id)).toEqual(queue.slice(0, 2));
    expect(store.pass!.queue).not.toContain("ghost-id");
  });
});

// ---- daily scheduling -------------------------------------------------------

const NOW = new Date("2026-10-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("shouldTidyNow", () => {
  const base = {
    enabled: true,
    hasApiKey: true,
    isRunning: false,
    hasPendingPlan: false,
    now: NOW,
  };

  test("first run goes immediately, then waits 20h", () => {
    expect(shouldTidyNow({ ...base, lastAttemptTimestamp: null })).toBe(true);
    expect(shouldTidyNow({ ...base, lastAttemptTimestamp: ago(TIDY_AFTER_MS - 1) })).toBe(false);
    expect(shouldTidyNow({ ...base, lastAttemptTimestamp: ago(TIDY_AFTER_MS) })).toBe(true);
  });

  test("a waiting plan blocks the next run", () => {
    expect(
      shouldTidyNow({ ...base, hasPendingPlan: true, lastAttemptTimestamp: ago(10 * TIDY_AFTER_MS) }),
    ).toBe(false);
  });

  test("off, no key, or already running blocks it", () => {
    expect(shouldTidyNow({ ...base, enabled: false })).toBe(false);
    expect(shouldTidyNow({ ...base, hasApiKey: false })).toBe(false);
    expect(shouldTidyNow({ ...base, isRunning: true })).toBe(false);
  });
});
