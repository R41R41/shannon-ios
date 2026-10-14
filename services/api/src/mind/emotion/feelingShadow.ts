import { foldFeelingDynamics, innerNoteDay, type CompanionStateSnapshot, type FeelingEvent, type FeelingPoint } from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import { remembered, type FeelingEvents, type FeelingKey } from './feelingEvents.js';
import { forgetIndex } from './innerNoteLineage.js';
import type { FeelingShadowRow } from './store/feelingShadowStore.js';

/**
 * The shadow of her fast layer (Syzygy ADR-0013 stage 2, items 1, 2, 7 and 9; `SHANNON_CORE_AFFECT`). Core: emotion.
 *
 * After each feeling event is written, the day's remembered events of its key are folded again (appraisal → core affect, mood and
 * blame → composure and register; `foldFeelingDynamics`) and the point of this event is written beside the current state's two
 * numbers, and shown to the Observer. Nothing is read back into her state, a prompt or a face: the owner approves the move from shadow
 * to live after looking at the comparison (the stage plan: two days of shadow first). Never throws.
 */
export interface FeelingShadowRecords {
  write(scopeKey: string, row: FeelingShadowRow, recordedAt: string): void;
  prune(scopeKey: string, before: string): number;
  sourced(scopeKey: string): { personKey: string; audience: string; sceneId: string | null; sourceId: string; at: string }[];
  deleteSpan(scopeKey: string, key: { personKey: string; audience: string; sceneId: string | null }, since: string, until: string): number;
}

/** The shadow keeps its rows as long as the events they were folded from (review M1). */
export const FEELING_SHADOW_LIMITS = Object.freeze({ retentionDays: 30, pruneEveryMilliseconds: 60 * 60_000 });
const DAY_MILLISECONDS = 24 * 60 * 60_000;

/** The key whose fast layer an event moves: its person, or the scene it happened in for anyone in a scene. */
export function shadowKeyOf(event: FeelingEvent): FeelingKey {
  if (event.sceneId && !event.personKey.startsWith('scene:') && event.personKey !== 'owner') {
    return { personKey: `scene:${event.sceneId}`, audience: event.audience, sceneId: event.sceneId };
  }
  return { personKey: event.personKey, audience: event.audience, sceneId: event.sceneId };
}

export class FeelingShadow {
  /** Per scope: the forgetting last applied (`forgetIndex` key) and when the rows were last pruned. */
  private readonly forgot = new Map<string, string>();
  private readonly pruned = new Map<string, number>();

  constructor(private readonly options: { events: () => FeelingEvents | null; store: FeelingShadowRecords;
    snapshot: (scopeKey: string) => CompanionStateSnapshot; now: () => string; reportError?: (error: unknown) => void }) {}

  recorded(scopeKey: string, event: FeelingEvent): void {
    try {
      const events = this.options.events();
      if (!events) return;
      const at = this.options.now();
      const snapshot = this.options.snapshot(scopeKey);
      const key = shadowKeyOf(event);
      const point = foldFeelingDynamics(events.today(scopeKey, event.occurredAt > at ? event.occurredAt : at, snapshot), key).series
        .filter(item => item.at === event.occurredAt && item.kind === event.kind).at(-1);
      if (!point) return;
      this.forget(scopeKey, snapshot);
      this.prune(scopeKey, at);
      const current = key.audience === 'owner_alone' ? { valence: snapshot.emotion.valence, arousal: snapshot.emotion.arousal } : null;
      observeSync('emotion', { phase: 'feeling.core_affect', audience: key.audience, kind: event.kind }, () =>
        this.options.store.write(scopeKey, { eventId: event.id, personKey: key.personKey, audience: key.audience, sceneId: key.sceneId,
          sourceId: event.sourceId, point, current }, at),
      () => ({ valence: point.valence, arousal: point.arousal, dominance: point.dominance, mood: point.mood, blame: point.blame, composure: point.composure,
        level: point.level, register: point.register, label: point.label, slip: point.slip, coverUp: point.coverUp,
        currentValence: current ? Math.round(current.valence * 1000) / 1000 : null }));
    } catch (error) {
      (this.options.reportError ?? (value => console.error('Shannon feeling shadow failed', value instanceof Error ? value.name : 'unknown')))(error);
    }
  }

  /**
   * Review M1: no forgotten influence persists. When the owner's forgetting changed, every day that has a row from a source now forgotten
   * is computed again for its key from the events still remembered (the rows of a day past the events' retention are only deleted).
   */
  forget(scopeKey: string, snapshot: CompanionStateSnapshot): void {
    const key = forgetIndex(snapshot).key;
    if (this.forgot.get(scopeKey) === key) return;
    if (this.forgot.size >= 64) this.forgot.clear();
    this.forgot.set(scopeKey, key);
    const timeZone = this.options.events()?.timeZone ?? 'Asia/Tokyo';
    const days = new Map<string, { key: FeelingKey; start: number }>();
    for (const row of this.options.store.sourced(scopeKey).filter(item => !remembered(snapshot, item.sourceId))) {
      const start = Date.parse(innerNoteDay(row.at, timeZone).endsAt) - DAY_MILLISECONDS;
      const rowKey = { personKey: row.personKey, audience: row.audience as FeelingKey['audience'], sceneId: row.sceneId };
      days.set(`${row.personKey}\u0000${row.audience}\u0000${row.sceneId ?? ''}\u0000${start}`, { key: rowKey, start });
    }
    for (const day of days.values()) this.recompute(scopeKey, day.key, day.start, snapshot);
  }

  private recompute(scopeKey: string, key: FeelingKey, start: number, snapshot: CompanionStateSnapshot): void {
    const since = new Date(start).toISOString(), until = new Date(start + DAY_MILLISECONDS - 1).toISOString();
    this.options.store.deleteSpan(scopeKey, key, since, until);
    const events = this.options.events()?.between(scopeKey, since, until).filter(event => remembered(snapshot, event.sourceId)) ?? [];
    const series = foldFeelingDynamics(events, key).series;
    const at = this.options.now();
    for (const event of events.filter(item => sameKey(shadowKeyOf(item), key))) {
      const point = series.find((item: FeelingPoint) => item.at === event.occurredAt && item.kind === event.kind);
      if (point) this.options.store.write(scopeKey, { eventId: event.id, personKey: key.personKey, audience: key.audience, sceneId: key.sceneId,
        sourceId: event.sourceId, point, current: null }, at);
    }
  }

  private prune(scopeKey: string, at: string): void {
    const now = Date.parse(at);
    const last = this.pruned.get(scopeKey);
    if (last !== undefined && now - last < FEELING_SHADOW_LIMITS.pruneEveryMilliseconds) return;
    this.pruned.set(scopeKey, now);
    this.options.store.prune(scopeKey, new Date(now - FEELING_SHADOW_LIMITS.retentionDays * DAY_MILLISECONDS).toISOString());
  }
}

const sameKey = (a: FeelingKey, b: FeelingKey) => a.personKey === b.personKey && a.audience === b.audience && (a.sceneId ?? null) === (b.sceneId ?? null);
