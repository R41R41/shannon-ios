import { SHANNON_EMOTION_KINDS, type ShannonEmotionKind, type ShannonExpressiveEmotion } from './types.js';
import { isShannonEmotionKind } from './emotionState.js';

/**
 * Her inner note (Syzygy ADR-0012 D1–D4), the pure part: its vocabulary, the gates that hold what one reflection may change,
 * the owner-local "day" a sulk may last, and the lines a reply, a touch and the voice router read. No database, model, timer or
 * environment: the server (`services/api/src/mind/emotion/innerNote*.ts`) stores, calls and schedules.
 *
 * The note is text first: what she really feels (本音), what she shows (建て前), why, how long she means to (つもり), and how she
 * feels about the owner underneath (底), in her own words. The hooks are derived from it by the same writer, in the same answer.
 * Only a separate reflection writes a note; a reply reads it and never rewrites it (D2.1).
 */

/** `keep` → `soften` → `forgive` → `none`: the order in which she lets something go. */
export const INNER_NOTE_INTENTS = ['keep', 'soften', 'forgive', 'none'] as const;
export type InnerNoteIntent = typeof INNER_NOTE_INTENTS[number];
/** `ordinary`: a sulk of minutes (its `until` at most an hour). `day`: for the rest of her day, only with a reason of a kind. */
export const INNER_NOTE_SCALES = ['ordinary', 'day'] as const;
export type InnerNoteScale = typeof INNER_NOTE_SCALES[number];
/** The kind of reason a `day` sulk needs (D4): done on purpose, done again, or something big. */
export const INNER_NOTE_DAY_REASONS = ['intentional', 'repeated', 'big'] as const;
export type InnerNoteDayReason = typeof INNER_NOTE_DAY_REASONS[number];
/** The sign of what she really feels showing through: none, or a blush (the Live2D cheek, ADR-0012 §7). */
export const INNER_NOTE_TELLS = ['none', 'blush'] as const;
export type InnerNoteTell = typeof INNER_NOTE_TELLS[number];
/** What made her reflect (D2.3), closed. */
export const INNER_NOTE_TRIGGERS = ['touch', 'apology', 'kindness', 'teasing', 'strong_reply', 'until', 'day_end'] as const;
export type InnerNoteTrigger = typeof INNER_NOTE_TRIGGERS[number];
/** How a day ended (D4): the nightly sleep ran, the owner said goodnight, or 3:00 in his time zone. */
export type InnerNoteDayEnd = 'sleep' | 'goodnight' | 'three';

/** Owner-safe bounds (D3, D4). The hour caps are the owner's safety bounds of ADR-0012, not numbers of how she feels. */
export const INNER_NOTE_LIMITS = Object.freeze({
  /** One field of the note, in characters. The whole note is meant to be 200–300. */
  fieldCharacters: 140,
  noteCharacters: 600,
  routeSummaryCharacters: 200,
  summaryCharacters: 160,
  changeReasonCharacters: 120,
  /** An ordinary sulk's `until` is at most an hour away (D4); a later one is cut to the hour and recorded as cut. */
  ordinaryUntilMinutes: 60,
  /** Her day ends at the earlier of the owner's sleep and 3:00 in his time zone (D4); 0:00–3:00 belongs to the day before. */
  dayEndHour: 3,
  /** At most this many events are told to one reflection or listed after a note. */
  events: 8,
});

export interface InnerNoteText {
  /** 本音: what she really feels. */
  honne: string;
  /** 建て前: what she shows. */
  tatemae: string;
  /** 理由: why she shows that. */
  reason: string;
  /** つもり: how long and how she means to keep it. */
  plan: string;
  /** 底: how she feels about the owner underneath, and what she does if he is in trouble. */
  bottom: string;
}

export interface InnerNoteHooks {
  shown: ShannonEmotionKind;
  tell: InnerNoteTell;
  /** Until when she means to (an instant), or null. Not a deadline: when it comes, she reflects again. */
  until: string | null;
  scale: InnerNoteScale;
  dayReason: InnerNoteDayReason | null;
  intent: InnerNoteIntent;
  /** One English line for the voice router, with nothing personal in it. */
  routeSummary: string;
}

