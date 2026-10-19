import type { FeelingEvent, FeelingEventFacts, FeelingEventKind } from './feelingEvent.js';

/**
 * Her closed days (Syzygy ADR-0013 stage 3): what of a day's feeling events is kept once the day is over, for the relationship ledger,
 * boundary memory and episode memory. Pure. Only what those folds read: the events about him and her refusals, with their closed facts
 * and their source ids (so forgetting still reaches them). Her ordinary replies, their openers, habits, drawers and checks are not kept.
 */
// Stage 5 (review T4): a viewer's comments are kept too (their kind and tags; never a digest), so each viewer has their own light ledger.
const KEPT_KINDS: ReadonlySet<FeelingEventKind> = new Set(['touched', 'spoke', 'apologized', 'praised', 'feeling_order', 'own_refusal', 'own_boundary',
  'comment']);
const KEPT_FACTS = ['touchKind', 'part', 'stance', 'refusal', 'tags', 'meaning', 'toldBoundary', 'commentKind', 'cues'] as const;

/** The event as a closed day keeps it, or null when the day does not keep it (her replies that do not refuse). */
export function closedDayEvent(event: FeelingEvent): FeelingEvent | null {
  const refusing = event.kind === 'own_reply' && event.facts.refusal === true;
  if (!KEPT_KINDS.has(event.kind) && !refusing) return null;
  const facts = Object.fromEntries(KEPT_FACTS.flatMap(name => (event.facts[name] === undefined ? [] : [[name, event.facts[name]]]))) as FeelingEventFacts;
  return { ...event, facts };
}

/** A day's events grouped by person, audience and scene (one closed-day row each). */
export function closedDayGroups(events: readonly FeelingEvent[]): { personKey: string; audience: FeelingEvent['audience']; sceneId: string | null;
  events: FeelingEvent[] }[] {
  const groups = new Map<string, { personKey: string; audience: FeelingEvent['audience']; sceneId: string | null; events: FeelingEvent[] }>();
  for (const event of events) {
    const kept = closedDayEvent(event);
    if (!kept) continue;
    const key = `${kept.personKey}\u0000${kept.audience}\u0000${kept.sceneId ?? ''}`;
    const group = groups.get(key) ?? { personKey: kept.personKey, audience: kept.audience, sceneId: kept.sceneId, events: [] };
    group.events.push(kept);
    groups.set(key, group);
  }
  return [...groups.values()];
}
