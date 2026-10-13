import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHARACTER_CORE } from '@shannon/cognition';
import {
  INNER_NOTE_SCHEMA_VERSION, INNER_NOTE_SERVICE_LIMITS,
  type InnerNoteDaySummary, type InnerNoteResponse, type InnerNoteView,
} from '../../contracts/innerNoteContract.js';
import type { SQLiteInnerNoteStore, StoredInnerNote } from '../../mind/emotion/store/innerNoteStore.js';
import { consumeDeviceAllowance, sendJson } from './serverHttp.js';

export interface InnerNoteRouteDependencies {
  store: Pick<SQLiteInnerNoteStore, 'since'>;
  ownerScopeKey: string;
  now: () => string;
}

/**
 * `GET /v1/shannon/inner-notes` (`docs/inner-note-contract.md`; Syzygy ADR-0012 answer 3): the owner's own app reads her notes of
 * the last days. What she shows (建て前) and the hooks are there at once; the whole note (本音 and the rest) only once its episode
 * closed: a later note let it go, or her day ended. Only a device paired into the owner's scope; nothing is written, no model is
 * called. The route exists only while `SHANNON_INNER_NOTE` is on (the server does not mount it otherwise: an older server's 404).
 */
export function createInnerNoteRoute(dependencies: InnerNoteRouteDependencies) {
  const usage = new Map<string, { startedAt: number; count: number }>();
  return (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string; deviceId: string } | null): void => {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device of the owner may read this.' });
    if (principal.scopeKey !== dependencies.ownerScopeKey) {
      return sendJson(response, 403, { error: 'INNER_NOTE_OWNER_ONLY', message: 'Only the owner may read this.' });
    }
    if (!consumeDeviceAllowance(usage, principal.deviceId, INNER_NOTE_SERVICE_LIMITS.readsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests; retry after a minute.' });
    }
    sendJson(response, 200, innerNoteResponse(dependencies, principal.scopeKey));
  };
}

export function innerNoteResponse(dependencies: Pick<InnerNoteRouteDependencies, 'store' | 'now'>, scopeKey: string): InnerNoteResponse {
  const at = dependencies.now();
  const { days, items } = INNER_NOTE_SERVICE_LIMITS;
  const since = new Date(Date.parse(at) - days * 86_400_000).toISOString();
  const notes = dependencies.store.since(scopeKey, since, items);
  return {
    schemaVersion: INNER_NOTE_SCHEMA_VERSION, generatedAt: at, coreVersion: CHARACTER_CORE.version,
    notes: notes.map(note => innerNoteView(note, notes, at)), days: daySummaries(notes, at), limits: { days, items },
  };
}

/** Whether a note's episode is over: her day closed or ended, or a later note of the same day let it go. */
export function innerNoteEpisodeClosed(note: StoredInnerNote, all: readonly StoredInnerNote[], at: string): boolean {
  if (note.closedAt || note.dayEndsAt <= at) return true;
  return all.some(other => other.dayId === note.dayId && other.sequence > note.sequence && (other.hooks.intent === 'none' || other.closedAt !== null));
}

export function innerNoteView(note: StoredInnerNote, all: readonly StoredInnerNote[], at: string): InnerNoteView {
  const closed = innerNoteEpisodeClosed(note, all, at);
  const { hooks } = note;
  return {
    id: note.id, at: note.createdAt, dayKey: note.dayKey, triggers: note.triggers, shown: hooks.shown, tell: hooks.tell, until: hooks.until,
    scale: hooks.scale, dayReason: hooks.dayReason, intent: hooks.intent, tatemae: note.text.tatemae, closed,
    ...(closed ? { text: { ...note.text, changeReason: note.changeReason, summary: note.summary } } : {}),
    flags: Object.keys(note.flags), costUsd: note.usage?.costUsd ?? null,
  };
}

/** Per day: reflections, their cost, the gate's holds and marks, and how long each sulk lasted (§11 of the daily-use evals). */
export function daySummaries(notes: readonly StoredInnerNote[], at: string): InnerNoteDaySummary[] {
  const byDay = new Map<string, StoredInnerNote[]>();
  for (const note of [...notes].sort((left, right) => left.sequence - right.sequence)) byDay.set(note.dayKey, [...byDay.get(note.dayKey) ?? [], note]);
  return [...byDay.entries()].map(([dayKey, day]) => {
    const flags: Record<string, number> = {};
    for (const flag of day.flatMap(note => Object.keys(note.flags))) flags[flag] = (flags[flag] ?? 0) + 1;
    return { dayKey, reflections: day.length, costUsd: Math.round(day.reduce((sum, note) => sum + (note.usage?.costUsd ?? 0), 0) * 1e6) / 1e6,
      gateStopped: flags.gateStopped ?? 0, flags, episodes: episodes(day, at) };
  }).sort((left, right) => right.dayKey.localeCompare(left.dayKey));
}

function episodes(day: readonly StoredInnerNote[], at: string): InnerNoteDaySummary['episodes'] {
  const found: { scale: 'ordinary' | 'day'; minutes: number }[] = [];
  let start: StoredInnerNote | null = null;
  let scale: 'ordinary' | 'day' = 'ordinary';
  const end = (until: string) => found.push({ scale, minutes: Math.max(0, Math.round((Date.parse(until) - Date.parse(start!.createdAt)) / 60_000)) });
  for (const note of day) {
    const sulking = note.hooks.intent === 'keep' || note.hooks.intent === 'soften';
    if (sulking && !start) start = note;
    if (sulking && note.hooks.scale === 'day') scale = 'day';
    if (sulking || !start) continue;
    end(note.createdAt);
    start = null;
    scale = 'ordinary';
  }
  const last = day.at(-1);
  if (start && last) end(last.closedAt ?? (last.dayEndsAt < at ? last.dayEndsAt : at));
  return found;
}