/** What one reflection answered, as read (`parsedInnerNoteReflection`), before the gates. */
export interface InnerNoteDraft {
  text: InnerNoteText;
  shown: ShannonEmotionKind;
  tell: InnerNoteTell;
  intent: InnerNoteIntent;
  scale: InnerNoteScale;
  dayReason: InnerNoteDayReason | null;
  untilMinutes: number | null;
  changeReason: string | null;
  routeSummary: string;
  /** Only when a day is closed: what happened that day, in one sentence. */
  summary: string | null;
}

/** What the gates noticed (D3: Observer marks). */
export interface InnerNoteFlags {
  /** An apology or kindness tried to move `intent` more than one step; it was held to one. */
  gateStopped?: true;
  /** `until` was further than the scale allows and was cut. */
  untilClamped?: true;
  /** `day` was asked without a reason of a kind: it is ordinary. */
  dayDowngraded?: true;
  /** She forgave while what she still holds is strong (the numbers have not come down). */
  forgaveWhileHigh?: true;
  /** She moved toward forgiving after an apology and gave no reason of her own (a heuristic of the words). */
  apologyOnlyReason?: true;
  /** An ordinary sulk reached an hour from its start: it ended there, whatever the draft said (D4, the owner's safety bound). */
  capEnded?: true;
  /** Written by the server, not by her: her settling reflection kept failing, and the sulk ended in code (its words are the last note's). */
  endedByCode?: true;
}

/** A note as stored and read. */
export interface InnerNote {
  id: string;
  sequence: number;
  /** The day episode this note belongs to (the id of its first note) and the owner-local day it is (0:00–3:00 is the day before). */
  dayId: string;
  dayKey: string;
  dayEndsAt: string;
  text: InnerNoteText;
  hooks: InnerNoteHooks;
  triggers: readonly InnerNoteTrigger[];
  changeReason: string | null;
  summary: string | null;
  flags: InnerNoteFlags;
  createdAt: string;
  replacedAt: string | null;
  /** Set on the note that closed its day (D4): from then on it is a memory of that day, not her present attitude. */
  closedAt: string | null;
  coreVersion: string;
  /** When the sulk this note belongs to began (its first keep/soften/forgive note); null for a calm note. The ordinary cap counts from it. */
  episodeStartedAt: string | null;
}

/** What happened, as closed facts and her own or the owner's words where they are already hers to read (owner alone only). */
export interface InnerNoteEvent {
  kind: InnerNoteTrigger;
  at: string;
  /** A touch: the part and the way, in the words she is told (胸をつつかれた), how she took it, and what her body did. */
  touch?: { phrase: string; stance?: string; reflex?: string; said?: string };
  /** The owner's words (an apology, a kind word, a tease) and her reply, clipped. */
  words?: string;
  reply?: string;
  /** The feeling of her reply (strong_reply). */
  feeling?: { kind: ShannonEmotionKind; intensity: number };
  /** day_end: why the day ended. */
  dayEnd?: InnerNoteDayEnd;
}

const RANK: Readonly<Record<InnerNoteIntent, number>> = Object.freeze({ keep: 0, soften: 1, forgive: 2, none: 3 });
/** Triggers that are something someone did: one of them moves `intent` at most one step toward letting go (D2.2). */
const EVENT_TRIGGERS: ReadonlySet<InnerNoteTrigger> = new Set(['touch', 'apology', 'kindness', 'teasing', 'strong_reply']);

