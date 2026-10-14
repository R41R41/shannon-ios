import {
  apologyIn, goodnightIn, isMemoryEvidenceVisible, soothingIn, teasingIn, touchConsentIn, visibleMemoryText,
  type CompanionStateSnapshot, type InnerNoteEvent,
} from '@shannon/cognition';
import type { InnerNoteTurn } from './innerNotePorts.js';
import type { StoredInnerNote } from './store/innerNoteStore.js';

/**
 * What of her inner note follows the owner's forgetting (Syzygy ADR-0012 D3). Core: emotion.
 *
 * A note is forgotten when one of its sources is (a turn or a touch kept as an experience, `experience:<id>`) or when the words of
 * a forgotten turn are among its events. Sources are a lineage: a note carries the sources of the note it was written after and of
 * the day summary it read, so forgetting one moment deletes every note derived from it, the day's closing summary among them.
 */

/** At most this many sources on one note (N3): a day's own moments and the summary it read, never weeks of them. */
export const LINEAGE_LIMIT = 64;

/** The shortest quote of forgotten words that makes a note's words forgotten too (N9): a greeting is not a quote. */
export const FORGOTTEN_QUOTE_MIN = 12;
const QUOTE_EVIDENCE_LIMIT = 400;

interface ForgetIndex { key: string; ids: ReadonlySet<string>; any: boolean; quotes: ReadonlySet<string> }
const indexes = new WeakMap<CompanionStateSnapshot, ForgetIndex>();

/**
 * The owner's forgetting as an index, built once per state snapshot: the ids he had her forget (or rejected, or corrected), and a key
 * that changes when any of them does (the sweep deletes only when it changed; a read checks a note in O(sources)).
 */
export function forgetIndex(snapshot: CompanionStateSnapshot): ForgetIndex {
  const known = indexes.get(snapshot);
  if (known) return known;
  const controls = snapshot.memoryControls.filter(control => control.status !== 'active' || control.overrideText);
  const gone = controls.filter(control => control.status !== 'active');
  const index = { key: controls.map(control => `${control.memoryId}:${control.status}:${control.updatedAt}`).join('|'),
    ids: new Set(gone.map(control => control.memoryId)), any: controls.length > 0, quotes: forgottenQuotes(snapshot, gone) };
  indexes.set(snapshot, index);
  return index;
}

/** Whether words (his, hers, a note's own) may still be read: none of them is the evidence of a forgotten or corrected item. */
function wordsVisible(snapshot: CompanionStateSnapshot, words: readonly (string | null | undefined)[]): boolean {
  const { quotes } = forgetIndex(snapshot);
  return quotes.size === 0 || words.every(text => !text || !quotesIn(normalized(text), quotes));
}

const normalized = (value: string): string => value.replace(/[\s。、！？!?「」]/gu, '');

/** Whether a text contains a forgotten quote: any window of `FORGOTTEN_QUOTE_MIN` characters it shares with a forgotten item's evidence. */
function quotesIn(text: string, quotes: ReadonlySet<string>): boolean {
  for (let start = 0; start + FORGOTTEN_QUOTE_MIN <= text.length; start += 1) if (quotes.has(text.slice(start, start + FORGOTTEN_QUOTE_MIN))) return true;
  return false;
}

/**
 * The windows of the evidence of what the owner had her forget or rejected (N9): only those (a correction keeps its moment), each
 * evidence its first `QUOTE_EVIDENCE_LIMIT` characters, and none shorter than `FORGOTTEN_QUOTE_MIN`.
 */
function forgottenQuotes(snapshot: CompanionStateSnapshot, gone: CompanionStateSnapshot['memoryControls']): Set<string> {
  const goneIds = new Set(gone.map(control => control.memoryId));
  const blocked = (id: string | undefined) => Boolean(id && goneIds.has(id));
  const evidence = [...gone.flatMap(control => [control.sourceEvidence,
    snapshot.userFacts.find(item => item.id === control.memoryId)?.evidence,
    snapshot.relationships.find(item => item.id === control.memoryId)?.evidence]),
  ...snapshot.prospectiveMemories.filter(memory => blocked(memory.id) || blocked(memory.sourceExperienceId)).map(memory => memory.evidence ?? memory.summary)];
  const quotes = new Set<string>();
  for (const text of evidence) {
    const quote = normalized(text ?? '').slice(0, QUOTE_EVIDENCE_LIMIT);
    for (let start = 0; start + FORGOTTEN_QUOTE_MIN <= quote.length; start += 1) quotes.add(quote.slice(start, start + FORGOTTEN_QUOTE_MIN));
  }
  return quotes;
}

