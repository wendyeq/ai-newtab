import { describe, expect, test } from "bun:test";
import { REBUILD_AFTER_MS, shouldAutoRebuild, type AutoRebuildInput } from "../apps/extension/lib/auto-rebuild";

const NOW = new Date("2026-10-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const input = (overrides: Partial<AutoRebuildInput>): AutoRebuildInput => ({
  enabled: true,
  hasApiKey: true,
  isRunning: false,
  lastBuildTimestamp: ago(REBUILD_AFTER_MS),
  lastAutoAttemptTimestamp: ago(REBUILD_AFTER_MS),
  now: NOW,
  ...overrides,
});

describe("shouldAutoRebuild", () => {
  test("rebuilds when the homepage and the last attempt are both 6 hours old", () => {
    expect(shouldAutoRebuild(input({}))).toBe(true);
  });

  test("does not rebuild until a full 6 hours have passed", () => {
    expect(shouldAutoRebuild(input({ lastBuildTimestamp: ago(REBUILD_AFTER_MS - 1), lastAutoAttemptTimestamp: null }))).toBe(false);
    expect(shouldAutoRebuild(input({ lastBuildTimestamp: ago(60 * 60 * 1000), lastAutoAttemptTimestamp: null }))).toBe(false);
  });

  test("a failed attempt waits 6 hours even when the homepage is older", () => {
    expect(
      shouldAutoRebuild(input({ lastBuildTimestamp: ago(24 * 60 * 60 * 1000), lastAutoAttemptTimestamp: ago(REBUILD_AFTER_MS - 1) })),
    ).toBe(false);
    expect(
      shouldAutoRebuild(input({ lastBuildTimestamp: ago(24 * 60 * 60 * 1000), lastAutoAttemptTimestamp: ago(REBUILD_AFTER_MS) })),
    ).toBe(true);
  });

  test("never fires before a first manual build, when off, without a key, or mid-build", () => {
    expect(shouldAutoRebuild(input({ lastBuildTimestamp: null }))).toBe(false);
    expect(shouldAutoRebuild(input({ enabled: false }))).toBe(false);
    expect(shouldAutoRebuild(input({ hasApiKey: false }))).toBe(false);
    expect(shouldAutoRebuild(input({ isRunning: true }))).toBe(false);
  });
});
