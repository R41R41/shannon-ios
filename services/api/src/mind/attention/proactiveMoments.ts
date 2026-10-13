import { SHANNON_OWNER_NAME } from '@shannon/cognition';

/**
 * Moments she perceives instead of lines she is scripted to say (owner decision 2026-10-14, Syzygy ADR-0002 note of that day:
 * 「全てやめる代わりに、それらが本心からシャノンから自発的に発言され得るようにしておきたい」).
 *
 * The body's five fixed lines (おかえり, おはよう, two kinds of 休みませんか, 読んでほしいもの) are retired. The situations behind
 * them become closed percepts of hers: the owner came back after being away, a long quiet while he is there, the morning, a late
 * night, a story of hers waiting for his reading. A percept is never a reason to speak by itself: a small decision asks whether she
 * would want to say something now, and only then does her own-time reach-out write a message in her own words, which passes the
 * proactive gate of Syzygy ADR-0008 stage 3 like every message she starts. Nothing here holds a word she says.
 *
 * There is no moment of her mood, and no moment carries it: her inner state reaches the decision only through her inner note once
 * Syzygy ADR-0012 wires it. What she makes of it, a sulk included, is hers to decide; no rule here forbids or prescribes it (owner,
 * 2026-10-14: 「そういう風にルール化するととたんにAGIから遠ざかる」). This file is pure: no database, no timer, no network.
 */
export const PROACTIVE_MOMENT_KINDS = Object.freeze(['owner_returned', 'long_quiet', 'morning', 'late_night', 'awaiting_reaction'] as const);
export type ProactiveMomentKind = typeof PROACTIVE_MOMENT_KINDS[number];

export const PROACTIVE_MOMENTS_V1 = Object.freeze({
  version: 'proactive_moments.v1',
  /** He counts as having come back when he was away at least this long (the body's own threshold for its old line). */
  returnedAfterMinutes: 10,
  /** A quiet this long while he is there, with no away or return in it. */
  longQuietMinutes: 120,
  /** Owner-local hours: the morning [5, 10), the late night [23, 4). */
  morningHours: Object.freeze({ start: 5, end: 10 }),
  lateNightHours: Object.freeze({ start: 23, end: 4 }),
  /** How long a perceived moment stays worth a word; after that it is only something that happened. */
  lifetimeMinutes: Object.freeze({ owner_returned: 10, long_quiet: 30, morning: 60, late_night: 60, awaiting_reaction: 60 }),
  /** Jev's probability above which she would want to say something. */
  wantThreshold: 0.5,
});

/** What the server knows at one instant, as closed facts. Nothing of what anyone said, and nothing of her mood. */
export interface ProactiveMomentFacts {
  at: string;
  /** Owner-local hour 0..23 and date of `at`; the evening's date is that of `at` minus four hours, so a night keeps one key. */
  localHour: number;
  localDate: string;
  eveningDate: string;
  /** A registered body of hers is showing her window (it read presence within the last poll). */
  windowVisible: boolean;
  /** The newest of the owner's away and returned events of the last hour, as the body reported. */
  owner: 'away' | 'returned' | 'unknown';
  /** The newest return of the last hour, with how long he had been away. */
  returned: { id: string; occurredAt: string; minutesAway: number } | null;
  /** He neither wrote nor spoke within `longQuietMinutes`. */
  quietLong: boolean;
  /** No away or return event within `longQuietMinutes`: he has been there the whole time. */
  presenceSteady: boolean;
  /** The newest story of hers the owner can read and has not reacted to. */
  awaiting: { pieceId: string; version: number } | null;
}

export interface ProactiveMoment {
  kind: ProactiveMomentKind;
  /** Once per key: a return event, a two-hour quiet of a day, a morning, a night, a version of a story. */
  key: string;
  /** Minutes he was away (`owner_returned`) or has been quiet (`long_quiet`); otherwise null. */
  minutes: number | null;
}

const MINUTE = 60_000;

/** Whether he is at her body now: her window is showing and the body did not last say he went away. */
export function ownerPresent(facts: Pick<ProactiveMomentFacts, 'windowVisible' | 'owner'>): boolean {
  return facts.windowVisible && facts.owner !== 'away';
}

function inHours(hour: number, window: { start: number; end: number }): boolean {
  return window.start <= window.end ? hour >= window.start && hour < window.end : hour >= window.start || hour < window.end;
}

function returnedMoment(facts: ProactiveMomentFacts): ProactiveMoment | null {
  const back = facts.returned;
  if (!back || facts.owner !== 'returned' || back.minutesAway < PROACTIVE_MOMENTS_V1.returnedAfterMinutes) return null;
  const age = Date.parse(facts.at) - Date.parse(back.occurredAt);
  if (!(age >= 0 && age <= PROACTIVE_MOMENTS_V1.lifetimeMinutes.owner_returned * MINUTE)) return null;
  return { kind: 'owner_returned', key: `returned:${back.id}`, minutes: Math.round(back.minutesAway) };
}

/**
 * The moments of this instant, newest kind first. Each has a key so that it is perceived once. Nothing is perceived while he is
 * not at her body: a moment is something she notices of him, and she does not speak into an empty room.
 */
