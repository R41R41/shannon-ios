import {
  apologyIn, goodnightIn, isMemoryEvidenceVisible, soothingIn, teasingIn, visibleMemoryText,
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

interface ForgetIndex { key: string; ids: ReadonlySet<string>; any: boolean }
const indexes = new WeakMap<CompanionStateSnapshot, ForgetIndex>();

/**
 * The owner's forgetting as an index, built once per state snapshot: the ids he had her forget (or rejected, or corrected), and a key
 * that changes when any of them does (the sweep deletes only when it changed; a read checks a note in O(sources)).
 */
export function forgetIndex(snapshot: CompanionStateSnapshot): ForgetIndex {
  const known = indexes.get(snapshot);
  if (known) return known;
  const controls = snapshot.memoryControls.filter(control => control.status !== 'active' || control.overrideText);
  const index = { key: controls.map(control => `${control.memoryId}:${control.status}:${control.updatedAt}`).join('|'),
    ids: new Set(controls.filter(control => control.status !== 'active').map(control => control.memoryId)), any: controls.length > 0 };
  indexes.set(snapshot, index);
  return index;
}

/** Whether words (his, hers, a note's own) may still be read: none of them is the evidence of a forgotten or corrected item. */
function wordsVisible(snapshot: CompanionStateSnapshot, words: readonly (string | null | undefined)[]): boolean {
  return !forgetIndex(snapshot).any || words.every(text => !text || isMemoryEvidenceVisible(snapshot, text));
}

/** Whether an event's words (his, hers, her line after a touch) may still be read. */
export function eventVisible(snapshot: CompanionStateSnapshot, event: InnerNoteEvent): boolean {
  return wordsVisible(snapshot, [event.words, event.reply, event.touch?.said]);
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
  return [...new Set(all.filter(id => !dropped.has(id)))].slice(-LINEAGE_LIMIT);
}

/**
 * The one event a finished turn is, if any: his apology, his kind word, a tease, or a reply she felt strongly; and whether it is
 * his goodnight to her. The cues are narrow (`innerNoteWords.ts`): a sentence addressed to her, not a word in passing.
 */
export function turnEvent(turn: InnerNoteTurn): { event: InnerNoteEvent | null; goodnight: boolean } {
  const base = { at: turn.at, words: turn.userMessage.slice(0, 200), reply: turn.reply.slice(0, 200) };
  const goodnight = goodnightIn(turn.userMessage);
  const soothing = soothingIn(turn.userMessage) ?? (apologyIn(turn.userMessage) ? 'apology' : null);
  if (soothing) return { event: { kind: soothing, ...base }, goodnight };
  if (teasingIn(turn.userMessage)) return { event: { kind: 'teasing', ...base }, goodnight };
  const feeling = turn.feeling;
  if (feeling && feeling.kind !== 'neutral' && feeling.intensity >= 0.6) return { event: { kind: 'strong_reply', ...base, feeling }, goodnight };
  return { event: null, goodnight };
}
