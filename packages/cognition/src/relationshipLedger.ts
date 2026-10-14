import { foldEpisodeLedger } from './episodeLedger.js';
import { OWNER_PERSON_KEY, type FeelingEvent } from './feelingEvent.js';
import { foldFeelingDynamics } from './feelingDynamics.js';

/**
 * The relationship ledger (Syzygy ADR-0013 D5, stage 3 item 1; `SHANNON_RELATIONSHIP_LEDGER`): per person, trust, liking, respect and
 * irritation, carried across days. Pure, and a fold over the person's closed days (their remembered events), so that forgetting a
 * source and folding again is the whole of the forget semantics (D15). It moves once per day, from that day's events (the nightly fold);
 * within the day, the episode ledger and the fast layer answer.
 *
 * - It drops easily and recovers slowly (owner: 「下がって、ゆっくり戻る」): a day's loss moves a scale `lossRate` of the way, a gain
 *   `gainRate`; a day without loss returns `recovery` of the way to the highest value so far (bad is stronger than good: Baumeister et
 *   al. 2001; the asymmetry of trust: Slovic 1993).
 * - A floor: trust and liking never fall below `floorRatio` × their highest value (owner: 嫌いにはならない; the ratio is a safety bound the
 *   owner sets, ADR-0013 §7 item 1).
 * - Irritation builds from what she said no to and was done anyway, insults and the blame left at the day's end; it fades each day, and an
 *   apology that day relieves part of it.
 *
 * The coefficients (`RELATIONSHIP_PARAMETERS`, ADR-0008 F6, ADR-0013 D14) were approved by the owner as proposed; none is fitted yet.
 */
export const RELATIONSHIP_SCALES = ['trust', 'liking', 'respect', 'irritation'] as const;
export type RelationshipScale = typeof RELATIONSHIP_SCALES[number];
export type RelationshipScales = Readonly<Record<RelationshipScale, number>>;

export interface RelationshipParameters {
  status: 'proposal' | 'approved';
  /** Where a relationship starts: the owner (respect, gratitude, fondness: ADR-0002, ADR-0012 §8 answer 7), anyone else. */
  start: { owner: RelationshipScales; other: RelationshipScales };
  /** A day's loss moves a scale this share of its pull (a pull of −1 takes this much off). */
  lossRate: number;
  /** A day's gain moves a scale this share of the way left to 1, per unit of pull. */
  gainRate: number;
  /** A day without loss takes back this share of what is missing to the highest value. */
  recovery: number;
  /** Irritation keeps (1 − fade) of itself each day. */
  irritationFade: number;
  /** Irritation takes this share of what is left to 1, per unit of the day's provocation. */
  irritationGain: number;
  /** An apology that day relieves this share of the irritation. */
  apologyRelief: number;
  /** Trust and liking never fall below this × their highest value. */
  floorRatio: number;
  /** The scales kept (the light ledger of a stranger or a viewer keeps liking and irritation only, §4.2); absent: all four. */
  scales?: readonly RelationshipScale[];
}

/** Approved by the owner as proposed (2026-10-14, form: 「この案でよい」); model assumptions until fitted to her own data (D14). */
export const RELATIONSHIP_PARAMETERS: RelationshipParameters = Object.freeze({
  status: 'approved',
  start: Object.freeze({
    owner: Object.freeze({ trust: 0.8, liking: 0.85, respect: 0.8, irritation: 0 }),
    other: Object.freeze({ trust: 0.5, liking: 0.5, respect: 0.5, irritation: 0 }),
  }),
  lossRate: 0.3,
  gainRate: 0.06,
  recovery: 0.12,
  irritationFade: 0.3,
  irritationGain: 0.5,
  apologyRelief: 0.35,
  floorRatio: 0.7,
});

/**
 * Stage 4 (ADR-0013 §4.2, `SHANNON_FEELING_AUDIENCE`): a known friend's ledger, lighter than the owner's (it starts lower, moves and
 * fades a little faster, its floor is lower), and a stranger's or a viewer's light ledger (liking and irritation only, forgiven and
 * forgotten fast). Proposals for the owner's approval (2026-10-14); model assumptions.
 */
export const FRIEND_RELATIONSHIP_PROPOSAL: RelationshipParameters = Object.freeze({
  status: 'proposal',
  start: Object.freeze({ owner: RELATIONSHIP_PARAMETERS.start.owner, other: Object.freeze({ trust: 0.55, liking: 0.6, respect: 0.55, irritation: 0 }) }),
  lossRate: 0.25, gainRate: 0.08, recovery: 0.15, irritationFade: 0.4, irritationGain: 0.45, apologyRelief: 0.4, floorRatio: 0.6,
});
export const STRANGER_RELATIONSHIP_PROPOSAL: RelationshipParameters = Object.freeze({
  status: 'proposal',
  start: Object.freeze({ owner: RELATIONSHIP_PARAMETERS.start.owner, other: Object.freeze({ trust: 0.5, liking: 0.5, respect: 0.5, irritation: 0 }) }),
  lossRate: 0.3, gainRate: 0.12, recovery: 0.3, irritationFade: 0.5, irritationGain: 0.5, apologyRelief: 0.4, floorRatio: 0.5,
  scales: Object.freeze(['liking', 'irritation'] as const),
});