export const isInnerNoteIntent = (value: unknown): value is InnerNoteIntent => (INNER_NOTE_INTENTS as readonly unknown[]).includes(value);
export const isInnerNoteScale = (value: unknown): value is InnerNoteScale => (INNER_NOTE_SCALES as readonly unknown[]).includes(value);
export const isInnerNoteTell = (value: unknown): value is InnerNoteTell => (INNER_NOTE_TELLS as readonly unknown[]).includes(value);
export const isInnerNoteTrigger = (value: unknown): value is InnerNoteTrigger => (INNER_NOTE_TRIGGERS as readonly unknown[]).includes(value);
export const isInnerNoteDayReason = (value: unknown): value is InnerNoteDayReason => (INNER_NOTE_DAY_REASONS as readonly unknown[]).includes(value);

/** The emotion vocabulary a note may show: every kind she has. */
export const INNER_NOTE_SHOWN_KINDS: readonly ShannonEmotionKind[] = SHANNON_EMOTION_KINDS;

/** Clipped to `maximum` characters, whitespace folded; empty for anything that is not text. */
export function clippedNoteText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const characters = Array.from(value.replace(/\s+/gu, ' ').trim());
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : characters.join('');
}

/** `intent` as one step at a time toward letting go: an event moves it at most one step (D2.2); time and her day's end do not count. */
export function gatedIntent(previous: InnerNoteIntent | null, proposed: InnerNoteIntent, triggers: readonly InnerNoteTrigger[]): {
  intent: InnerNoteIntent; stopped: boolean;
} {
  if (!previous || !triggers.some(trigger => EVENT_TRIGGERS.has(trigger))) return { intent: proposed, stopped: false };
  if (RANK[proposed] - RANK[previous] <= 1) return { intent: proposed, stopped: false };
  return { intent: INNER_NOTE_INTENTS[RANK[previous] + 1]!, stopped: true };
}

/**
 * Her `until` as an instant (D4): an ordinary sulk at most an hour ahead, a day sulk at most to the end of her day; nothing for
 * no minutes, none or a past time. A value further than its bound is cut and recorded as cut.
 */
export function boundedUntil(scale: InnerNoteScale, minutes: number | null, at: string, dayEndsAt: string): { until: string | null; clamped: boolean } {
  const time = Date.parse(at);
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(time)) return { until: null, clamped: false };
  const ordinaryCap = INNER_NOTE_LIMITS.ordinaryUntilMinutes;
  const capped = scale === 'ordinary' ? Math.min(minutes, ordinaryCap) : minutes;
  const end = Date.parse(dayEndsAt);
  const target = Math.min(time + capped * 60_000, Number.isFinite(end) ? end : Number.POSITIVE_INFINITY);
  if (target <= time) return { until: null, clamped: true };
  return { until: new Date(Math.round(target)).toISOString(), clamped: capped !== minutes || target < time + capped * 60_000 };
}

export interface SettleInnerNoteInput {
  draft: InnerNoteDraft;
  previous: Pick<InnerNote, 'hooks' | 'closedAt' | 'createdAt' | 'episodeStartedAt'> | null;
  triggers: readonly InnerNoteTrigger[];
  at: string;
  dayEndsAt: string;
  /** Strength of what she still holds against the owner (an unpleasant feeling underneath), 0–1. */
  holding: number;
  /** The visibility threshold of a held feeling (`SHANNON_EMOTION_CONTINUITY.visibleFrom`). */
  visibleFrom: number;
}

const APOLOGY_WORDS = /謝(?:られ|って|罪|った)|ごめん|すみません/u;
const SULKING: ReadonlySet<InnerNoteIntent> = new Set(['keep', 'soften', 'forgive']);
const MINUTE = 60_000;

/** Whether an intent is a sulk (keep, soften or forgive): what the face, the cap and the sweep look at. */
export const sulkingIntent = (intent: InnerNoteIntent): boolean => SULKING.has(intent);

/** The instant an ordinary sulk ends at the latest: an hour from the start of its episode (never reset by a rewrite). */
export function ordinaryCapOf(note: Pick<InnerNote, 'createdAt' | 'episodeStartedAt'>): string {
  const start = Date.parse(note.episodeStartedAt ?? note.createdAt);
  return new Date((Number.isFinite(start) ? start : 0) + INNER_NOTE_LIMITS.ordinaryUntilMinutes * MINUTE).toISOString();
}

