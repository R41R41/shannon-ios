import { foldFeelingDynamics, type CompanionStateSnapshot, type FeelingEvent } from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { FeelingEvents, FeelingKey } from './feelingEvents.js';
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
}

/** The key whose fast layer an event moves: its person, or the scene it happened in for anyone in a scene. */
export function shadowKeyOf(event: FeelingEvent): FeelingKey {
  if (event.sceneId && !event.personKey.startsWith('scene:') && event.personKey !== 'owner') {
    return { personKey: `scene:${event.sceneId}`, audience: event.audience, sceneId: event.sceneId };
  }
  return { personKey: event.personKey, audience: event.audience, sceneId: event.sceneId };
}

export class FeelingShadow {
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
}
