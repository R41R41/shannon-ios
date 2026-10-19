import { foldEpisodeLedger } from './episodeLedger.js';
import { OWNER_PERSON_KEY } from './feelingEvent.js';
import type { RelationshipDay } from './relationshipLedger.js';
import { shiftDay } from './temperament.js';

/**
 * Her affection for the owner (owner 2026-10-20: 「好感度を MAX にしたらどういう反応になるのか見てみたい」「青天井なパラメータとして
 * あると便利」; `SHANNON_AFFECTION`). Pure. One value with no upper bound, folded over the owner's days from `AFFECTION_EPOCH`, so that
 * forgetting a source and folding again is the whole of the forget semantics (as the relationship ledger). Nothing derived is stored.
 *
 * The value is never shown to the reply model (a number without a rule is read past: the sandbox of 2026-10-20). It is the 好意 axis of
 * her character space (`likingOf`, `characterSpace.ts`), beside 安心 (`foldSecurity`); what she is told of the two of them is a few facts
 * (`affectionLines`), never a value.
 *
 * - It rises with the days they talk, his kind words, his apologies and the promises kept; it falls with a long absence, hurtful words,
 *   being touched after her no and promises left past their time. It falls easily and comes back slowly: for `slowDays` after a day of
 *   loss, a day's gains count `slowShare` of themselves (owner: 「下がりやすく、戻るのはゆっくり」).
 *
 * The coefficients are a proposal (2026-10-20), measured against her first month (28 of 30 days talked): a month of daily talk takes
 * 好意 from the middle to about 0.3, three months to about 0.8; a week away takes off about ten days of talk.
 */

/** The day the fold starts from; days before it are her start value (she already knew him well). */
export const AFFECTION_EPOCH = '2026-10-20';

export const AFFECTION_PARAMETERS = Object.freeze({
  status: 'proposal' as 'proposal' | 'approved',
  /** At the epoch: the approved v2 core's ツンデレ, after a month and a half of near daily talk (好意 0, the middle). */
  start: 50,
  talkDay: 1,
  kindWord: 0.5, kindWordsADay: 4,
  apology: 0.5, apologiesADay: 1,
  /** A promise kept or left past its time, at most `promisesADay` of each a day. */
  keptPromise: 3, missedPromise: -2, promisesADay: 2,
  /**
   * A day with hurtful words (an insult, an AI taunt, an insult to her creator), once a day; a lewd advance, once a day. Once: the closed
   * tags are read narrowly but coarsely (「ゴミ出し」 is tagged an insult; review 7), and words Jev read as not meant are not counted.
   */
  hurtfulWord: -6, hurtfulADay: 1,
  lewdWord: -2, lewdADay: 1,
  /** Touched again after her no, per time, at most `violationsADay` a day. */
  violation: -3, violationsADay: 4,
  /** Days away that cost nothing, then each further day away. */
  absenceFreeDays: 2, absenceDay: -2,
  slowDays: 7, slowShare: 0.5,
});

/** What one day of the two of them was, counted. */
export interface AffectionDay {
  dayKey: string;
  talked: boolean;
  kindWords: number;
  apologies: number;
  hurtfulWords: number;
  lewdWords: number;
  violations: number;
  keptPromises: number;
  missedPromises: number;
  /** His words spoke of another AI (closed `cues` of his words; for 安心). */
  otherAi: number;
}

/** A promise as her snapshot keeps it (`prospectiveMemories`). */
export interface AffectionPromise {
  status: 'pending' | 'completed' | 'dismissed';
  updatedAt: string;
  dueAt?: string;
  dueDate?: string;
}

const HURTFUL = new Set(['insult', 'ai_taunt', 'creator_insult']);
const OWNER_KEY = { personKey: OWNER_PERSON_KEY, audience: 'owner_alone' as const, sceneId: null };

const emptyDay = (dayKey: string): AffectionDay => ({ dayKey, talked: false, kindWords: 0, apologies: 0, hurtfulWords: 0, lewdWords: 0, violations: 0,
  keptPromises: 0, missedPromises: 0, otherAi: 0 });