/**
 * Whether an event's words (his, hers, her line after a touch) may still be read. They are the turn itself, often short and without a
 * source id (a voice client without an utterance id): the memory boundary's own containment check, not the 12-character quote window.
 */
export function eventVisible(snapshot: CompanionStateSnapshot, event: InnerNoteEvent): boolean {
  return !forgetIndex(snapshot).any || [event.words, event.reply, event.touch?.said].every(text => !text || isMemoryEvidenceVisible(snapshot, text));
}

/** Whether a source may still be read: an experience the owner did not have her forget (anything else is kept). */
export function sourceVisible(snapshot: CompanionStateSnapshot, sourceId: string): boolean {
  if (!sourceId.startsWith('experience:')) return true;
  const id = sourceId.slice('experience:'.length);
  return !forgetIndex(snapshot).ids.has(id) && visibleMemoryText(snapshot, id, 'visible') !== null;
}

/**
 * A note to delete: one of its sources was forgotten, or the words of one of its events, or — a backstop for what it quotes from the
 * conversation it read — its own words are the evidence of a forgotten turn.
 */
export function noteForgotten(snapshot: CompanionStateSnapshot, note: Pick<StoredInnerNote, 'sourceIds' | 'events' | 'text' | 'summary'>): boolean {
  if (!forgetIndex(snapshot).any) return false;
  return note.sourceIds.some(id => !sourceVisible(snapshot, id)) || note.events.some(event => !eventVisible(snapshot, event))
    || !wordsVisible(snapshot, [note.text.honne, note.text.tatemae, note.text.reason, note.text.plan, note.text.bottom, note.summary]);
}

/**
 * The sources of a new note (N3): its own (its events, the conversation lines it read), the same day's note before it (which it
 * read), and the day summary it read. A closing note keeps only its day's own: yesterday's sources stop at the day they were read.
 * Bounded by `LINEAGE_LIMIT`, newest kept.
 */
export function lineage(own: readonly (string | undefined)[], previous: Pick<StoredInnerNote, 'sourceIds'> | null,
  yesterday: { sourceIds: readonly string[] } | null, closing: { yesterday: readonly string[] } | null = null): string[] {
  const all = [...previous?.sourceIds ?? [], ...yesterday?.sourceIds ?? [], ...own.filter((id): id is string => Boolean(id))];
  const dropped = new Set(closing?.yesterday ?? []);
  const kept = [...new Set(all.filter(id => !dropped.has(id)))];
  // The summary it read (`note:<id>`) stays whatever else is capped: deleting that summary deletes what read it (N6).
  const notes = kept.filter(id => id.startsWith('note:'));
  return [...notes, ...kept.filter(id => !id.startsWith('note:')).slice(-(LINEAGE_LIMIT - notes.length))];
}

/**
 * The one event a finished turn is, if any: his apology, his kind word, a tease, touching her asked, allowed or refused, or a reply she
 * felt strongly; and whether it is his goodnight to her. The cues are narrow (`innerNoteWords.ts`): a sentence addressed to her, not a
 * word in passing. A turn about touching her rides on an apology or a tease of the same turn as `consent`, and is its own event
 * otherwise (owner decision 2026-10-14: such a turn, her own yes or no included, makes her reflect at once).
 */
export function turnEvent(turn: InnerNoteTurn): { event: InnerNoteEvent | null; goodnight: boolean } {
  const consent = touchConsentIn(turn.userMessage, turn.reply);
  const base = { at: turn.at, words: turn.userMessage.slice(0, 200), reply: turn.reply.slice(0, 200), ...(consent ? { consent } : {}) };
  const goodnight = goodnightIn(turn.userMessage);
  const soothing = soothingIn(turn.userMessage) ?? (apologyIn(turn.userMessage) ? 'apology' : null);
  if (soothing) return { event: { kind: soothing, ...base }, goodnight };
  if (teasingIn(turn.userMessage)) return { event: { kind: 'teasing', ...base }, goodnight };
  if (consent) return { event: { kind: 'consent', ...base }, goodnight };
  const feeling = turn.feeling;
  if (feeling && feeling.kind !== 'neutral' && feeling.intensity >= 0.6) return { event: { kind: 'strong_reply', ...base, feeling }, goodnight };
  return { event: null, goodnight };
}