/** The draft through the gates (D2, D4): the hooks to store, the episode it belongs to, and what the gates noticed. */
export function settleInnerNote(input: SettleInnerNoteInput): { hooks: InnerNoteHooks; flags: InnerNoteFlags; episodeStartedAt: string | null } {
  const { draft, triggers } = input;
  const flags: InnerNoteFlags = {};
  if (triggers.includes('day_end')) {
    return { hooks: { shown: draft.shown, tell: 'none', until: null, scale: 'ordinary', dayReason: null, intent: 'none',
      routeSummary: draft.routeSummary }, flags, episodeStartedAt: null };
  }
  const open = input.previous && !input.previous.closedAt ? input.previous : null;
  const previous = open ? open.hooks.intent : null;
  const gate = gatedIntent(previous, draft.intent, triggers);
  if (gate.stopped) flags.gateStopped = true;
  const dayAllowed = draft.scale === 'day' && draft.dayReason !== null;
  if (draft.scale === 'day' && !dayAllowed) flags.dayDowngraded = true;
  const scale: InnerNoteScale = dayAllowed ? 'day' : 'ordinary';
  const episodeStartedAt = open && SULKING.has(open.hooks.intent) ? open.episodeStartedAt ?? open.createdAt : input.at;
  const capped = cappedIntent(gate.intent, scale, episodeStartedAt, input.at, flags);
  const until = cappedUntil(capped, scale, draft.untilMinutes, input, episodeStartedAt, flags);
  Object.assign(flags, driftFlags(input, previous, capped));
  return {
    hooks: { shown: draft.shown, tell: draft.tell, until, scale, dayReason: dayAllowed ? draft.dayReason : null, intent: capped,
      routeSummary: draft.routeSummary },
    flags, episodeStartedAt: SULKING.has(capped) ? episodeStartedAt : null,
  };
}

/** Her `until` within the bounds: none for a calm note; an ordinary sulk's no later than an hour from its episode's start. */
function cappedUntil(intent: InnerNoteIntent, scale: InnerNoteScale, minutes: number | null, input: SettleInnerNoteInput, episodeStartedAt: string,
  flags: InnerNoteFlags): string | null {
  if (intent === 'none') return null;
  const bounded = boundedUntil(scale, minutes, input.at, input.dayEndsAt);
  const cap = ordinaryCapOf({ createdAt: input.at, episodeStartedAt });
  const until = scale === 'ordinary' && bounded.until !== null ? earlier(bounded.until, cap) : bounded.until;
  if (bounded.clamped || until !== bounded.until) flags.untilClamped = true;
  return until;
}

const earlier = (left: string, right: string) => (left <= right ? left : right);

/** An ordinary sulk past an hour from its start ends: the owner's safety bound of D4, kept in code, not asked of her. */
function cappedIntent(intent: InnerNoteIntent, scale: InnerNoteScale, episodeStartedAt: string, at: string, flags: InnerNoteFlags): InnerNoteIntent {
  if (!SULKING.has(intent) || scale !== 'ordinary' || at < ordinaryCapOf({ createdAt: at, episodeStartedAt })) return intent;
  flags.capEnded = true;
  return 'none';
}

/** D3's drift marks: forgiving while the numbers are still high, and moving after an apology without a reason of her own. */
function driftFlags(input: SettleInnerNoteInput, previous: InnerNoteIntent | null, intent: InnerNoteIntent): InnerNoteFlags {
  const flags: InnerNoteFlags = {};
  if (previous === null || RANK[intent] <= RANK[previous]) return flags;
  if (RANK[intent] >= RANK.forgive && input.holding >= input.visibleFrom) flags.forgaveWhileHigh = true;
  const reason = input.draft.changeReason;
  const ownReason = reason !== null && !(APOLOGY_WORDS.test(reason) && Array.from(reason).length < 30);
  if (input.triggers.includes('apology') && !ownReason) flags.apologyOnlyReason = true;
  return flags;
}