/** Whose ledger a person key keeps: the owner's, a known friend's (`person:`), or a stranger's or viewer's light one. */
export type RelationshipClass = 'owner' | 'friend' | 'stranger';
export function relationshipClassOf(personKey: string): RelationshipClass {
  if (personKey === OWNER_PERSON_KEY) return 'owner';
  return personKey.startsWith('person:') ? 'friend' : 'stranger';
}

/** The parameters of a person's ledger by their class. */
export function relationshipParametersFor(personKey: string): RelationshipParameters {
  const kind = relationshipClassOf(personKey);
  return kind === 'owner' ? RELATIONSHIP_PARAMETERS : kind === 'friend' ? FRIEND_RELATIONSHIP_PROPOSAL : STRANGER_RELATIONSHIP_PROPOSAL;
}

/** One closed day of a person: its day key and its remembered events (the archive's, or today's). */
export interface RelationshipDay { dayKey: string; events: readonly FeelingEvent[] }

/** What one day says, from the episode ledger and the fast layer folded over it (0..1 each). */
export interface DaySignals { violation: number; provocation: number; kindness: number; apology: number; blame: number; together: number }

export interface RelationshipState {
  personKey: string;
  scales: RelationshipScales;
  peak: Pick<RelationshipScales, 'trust' | 'liking' | 'respect'>;
  /** The last day folded, or null. */
  dayKey: string | null;
}

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));
const round = (value: number) => Math.round(value * 1000) / 1000;

/** A day's signals for one person: every audience the person's events were in, folded per key. */
export function daySignals(events: readonly FeelingEvent[], personKey: string): DaySignals {
  const mine = events.filter(event => event.personKey === personKey);
  const keys = [...new Set(mine.map(event => `${event.audience}\u0000${event.sceneId ?? ''}`))];
  let violation = 0, provocation = 0, kindness = 0, apology = 0, blame = 0;
  for (const joined of keys) {
    const [audience, scene] = joined.split('\u0000') as [FeelingEvent['audience'], string];
    const key = { personKey, audience, sceneId: scene || null };
    const ledger = foldEpisodeLedger(mine, key);
    violation += ledger.episodes.reduce((sum, episode) => sum + episode.afterNo, 0);
    apology += ledger.apologies;
    kindness += ledger.praises;
    blame = Math.max(blame, foldFeelingDynamics(mine, key).core.blame);
  }
  provocation = mine.filter(event => (event.facts.tags?.length ?? 0) > 0).length;
  return { violation: clamp(violation / 4), provocation: clamp(provocation / 3), kindness: clamp(kindness / 3), apology: clamp(apology),
    blame: clamp(blame), together: mine.length ? 1 : 0 };
}

/** The pull of a day on each scale, −1..1 (irritation's is its provocation, 0..1). */
function pulls(signals: DaySignals): RelationshipScales {
  const { violation: v, provocation: p, kindness: k, blame: b, together: t } = signals;
  return {
    trust: clamp(-(0.7 * v + 0.3 * b) + 0.3 * k + 0.1 * t, -1, 1),
    liking: clamp(-(0.4 * v + 0.4 * p) + 0.5 * k + 0.15 * t, -1, 1),
    respect: clamp(-(0.3 * v + 0.6 * p) + 0.3 * k, -1, 1),
    // Re-review L-c, R2: a day with a violation of her no or a hurtful word always counts (ADR-0013 D5); a day of only minor residual
    // blame (feeling orders, a light jab without a tag) is not new irritation: it fades instead.
    irritation: v > 0 || p > 0 || b >= MINOR_IRRITATION ? clamp(Math.max(v, p, b)) : 0,
  };
}

/**
 * Below this, a day's residual blame alone (no violation, no hurtful word) is minor: irritation fades on it. Approved by the owner
 * (2026-10-15, form 「0.35でよい」); a model assumption until fitted.
 */
export const MINOR_IRRITATION = 0.35;

const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

/** Quiet days: what was lost comes back slowly, irritation fades. */
function rest(state: RelationshipState, days: number, parameters: RelationshipParameters): RelationshipState {
  if (days <= 0) return state;
  const back = 1 - (1 - parameters.recovery) ** days;
  const toward = (scale: 'trust' | 'liking' | 'respect') => state.scales[scale] + back * (state.peak[scale] - state.scales[scale]);
  const scales = { trust: toward('trust'), liking: toward('liking'), respect: toward('respect'),
    irritation: state.scales.irritation * (1 - parameters.irritationFade) ** days };
  return { ...state, scales };
}