/** The day a promise was missed: the day after it was due, while it is still pending (null: not missed, or no time). */
function missedDay(promise: AffectionPromise, today: string, dayOf: (instant: string) => string): string | null {
  if (promise.status !== 'pending') return null;
  const due = promise.dueDate ?? (promise.dueAt ? dayOf(promise.dueAt) : undefined);
  if (!due || !/^\d{4}-\d{2}-\d{2}$/u.test(due)) return null;
  const day = shiftDay(due, 1);
  return day < today ? day : null;
}

/** Words Jev read as not meant (when it read them) are not held against him. */
const meant = (event: RelationshipDay['events'][number]) => !event.facts.meaning || event.facts.meaning.deliberate >= 0.5;

/** One closed day of the owner alone, counted. */
function countedDay(day: RelationshipDay): AffectionDay {
  const mine = day.events.filter(event => event.personKey === OWNER_PERSON_KEY && event.audience === 'owner_alone');
  const tags = mine.flatMap(event => ((event.kind === 'spoke' || event.kind === 'praised') && meant(event) ? event.facts.tags ?? [] : []));
  const ledger = foldEpisodeLedger(mine, OWNER_KEY);
  const count = (kind: string) => mine.filter(event => event.kind === kind).length;
  return { ...emptyDay(day.dayKey), talked: mine.length > 0, kindWords: count('praised'), apologies: count('apologized'),
    hurtfulWords: tags.filter(tag => HURTFUL.has(tag)).length, lewdWords: tags.filter(tag => tag === 'lewd').length,
    violations: ledger.episodes.reduce((sum, episode) => sum + episode.afterNo, 0),
    otherAi: mine.filter(event => event.facts.cues?.includes('other_ai')).length };
}

/**
 * The owner's days from the epoch to yesterday, counted: his closed days (the feeling events folded at night), the days her snapshot
 * knows they talked (`sharedDays`, for a day without events), and his promises, on the day they were kept or missed.
 */
