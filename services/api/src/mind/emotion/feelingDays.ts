import {
  OWNER_PERSON_KEY, UNKNOWN_PERSON_KEY, closedDayGroups, foldRelationship, innerNoteDay, relationshipFacts, relationshipLine,
  type CompanionStateSnapshot, type FeelingEvent, type RelationshipDay,
} from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { ClosedDayRow } from './store/feelingDayStore.js';
import { remembered, type FeelingKey } from './feelingEvents.js';

/**
 * Her closed days and what is carried across them (Syzygy ADR-0013 stage 3; `SHANNON_RELATIONSHIP_LEDGER`, `SHANNON_EPISODE_MEMORY`,
 * `SHANNON_BOUNDARY_MEMORY`). Core: emotion.
 *
 * - The nightly fold: once her day (3:00, owner time) is over, the next use closes it: its events, in their closed form, become one row
 *   per person, audience and scene (`closedDayGroups`). A process closes the days it missed, up to `backfillDays` back.
 * - Everything carried is a fold over the closed days through the forgetting filter: a forgotten source is left out, and the relationship
 *   ledger (and the boundaries and episodes) are computed again without it. Nothing derived is stored.
 * - Who: only a known person (the owner; later a registered friend), never anyone unknown or a whole scene.
 *
 * Never throws: a failure loses a line, never a turn.
 */
export interface ClosedDayRecords {
  write(scopeKey: string, row: ClosedDayRow, closedAt: string): void;
  person(scopeKey: string, personKey: string, sinceDayKey: string): ClosedDayRow[];
  lastDayKey(scopeKey: string): string | null;
  prune(scopeKey: string, beforeDayKey: string): number;
}

export interface FeelingDayFeatures { relationship: boolean; episodes: boolean; boundaries: boolean }

export const FEELING_DAY_LIMITS = Object.freeze({ backfillDays: 30, retentionDays: 400 });

const DAY_MILLISECONDS = 24 * 60 * 60_000;

/** What is carried into a turn: lines of facts for the audience's own turn, and closed numbers. */
export interface CarriedLines { lines: readonly string[]; facts: Record<string, number | string> }

export class FeelingDays {
  /** Per scope, the newest day known to be closed (a process scans back once, then only the day just over). */
  private readonly closedThrough = new Map<string, string>();

  constructor(private readonly options: { events: { between(scopeKey: string, since: string, until: string, limit?: number): FeelingEvent[] };
    store: ClosedDayRecords; timeZone: string; now: () => string; features: FeelingDayFeatures; reportError?: (error: unknown) => void }) {}

  get features(): FeelingDayFeatures { return this.options.features; }

  /** Closes every day that is over and not closed yet (at most `backfillDays` back). Cheap when nothing is new. */
  close(scopeKey: string, at: string): void {
    try {
      const today = innerNoteDay(at, this.options.timeZone);
      const known = this.closedThrough.get(scopeKey);
      const yesterdayStart = Date.parse(today.endsAt) - 2 * DAY_MILLISECONDS;
      if (known !== undefined && known >= this.dayKeyAt(yesterdayStart)) return;
      const last = known ?? this.options.store.lastDayKey(scopeKey);
      for (let back = FEELING_DAY_LIMITS.backfillDays; back >= 1; back -= 1) {
        const start = Date.parse(today.endsAt) - (back + 1) * DAY_MILLISECONDS;
        const dayKey = this.dayKeyAt(start);
        if (last !== null && dayKey <= last) continue;
        this.closeDay(scopeKey, dayKey, start, at);
      }
      this.closedThrough.set(scopeKey, this.dayKeyAt(yesterdayStart));
      if (this.closedThrough.size > 64) this.closedThrough.clear();
      this.options.store.prune(scopeKey, this.dayKeyAt(Date.parse(today.endsAt) - (FEELING_DAY_LIMITS.retentionDays + 1) * DAY_MILLISECONDS));
    } catch (error) { this.report(error); }
  }

  /** A person's closed days before today, each day's rows merged, through the forgetting filter (oldest first). */
  history(scopeKey: string, personKey: string, at: string, snapshot: CompanionStateSnapshot): RelationshipDay[] {
    const today = innerNoteDay(at, this.options.timeZone).dayKey;
    const since = this.dayKeyAt(Date.parse(at) - (FEELING_DAY_LIMITS.retentionDays + 2) * DAY_MILLISECONDS);
    const byDay = new Map<string, FeelingEvent[]>();
    for (const row of this.options.store.person(scopeKey, personKey, since)) {
      if (row.dayKey >= today) continue;
      byDay.set(row.dayKey, [...byDay.get(row.dayKey) ?? [], ...row.events.filter(event => remembered(snapshot, event.sourceId))]);
    }
    return [...byDay].map(([dayKey, events]) => ({ dayKey, events })).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  }

  /** What a turn of this key is handed of the days before (owner: the relationship line; nothing for anyone unknown or a scene). */
  carried(scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot): CarriedLines {
    if (!this.options.features.relationship || !knownPerson(key)) return { lines: [], facts: {} };
    try {
      this.close(scopeKey, at);
      const days = this.history(scopeKey, key.personKey, at, snapshot);
      const today = innerNoteDay(at, this.options.timeZone).dayKey;
      const state = observeSync('emotion', { phase: 'feeling.relationship', owner: key.personKey === OWNER_PERSON_KEY, days: days.length },
        () => foldRelationship(days, key.personKey, today), value => ({ ...value.scales, peakTrust: value.peak.trust, peakLiking: value.peak.liking }));
      const line = relationshipLine(state, key.personKey === OWNER_PERSON_KEY ? 'ライ氏' : 'この人');
      return { lines: line ? [line] : [], facts: relationshipFacts(state) };
    } catch (error) {
      this.report(error);
      return { lines: [], facts: {} };
    }
  }

  private closeDay(scopeKey: string, dayKey: string, start: number, at: string): void {
    const events = this.options.events.between(scopeKey, new Date(start).toISOString(), new Date(start + DAY_MILLISECONDS - 1).toISOString(), 5_000);
    for (const group of closedDayGroups(events)) this.options.store.write(scopeKey, { dayKey, ...group }, at);
  }

  private dayKeyAt(time: number): string {
    return innerNoteDay(new Date(time + 60 * 60_000).toISOString(), this.options.timeZone).dayKey;
  }

  private report(error: unknown): void {
    (this.options.reportError ?? (value => console.error('Shannon feeling days failed', value instanceof Error ? value.name : 'unknown')))(error);
  }
}

/** A person whose relationship she keeps: not anyone unknown, and not a scene as a whole. */
const knownPerson = (key: FeelingKey) => key.personKey !== UNKNOWN_PERSON_KEY && !key.personKey.startsWith('scene:');
