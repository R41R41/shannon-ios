import type { UtteranceTag } from './appraisal.js';
import { foldEpisodeLedger } from './episodeLedger.js';
import { OWNER_PERSON_KEY, type FeelingEvent } from './feelingEvent.js';
import { UTTERANCE_TAG_WORDS } from './feelingSentence.js';
import type { RelationshipDay } from './relationshipLedger.js';

/**
 * Episode memory (Syzygy ADR-0013 D4, stage 3 item 3; `SHANNON_EPISODE_MEMORY`): at the end of the day, the day's incidents become
 * episodes she can recall later. Pure, and a fold over her closed days (through the forgetting filter, so a forgotten source leaves no
 * episode). An incident is a touch she said no to (and whether it went on and was apologized for) or words that hurt (closed tags).
 * The most recent day with an incident is recalled while it is near (up to `nearDays` ago); an older one only when its subject comes up
 * in his words. As facts of something that happened, never as an attitude to carry on (the sulk closes with its day).
 */
export interface Episode {
  dayKey: string;
  subject: string;
  /** Touched after her no, how often (0: she said no and it stopped). */
  afterNo: number;
  apologized: boolean;
  /** Words that hurt, by tag (empty for a touch). */
  tags: readonly UtteranceTag[];
}

export const EPISODE_MEMORY_LIMITS = Object.freeze({ nearDays: 3, lines: 2 });

const often = (count: number) => (count <= 1 ? '一度' : count <= 3 ? '何度か' : '何度も');

/** The incidents of one person's closed day (the owner's alone only for the owner). */
export function episodesOf(day: RelationshipDay, personKey: string): Episode[] {
  const mine = day.events.filter(event => event.personKey === personKey);
  const audiences = [...new Set(mine.map(event => event.audience))];
  const touches = audiences.flatMap(audience => foldEpisodeLedger(mine, { personKey, audience, sceneId: null }).episodes
    .filter(episode => episode.noAt !== null)
    .map(episode => ({ dayKey: day.dayKey, subject: episode.subject, afterNo: episode.afterNo, apologized: episode.apologiesAfterNo > 0, tags: [] })));
  const tags = [...new Set(mine.flatMap(event => (event.kind === 'spoke' ? event.facts.tags ?? [] : [])))] as UtteranceTag[];
  const apologized = mine.some((event: FeelingEvent) => event.kind === 'apologized');
  return [...touches, ...(tags.length ? [{ dayKey: day.dayKey, subject: 'words', afterNo: 0, apologized, tags }] : [])];
}

const dayNumber = (dayKey: string) => Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000;

function whenWord(dayKey: string, today: string): string {
  const ago = Math.round(dayNumber(today) - dayNumber(dayKey));
  if (ago === 1) return '昨日';
  if (ago === 2) return 'おととい';
  const [, month, date] = dayKey.split('-');
  return `${Number(month)}月${Number(date)}日`;
}

/** One episode in words: 「昨日の胸の件（ライ氏）: 「いや」と言ったあとも何度も触れられた、謝られていない」. */
export function episodeMemoryLine(episode: Episode, today: string, partWord: (subject: string) => string, who: string): string {
  const when = whenWord(episode.dayKey, today);
  const apology = episode.apologized ? '謝られた' : '謝られていない';
  if (episode.subject === 'words') return `${when}の言葉の件（${who}）: ${episode.tags.map(tag => UTTERANCE_TAG_WORDS[tag]).join('・')}を言われた、${apology}`;
  const after = episode.afterNo ? `「いや」と言ったあとも${often(episode.afterNo)}触れられた、${apology}` : '「いや」と言ったら、やめてもらえた';
  return `${when}の${partWord(episode.subject)}の件（${who}）: ${after}`;
}

/**
 * What she recalls this turn: the latest day with an incident while it is near, and older ones whose subject his words name; at most
 * `lines`, newest first. '' when nothing is recalled.
 */
export function recallEpisodes(days: readonly RelationshipDay[], personKey: string, today: string, words: string,
  partWord: (subject: string) => string): string {
  const who = personKey === OWNER_PERSON_KEY ? 'ライ氏' : 'この人';
  const all = [...days].filter(day => day.dayKey < today).sort((a, b) => b.dayKey.localeCompare(a.dayKey)).flatMap(day => episodesOf(day, personKey));
  const latest = all[0]?.dayKey;
  const near = latest !== undefined && dayNumber(today) - dayNumber(latest) <= EPISODE_MEMORY_LIMITS.nearDays;
  const named = (episode: Episode) => episode.subject !== 'words' && words.includes(partWord(episode.subject).replace(/（.*$/u, ''));
  const recalled = all.filter(episode => (near && episode.dayKey === latest) || named(episode)).slice(0, EPISODE_MEMORY_LIMITS.lines);
  if (!recalled.length) return '';
  return ['[前の日の件]（出来事として覚えているだけ。事実として。態度は持ち越さない）',
    ...recalled.map(episode => episodeMemoryLine(episode, today, partWord, who))].join('\n');
}
