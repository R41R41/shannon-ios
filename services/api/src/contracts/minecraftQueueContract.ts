/**
 * The owner's list of small requests for her Minecraft body (「ケーキを作って」「木材を1スタック集めといて」), as the head keeps it and the
 * game side (the mod, the body's bridge, the trial rig) reads and changes it. No imports: every side reads the same words.
 *
 * The body works on one request at a time. The list is the head's: it is stored (it survives a restart), and exactly one entry is
 * `running`, the one bound to the common task. `docs/minecraft-body-contract.md` is the prose form.
 */
export const MINECRAFT_QUEUE_PATH = '/v1/body/minecraft/queue';

export const MINECRAFT_QUEUE_STATES = ['queued', 'running', 'paused', 'stopped', 'done', 'failed', 'cancelled'] as const;
/**
 * queued: waits its turn. running: the body works on it. paused: held by the owner (the list goes on without it). stopped: the whole
 * list was stopped while it ran (or its task was stopped from outside). done / failed / cancelled: ended; `failed` is kept apart from
 * `done` so that a request that did not work is never shown as made.
 */
export type MinecraftQueueState = typeof MINECRAFT_QUEUE_STATES[number];
export const MINECRAFT_QUEUE_ORIGINS = ['mod', 'chat', 'voice', 'app', 'operator'] as const;
export type MinecraftQueueOrigin = typeof MINECRAFT_QUEUE_ORIGINS[number];
/** Where a new request goes: after all (default), straight after the one running, or before it (the one running is paused). */
export const MINECRAFT_QUEUE_PLACEMENTS = ['end', 'next', 'now'] as const;
export type MinecraftQueuePlacement = typeof MINECRAFT_QUEUE_PLACEMENTS[number];
export const MINECRAFT_QUEUE_OPS = ['add', 'delete', 'move', 'start', 'stop', 'cancel', 'hold', 'resume'] as const;
export type MinecraftQueueOp = typeof MINECRAFT_QUEUE_OPS[number];
/**
 * `ok`; `not_found` (no such entry); `bad_state` (the entry's state does not allow it); `running` (it is running: cancel it first);
 * `queue_full`; `invalid`.
 */
export const MINECRAFT_QUEUE_CODES = ['ok', 'not_found', 'bad_state', 'running', 'queue_full', 'invalid'] as const;
export type MinecraftQueueCode = typeof MINECRAFT_QUEUE_CODES[number];

export const MINECRAFT_QUEUE_LIMITS = Object.freeze({
  goalCharacters: 120,
  noteCharacters: 80,
  /** Entries that are not running and not ended (queued, paused, stopped): one more is refused with `queue_full`. */
  waiting: 20,
  /** Ended entries kept; the newest `shown` of them are in the read. */
  ended: 30,
  shown: 10,
  /** The lines of the list given to her in a turn (`[依頼の列]`). */
  promptLines: 8,
  bodyBytes: 4 * 1024,
});

/** One entry as the game side sees it. `pos` counts the entries not ended from 0 (the one running is 0); an ended entry has -1. */
export interface MinecraftQueueEntry {
  id: string;
  /** Rises by one for each new entry and is never reused: what people say aloud and read as 「#3」. */
  seq: number;
  goal: string;
  state: MinecraftQueueState;
  pos: number;
  origin: MinecraftQueueOrigin;
  /** The common task once it has run (it stays after a pause). */
  taskId?: string;
  createdAt: string;
  /** Why it ended or was stopped, in a few words. */
  note?: string;
}

export interface MinecraftQueueView {
  /** Rises by one at each change: a reader that has this one has the list. */
  rev: number;
  /** Whether the next request is started when the body is free (false after a stop of the whole list). */
  autoRun: boolean;
  /** Not ended, in order. */
  entries: MinecraftQueueEntry[];
  /** The newest ended ones. */
  recent: MinecraftQueueEntry[];
}

/** `GET MINECRAFT_QUEUE_PATH?since=<rev>`: the list, or `{ rev, unchanged: true }` when `since` is still the revision. */
export type MinecraftQueueRead = MinecraftQueueView | { rev: number; unchanged: true };

/** `POST MINECRAFT_QUEUE_PATH`. `id` is an entry's id (or 「#3」 / 「3」, its seq). `before`: an entry's id, or null for the end. */
export interface MinecraftQueueRequest {
  op: MinecraftQueueOp;
  id?: string;
  before?: string | null;
  goal?: string;
  placement?: MinecraftQueuePlacement;
  requestId?: string;
}

export interface MinecraftQueueAnswer {
  ok: boolean;
  code: MinecraftQueueCode;
  queue: MinecraftQueueView;
  /** The entry an `add` made (or found again). */
  entryId?: string;
  /** The request is kept but nothing runs yet: the body is not connected. */
  waiting?: 'body';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shaped = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:#-]{1,80}$/u.test(value);
const oneOf = (values: readonly unknown[], value: unknown): boolean => values.includes(value);
/** What each field of a POST body may be. A key that is not here is refused. */
const FIELD_CHECKS = new Map<string, (value: unknown) => boolean>([
  ['op', value => oneOf(MINECRAFT_QUEUE_OPS, value)],
  ['id', shaped],
  ['before', value => value === null || shaped(value)],
  ['goal', value => typeof value === 'string' && value.length <= 1_000],
  ['placement', value => oneOf(MINECRAFT_QUEUE_PLACEMENTS, value)],
  ['requestId', shaped],
]);

/** The request of a POST body, or null when it is not one (the route answers 400). Unknown fields are refused. */
export function parsedMinecraftQueueRequest(value: unknown): MinecraftQueueRequest | null {
  if (!isRecord(value) || !('op' in value)) return null;
  if (Object.keys(value).some(key => !FIELD_CHECKS.get(key)?.(value[key]))) return null;
  return { ...value } as unknown as MinecraftQueueRequest;
}