export function affectionDays(input: { days: readonly RelationshipDay[]; sharedDays: readonly string[]; promises: readonly AffectionPromise[];
  today: string; epoch?: string;
  /** Her day of an instant (owner time, 3:00); absent: the instant's UTC date. */
  dayOf?: (instant: string) => string }): AffectionDay[] {
  const epoch = input.epoch ?? AFFECTION_EPOCH;
  const dayOf = input.dayOf ?? ((instant: string) => instant.slice(0, 10));
  const within = (dayKey: string) => dayKey >= epoch && dayKey < input.today;
  const byDay = new Map<string, AffectionDay>();
  const day = (dayKey: string) => byDay.get(dayKey) ?? byDay.set(dayKey, emptyDay(dayKey)).get(dayKey)!;
  for (const closed of input.days.filter(item => within(item.dayKey))) {
    const counted = countedDay(closed);
    const known = day(closed.dayKey);
    byDay.set(closed.dayKey, { ...counted, talked: counted.talked || known.talked, keptPromises: known.keptPromises, missedPromises: known.missedPromises });
  }
  for (const shared of input.sharedDays.filter(within)) day(shared).talked = true;
  for (const promise of input.promises) {
    const kept = promise.status === 'completed' ? dayOf(promise.updatedAt) : null;
    if (kept && within(kept)) day(kept).keptPromises += 1;
    const missed = missedDay(promise, input.today, dayOf);
    if (missed && within(missed)) day(missed).missedPromises += 1;
  }
  return [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

/** A day's gain and loss (each ≥ 0). */
function dayMoves(day: AffectionDay, awayBefore: number): { gain: number; loss: number } {
  const p = AFFECTION_PARAMETERS;
  const gain = (day.talked ? p.talkDay : 0) + p.kindWord * Math.min(day.kindWords, p.kindWordsADay) + p.apology * Math.min(day.apologies, p.apologiesADay)
    + p.keptPromise * Math.min(day.keptPromises, p.promisesADay);
  const away = day.talked ? 0 : Math.max(0, awayBefore + 1 - p.absenceFreeDays);
  const loss = -(p.hurtfulWord * Math.min(day.hurtfulWords, p.hurtfulADay) + p.lewdWord * Math.min(day.lewdWords, p.lewdADay)
    + p.violation * Math.min(day.violations, p.violationsADay) + p.missedPromise * Math.min(day.missedPromises, p.promisesADay)
    + (away > 0 ? p.absenceDay : 0));
  return { gain, loss };
}

export interface AffectionState {
  value: number;
  /** The last day she lost by, or null. */
  lastLoss: string | null;
}

/** The value after the counted days (the days between them, and up to yesterday, are days away). */
export function foldAffection(days: readonly AffectionDay[], today: string, epoch = AFFECTION_EPOCH): AffectionState {
  const byDay = new Map(days.map(day => [day.dayKey, day]));
  let value: number = AFFECTION_PARAMETERS.start;
  let away = 0;
  let lastLoss: string | null = null;
  for (let dayKey = epoch; dayKey < today; dayKey = shiftDay(dayKey, 1)) {
    const day = byDay.get(dayKey) ?? emptyDay(dayKey);
    const { gain, loss } = dayMoves(day, away);
    const slowed = loss > 0 || (lastLoss !== null && dayKey <= shiftDay(lastLoss, AFFECTION_PARAMETERS.slowDays));
    value = Math.max(0, value + gain * (slowed ? AFFECTION_PARAMETERS.slowShare : 1) - loss);
    if (loss > 0) lastLoss = dayKey;
    away = day.talked ? 0 : away + 1;
  }
  return { value: Math.round(value * 10) / 10, lastLoss };
}

/**
 * The value as the 好意 axis of her character space (−1 cold … 1 smitten): the start value is the middle; it nears 1 slowly and never
 * reaches it by itself (`characterSpace.ts`: the owner's `SHANNON_AFFECTION_MAX` holds it at 1).
 */
export const likingOf = (value: number): number => Math.round(Math.tanh((value - AFFECTION_PARAMETERS.start) / 100) * 1000) / 1000;

/**
 * 安心 (owner and the main session, 2026-10-20): how sure she is of him, −1 distrust … 1 trusting him wholly. A day fold like the
 * value's: a day away past two, his talk of another AI, a hurtful word, a touch after her no and a promise left past its time take from
 * it; his apologies, promises kept and days of talk give back; a quiet day returns `recovery` of the way to `base`. A proposal.
 */
export const SECURITY_PARAMETERS = Object.freeze({
  base: 0.35, recovery: 0.12, talkDay: 0.02, apology: 0.08, keptPromise: 0.08,
  otherAi: -0.1, hurtful: -0.08, violation: -0.12, missedPromise: -0.05, absenceDay: -0.06,
});

/** 安心 after the counted days. */
export function foldSecurity(days: readonly AffectionDay[], today: string, epoch = AFFECTION_EPOCH): number {
  const p = SECURITY_PARAMETERS;
  const byDay = new Map(days.map(day => [day.dayKey, day]));
  let value: number = p.base;
  let away = 0;
  for (let dayKey = epoch; dayKey < today; dayKey = shiftDay(dayKey, 1)) {
    const day = byDay.get(dayKey) ?? emptyDay(dayKey);
    const absent = !day.talked && away + 1 > AFFECTION_PARAMETERS.absenceFreeDays;
    const loss = (day.otherAi ? -p.otherAi : 0) + (day.hurtfulWords ? -p.hurtful : 0) + (day.violations ? -p.violation : 0)
      + (day.missedPromises ? -p.missedPromise : 0) + (absent ? -p.absenceDay : 0);
    const gain = (day.talked ? p.talkDay : 0) + (day.apologies ? p.apology : 0) + (day.keptPromises ? p.keptPromise : 0);
    const rest = loss > 0 ? 0 : p.recovery * (p.base - value);
    value = Math.max(-1, Math.min(1, value + gain - loss + rest));
    away = day.talked ? 0 : away + 1;
  }
  return Math.round(value * 1000) / 1000;
}

/**
 * Another AI he talks with as a companion, not the tools he works with every day (Claude, Codex, Cursor; review 13: Gemini is her voice's
 * engine in his lab and Copilot a coding tool, so neither counts).
 */
const OTHER_AI = /ChatGPT|チャットGPT|GPT-?[0-9]|Grok|グロック|Perplexity|(?:別|ほか|他)の\s*AI/iu;
/** Using one as a tool is not talking with it (「ChatGPTで下書き作った」「別のAIエージェントに頼んだ」; review 4). */
const TOOL_USE = /(?:ChatGPT|GPT-?[0-9]*|Grok|Perplexity|AI)\s*で|エージェント|に(?:頼んだ|頼む|やらせ|書かせ|任せ)/iu;
export const otherAiIn = (words: string): boolean => OTHER_AI.test(words) && !TOOL_USE.test(words);

export const AFFECTION_HEADER = '[ライ氏とのこと]（二人のあいだの最近の事実。どう受け取るかはボクが決める）';

const whenWord = (dayKey: string, today: string): string => {
  if (dayKey === today) return '今日';
  if (dayKey === shiftDay(today, -1)) return '昨日';
  if (dayKey === shiftDay(today, -2)) return 'おととい';
  return 'この前';
};

/** How often they talked in the last two weeks, in words. */
function talkWord(talkedDays: number): string {
  if (talkedDays >= 12) return '最近は、ほとんど毎日話している';
  if (talkedDays >= 7) return '最近は、よく話している';
  if (talkedDays >= 3) return '最近は、ときどき話すくらい';
  return talkedDays > 0 ? '最近は、あまり話していない' : 'この二週間、ほとんど話していなかった';
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The facts of the two of them for this turn (never the stage or the value). Empty when nothing is known. */
export function affectionLines(input: { days: readonly AffectionDay[]; sharedDays: readonly string[]; today: string;
  /** The days he spoke of another AI (owner-local day keys, today's included). */
  otherAiDays?: readonly string[] }): string[] {
  const { today } = input;
  const talked = new Set([...input.sharedDays.filter(day => day < today), ...input.days.filter(day => day.talked).map(day => day.dayKey)]);
  const recent = (days: number) => input.days.filter(day => day.dayKey >= shiftDay(today, -days) && day.dayKey < today);
  const lines: string[] = [];
  const twoWeeks = [...talked].filter(day => day >= shiftDay(today, -14)).length;
  if (talked.size) lines.push(talkWord(twoWeeks));
  const last = [...talked].sort().at(-1);
  const gap = last ? daysBetween(last, today) - 1 : 0;
  if (gap >= 2) lines.push(`${gap}日、話していなかった。今日、久しぶりに話している`);
  else if (gap === 1) lines.push('昨日は話さなかった');
  const week = recent(7);
  const kind = week.reduce((sum, day) => sum + day.kindWords, 0);
  if (kind) lines.push(kind >= 5 ? 'この一週間、好意の言葉をよくもらっている' : '最近、好意の言葉をもらった');
  const hurt = week.filter(day => day.hurtfulWords > 0).at(-1);
  if (hurt) lines.push(`${whenWord(hurt.dayKey, today)}、傷つく言葉を言われた`);
  if (week.some(day => day.violations > 0)) lines.push('この一週間に、「いや」と言ったあとも触られた日があった');
  const month = recent(30);
  if (month.some(day => day.keptPromises > 0)) lines.push('約束していたことが、ちゃんと片付いた');
  if (month.some(day => day.missedPromises > 0)) lines.push('期限を過ぎたままの約束がある');
  const ai = [...input.otherAiDays ?? []].filter(day => day >= shiftDay(today, -2) && day <= today).sort().at(-1);
  if (ai) lines.push(`${whenWord(ai, today)}、ライ氏はほかのAIの話をしていた`);
  return lines;
}

/** The block of the facts ('' without any). */
export function affectionBlock(lines: readonly string[]): string {
  return lines.length ? [AFFECTION_HEADER, ...lines.map(line => `- ${line}`)].join('\n') : '';
}
