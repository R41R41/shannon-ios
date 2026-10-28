/**
 * What a body tells while it works (session mb-arch, stage 1, owner 2026-10-20: "observe while the body works, and interrupt or queue").
 * Until now a surface was seen only at a step's boundary, as one picture taken when the decision began; a body's long command (a
 * move of 110 s, a dig of 140 s) ran unseen until its receipt. Here a surface sends small events between its polls, the same shape
 * for every surface (Minecraft first; the desktop body and the conversation later):
 *
 * - `need.appeared` / `need.gone`: a thing an unmet need wants came into or went out of reach (subject: the need's own id).
 * - `action.progress`: how the running command goes, every few seconds (subject: the command's id).
 * - `action.stalled`: the command's own measure has not got better for a while (the surface measures; the arbiter decides).
 * - `furnace.done` (run 39, 2026-10-26): a batch put in a furnace has come due, told once (subject `furnace:x,y,z`, data.text the words). Nothing is folded.
 *
 * Like the rest of this package it holds no timer, no database and no network: the service hands events in and asks what it needs.
 * The log is per body and per connection: a body that connects again numbers its events from 1 again.
 */
export const WORKING_EVENTS_V1 = 'working.events.v1';
export const WORKING_EVENT_KINDS = Object.freeze(['need.appeared', 'need.gone', 'action.progress', 'action.stalled', 'furnace.done',
  'reflex.capped', 'server.tick', 'inventory.changed', 'utility.near'] as const);
/**
 * `continue` contract v3.1 (2026-10-28): `reflex.capped` (a reflex reached its limit; the head decides at once), `server.tick` (the server's tick
 * as the body read it), `inventory.changed` (a reflex's use of the pack outside any act, for the promises' ledger), `utility.near` (a table,
 * furnace, chest or bed came near or went). They are read by their own readers and never folded into a command's progress.
 */
const SEPARATE_KINDS: ReadonlySet<string> = new Set(['furnace.done', 'reflex.capped', 'server.tick', 'inventory.changed', 'utility.near']);
export type WorkingEventKind = typeof WORKING_EVENT_KINDS[number];
export type WorkingScalar = string | number | boolean | null;

export const WORKING_EVENT_LIMITS = Object.freeze({ perPoll: 32, subject: 160, dataKeys: 16, key: 40, text: 120, kept: 400 });

export interface WorkingEvent {
  seq: number;
  /** ISO 8601, as the body stamped it. */
  at: string;
  kind: WorkingEventKind;
  subject: string;
  data: Readonly<Record<string, WorkingScalar>>;
}

/** A need the body has in reach now: the last `need.appeared` for its id with no `need.gone` after it. */
export interface WorkingNeed {
  id: string; need: string; name: string; distance: number | null; canReach: boolean; at: string;
  data: Readonly<Record<string, WorkingScalar>>;
}
/** The latest `action.progress` / `action.stalled` for a command. */
export interface WorkingProgress {
  subject: string; skill: string; measure: string | null; elapsedMs: number; sinceProgressMs: number; distance: number | null;
  stalled: boolean; at: string;
  /** What the body says makes a stall worse where it is (`water`), or null. */
  hazard: string | null;
}

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:,@-]*$/u;
const KEY = /^[A-Za-z][A-Za-z0-9_]*$/u;
const numberOf = (value: WorkingScalar | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const scalar = (item: unknown) => item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item));

/** The data's problem, or null: at most `dataKeys` keys of a plain form, scalar values, bounded text. */
function dataProblem(entries: readonly [string, unknown][]): string | null {
  if (entries.length > WORKING_EVENT_LIMITS.dataKeys) return 'data has too many keys';
  for (const [key, item] of entries) {
    if (key.length > WORKING_EVENT_LIMITS.key || !KEY.test(key)) return `data.${key.slice(0, 40)} is not a valid key`;
    if (!scalar(item)) return `data.${key} must be a scalar`;
    if (typeof item === 'string' && item.length > WORKING_EVENT_LIMITS.text) return `data.${key} is too long`;
  }
  return null;
}

/** The envelope's problem (keys, seq, at, kind, subject), or null. */
function envelopeProblem(row: Record<string, unknown>): string | null {
  const unknown = Object.keys(row).find(key => !['seq', 'at', 'kind', 'subject', 'data'].includes(key));
  if (unknown) return `${unknown} is not allowed`;
  if (!Number.isSafeInteger(row.seq) || (row.seq as number) < 1) return 'seq is invalid';
  if (typeof row.at !== 'string' || row.at.length > 40 || Number.isNaN(Date.parse(row.at))) return 'at is invalid';
  if (!(WORKING_EVENT_KINDS as readonly string[]).includes(String(row.kind))) return 'kind is invalid';
  const subject = row.subject;
  if (typeof subject !== 'string' || subject.length > WORKING_EVENT_LIMITS.subject || !SUBJECT.test(subject)) return 'subject is invalid';
  return null;
}

