import { expect, test } from "bun:test";
import { INITIAL_BUILD_STATE, type BuildState } from "../../apps/extension/lib/protocol.ts";

const mem = new Map<string, unknown>();

const browserStub = {
  storage: {
    local: {
      async get(key: string | string[]) {
        if (typeof key === "string") return { [key]: mem.get(key) };
        const out: Record<string, unknown> = {};
        for (const item of key) out[item] = mem.get(item);
        return out;
      },
      async set(values: Record<string, unknown>) {
        for (const [key, value] of Object.entries(values)) mem.set(key, value);
      },
      async remove(key: string) {
        mem.delete(key);
      },
    },
  },
  runtime: {
    async getPlatformInfo() {
      return {};
    },
    getURL(path: string) {
      return path;
    },
  },
  notifications: { create() {} },
};

(globalThis as typeof globalThis & { browser: typeof browserStub }).browser = browserStub;

const { BuildManager } = await import("../../apps/extension/lib/build-manager.ts");

function stuck(): BuildState {
  return {
    ...INITIAL_BUILD_STATE,
    running: true,
    phase: "analyzing",
    stepIndex: 2,
    detail: "stuck",
  };
}

function fakePort() {
  const messages: Array<{ kind: string; state?: BuildState }> = [];
  return {
    messages,
    port: {
      onMessage: { addListener() {} },
      onDisconnect: { addListener() {} },
      postMessage(message: { kind: string; state?: BuildState }) {
        messages.push(message);
      },
    },
  };
}

test("a new worker clears a running snapshot when no build is active", async () => {
  mem.set("buildSnapshot", stuck());
  const manager = new BuildManager();
  const { messages, port } = fakePort();
  manager.attach(port as never);
  await manager.tick();
  const stored = mem.get("buildSnapshot") as BuildState;
  expect(stored.running).toBe(false);
  expect(stored.phase).toBeNull();
  expect(messages.some((message) => message.kind === "snapshot" && message.state?.running === false)).toBe(true);
});

test("cancel with no controller clears a running snapshot", async () => {
  mem.set("buildSnapshot", stuck());
  const manager = new BuildManager();
  const { messages, port } = fakePort();
  manager.attach(port as never);
  await manager.cancel();
  const stored = mem.get("buildSnapshot") as BuildState;
  expect(stored.running).toBe(false);
  expect(stored.phase).toBeNull();
  expect(messages.at(-1)).toEqual({ kind: "snapshot", state: INITIAL_BUILD_STATE });
});

test("tick leaves an idle snapshot alone", async () => {
  const idle = { ...INITIAL_BUILD_STATE, phase: "error" as const, error: "earlier" };
  mem.set("buildSnapshot", idle);
  const manager = new BuildManager();
  await manager.tick();
  expect(mem.get("buildSnapshot")).toEqual(idle);
});
