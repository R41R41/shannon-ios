import { CHARACTER_CORE, characterCoreBlock, type CharacterCore } from './characterCore.js';
import {
  INNER_NOTE_DAY_REASONS, INNER_NOTE_INTENTS, INNER_NOTE_LIMITS, INNER_NOTE_SCALES, INNER_NOTE_SHOWN_KINDS, INNER_NOTE_TELLS,
  asciiRouteSummary, clippedNoteText, innerNoteEventLine, innerNoteTextLines, isInnerNoteDayReason, isInnerNoteIntent,
  isInnerNoteScale, isInnerNoteTell, localClock, shownKind,
  type InnerNote, type InnerNoteDraft, type InnerNoteEvent, type InnerNoteText,
} from './innerNote.js';
import { SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME } from './persona.js';
import type { ShannonEmotionKind } from './types.js';

/**
 * The reflection that writes her inner note (Syzygy ADR-0012 D2–D4): its fixed instructions (her character core, the rules and
 * the questions; the same bytes on every call, so the provider caches them for an hour), the facts of one call, the answer's
 * schema, and how the answer is read. It describes her (the core), the note's form and what the system holds in code (the one-step
 * gate, the caps of `until`, the day's end); it hard-codes no outcome, neither how she should feel nor what she must do (owner,
 * 2026-10-14: rules of behavior take her further from being an AGI).
 */

const I = SHANNON_FIRST_PERSON;
const OWNER = SHANNON_OWNER_NAME;

const HEADER = `[心のメモを書く]
あなたはシャノン本人。いまから、自分の気持ちを短い独白（心のメモ）として書く。${OWNER}への返事ではなく、聞き手のいない独白として、自分の言葉で書く。
返事を書く時の${I}は、このメモを読んでいまの自分の気持ちを知る。メモを書くのは、この振り返りの時だけ。
${OWNER}はあとで「ようす」でこのメモを読むことがある。`;

const FIELDS = `[書く項目]（合わせて200〜300字ほど。各項目は1〜2文）
- honne（本音）: ほんとうはどう感じているか。
- tatemae（建て前）: 何を見せるか。
- reason（理由）: なぜそれを見せるか。
- plan（つもり）: どれくらいの間、どうしているつもりか。構えとして書く（次に言うせりふは書かない。言葉はその時の${I}が決める）。
- bottom（底）: ${OWNER}への気持ち（好き・信頼）がいまどうか。
本音と建て前は食い違っていてもいい。`;

const LENGTH_FACT = '- scale は ordinary（ふだん）か day（その日いっぱい）。ordinary の until_minutes は60分までしか置けない。'
  + 'day を選ぶ時は、その理由の種類を day_reason（intentional＝わざと / repeated＝繰り返し / big＝大きめのこと）に書く。書かないと ordinary になる。'
  + `until は今日の終わり（遅くとも3:00、${OWNER}が寝たらそこまで）より先には置けない。`;

const SYSTEM = `[仕組み]（メモの形と、仕組みとして決まっていること）
- 前のメモで書いた「つもり」を変える時は、変えた自分の理由を change_reason に一行で書く。変えない時は null。
- intent は keep（このまま）→ soften（やわらげる）→ forgive（許す）→ none（何もない）の順。誰かがしたこと（謝罪・やさしい言葉・触れる・からかう）1回では、この順に1段までしか動かない（仕組み）。
${LENGTH_FACT}
- 一日の気持ちは、次の日には持ち越されない（仕組み）。[今日を閉じる] とある時は、intent=none、until_minutes=null にして、summary に今日の出来事を一文で書く。それ以外の時、summary は null。`;

const QUESTIONS = `[振り返りの問い]
- いま本当はどう感じている？　それを見せたい？
- 見せないなら、何を見せる？　なぜ？
- いつごろまで、そうしているつもり？（言うせりふではなく、構えとして）
- 触れられたのなら、それはわざと？　回数・場所・直前の会話から、${I}はどう読む？
- ${OWNER}のことは、いまどう思っている？
- 自分の性格の核と食い違っていない？`;

const ROUTE_FIELD = '- route_summary: 英語1文。声の演じ方を選ぶ係に渡る。個人的な中身（何をされた・何を言われた・名前）は書かず、見せ方の向きだけを書く'
  + '（例: "Shannon is acting a little sulky and cool, but is not truly hurt."）。';

const HOOKS = `[フック]（本文と一緒に出す）
- shown: 見せる気持ちを一つ（語彙から。たとえば sulky・cuteAngry・flustered・hidingHappiness・bashful・annoyed・neutral）。
- tell: 本音がにじむしるし（頬が赤くなる）があれば blush、なければ none。
- intent: keep・soften・forgive・none。
- scale・until_minutes・day_reason: 上の仕組みのとおり。何もない時は until_minutes=null。
${ROUTE_FIELD}`;

