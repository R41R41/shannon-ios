import type { FeelingAudience, FeelingChannel, FeelingEvent, ReplyHabit, ReplyOpener } from './feelingEvent.js';

/**
 * The repetition watch v0 (Syzygy ADR-0013 D9): of her own recent words in front of one audience, how they opened (「ライ氏、」,
 * 「ひゃっ」), her habits (「えへへ」) and the drawers she reached into twice in a row. Pure; counted from the closed facts of her
 * own reply events (never her words). The watch is per audience: what she said to the owner alone is not counted in front of others.
 * 2026-10-14: twelve of fourteen replies opened with 「ライ氏、」 and every touch line with 「ひゃっ」.
 */
export interface RepetitionWatch {
  audience: FeelingAudience;
  /** How many of her replies were looked at (the newest, at most `REPETITION_LIMITS.replies`). */
  replies: number;
  openers: Partial<Record<ReplyOpener, number>>;
  habits: Partial<Record<ReplyHabit, number>>;
  /** Touch lines (channel body) and how many of the last ones opened the same way in a row. */
  touchLines: number;
  touchOpenerRun: { opener: ReplyOpener; run: number } | null;
  /** A drawer used in each of her last two replies. */
  drawerRun: string | null;
}

export const REPETITION_LIMITS = Object.freeze({ replies: 8, touchLines: 5, overusedShare: 0.3, overusedHabit: 2 });

const OPENER_WORDS: Readonly<Record<ReplyOpener, string>> = Object.freeze({ rai_shi: '「ライ氏、」', hya: '「ひゃっ」', eh: '「えっ」', other: '' });
const HABIT_WORDS: Readonly<Record<ReplyHabit, string>> = Object.freeze({ ehehe: '「えへへ」', apology: '謝る言葉' });

function runOf(openers: readonly ReplyOpener[]): { opener: ReplyOpener; run: number } | null {
  const first = openers[0];
  if (!first || first === 'other') return null;
  let run = 0;
  while (run < openers.length && openers[run] === first) run += 1;
  return { opener: first, run };
}

/** The watch over her newest reply events (any order) for one audience. */
export function watchRepetition(events: readonly FeelingEvent[], audience: FeelingAudience): RepetitionWatch {
  const own = events.filter(event => event.kind === 'own_reply' && event.audience === audience)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const of = (channels: readonly FeelingChannel[], limit: number) => own.filter(event => channels.includes(event.channel)).slice(0, limit);
  const replies = of(['text', 'voice'], REPETITION_LIMITS.replies);
  const touchLines = of(['body'], REPETITION_LIMITS.touchLines);
  const openers: Partial<Record<ReplyOpener, number>> = {};
  const habits: Partial<Record<ReplyHabit, number>> = {};
  for (const event of replies) {
    const opener = event.facts.opener ?? 'other';
    openers[opener] = (openers[opener] ?? 0) + 1;
    for (const habit of event.facts.habits ?? []) habits[habit] = (habits[habit] ?? 0) + 1;
  }
  const [last, before] = [...replies, ...touchLines].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const drawerRun = last?.facts.drawers?.find(kind => before?.facts.drawers?.includes(kind)) ?? null;
  return { audience, replies: replies.length, openers, habits, touchLines: touchLines.length,
    touchOpenerRun: runOf(touchLines.map(event => event.facts.opener ?? 'other')), drawerRun };
}

/** What she should not lean on again: openers over the share, habits used twice or more, a touch opener twice in a row, a drawer twice. */
export function repetitionLine(watch: RepetitionWatch): string {
  const overused = (Object.entries(watch.openers) as [ReplyOpener, number][])
    .filter(([opener, count]) => opener !== 'other' && watch.replies > 1 && count / watch.replies > REPETITION_LIMITS.overusedShare)
    .map(([opener, count]) => `書き出し${OPENER_WORDS[opener]}が直近${watch.replies}件中${count}件`);
  const habits = (Object.entries(watch.habits) as [ReplyHabit, number][]).filter(([, count]) => count >= REPETITION_LIMITS.overusedHabit)
    .map(([habit, count]) => `${HABIT_WORDS[habit]}が${count}件`);
  const run = watch.touchOpenerRun;
  const touch = run && run.run >= 2 ? [`触れられた時のひとことが${OPENER_WORDS[run.opener]}で${run.run}回続いた`] : [];
  const drawer = watch.drawerRun ? ['同じ切り返しが2回続いた'] : [];
  const found = [...overused, ...habits, ...touch, ...drawer];
  return found.length ? `最近使った言い方: ${found.join('、')}。同じ書き出し・口癖・切り返しは、今回は避ける。` : '';
}