/** One event from a body, checked: closed keys and kinds, bounded subject and data (scalars only). A frozen copy, or what is wrong. */
export function checkedWorkingEvent(value: unknown): WorkingEvent | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'event must be an object';
  const row = value as Record<string, unknown>;
  const envelope = envelopeProblem(row);
  if (envelope) return envelope;
  const data = row.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'data must be an object';
  const entries = Object.entries(data as Record<string, unknown>);
  const problem = dataProblem(entries);
  if (problem) return problem;
  return Object.freeze({ seq: row.seq as number, at: row.at as string, kind: row.kind as WorkingEventKind, subject: row.subject as string,
    data: Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, WorkingScalar>> });
}

/**
 * The events of one body, in order, with what they add up to: the needs in reach now and each command's latest progress. Taking a
 * poll's events answers the highest `seq` taken (the body drops those); an event already taken, or a malformed one, is skipped.
 */
export class WorkingEventLog {
  private connection: string | null = null;
  private through = 0;
  private events: WorkingEvent[] = [];
  private readonly needMap = new Map<string, WorkingNeed>();
  private readonly progressMap = new Map<string, WorkingProgress>();
  /** Counts each event taken, from 1, across connections: a reader keeps the last count it read (`since`). */
  private taken = 0;
  private readonly order: number[] = [];

  /** Takes a poll's events. A new connection starts the numbering and the needs afresh (the body forgot them too). */
  take(connection: string, raw: unknown): { through: number; accepted: number; rejected: number } {
    this.connect(connection);
    const list = Array.isArray(raw) ? raw.slice(0, WORKING_EVENT_LIMITS.perPoll) : [];
    let accepted = 0, rejected = 0;
    for (const item of list) {
      const event = checkedWorkingEvent(item);
      if (typeof event === 'string') {
        rejected++;
        // Its number is still taken, so the body stops sending it (it would come back with every poll).
        const seq = (item as { seq?: unknown } | null)?.seq;
        if (Number.isSafeInteger(seq) && (seq as number) > this.through) this.through = seq as number;
        continue;
      }
      if (event.seq <= this.through) continue;
      this.through = event.seq;
      this.taken += 1;
      this.events.push(event);
      this.order.push(this.taken);
      if (this.events.length > WORKING_EVENT_LIMITS.kept) {
        this.events.shift();
        this.order.shift();
      }
      this.fold(event);
      accepted++;
    }
    return { through: this.through, accepted, rejected };
  }

  /** The events taken after `cursor` (a count from `cursor()`), oldest first, and the new cursor. Older ones may have been dropped. */
  since(cursor: number): { events: readonly WorkingEvent[]; cursor: number } {
    const start = this.order.findIndex(count => count > cursor);
    return { events: start < 0 ? [] : this.events.slice(start), cursor: this.taken };
  }

  /** The body's connection now: a new one forgets the needs and the progress of the old (also when its first poll carries no events). */
  connect(connection: string): void {
    if (connection === this.connection) return;
    this.connection = connection;
    this.through = 0;
    this.needMap.clear();
    this.progressMap.clear();
  }

  cursor(): number { return this.taken; }
  needs(): readonly WorkingNeed[] { return [...this.needMap.values()].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity)); }
  progress(subject: string): WorkingProgress | null { return this.progressMap.get(subject) ?? null; }

  private fold(event: WorkingEvent): void {
    const d = event.data;
    if (event.kind === 'need.appeared') {
      this.needMap.set(event.subject, { id: event.subject, need: String(d.need ?? ''), name: String(d.name ?? ''), distance: numberOf(d.distance),
        canReach: d.canReach !== false, at: event.at, data: d });
    } else if (event.kind === 'need.gone') this.needMap.delete(event.subject);
    else if (!SEPARATE_KINDS.has(event.kind)) {
      const before = this.progressMap.get(event.subject);
      const since = numberOf(d.sinceProgressMs) ?? 0;
      // Still stalled while the time since progress keeps growing; progress (it falls back) ends the stall.
      const stalled = event.kind === 'action.stalled' || (!!before?.stalled && since >= before.sinceProgressMs);
      this.progressMap.set(event.subject, { subject: event.subject, skill: String(d.skill ?? ''), measure: typeof d.measure === 'string' ? d.measure : null,
        elapsedMs: numberOf(d.elapsedMs) ?? 0, sinceProgressMs: since, distance: numberOf(d.distance), stalled, at: event.at,
        hazard: typeof d.hazard === 'string' ? d.hazard : null });
      if (this.progressMap.size > 64) this.progressMap.delete(this.progressMap.keys().next().value as string);
    }
  }
}