/**
 * Syzygy ADR-0013 §6 (`SHANNON_INNER_NARRATOR`): the note no longer decides her feeling; it reads the fast layer and the ledger, and tells
 * her honne, her tatemae and her plan as the narrator. Her replies were said to the moment, so they are not where her honne comes from.
 */
const NARRATOR = `[語り手として]
- いまの気持ちは、もう動いている（[いまの${I}]、速い層）。メモはそれを決め直さず、読んで、本人の言葉で語る。
- 本音は、速い層と今日の件（帳面）から読む。${I}が返事で言ったことを本音の元にしない（返事は、その場に合わせて言ったことがある）。`;

/** The fixed instructions of a reflection: the same bytes for every call of one core version (cached for an hour); one more section as narrator. */
export function innerNoteReflectionInstructions(core: CharacterCore = CHARACTER_CORE, options: { narrator?: boolean } = {}): string {
  return [HEADER, characterCoreBlock(core), FIELDS, SYSTEM, QUESTIONS, HOOKS, ...(options.narrator ? [NARRATOR] : [])].join('\n\n');
}

export interface InnerNoteReflectionFacts {
  at: string;
  timeZone: string;
  events: readonly InnerNoteEvent[];
  previous: InnerNote | null;
  /** This day's apologies and kind words, oldest first (instants): repeated apologies count for less (D2.2). */
  apologies: readonly string[];
  kindnesses: readonly string[];
  /** The numbers of her feeling, as facts (ADR-0006: time and strength are theirs). */
  feeling: { present: { kind: ShannonEmotionKind; intensity: number } | null; lingering: readonly { kind: ShannonEmotionKind; strength: number }[] };
  dayEndsAt: string;
  /** The day is being closed. */
  closing: boolean;
  /** The last closed day's summary, as something that happened (never an attitude to carry on). */
  yesterday: string | null;
  /** The last lines of the conversation in progress, oldest first (the owner alone only). */
  recent: readonly { role: 'user' | 'assistant'; content: string }[];
  /**
   * Her body this day (owner alone only; 2026-10-14): how often each part was touched since her day began, and what she said lately
   * because of touches, oldest first. Facts, so that she reads for herself whether it was on purpose. Absent: nothing is said of it.
   */
  touches?: { today: readonly { part: string; count: number }[]; lines: readonly string[] };
  /** Syzygy ADR-0013 (`SHANNON_FEELING_EVENTS`): the day's episode ledger, the same line her replies are given. Absent: nothing. */
  ledger?: string;
  /** This day's turns that asked, allowed or refused touching her, oldest first (events with `consent`). */
  consents?: readonly InnerNoteEvent[];
  /** Syzygy ADR-0013 §6 (`SHANNON_INNER_NARRATOR`): her fast layer now, in words (`fastLayerWords`). Present: she reflects as narrator. */
  fastLayer?: string;
}