type ActiveFields = Pick<InnerNote, 'closedAt' | 'dayEndsAt' | 'hooks' | 'createdAt' | 'episodeStartedAt'>;

/**
 * While a note still holds her attitude (D4): not closed, her day not over, her `until` not passed, and for an ordinary sulk not
 * past an hour from the start of its episode (with no `until` it lasts at most that hour). A calm note is active only before its
 * `until`. Past these the sulk has expired: the server's sweep asks her to settle (`innerNoteExpired`).
 */
export function innerNoteActive(note: ActiveFields | null, at: string): boolean {
  if (!note || note.closedAt || at >= note.dayEndsAt) return false;
  if (note.hooks.until !== null && at >= note.hooks.until) return false;
  if (!SULKING.has(note.hooks.intent)) return note.hooks.until !== null;
  return note.hooks.scale === 'day' || at < ordinaryCapOf(note);
}

/** A sulk whose time ran out (its `until`, or the ordinary hour) while her day goes on: the sweep asks for a settling reflection. */
export function innerNoteExpired(note: ActiveFields | null, at: string): boolean {
  return Boolean(note && innerNoteCurrent(note, at) && SULKING.has(note.hooks.intent) && !innerNoteActive(note, at));
}

/** Whether her note still belongs to the present (her day is not over and it was not closed): what the readers are given. */
export function innerNoteCurrent(note: Pick<InnerNote, 'closedAt' | 'dayEndsAt'> | null, at: string): boolean {
  return Boolean(note && !note.closedAt && at < note.dayEndsAt);
}

/** The face hooks while a note is active (Live2D: face, blush, until), or null. */
export function innerNoteFace(note: ActiveFields | null, at: string): {
  shown: ShannonEmotionKind; tell: InnerNoteTell; until: string | null;
} | null {
  if (!note || !innerNoteActive(note, at)) return null;
  return { shown: note.hooks.shown, tell: note.hooks.tell, until: note.hooks.until };
}

/**
 * D5.2: her own 「ごめん」 does not take her face while a note is active. A feeling named `apologetic` by a cue word of her reply or
 * by the router's reading of his words gives way to what the note shows; an apology she decided for herself (a text reply's
 * feeling at moderate or above) or an override (safety, grief, an emergency) stays. Anything else is returned as it was.
 */
