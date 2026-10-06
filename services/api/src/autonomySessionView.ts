import { ownerDay } from './mind/emotion/companionPresence.js';
import { SESSION_END_LABEL, yen } from './autonomyLoopSessionPrompts.js';
import type { SessionEndCode } from './autonomyLoopSessions.js';
import type { AutonomyLoopState } from './autonomyLoopState.js';

/**
 * What she is doing in her own time, for the owner's screens (`GET /v1/autonomy`, field `session`): in a session,
 * since when and what it has spent; standing still because the owner is talking or has paused her; or resting until
 * a time, with the reason she gave in her own words. Null under `SHANNON_AUTONOMY_PACING=cycles` and before her
 * first session. Status text is neutral; only `reason` is hers.
 */
export interface AutonomySessionView {
  state: 'active' | 'held' | 'resting';
  label: string;
  /** `active`, `held`: when the session began, what it has been charged, and its steps so far. */
  since?: string;
  spentYen?: number;
  steps?: number;
  /** `resting`: when the next session may begin, how the last one ended, and her reason when she chose to rest. */
  until?: string;
  endedAt?: string;
  endCode?: SessionEndCode;
  endLabel?: string;
  reason?: string;
}

export function autonomySessionView(loop: AutonomyLoopState, scopeKey: string, at: string, timeZone: string): AutonomySessionView | null {
  try {
    const open = loop.openCycle(scopeKey);
    const session = open ? loop.sessions.get(open.id) : null;
    if (open && session) {
      const spentYen = loop.sessions.spentYen(open.id);
      const since = when(session.startedAt, at, timeZone);
      return Object.freeze({
        state: session.heldAt ? 'held' as const : 'active' as const, since: session.startedAt, spentYen, steps: open.stepsTaken,
        label: session.heldAt ? `${since}に始めた活動を、いったん止めています` : `${since}から活動中（この時間に${yen(Math.ceil(spentYen))}）`,
      });
    }
    const last = loop.sessions.latestClosed(scopeKey);
    if (!last?.resumeAt || !last.endedAt || !last.endCode || Date.parse(last.resumeAt) <= Date.parse(at)) return null;
    return Object.freeze({
      state: 'resting' as const, label: `${when(last.resumeAt, at, timeZone)}まで休憩中`, until: last.resumeAt,
      endedAt: last.endedAt, endCode: last.endCode, endLabel: SESSION_END_LABEL[last.endCode],
      ...(last.restReason ? { reason: last.restReason } : {}),
    });
  } catch { return null; }
}

/** 「14:05」, with the date in front when it is not today for the owner. */
function when(instant: string, at: string, timeZone: string): string {
  try {
    const sameDay = ownerDay(instant, timeZone) === ownerDay(at, timeZone);
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone, ...(sameDay ? {} : { month: 'numeric' as const, day: 'numeric' as const }), hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(instant));
  } catch { return instant.slice(11, 16); }
}
