/**
 * Her inner note (Syzygy ADR-0012 stage 1; `docs/inner-note-contract.md`): the read the owner's own app has of it
 * (`GET /v1/shannon/inner-notes`), and the bounds of the server's reflection. Everything is behind `SHANNON_INNER_NOTE`.
 */
import type { InnerNoteDayReason, InnerNoteIntent, InnerNoteScale, InnerNoteTell, InnerNoteTrigger, ShannonEmotionKind } from '@shannon/cognition';

export const INNER_NOTE_PATH = '/v1/shannon/inner-notes';
export const INNER_NOTE_SCHEMA_VERSION = 1;

/** The server's own bounds: timing and cost (D3; technical and budget bounds, not how she feels). */
export const INNER_NOTE_SERVICE_LIMITS = Object.freeze({
  /** Events close together are one reflection: wait this long after the last one... */
  debounceMilliseconds: 1_200,
  /** ...but never longer than this after the first. */
  maximumWaitMilliseconds: 5_000,
  /** How often the server looks for an `until` that came, a day that ended, and what she was asked to forget. */
  sweepMilliseconds: 60_000,
  /** At most this many reflections a day (a cost guard; the ADR expects a few to a few dozen). */
  reflectionsPerDay: 96,
  /** The provider call's own bound. */
  timeoutMilliseconds: 30_000,
  maximumOutputTokens: 900,
  /** The last lines of a conversation in progress given to a reflection (owner alone only). */
  recentLines: 6,
  /** A conversation older than this is not "in progress". */
  recentFreshMilliseconds: 30 * 60_000,
  /** Reads of the route per device and minute, and how far back it reads. */
  readsPerMinute: 30,
  days: 7,
  items: 60,
});

/** A note as the owner's app reads it. `text` is present only once its episode closed (answer 3): until then, what she shows. */
export interface InnerNoteView {
  id: string;
  at: string;
  dayKey: string;
  triggers: readonly InnerNoteTrigger[];
  shown: ShannonEmotionKind;
  tell: InnerNoteTell;
  until: string | null;
  scale: InnerNoteScale;
  dayReason: InnerNoteDayReason | null;
  intent: InnerNoteIntent;
  /** 建て前, always (what she shows is already shown). */
  tatemae: string;
  /** The whole note, once its episode closed: a later note let it go (`none`) or her day closed. */
  text?: { honne: string; tatemae: string; reason: string; plan: string; bottom: string; changeReason: string | null; summary: string | null };
  closed: boolean;
  flags: readonly string[];
  costUsd: number | null;
}

export interface InnerNoteDaySummary {
  dayKey: string;
  reflections: number;
  costUsd: number;
  /** Times the one-step gate held an apology or kindness to one step. */
  gateStopped: number;
  flags: Readonly<Record<string, number>>;
  /** Minutes of each sulk episode (keep/soften until it was let go), by scale. */
  episodes: readonly { scale: InnerNoteScale; minutes: number }[];
}

export interface InnerNoteResponse {
  schemaVersion: number;
  generatedAt: string;
  coreVersion: string;
  notes: readonly InnerNoteView[];
  days: readonly InnerNoteDaySummary[];
  limits: { days: number; items: number };
}
