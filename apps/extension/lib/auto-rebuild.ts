/**
 * Auto-rebuild policy, evaluated by the worker's alarm heartbeat: one edition
 * a day. The first heartbeat at or after 5am rebuilds headlessly, so the next
 * new tab already shows today's homepage.
 */

/** Local hour when the new day's auto-rebuild window opens. */
export const DAY_START_HOUR = 5;

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
 * - Fires at or after 5am local time (so late-night browsing after midnight
 *   doesn't kick off tomorrow's build). Opening Chrome in the afternoon or
 *   evening still builds today's edition if nothing has run since 5am.
 * - At most one attempt per day: a build (manual or automatic) or a failed
 *   or cancelled attempt since today's 5am boundary counts as today's.
 */
export function shouldAutoRebuild(input: AutoRebuildInput): boolean {
  const { enabled, hasApiKey, isRunning, lastBuildTimestamp, lastAutoAttemptTimestamp, now } = input;

  if (!enabled || !hasApiKey || isRunning || !lastBuildTimestamp) return false;

  const hour = now.getHours();
  if (hour < DAY_START_HOUR) return false;

  const dayStart = new Date(now);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  const sinceDayStart = (iso: string) => new Date(iso).getTime() >= dayStart.getTime();

  if (sinceDayStart(lastBuildTimestamp)) return false;
  if (lastAutoAttemptTimestamp && sinceDayStart(lastAutoAttemptTimestamp)) return false;
  return true;
}