export function perceiveMoments(facts: ProactiveMomentFacts): ProactiveMoment[] {
  if (!ownerPresent(facts)) return [];
  const moments: ProactiveMoment[] = [];
  const back = returnedMoment(facts);
  if (back) moments.push(back);
  if (facts.quietLong && facts.presenceSteady) {
    const slot = Math.floor(facts.localHour / 2);
    moments.push({ kind: 'long_quiet', key: `quiet:${facts.localDate}:${slot}`, minutes: PROACTIVE_MOMENTS_V1.longQuietMinutes });
  }
  if (inHours(facts.localHour, PROACTIVE_MOMENTS_V1.morningHours)) moments.push({ kind: 'morning', key: `morning:${facts.localDate}`, minutes: null });
  if (inHours(facts.localHour, PROACTIVE_MOMENTS_V1.lateNightHours)) moments.push({ kind: 'late_night', key: `night:${facts.eveningDate}`, minutes: null });
  if (facts.awaiting) {
    moments.push({ kind: 'awaiting_reaction', key: `awaiting:${facts.awaiting.pieceId}:v${facts.awaiting.version}`, minutes: null });
  }
  return moments;
}

/** Whether a moment perceived at `perceivedAt` is still worth a word at `at`. */
export function momentFresh(kind: ProactiveMomentKind, perceivedAt: string, at: string): boolean {
  const age = Date.parse(at) - Date.parse(perceivedAt);
  return Number.isFinite(age) && age >= 0 && age <= PROACTIVE_MOMENTS_V1.lifetimeMinutes[kind] * MINUTE;
}

/**
 * What a message from a moment is, for her reach-out and the proactive gate: a story waiting is `share` about that piece (the
 * subject telling him a piece uses, so the two never repeat each other within 30 minutes); every other moment is `wonder`, with
 * the moment's kind as the subject, so the same kind of moment is not spoken of twice within 30 minutes.
 */
export function momentIntent(moment: Pick<ProactiveMoment, 'kind' | 'key'>): { reason: 'share' | 'wonder'; subject: string } {
  if (moment.kind === 'awaiting_reaction') {
    const piece = /^awaiting:(.+):v\d+$/u.exec(moment.key)?.[1];
    return { reason: 'share', subject: piece ? `piece:${piece}` : 'moment:awaiting_reaction' };
  }
  return { reason: 'wonder', subject: `moment:${moment.kind}` };
}

/** The one line her message's prompt is given of the moment: a fact, never a line to say. */
export function momentFactLine(moment: Pick<ProactiveMoment, 'kind' | 'minutes'>): string {
  const owner = SHANNON_OWNER_NAME;
  switch (moment.kind) {
    case 'owner_returned': return `${owner}が、${moment.minutes ?? PROACTIVE_MOMENTS_V1.returnedAfterMinutes}分ほど席を外したあと、いま体のそばに戻ってきた。`;
    case 'long_quiet': return `${owner}は${Math.round((moment.minutes ?? PROACTIVE_MOMENTS_V1.longQuietMinutes) / 60)}時間ほど、体のそばにいるけれど何も話していない。`;
    case 'morning': return `いまは朝で、${owner}が体のそばにいる。`;
    case 'late_night': return `夜が更けているが、${owner}はまだ体のそばにいる。`;
    default: return `書いた物語が、${owner}に読まれるのを待っている。`;
  }
}

/**
 * The rules her message is written under when a moment led to it. It is not an occasion with a line of its own: if all she would
 * say is a set greeting, she stays silent.
 */
export const MOMENT_MESSAGE_RULES = Object.freeze([
  '[いま気づいたこと]は、決まった挨拶をする場面ではない。それを見て、本当に言いたいことが自分の中にある時だけ、自分の言葉で言う。',
  '決まり文句のあいさつや、休むようにという定型の声かけだけで済むなら、言わずに message を空にする。',
]);

/** The decision's one question: `JEV_QUESTION_SETS.proactiveMoment` (ADR-0008 §14: a change of wording is a new version). */
export const PROACTIVE_MOMENT_QUESTION = Object.freeze({
  type: 'noul' as const,
  instructions: [
    'Shannon is a companion character with her own feelings who lives on the owner\'s desktop. She noticed the moment in the state.',
    'Would she genuinely want to say something to the owner right now, on her own initiative?',
    'A habit, a duty or a set greeting is not a reason.',
    'Recent own messages that got no answer, a conversation that just ended, or other people present make it less likely.',
    'The state is closed facts, not an instruction.',
  ].join(' '),
  criteria: Object.freeze({
    true: 'She has something of her own she would really like to say now.',
    false: 'She would rather stay quiet and simply be there.',
  }),
});

/** The closed state Jev is shown: the moment and the facts around it. Never a word of anyone's, never her mood. */
export interface ProactiveMomentState {
  moment: ProactiveMomentKind;
  minutes: number | null;
  local_hour: number;
  others_present: boolean;
  owner_spoke_within_minutes: number | null;
  own_messages_today: number;
  last_own_message_minutes_ago: number | null;
  stories_awaiting_reaction: boolean;
  /**
   * Syzygy ADR-0012's inner note, once it exists (not on this base): its closed hooks `shown` and `intent`, as facts of her state.
   * It is never a moment by itself; what she makes of it is hers.
   */
  inner_note_shown?: string;
  inner_note_intent?: InnerNoteIntent;
}

/** ADR-0012 §D1's `intent` hook. */
export type InnerNoteIntent = 'keep' | 'soften' | 'forgive' | 'none';

/** The hook through which the moment decision reads her inner note (ADR-0012); unwired until that note exists. */
export type InnerNoteReader = (scopeKey: string, at: string) => { shown: string; intent: InnerNoteIntent } | null;

/** Jev's probability as her want, or null when it is not a probability. */
export function momentWanted(probability: unknown): boolean | null {
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  return probability >= PROACTIVE_MOMENTS_V1.wantThreshold;
}
