import type { LivenessFacts } from './store/livenessStore.js';

export const LIVENESS_LIMITS = Object.freeze({
  /** A due nightly sleep that has not completed for this long is stalled. */
  sleepStalledMs: 30 * 3_600_000,
  /** Own time switched on and not paused, yet no session or step for this long. */
  ownTimeQuietMs: 6 * 3_600_000,
  /** This many mind worker starts within an hour means it is crash-looping. */
  mindRestartsPerHour: 3,
  checkIntervalMs: 10 * 60_000,
});

export type LivenessIncident = 'sleep_stalled' | 'own_time_stalled' | 'mind_worker_restarting';

/** What `GET /v1/ops` shows the owner under `server.liveness`. Timestamps, counts and closed codes only. */
export interface LivenessView {
  checkedAt: string;
  incidents: LivenessIncident[];
  sleep: { lastCompletedAt: string | null; oldestDueAt: string | null };
  ownTime: { enabled: boolean; paused: boolean; lastActivityAt: string | null };
  mindWorker: { startsLastHour: number; startsLastDay: number; lastStartAt: string | null };
}

const older = (value: string | null, at: string, milliseconds: number) => value !== null && Date.parse(at) - Date.parse(value) > milliseconds;

export function evaluateLiveness(facts: LivenessFacts, at: string, ownTimeEnabled: boolean): LivenessView {
  const incidents: LivenessIncident[] = [];
  const sleepRecent = facts.lastSleepCompletedAt !== null && !older(facts.lastSleepCompletedAt, at, LIVENESS_LIMITS.sleepStalledMs);
  if (older(facts.oldestDueSleepAt, at, LIVENESS_LIMITS.sleepStalledMs) && !sleepRecent) incidents.push('sleep_stalled');
  // Never having run is not a stall: a fresh database has no session yet.
  if (ownTimeEnabled && !facts.ownTimePaused && older(facts.lastOwnTimeActivityAt, at, LIVENESS_LIMITS.ownTimeQuietMs)) incidents.push('own_time_stalled');
  if (facts.mindWorkerStarts.lastHour >= LIVENESS_LIMITS.mindRestartsPerHour) incidents.push('mind_worker_restarting');
  return {
    checkedAt: at, incidents,
    sleep: { lastCompletedAt: facts.lastSleepCompletedAt, oldestDueAt: facts.oldestDueSleepAt },
    ownTime: { enabled: ownTimeEnabled, paused: facts.ownTimePaused, lastActivityAt: facts.lastOwnTimeActivityAt },
    mindWorker: { startsLastHour: facts.mindWorkerStarts.lastHour, startsLastDay: facts.mindWorkerStarts.lastDay, lastStartAt: facts.mindWorkerStarts.lastAt },
  };
}

/** One line when an incident begins and one when it ends; never a line per check. */
export function livenessTransitions(previous: ReadonlySet<LivenessIncident>, view: LivenessView): string[] {
  const lines: string[] = [];
  for (const incident of view.incidents) if (!previous.has(incident)) lines.push(`Shannon liveness: incident ${incident} ${detail(incident, view)}`);
  for (const incident of previous) if (!view.incidents.includes(incident)) lines.push(`Shannon liveness: recovered ${incident}`);
  return lines;
}

function detail(incident: LivenessIncident, view: LivenessView): string {
  if (incident === 'sleep_stalled') return `lastCompleted=${view.sleep.lastCompletedAt ?? 'none'} oldestDue=${view.sleep.oldestDueAt ?? 'none'}`;
  if (incident === 'own_time_stalled') return `lastActivity=${view.ownTime.lastActivityAt ?? 'none'}`;
  return `startsLastHour=${view.mindWorker.startsLastHour} startsLastDay=${view.mindWorker.startsLastDay}`;
}