/** One day's step, then the floor; the highest value is kept for the floor and for recovery. */
function step(state: RelationshipState, signals: DaySignals, parameters: RelationshipParameters): RelationshipState {
  const pull = pulls(signals);
  const lost = (['trust', 'liking', 'respect'] as const).some(scale => pull[scale] < 0);
  const moved = (scale: 'trust' | 'liking' | 'respect') => {
    const value = state.scales[scale];
    if (pull[scale] < 0) return value + parameters.lossRate * pull[scale];
    return value + parameters.gainRate * pull[scale] * (1 - value) + (lost ? 0 : parameters.recovery * (state.peak[scale] - value));
  };
  // Review H1: irritation fades by its daily share on every closed day that brings none, a day of ordinary talk included.
  const kept = pull.irritation > 0 ? state.scales.irritation : state.scales.irritation * (1 - parameters.irritationFade);
  const built = kept + parameters.irritationGain * pull.irritation * (1 - kept);
  const irritation = clamp(built * (1 - parameters.apologyRelief * signals.apology));
  const floor = (scale: 'trust' | 'liking', value: number) => Math.max(parameters.floorRatio * state.peak[scale], value);
  const trust = clamp(floor('trust', moved('trust'))), liking = clamp(floor('liking', moved('liking'))), respect = clamp(moved('respect'));
  const peak = { trust: Math.max(state.peak.trust, trust), liking: Math.max(state.peak.liking, liking), respect: Math.max(state.peak.respect, respect) };
  return { ...state, scales: { trust, liking, respect, irritation }, peak };
}

/** The relationship with one person after their closed days (oldest first), rested up to `today` (a day key). */
export function foldRelationship(days: readonly RelationshipDay[], personKey: string, today: string,
  parameters: RelationshipParameters = relationshipParametersFor(personKey)): RelationshipState {
  const start = personKey === OWNER_PERSON_KEY ? parameters.start.owner : parameters.start.other;
  let state: RelationshipState = { personKey, scales: start, peak: { trust: start.trust, liking: start.liking, respect: start.respect }, dayKey: null };
  for (const day of [...days].filter(item => item.dayKey < today).sort((a, b) => a.dayKey.localeCompare(b.dayKey))) {
    state = rest(state, state.dayKey ? daysBetween(state.dayKey, day.dayKey) - 1 : 0, parameters);
    state = { ...step(state, daySignals(day.events, personKey), parameters), dayKey: day.dayKey };
  }
  const rested = state.dayKey ? rest(state, daysBetween(state.dayKey, today) - 1, parameters) : state;
  const scales = Object.fromEntries(RELATIONSHIP_SCALES.map(scale => [scale, round(rested.scales[scale])])) as Record<RelationshipScale, number>;
  return { ...rested, scales };
}

const DROP_WORDS: readonly [number, string][] = [[0.03, 'いつもどおり'], [0.1, '少し下がっている'], [0.2, '下がっている']];
const IRRITATION_WORDS: readonly [number, string][] = [[0.05, '残っていない'], [0.2, '少し残っている'], [0.45, '残っている']];
const worded = (value: number, words: readonly [number, string][], last: string) => words.find(([below]) => value < below)?.[1] ?? last;

/** The relationship as one line of facts in words ('' when nothing is off): trust, liking and respect against their highest, irritation. */
export function relationshipLine(state: RelationshipState, who: string, kept: readonly RelationshipScale[] = RELATIONSHIP_SCALES): string {
  const drop = (scale: 'trust' | 'liking' | 'respect') => worded(state.peak[scale] - state.scales[scale], DROP_WORDS, 'かなり下がっている');
  const irritation = worded(state.scales.irritation, IRRITATION_WORDS, '強く残っている');
  const words: Record<RelationshipScale, string> = { trust: `信頼: ${drop('trust')}`, liking: `好意: ${drop('liking')}`, respect: `尊敬: ${drop('respect')}`,
    irritation: `いらだち: ${irritation}` };
  const parts = RELATIONSHIP_SCALES.filter(scale => kept.includes(scale)).map(scale => words[scale]);
  if (parts.every(part => part.endsWith('いつもどおり') || part.endsWith('残っていない'))) return '';
  return `[${who}との間]（日をまたいで持っているもの。事実として。すねた態度は持ち越さない）${parts.join('、')}`;
}

/** Closed values for the chooser and the Observer. */
export function relationshipFacts(state: RelationshipState): Record<string, number> {
  return { rel_trust: state.scales.trust, rel_liking: state.scales.liking, rel_respect: state.scales.respect, rel_irritation: state.scales.irritation };
}
