/**
 * Her character space in a text turn (owner 2026-10-20; `SHANNON_CHARACTER_SPACE`): her mood folded from the day's feeling events and
 * this turn's words, the relationship with whoever she is talking to (the closed days' fold, `feelingDays.ts`), her place, and who she
 * is there. Computation only: nothing is kept but the region her reply is recorded with (for the next turn's stickiness). Core: emotion.
 */
import {
  OWNER_PERSON_KEY, cuesOfWords, moodAxes, personaBlock, securityToday, selectPersona, spacePosition, PERSONA_LIMITS, isRegionId,
  type CompanionStateSnapshot, type FeelingEvent, type PersonaSelection, type Relation, type RegionId, type SpaceCue, type SpacePosition,
} from '@shannon/cognition';
import type { FeelingKey } from './feelingEvents.js';

/** What a text turn holds of her space. */
export interface SpaceLines {
  position: SpacePosition;
  selection: PersonaSelection;
  /** The [いまのボク] block of the last block. */
  block: string;
  /** This turn's cues (recorded on his words' event). */
  cues: readonly SpaceCue[];
}

/** Someone she does not know yet: a little reserved, not distrustful. */
export const STRANGER_RELATION: Relation = Object.freeze({ liking: -0.1, security: 0 });

const localHour = (at: string, timeZone: string): number => {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at));
  return Number(hour) % 24;
};

/** The region she replied from most lately to this key, within the hold. */
function previousRegion(events: readonly FeelingEvent[], key: FeelingKey, at: string): RegionId | null {
  const since = Date.parse(at) - PERSONA_LIMITS.holdMinutes * 60_000;
  const last = events.filter(event => event.kind === 'own_reply' && event.personKey === key.personKey && event.audience === key.audience
    && Date.parse(event.occurredAt) >= since && Date.parse(event.occurredAt) <= Date.parse(at))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0]?.facts.region;
  return isRegionId(last) ? last : null;
}

export interface SpaceInput {
  key: FeelingKey;
  at: string;
  timeZone: string;
  words: string;
  snapshot: CompanionStateSnapshot;
  /** The day's events of the scope (every audience: her mood is one). */
  events: readonly FeelingEvent[];
  /** The relationship with this person from their closed days, and how many days he had been away (the owner); absent: a stranger. */
  relation?: Relation & { awayDays?: number };
  /** The owner holds her 好意 at its top (`SHANNON_AFFECTION_MAX`; the owner alone only). */
  max: boolean;
}

/** Her space this turn. */
export function spaceOf(input: SpaceInput): SpaceLines {
  const { key, at } = input;
  const owner = key.personKey === OWNER_PERSON_KEY && key.audience === 'owner_alone';
  const spokeToday = input.events.some(event => event.personKey === key.personKey && event.audience === key.audience && event.kind !== 'own_reply'
    && Date.parse(event.occurredAt) < Date.parse(at));
  const returning = owner && (input.relation?.awayDays ?? 0) >= 1 && !spokeToday;
  const cues = cuesOfWords(input.words, { returning });
  const mood = moodAxes({ events: input.events, now: cues, at, localHour: localHour(at, input.timeZone), lingering: input.snapshot.emotion });
  const base = input.relation ?? STRANGER_RELATION;
  const mine = input.events.filter(event => event.personKey === key.personKey);
  const max = owner && input.max;
  const relation = { liking: max ? 1 : base.liking, security: securityToday(base.security, mine, cues) };
  const position = spacePosition(mood, relation);
  const selection = selectPersona(position, { ownerAlone: owner, max, previous: previousRegion(input.events, key, at) });
  return { position, selection, block: personaBlock(selection), cues };
}