export function withoutOwnApology(
  emotion: ShannonExpressiveEmotion, note: ActiveFields | null, at: string,
  decided?: { primary: string; intensity: number },
  /** A tool of the turn failed: her apology may be for that, and it stays. */
  failed = false,
): ShannonExpressiveEmotion {
  if (emotion.primary !== 'apologetic' || emotion.overrideReason || failed) return emotion;
  if (decided?.primary === 'apologetic' && decided.intensity >= 0.6) return emotion;
  const face = innerNoteFace(note, at);
  if (!face) return emotion;
  const primary = face.shown;
  return Object.freeze({ ...emotion, primary, secondary: Object.freeze(emotion.secondary.filter(kind => kind !== primary && kind !== 'apologetic')) });
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit' });
    } catch {
      return zoneFormatter('Asia/Tokyo');
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock of an instant in a time zone. */
export function zonedParts(time: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(zoneFormatter(timeZone).formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** The instant of a wall-clock time in a time zone (two passes, so a change of offset is followed). */
function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let guess = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = zonedParts(guess, timeZone);
    const shown = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    guess += wall - shown;
  }
  return guess;
}

/**
 * Her day (D4): the owner-local date it belongs to (0:00–3:00 is the day before) and its latest end, 3:00 of the next morning in
 * his time zone. The owner's sleep may end it earlier; the server says when.
 */
export function innerNoteDay(at: string, timeZone = 'Asia/Tokyo'): { dayKey: string; endsAt: string } {
  const time = Date.parse(at);
  const hour = INNER_NOTE_LIMITS.dayEndHour;
  const local = zonedParts((Number.isFinite(time) ? time : 0) - hour * 3_600_000, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const endsAt = zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, timeZone);
  return { dayKey: `${local.year}-${pad(local.month)}-${pad(local.day)}`, endsAt: new Date(endsAt).toISOString() };
}

/** 「22:40」 in the owner's time zone. */
export function localClock(at: string, timeZone = 'Asia/Tokyo'): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const local = zonedParts(time, timeZone);
  return `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
}

const STANCE_WORDS: Readonly<Record<string, string>> = Object.freeze({ welcome: 'うれしい', fine: 'かまわない', unsure: '戸惑う', dislike: 'いや', refuse: '拒む' });
const REFLEX_WORDS: Readonly<Record<string, string>> = Object.freeze({ flinch: '体が反射で小さく身を引いた', avoid: '体が反射で身をそらした' });

/** How long ago, in her words. */
function ago(at: string, now: string): string {
  const minutes = Math.round((Date.parse(now) - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'さっき';
  return minutes < 60 ? `${minutes}分前` : `${Math.round(minutes / 60)}時間前`;
}

const quoted = (text: string | undefined, label: string) => text ? `${label}「${clippedNoteText(text, 80)}」` : '';
const exchange = (event: InnerNoteEvent) => `${quoted(event.words, ': ')}${quoted(event.reply, ' → ボク')}`;
const DAY_END_WORDS: Readonly<Record<InnerNoteDayEnd, string>> = Object.freeze({ sleep: '夜の眠りの処理が走った', goodnight: 'ライ氏がおやすみと言った', three: '3:00' });

function touchLine(event: InnerNoteEvent): string {
  const touch = event.touch;
  const stance = touch?.stance ? `。ボクの受け取り: ${STANCE_WORDS[touch.stance] ?? touch.stance}` : '';
  const reflex = touch?.reflex && REFLEX_WORDS[touch.reflex] ? `（${REFLEX_WORDS[touch.reflex]}）` : '';
  return `体: ${touch?.phrase ?? '体に触れられた'}${reflex}${stance}${quoted(touch?.said, '。ボクの一言')}`;
}

const EVENT_WORDS: Readonly<Record<InnerNoteTrigger, (event: InnerNoteEvent) => string>> = Object.freeze({
  touch: touchLine,
  apology: event => `ライ氏が謝った${exchange(event)}`,
  kindness: event => `ライ氏のやさしい言葉${exchange(event)}`,
  teasing: event => `ライ氏にからかわれた${exchange(event)}`,
  strong_reply: event => `気持ちが動いた（${event.feeling ? `${event.feeling.kind} ${event.feeling.intensity.toFixed(2)}` : '?'}）${exchange(event)}`,
  until: () => '前のメモで決めた時刻が来た',
  day_end: event => `今日が終わる（${DAY_END_WORDS[event.dayEnd ?? 'three']}）`,
});

/** One event as a line: the time, what happened, and how she took it. */
export function innerNoteEventLine(event: InnerNoteEvent, now: string, timeZone = 'Asia/Tokyo'): string {
  return `- ${localClock(event.at, timeZone)}（${ago(event.at, now)}） ${EVENT_WORDS[event.kind](event)}`;
}

/** The text of a note as she wrote it, one field a line. */
export function innerNoteTextLines(text: InnerNoteText): string[] {
  return [`本音: ${text.honne}`, `建て前: ${text.tatemae}`, `理由: ${text.reason}`, `つもり: ${text.plan}`, `底: ${text.bottom}`];
}

function horizon(note: InnerNote, timeZone: string): string {
  if (note.hooks.scale === 'day') return 'その日いっぱい';
  return note.hooks.until ? `${localClock(note.hooks.until, timeZone)}ごろまで` : '';
}

/**
 * The block a reply reads at the end of its turn context (D2.5): with the owner alone her whole note and what happened since it
 * was written; with anyone else present only what she shows, without a reason (ADR-0005 decision 6); nothing without a current
 * note or for a guest's own call. It describes how she feels and holds no rule of behavior (owner, 2026-10-14): what must happen
 * whatever her mood (his alarms and reminders, the tools a request needs) is guaranteed in code, not asked of her here.
 */
export function innerNoteTurnBlock(note: InnerNote | null, audience: 'owner' | 'others' | 'guest', at: string,
  pending: readonly InnerNoteEvent[] = [], timeZone = 'Asia/Tokyo'): string {
  if (!note || !innerNoteCurrent(note, at) || audience === 'guest') return '';
  if (audience === 'others') return innerNoteActive(note, at) ? `[いまの見せ方]（ほかの人もいる場）見せる気持ち: ${note.hooks.shown}` : '';
  if (innerNoteExpired(note, at) || note.flags.endedByCode) return pastNoteBlock(note, timeZone);
  const span = horizon(note, timeZone);
  return [
    `[心のメモ]（${localClock(note.createdAt, timeZone)}にボクが自分で書いた独白。いまの自分の気持ち）`,
    ...innerNoteTextLines(note.text).map(line => `- ${line}`),
    `- 見せる気持ち: ${note.hooks.shown}${note.hooks.tell === 'blush' ? '（本音が少しにじむ: 頬が赤くなる）' : ''}${span ? ` / ${span}` : ''}`,
    ...(pending.length ? ['- このメモのあとに起きたこと（まだ振り返っていない。事実として）:',
      ...pending.slice(-INNER_NOTE_LIMITS.events).map(event => `  ${innerNoteEventLine(event, at, timeZone).slice(2)}`)] : []),
  ].join('\n');
}

/** The short form a touch prompt carries: with the owner alone 本音・建て前・つもり, with others what she shows; else nothing. */
export function innerNoteTouchBlock(note: InnerNote | null, audience: 'owner' | 'others', at: string, timeZone = 'Asia/Tokyo'): string {
  if (!note || !innerNoteCurrent(note, at)) return '';
  if (audience === 'others') return innerNoteActive(note, at) ? `[いまの見せ方]（ほかの人もいる場）見せる気持ち: ${note.hooks.shown}` : '';
  if (innerNoteExpired(note, at) || note.flags.endedByCode) return pastNoteBlock(note, timeZone);
  const span = horizon(note, timeZone);
  return ['[心のメモ]（さっき自分で書いた独白。いまの自分の気持ち）', `- 本音: ${note.text.honne}`, `- 建て前: ${note.text.tatemae}`,
    `- つもり: ${note.text.plan}${span ? `（${span}）` : ''}`].join('\n');
}

/**
 * A sulk whose time ran out (N1): only as what she felt a while ago, in the past tense and without its hooks, until her settling
 * reflection writes how she is now. Never as 「いまの自分の気持ち」.
 */
function pastNoteBlock(note: InnerNote, timeZone: string): string {
  return [`[さっきまでの気持ち]（${localClock(note.createdAt, timeZone)}に書いたメモ。そのつもりの時間はもう過ぎた）`, `- 本音: ${note.text.honne}`,
    `- 建て前: ${note.text.tatemae}`].join('\n');
}

/** Jev's one English line (D5.4, `voice_route.v3`): only while a note is current and not run out; ASCII only. */
export function innerNoteRouteSummary(note: InnerNote | null, at: string): string | undefined {
  if (!note || !innerNoteCurrent(note, at) || innerNoteExpired(note, at) || note.flags.endedByCode) return undefined;
  const plain = asciiRouteSummary(note.hooks.routeSummary);
  return plain || undefined;
}

/** A route summary as Jev may be given it: printable ASCII, folded, bounded. */
export function asciiRouteSummary(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\x20-\x7e]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, INNER_NOTE_LIMITS.routeSummaryCharacters);
}

/** A kind read from a reflection: one of hers, else neutral. */
export function shownKind(value: unknown): ShannonEmotionKind {
  return typeof value === 'string' && isShannonEmotionKind(value) ? value : 'neutral';
}