function minutesLeft(at: string, until: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(until) - Date.parse(at)) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60}分` : `${minutes}分`;
}

function previousLines(previous: InnerNote, at: string, timeZone: string): string[] {
  const until = previous.hooks.until ? `, until=${localClock(previous.hooks.until, timeZone)}` : '';
  return [`[前のメモ]（${localClock(previous.createdAt, timeZone)}に書いた）`, ...innerNoteTextLines(previous.text),
    `フック: shown=${previous.hooks.shown}, tell=${previous.hooks.tell}, intent=${previous.hooks.intent}, scale=${previous.hooks.scale}${until}`,
    ...(previous.hooks.until && previous.hooks.until <= at ? ['（前のメモで決めた時刻は過ぎている）'] : [])];
}

function feelingLine(feeling: InnerNoteReflectionFacts['feeling']): string {
  const present = feeling.present ? `いまの気持ち: ${feeling.present.kind} ${feeling.present.intensity.toFixed(2)}` : 'いまの気持ち: 落ち着いている';
  const held = feeling.lingering.map(item => `${item.kind} ${item.strength.toFixed(2)}`).join('、');
  const lingering = held ? `残っている気持ち: ${held}` : '残っている気持ち: なし';
  return `[数値の気持ち]（時間で薄れる側。事実として）${present}。${lingering}。`;
}

/** Her body this day and the turns about touching her, as facts (absent: nothing). */
function touchLines(facts: InnerNoteReflectionFacts): string[] {
  const today = facts.touches?.today.filter(item => item.count > 0) ?? [];
  const lines = facts.touches?.lines ?? [];
  const consents = (facts.consents ?? []).slice(-3);
  return [
    ...(facts.ledger ? [`[今日の件]（帳面。事実として）\n${facts.ledger}`] : []),
    ...(today.length ? [`[今日、体に触れられた回数]（場所ごと。事実として）${today.map(item => `${item.part} ${item.count}回`).join('、')}`] : []),
    ...(lines.length ? [`[触れられて${I}が言ったこと]（古い順）${lines.map(line => `「${clippedNoteText(line, 60)}」`).join('')}`] : []),
    ...(consents.length ? [['[触れることについての会話]（今日。事実として）', ...consents.map(event => innerNoteEventLine(event, facts.at, facts.timeZone))].join('\n')] : []),
  ];
}

/** The facts of one reflection, as its input (never in the cached part). */
export function innerNoteReflectionInput(facts: InnerNoteReflectionFacts): string {
  const { at, timeZone } = facts;
  const times = facts.apologies.map(item => localClock(item, timeZone)).join('、');
  const counts = `[この日のこと] ${OWNER}の謝罪: ${facts.apologies.length}回${times ? `（${times}）` : ''}。やさしい言葉: ${facts.kindnesses.length}回。`;
  const recent = facts.recent.map(item => `${item.role === 'user' ? OWNER : I}: ${clippedNoteText(item.content, 160)}`);
  return [
    `[いま] ${localClock(at, timeZone)}（${OWNER}の時刻）。今日の終わりまで、あと${minutesLeft(at, facts.dayEndsAt)}（遅くとも${localClock(facts.dayEndsAt, timeZone)}）。`,
    ...(facts.previous ? previousLines(facts.previous, at, timeZone) : ['[前のメモ] なし（今日はまだ書いていない）']),
    counts,
    ['[起きたこと]', ...facts.events.slice(-INNER_NOTE_LIMITS.events).map(event => innerNoteEventLine(event, at, timeZone))].join('\n'),
    ...touchLines(facts),
    ...(facts.fastLayer ? [facts.fastLayer] : []),
    feelingLine(facts.feeling),
    ...(recent.length ? [['[直前の会話]', ...recent].join('\n')] : []),
    ...(facts.yesterday ? [`[前の日のこと]（出来事として覚えているだけ。態度は持ち越さない）${facts.yesterday}`] : []),
    facts.closing ? '[今日を閉じる] 今日の終わり。intent=none、until_minutes=null にして、summary に今日の出来事を一文で書く。' : '上のことを踏まえて、いまの心のメモを書く。',
  ].join('\n\n');
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [{ type: 'null' }, schema] });

/** The answer of a reflection. */
export const INNER_NOTE_REFLECTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    honne: { type: 'string', description: '本音' },
    tatemae: { type: 'string', description: '建て前' },
    reason: { type: 'string', description: '理由' },
    plan: { type: 'string', description: 'つもり' },
    bottom: { type: 'string', description: '底' },
    shown: { type: 'string', enum: [...INNER_NOTE_SHOWN_KINDS], description: '見せる気持ち' },
    tell: { type: 'string', enum: [...INNER_NOTE_TELLS] },
    intent: { type: 'string', enum: [...INNER_NOTE_INTENTS] },
    scale: { type: 'string', enum: [...INNER_NOTE_SCALES] },
    day_reason: nullable({ type: 'string', enum: [...INNER_NOTE_DAY_REASONS] }),
    until_minutes: nullable({ type: 'integer', description: '何分後まで。なければnull' }),
    change_reason: nullable({ type: 'string', description: 'つもりを変えた自分の理由' }),
    route_summary: { type: 'string', description: 'English, one sentence, nothing personal' },
    summary: nullable({ type: 'string', description: '今日を閉じる時だけ: 今日の出来事を一文で' }),
  },
  required: ['honne', 'tatemae', 'reason', 'plan', 'bottom', 'shown', 'tell', 'intent', 'scale', 'day_reason', 'until_minutes',
    'change_reason', 'route_summary', 'summary'],
});

/** The answer as a draft, or null when it is not one (a field missing or empty). The gates come after (`settleInnerNote`). */
export function parsedInnerNoteReflection(value: unknown): InnerNoteDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = noteTextOf(row);
  if (!text || !isInnerNoteIntent(row.intent) || !isInnerNoteScale(row.scale)) return null;
  const minutes = typeof row.until_minutes === 'number' && Number.isFinite(row.until_minutes) ? Math.round(row.until_minutes) : null;
  return {
    text, shown: shownKind(row.shown), tell: isInnerNoteTell(row.tell) ? row.tell : 'none', intent: row.intent, scale: row.scale,
    dayReason: isInnerNoteDayReason(row.day_reason) ? row.day_reason : null, untilMinutes: minutes,
    changeReason: clippedNoteText(row.change_reason, INNER_NOTE_LIMITS.changeReasonCharacters) || null,
    routeSummary: asciiRouteSummary(row.route_summary), summary: clippedNoteText(row.summary, INNER_NOTE_LIMITS.summaryCharacters) || null,
  };
}

/** The five fields, clipped; null when 本音, 建て前, つもり or 底 is empty (理由 may be). */
function noteTextOf(row: Record<string, unknown>): InnerNoteText | null {
  const field = (name: string) => clippedNoteText(row[name], INNER_NOTE_LIMITS.fieldCharacters);
  const text = { honne: field('honne'), tatemae: field('tatemae'), reason: field('reason'), plan: field('plan'), bottom: field('bottom') };
  return text.honne && text.tatemae && text.plan && text.bottom ? text : null;
}
