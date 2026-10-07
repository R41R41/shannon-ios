import { createHash, randomUUID } from 'node:crypto';
import { MIND_EVENT_LIMITS, mindEvent, type MindEvent, type MindEventDraft } from '@shannon/mind';

/**
 * What every normalizer of `mind/perception/` shares (Syzygy ADR-0008 stage 3, step F2, `docs/mind-workspace-contract.md`): a
 * fresh event id, closed ids made safe for the envelope, and the one call that builds the event. A normalizer never decides who
 * is present: it is handed the audience the surface already decided and copies it (`mindEvent` freezes a deep copy of it).
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u;

/** The id of one perceived event: `<surface>:<random>`, fresh every time (a perceived event is never merged with another). */
export function perceivedId(surface: string): string {
  return `${surface}:${randomUUID()}`;
}

/**
 * A closed id as the envelope accepts it (`[A-Za-z0-9][A-Za-z0-9_.:@-]*`, bounded): the value itself when it already is one,
 * otherwise a short digest of it, so a thread id or a platform conversation id the client chose never makes an event invalid.
 */
export function closedId(value: string | null | undefined, limit: number = MIND_EVENT_LIMITS.sourceId): string {
  const text = (value ?? '').trim();
  if (text && text.length <= limit && ID.test(text)) return text;
  return `h-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

/** Her name called in the words (the address that `voiceSilence` also listens for: シャノン, in kana or Latin letters). */
export function namesHer(text: string): boolean {
  return /シャノン|しゃのん|shannon/iu.test(text);
}

/** The event, or null when the surface handed something the envelope refuses (perception never stops a turn). */
export function perceived(draft: MindEventDraft): MindEvent | null {
  const event = mindEvent(draft);
  return typeof event === 'string' ? null : event;
}

/** The text a normalizer keeps in memory (never journaled), bounded as the envelope bounds it. */
export function heldText(text: string): { text: string } {
  return { text: text.slice(0, MIND_EVENT_LIMITS.text) };
}
