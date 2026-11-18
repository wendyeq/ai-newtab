/**
 * Auto-rebuild policy, evaluated by the worker's alarm heartbeat.
 * Rebuild when the homepage is at least 6 hours old. A failed attempt waits
 * 6 hours too, so a persistent error cannot loop. The heartbeat only runs
 * while Chrome is open.
 */

/** How long a homepage stays current, and how long a failed attempt waits. */
export const REBUILD_AFTER_HOURS = 6;

export const REBUILD_AFTER_MS = REBUILD_AFTER_HOURS * 60 * 60 * 1000;

export interface AutoRebuildInput {
  enabled: boolean;
  hasApiKey: boolean;
  isRunning: boolean;
  /** ISO timestamp of the last successful build, if any. */
  lastBuildTimestamp?: string | null;
  /** ISO timestamp of the last auto-build attempt, if any. */
  lastAutoAttemptTimestamp?: string | null;
  now: Date;
}

/**
 * Conservative by design:
 * - Never fires before the first manual build, so nothing spends on the API
 *   before the user has engaged.
 * - Fires once the last successful homepage is at least 6 hours old.
 * - A failed, cancelled, or interrupted attempt also waits 6 hours, so the
 *   same error cannot start another build on the next heartbeat.
 */
export function shouldAutoRebuild(input: AutoRebuildInput): boolean {
  const { enabled, hasApiKey, isRunning, lastBuildTimestamp, lastAutoAttemptTimestamp, now } = input;

  if (!enabled || !hasApiKey || isRunning || !lastBuildTimestamp) return false;

  const ageMs = (iso: string) => now.getTime() - new Date(iso).getTime();
  if (ageMs(lastBuildTimestamp) < REBUILD_AFTER_MS) return false;
  if (lastAutoAttemptTimestamp && ageMs(lastAutoAttemptTimestamp) < REBUILD_AFTER_MS) return false;
  return true;
}