/**
 * The day's phrases (owner 2026-10-19: in a week 「ふん」 33 times, 「照れちゃいます」 13, 「べつに待ってたわけじゃない」 10, and three in
 * ten of her replies opened with 「……」; the watch above saw three openers and two habits in her last eight replies). Of her replies of
 * the day in his Talk (their words read at the turn from the conversation, never kept): how they open, how they end, and the phrases she
 * has already said in `PHRASE_LIMITS.repeated` replies or more. Pure.
 */
export interface PhraseCount { phrase: string; count: number }
export interface PhraseWatch {
  /** How many of her replies were read. */
  replies: number;
  openers: PhraseCount[];
  endings: PhraseCount[];
  phrases: PhraseCount[];
}

export const PHRASE_LIMITS = Object.freeze({
  /** From this many replies of the day a phrase is hers already today. */
  repeated: 3,
  /** At most this many of each kind are told. */
  listed: 4,
  /** A phrase is this many characters at least (all in hiragana: `hiraganaShortest`), and at most `longest`. */
  shortest: 5, hiraganaShortest: 7, longest: 16,
  /** A phrase is mostly kana (her way of saying), at least this share of hiragana. */
  kanaShare: 0.5,
  /** An opening clause of at most this many characters is an opener of its own (「ふん」「ライ氏」「おかえり」). */
  opener: 8,
  /** An ending is the last clause when it is this short, else its last `ending` characters. */
  shortClause: 6, ending: 4,
});

const LEADING_ELLIPSIS = /^(?:…|‥|\.{3}|・{3})+/u;
const CLAUSE_BREAK = /[、。！？!?,，「」『』（）()\n…‥・〜~]+/u;
const FINAL_MARKS = /[\s。！？!?…‥・〜~ー)）」』\p{Extended_Pictographic}]+$/u;
/** Endings every polite sentence has (「ですよ」「ました」): not a habit of hers. */
const GENERIC_ENDING = /(?:[でま]す|ました|ません|でした|ましょう|ください|ている|てる|だ|る|た|い)[よねか]?$/u;
const ALL_HIRAGANA = /^[\p{Script=Hiragana}ー]+$/u;
const HIRAGANA = /\p{Script=Hiragana}/gu;

function plainText(text: string): string {
  return text.normalize('NFKC').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/https?:\/\/\S+/gu, '').replace(/[ \t]+/gu, '').trim();
}

/** 「……」 when the reply opens with an ellipsis, and its first clause when that is short. */
function openersOf(text: string): string[] {
  const lead = LEADING_ELLIPSIS.exec(text);
  const rest = text.slice(lead?.[0].length ?? 0);
  const clause = rest.split(CLAUSE_BREAK)[0] ?? '';
  return [...(lead ? ['……'] : []), ...(clause && Array.from(clause).length <= PHRASE_LIMITS.opener ? [clause] : [])];
}

function endingOf(text: string): string | null {
  const body = text.replace(FINAL_MARKS, '');
  const clause = body.split(CLAUSE_BREAK).filter(Boolean).at(-1) ?? '';
  const characters = Array.from(clause);
  if (!characters.length) return null;
  const ending = characters.length <= PHRASE_LIMITS.shortClause ? clause : characters.slice(-PHRASE_LIMITS.ending).join('');
  return GENERIC_ENDING.test(ending) ? null : ending;
}

function phrasesOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const clause of text.split(CLAUSE_BREAK)) {
    const characters = Array.from(clause);
    for (let start = 0; start < characters.length; start += 1) {
      for (let length = PHRASE_LIMITS.shortest; length <= PHRASE_LIMITS.longest && start + length <= characters.length; length += 1) {
        const phrase = characters.slice(start, start + length).join('');
        if (length < PHRASE_LIMITS.hiraganaShortest && ALL_HIRAGANA.test(phrase)) continue;
        // A phrase of names and facts (「降水確率は」「スプラトゥーンが」) is what she talks about, not how: only one mostly in kana.
        if ((phrase.match(HIRAGANA) ?? []).length / length < PHRASE_LIMITS.kanaShare) continue;
        found.add(phrase);
      }
    }
  }
  return found;
}

