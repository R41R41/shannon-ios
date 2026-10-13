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

/** Whether an event's words (his, hers, her line after a touch) may still be read. */
export function eventVisible(snapshot: CompanionStateSnapshot, event: InnerNoteEvent): boolean {
  const words = [event.words, event.reply, event.touch?.said].filter((text): text is string => Boolean(text));
  return words.every(text => isMemoryEvidenceVisible(snapshot, text));
}

/** Whether a source may still be read: an experience the owner did not have her forget (anything else is kept). */
export function sourceVisible(snapshot: CompanionStateSnapshot, sourceId: string): boolean {
  if (!sourceId.startsWith('experience:')) return true;
  return visibleMemoryText(snapshot, sourceId.slice('experience:'.length), 'visible') !== null;
}

/** A note to delete: a source of its lineage, or the words of one of its events, were forgotten. */
export function noteForgotten(snapshot: CompanionStateSnapshot, note: Pick<StoredInnerNote, 'sourceIds' | 'events'>): boolean {
  return note.sourceIds.some(id => !sourceVisible(snapshot, id)) || note.events.some(event => !eventVisible(snapshot, event));
}

/** The sources of a new note: its own events', and its lineage (the note before it, the day summary it read). */
export function lineage(own: readonly (string | undefined)[], previous: Pick<StoredInnerNote, 'sourceIds'> | null,
  yesterday: { sourceIds: readonly string[] } | null): string[] {
  return [...new Set([...own.filter((id): id is string => Boolean(id)), ...previous?.sourceIds ?? [], ...yesterday?.sourceIds ?? []])];
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
