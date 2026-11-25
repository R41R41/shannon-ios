/**
 * 「収録中」: the owner's statement that what is said now is being recorded or broadcast and will be seen by people who are not in the room.
 * It is a state with an end (it lapses by itself) and a short note the owner writes (who is where, what is not to be talked about). The note is
 * written on the server by the owner's paired device and read into the spoken reply's prompt; nothing here is written by a model.
 */
export const ON_AIR_PATH = '/v1/on-air';

export interface OnAir {
  /** When it lapses (ISO time). */
  until: string;
  /** What the owner wrote for the scene (at most `ON_AIR_LIMITS.noteCharacters`). */
  note: string;
}

export const ON_AIR_LIMITS = {
  bodyBytes: 4096,
  requestsPerMinute: 30,
  noteCharacters: 600,
  defaultMinutes: 240,
  maximumMinutes: 720,
} as const;

export interface OnAirRefusal { status: 400; error: 'INVALID_REQUEST'; message: string }

const refusal = (message: string): OnAirRefusal => ({ status: 400, error: 'INVALID_REQUEST', message });

/** What a write asks: `{ "off": true }`, or `{ "minutes"?: number, "note"?: string }`. */
export type OnAirRequest = { off: true } | { off: false; minutes: number; note: string };

export function validatedOnAirRequest(value: unknown): OnAirRequest | OnAirRefusal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refusal('JSON object body is required');
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => key !== 'off' && key !== 'minutes' && key !== 'note');
  if (unknown !== undefined) return refusal(`${unknown.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not allowed`);
  if (body.off !== undefined && typeof body.off !== 'boolean') return refusal('off must be a boolean');
  if (body.off === true) return { off: true };
  const minutes = body.minutes ?? ON_AIR_LIMITS.defaultMinutes;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > ON_AIR_LIMITS.maximumMinutes) {
    return refusal(`minutes must be a whole number from 1 to ${ON_AIR_LIMITS.maximumMinutes}`);
  }
  const note = body.note ?? '';
  if (typeof note !== 'string' || [...note].length > ON_AIR_LIMITS.noteCharacters) return refusal(`note must be text of at most ${ON_AIR_LIMITS.noteCharacters} characters`);
  return { off: false, minutes, note: note.trim() };
}

/**
 * What the body asks on the owner's behalf when the owner presses 「収録中」 in the game mod (`POST /v1/platform/voice/on-air`, the bridge's token).
 * Who the owner is was decided by the body before it asked. A button turns it on for a time and off again without touching the note the owner
 * wrote; the note itself is never sent back.
 */
export interface OnAirControl {
  /** When it lapses (ISO time), or null when it is not on air. */
  until(): string | null;
  /** On for this many minutes, keeping the note written last. */
  start(minutes: number): void;
  /** Off now, keeping the note. */
  stop(): void;
}

/** What the body may ask: `{ "read": true }`, `{ "off": true }` or `{ "minutes": whole number }`. Anything else is refused. */
export type OnAirControlRequest = { read: true } | { off: true } | { minutes: number };

export function validatedOnAirControlRequest(value: unknown): OnAirControlRequest | OnAirRefusal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refusal('JSON object body is required');
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1) return refusal('exactly one of read, off and minutes is required');
  if (body.read === true) return { read: true };
  if (body.off === true) return { off: true };
  const minutes = body.minutes;
  if (typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= ON_AIR_LIMITS.maximumMinutes) return { minutes };
  return refusal(`read, off or minutes (a whole number from 1 to ${ON_AIR_LIMITS.maximumMinutes}) is required`);
}