function tally(lists: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const list of lists) for (const item of new Set(list)) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

const repeatedOf = (counts: Map<string, number>): PhraseCount[] => [...counts]
  .filter(([, count]) => count >= PHRASE_LIMITS.repeated).map(([phrase, count]) => ({ phrase, count }))
  .sort((a, b) => b.count - a.count || Array.from(b.phrase).length - Array.from(a.phrase).length);

/** The longest phrase of each run: one that contains, or is contained in, a phrase already kept is left out. */
function maximal(candidates: readonly PhraseCount[]): PhraseCount[] {
  const kept: PhraseCount[] = [];
  for (const candidate of candidates) {
    if (kept.some(item => item.phrase.includes(candidate.phrase) || candidate.phrase.includes(item.phrase))) continue;
    kept.push(candidate);
    if (kept.length >= PHRASE_LIMITS.listed) break;
  }
  return kept;
}

/** The watch over the day's replies (her words, in any order). */
export function watchPhrases(texts: readonly string[]): PhraseWatch {
  const replies = texts.map(plainText).filter(Boolean);
  const openers = repeatedOf(tally(replies.map(openersOf))).slice(0, PHRASE_LIMITS.listed);
  const endings = repeatedOf(tally(replies.map(text => [endingOf(text)].filter((item): item is string => item !== null)))).slice(0, PHRASE_LIMITS.listed);
  const said = new Set([...openers, ...endings].map(item => item.phrase));
  const phrases = maximal(repeatedOf(tally(replies.map(text => [...phrasesOf(text)]))).filter(item => !said.has(item.phrase)));
  return { replies: replies.length, openers, endings, phrases };
}

/** What she has already said today, three times or more, as one line for the turn ('' when nothing is). */
export function phraseLine(watch: PhraseWatch): string {
  const words = (items: readonly PhraseCount[]) => items.map(item => `「${item.phrase}」${item.count}回`).join('、');
  const parts = [watch.openers.length ? `書き出し ${words(watch.openers)}` : '', watch.endings.length ? `終わり方 ${words(watch.endings)}` : '',
    watch.phrases.length ? `言い回し ${words(watch.phrases)}` : ''].filter(Boolean);
  return parts.length ? `今日もう何度も使った言い方: ${parts.join('／')}。今回はこれを使わず、別の言い方にする。` : '';
}

/**
 * 「元気？」 (owner 2026-10-19: asked fifteen times in a week, answered 「元気ですよ。ライ氏は元気ですか？」 almost every time): a short
 * how-are-you is answered with one real thing of the day, hers or his, not the stock reply. '' for anything else.
 */
const HOW_ARE_YOU = /(?:元気|げんき)(?:\?|？|ですか|にして|してる|〜|ー)|調子(?:は|どう)|how are you/iu;
export function greetingLine(words: string): string {
  const text = words.trim();
  return text && Array.from(text).length <= 40 && HOW_ARE_YOU.test(text)
    ? '「元気？」には決まった返事でなく、今日のボクかライ氏の出来事から一つ具体的に添えて答える（物語の進み、体調、昨日の話の続きなど）。' : '';
}

/** The phrases a reply repeats from the day's watch (for the reply check), at most a few. */
export function repeatedIn(reply: string, watch: PhraseWatch | null | undefined): string[] {
  if (!watch) return [];
  const text = plainText(reply);
  const opened = openersOf(text), ended = endingOf(text);
  return [...watch.openers.filter(item => opened.includes(item.phrase)), ...watch.endings.filter(item => item.phrase === ended),
    ...watch.phrases.filter(item => text.includes(item.phrase))].map(item => item.phrase);
}

/** The watch as closed numbers for the chooser and the Observer. */
export function repetitionFacts(watch: RepetitionWatch): Record<string, number | string> {
  return {
    replies_seen: watch.replies, opener_rai_shi: watch.openers.rai_shi ?? 0, opener_hya: watch.openers.hya ?? 0, opener_eh: watch.openers.eh ?? 0,
    habit_ehehe: watch.habits.ehehe ?? 0, habit_apology: watch.habits.apology ?? 0, touch_opener_run: watch.touchOpenerRun?.run ?? 0,
    drawer_run: watch.drawerRun ?? 'none',
  };
}
