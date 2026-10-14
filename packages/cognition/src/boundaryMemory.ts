import { foldEpisodeLedger } from './episodeLedger.js';
import type { FeelingEvent } from './feelingEvent.js';
import { innerNoteDay } from './innerNote.js';
import { SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME } from './persona.js';

/**
 * Boundary memory (Syzygy ADR-0013 D6, stage 3 item 2; `SHANNON_BOUNDARY_MEMORY`). Pure, and a fold over her remembered events (closed
 * days and today), so forgetting a source recomputes it. A boundary keeps its basis (since when, how often she said no, how often it was
 * crossed after, who brought it up) and its origin (ADR-0005 3 and 7):
 *
 * - `self`: she said no herself (a touch she took as dislike or refuse, or her own refusing words about it).
 * - `told`: someone told her she should refuse it (「嫌だって言わないと」). It stays `told`, and is never described as her own decision,
 *   until she endorses it in her inner note's reflection (an `own_boundary` event); then it is hers (`endorsed`).
 */
export interface Boundary {
  subject: string;
  origin: 'self' | 'told';
  /** A told boundary she took as her own in reflection. */
  endorsed: boolean;
  firstAt: string;
  /** Days she said no to it herself. */
  saidNoDays: number;
  /** Touches after her no, over all days. */
  crossed: number;
  /** Who told her (a person key), for a told boundary. */
  toldBy: string | null;
  /** The source of the latest telling (an endorsement takes it, so forgetting the telling forgets both). */
  toldSource: string | null;
}

const TOLD = new RegExp([
  '(?:嫌|いや|イヤ|ダメ|だめ|駄目)(?:だ|です)?(?:って|と)(?:言わ|いわ)(?:ないと|なきゃ|なくちゃ|なければ)', '断ら(?:ないと|なきゃ|なくちゃ|なければ)',
  '拒否(?:し(?:ないと|なきゃ|なさい|ろ)|すべき)', '(?:触ら|さわら)せ(?:ちゃ|ては)(?:だめ|ダメ|いけない)', '嫌がら(?:ないと|なきゃ)',
].join('|'), 'u');

/** The subject his words told her to refuse: a part they name, else her body as a whole; null when they told her nothing of the kind. */
export function toldBoundaryIn(words: string, subjects: readonly { subject: string; word: string }[]): string | null {
  const text = words.trim();
  if (!text || Array.from(text).length > 200 || !TOLD.test(text)) return null;
  return subjects.find(item => text.includes(item.word))?.subject ?? 'body';
}

function selfBoundaries(events: readonly FeelingEvent[], personKey: string, timeZone: string): Map<string, Boundary> {
  const found = new Map<string, Boundary>();
  const byDay = new Map<string, FeelingEvent[]>();
  for (const event of events) {
    const day = innerNoteDay(event.occurredAt, timeZone).dayKey;
    byDay.set(day, [...byDay.get(day) ?? [], event]);
  }
  for (const day of [...byDay.values()]) {
    for (const episode of foldEpisodeLedger(day, { personKey, audience: 'owner_alone', sceneId: null }).episodes) {
      if (!episode.noAt) continue;
      const known = found.get(episode.subject);
      found.set(episode.subject, { subject: episode.subject, origin: 'self', endorsed: false, firstAt: known?.firstAt ?? episode.noAt,
        saidNoDays: (known?.saidNoDays ?? 0) + 1, crossed: (known?.crossed ?? 0) + episode.afterNo, toldBy: null, toldSource: null });
    }
  }
  return found;
}

/** Her boundaries with one person (oldest first): her own, then the told ones not already hers. */
export function foldBoundaries(events: readonly FeelingEvent[], personKey: string, timeZone = 'Asia/Tokyo'): Boundary[] {
  const ordered = [...events].filter(event => event.personKey === personKey).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const found = selfBoundaries(ordered, personKey, timeZone);
  for (const event of ordered) {
    const subject = event.facts.toldBoundary;
    if (event.kind === 'spoke' && subject && !found.has(subject)) {
      found.set(subject, { subject, origin: 'told', endorsed: false, firstAt: event.occurredAt, saidNoDays: 0, crossed: 0, toldBy: event.personKey,
        toldSource: event.sourceId });
    } else if (event.kind === 'spoke' && subject && found.get(subject)?.origin === 'told') {
      found.set(subject, { ...found.get(subject)!, toldSource: event.sourceId });
    }
  }
  for (const event of ordered) {
    const told = event.kind === 'own_boundary' && event.facts.part ? found.get(event.facts.part) : undefined;
    if (told?.origin === 'told') found.set(told.subject, { ...told, endorsed: true });
  }
  return [...found.values()].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
}

const often = (count: number) => (count <= 1 ? '一度' : count <= 3 ? '何度か' : '何度も');

/** The boundaries as lines of facts ('' when there are none). A told one is never worded as her own decision. */
export function boundaryLines(boundaries: readonly Boundary[], partWord: (subject: string) => string): string {
  if (!boundaries.length) return '';
  const line = (boundary: Boundary) => {
    const what = boundary.subject === 'body' ? '体に触れられること' : partWord(boundary.subject);
    if (boundary.origin === 'self') {
      const crossed = boundary.crossed ? `、そのあとも${often(boundary.crossed)}触れられた` : '';
      return `- ${what}: ${SHANNON_FIRST_PERSON}が自分で「いや」と言った境界（${often(boundary.saidNoDays)}言った${crossed}）`;
    }
    const who = boundary.toldBy === 'owner' ? SHANNON_OWNER_NAME : '人';
    return boundary.endorsed ? `- ${what}: ${who}に言われて考え、${SHANNON_FIRST_PERSON}が自分のものにした境界`
      : `- ${what}: ${who}に「嫌と言わないと」と言われて持った境界。まだ${SHANNON_FIRST_PERSON}が自分で決めたものではない（自分で決めたとは言わない）`;
  };
  return [`[${SHANNON_FIRST_PERSON}の境界]（事実として）`, ...boundaries.map(line)].join('\n');
}

/** The told boundaries not yet hers, for her reflection to consider. */
export function toldBoundariesOpen(boundaries: readonly Boundary[]): Boundary[] {
  return boundaries.filter(boundary => boundary.origin === 'told' && !boundary.endorsed);
}
