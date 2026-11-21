import {
  MINECRAFT_QUEUE_LIMITS, type MinecraftQueueCode, type MinecraftQueueEntry, type MinecraftQueueOrigin, type MinecraftQueuePlacement,
  type MinecraftQueueState, type MinecraftQueueView,
} from '../../contracts/minecraftQueueContract.js';

/**
 * The owner's list of requests for her Minecraft body, as pure state changes (`contracts/minecraftQueueContract.ts` says what each word
 * means). Nothing here reads a clock, a database or the task runtime: a change takes the list and returns the next one, with the
 * stops of tasks it asks the caller to make (`wiring/fcaMinecraftQueue.ts` stores the list and carries those out).
 *
 * The body is one: at most one entry is `running`, and it is first in the order. Entries that are not ended keep an order (`pos`);
 * ended ones have none and only the newest few are kept.
 */
export interface QueueRecord {
  id: string;
  seq: number;
  goal: string;
  state: MinecraftQueueState;
  pos: number;
  origin: MinecraftQueueOrigin;
  /** The id the request came with (`mc:…`, `dcv:…`): a repeat of it is the same request. */
  requestId: string | null;
  /** The stored turn the request was made in, and when it was said; null for a request that came from no turn. */
  experienceId: string | null;
  observedAt: string | null;
  /** Who asked, in the words of the entry (a Discord member's shown name, a guest marked as one); null when the entry does not say. */
  askedBy: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  note: string | null;
}

export interface QueueSnapshot {
  autoRun: boolean;
  nextSeq: number;
  entries: readonly QueueRecord[];
}

/** A task the caller must stop: the entry that was running and let go. `taskId` is null while its task was still being made. */
export interface QueueStop {
  entryId: string;
  taskId: string | null;
  reason: string;
}

export type QueueFailure = Exclude<MinecraftQueueCode, 'ok'>;
export type QueueChange =
  | { ok: true; snapshot: QueueSnapshot; stops: QueueStop[]; entry: QueueRecord | null; duplicate?: true }
  | { ok: false; code: QueueFailure };

export const EMPTY_QUEUE: QueueSnapshot = Object.freeze({ autoRun: true, nextSeq: 1, entries: Object.freeze([]) as readonly QueueRecord[] });

const ENDED: readonly MinecraftQueueState[] = ['done', 'failed', 'cancelled'];
export const queueEnded = (state: MinecraftQueueState): boolean => ENDED.includes(state);
const waiting = (state: MinecraftQueueState): boolean => state === 'queued' || state === 'paused' || state === 'stopped';

/** A goal as it is kept: control characters turned to spaces, trimmed, cut to the limit. Empty when nothing is left. */
export function queueGoal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MINECRAFT_QUEUE_LIMITS.goalCharacters);
}
const queueNote = (text: string): string => queueGoal(text).slice(0, MINECRAFT_QUEUE_LIMITS.noteCharacters);

interface Draft {
  /** Not ended, in order (the working copies). */
  order: QueueRecord[];
  ended: QueueRecord[];
  autoRun: boolean;
  nextSeq: number;
  stops: QueueStop[];
  at: string;
}

function draftOf(snapshot: QueueSnapshot, at: string): Draft {
  const copies = snapshot.entries.map(entry => ({ ...entry }));
  return { order: copies.filter(entry => !queueEnded(entry.state)).sort((a, b) => a.pos - b.pos),
    ended: copies.filter(entry => queueEnded(entry.state)), autoRun: snapshot.autoRun, nextSeq: snapshot.nextSeq, stops: [], at };
}

function changed(draft: Draft, entry: QueueRecord | null, duplicate = false): QueueChange {
  draft.order.forEach((item, index) => { item.pos = index; });
  for (const item of draft.ended) item.pos = -1;
  const ended = [...draft.ended].sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.seq - a.seq)
    .slice(0, MINECRAFT_QUEUE_LIMITS.ended);
  return { ok: true, snapshot: { autoRun: draft.autoRun, nextSeq: draft.nextSeq, entries: [...draft.order, ...ended] },
    stops: draft.stops, entry, ...(duplicate ? { duplicate: true as const } : {}) };
}

const failed = (code: QueueFailure): QueueChange => ({ ok: false, code });

/** The entry an id or a number names: an entry's id, or its seq as 「#3」 or 「3」. */
export function locateQueueEntry(snapshot: Pick<QueueSnapshot, 'entries'>, target: string): QueueRecord | null {
  const text = target.trim();
  const exact = snapshot.entries.find(entry => entry.id === text);
  if (exact) return exact;
  const number = /^[#＃]?\s*(\d{1,6})$/u.exec(text.normalize('NFKC'))?.[1];
  return number === undefined ? null : snapshot.entries.find(entry => entry.seq === Number(number)) ?? null;
}

const find = (draft: Draft, target: string): QueueRecord | null => {
  const located = locateQueueEntry({ entries: [...draft.order, ...draft.ended] }, target);
  return located ? [...draft.order, ...draft.ended].find(entry => entry.id === located.id) ?? null : null;
};

const running = (draft: Draft): QueueRecord | undefined => draft.order.find(entry => entry.state === 'running');

/** Moves an entry to a state. An ended state takes it out of the order. A running entry that is let go asks for its task to be stopped. */
function settle(draft: Draft, entry: QueueRecord, to: MinecraftQueueState, reason: string, note?: string): void {
  if (entry.state === 'running' && to !== 'running') draft.stops.push({ entryId: entry.id, taskId: entry.taskId, reason });
  entry.state = to;
  entry.updatedAt = draft.at;
  if (note !== undefined) entry.note = note ? queueNote(note) : null;
  if (!queueEnded(to)) return;
  entry.endedAt = draft.at;
  draft.order.splice(draft.order.indexOf(entry), 1);
  draft.ended.push(entry);
}

function place(draft: Draft, entry: QueueRecord, index: number): void {
  const at = draft.order.indexOf(entry);
  if (at >= 0) draft.order.splice(at, 1);
  draft.order.splice(Math.min(Math.max(index, 0), draft.order.length), 0, entry);
}

export interface NewQueueEntry {
  id: string;
  goal: string;
  placement: MinecraftQueuePlacement;
  origin: MinecraftQueueOrigin;
  requestId?: string | null;
  experienceId?: string | null;
  observedAt?: string | null;
  askedBy?: string | null;
}

/**
 * A new request: queued, and the list is let run again (a new request is the sign to go on). `now` lets go of the one running
 * (paused, so it can be taken up again) and puts the new one first. A request id seen before is the same request: nothing changes.
 */
export function addToQueue(snapshot: QueueSnapshot, input: NewQueueEntry, at: string): QueueChange {
  const goal = queueGoal(input.goal);
  if (!goal) return failed('invalid');
  const known = input.requestId ? snapshot.entries.find(entry => entry.requestId === input.requestId) : undefined;
  if (known) return { ok: true, snapshot, stops: [], entry: known, duplicate: true };
  const draft = draftOf(snapshot, at);
  if (draft.order.filter(entry => waiting(entry.state)).length >= MINECRAFT_QUEUE_LIMITS.waiting) return failed('queue_full');
  const entry = newRecord(input, goal, draft.nextSeq, at);
  draft.nextSeq += 1;
  draft.autoRun = true;
  const current = running(draft);
  if (input.placement === 'now' && current) settle(draft, current, 'paused', 'queue_now');
  draft.order.splice(insertionIndex(input.placement, draft.order, current), 0, entry);
  return changed(draft, entry);
}

function newRecord(input: NewQueueEntry, goal: string, seq: number, at: string): QueueRecord {
  return { id: input.id, seq, goal, state: 'queued', pos: 0, origin: input.origin, requestId: input.requestId ?? null,
    experienceId: input.experienceId ?? null, observedAt: input.observedAt ?? null, askedBy: input.askedBy ?? null, taskId: null, createdAt: at, updatedAt: at,
    endedAt: null, note: null };
}

function insertionIndex(placement: MinecraftQueuePlacement, order: readonly QueueRecord[], current: QueueRecord | undefined): number {
  if (placement === 'now') return 0;
  if (placement === 'next') return current ? 1 : 0;
  return order.length;
}

/** Removes an entry that is not running, ended ones too (their line in the history). */
export function deleteFromQueue(snapshot: QueueSnapshot, target: string, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  const entry = find(draft, target);
  if (!entry) return failed('not_found');
  if (entry.state === 'running') return failed('running');
  draft.order = draft.order.filter(item => item !== entry);
  draft.ended = draft.ended.filter(item => item !== entry);
  return changed(draft, entry);
}

/** Puts an entry before another, or at the end (`before` null). Never the one running, and never in front of it (after it instead). */
export function moveInQueue(snapshot: QueueSnapshot, target: string, before: string | null, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  const entry = find(draft, target);
  const other = before === null ? null : find(draft, before);
  if (!entry || (before !== null && !other)) return failed('not_found');
  if (entry.state === 'running') return failed('running');
  if (queueEnded(entry.state) || (other && queueEnded(other.state))) return failed('bad_state');
  if (other === entry) return failed('invalid');
  const rest = draft.order.filter(item => item !== entry);
  place(draft, entry, other ? rest.indexOf(other) + (other.state === 'running' ? 1 : 0) : rest.length);
  return changed(draft, entry);
}

/**
 * Starts the list (no target): it runs again, and what a stop of the whole list stopped waits its turn again. Starts one entry (a
 * target): it is first, the one that was running is paused, and the list runs again.
 */
export function startQueue(snapshot: QueueSnapshot, target: string | null, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  draft.autoRun = true;
  if (target === null) {
    for (const entry of draft.order) if (entry.state === 'stopped') settle(draft, entry, 'queued', 'queue_start');
    return changed(draft, null);
  }
  const entry = find(draft, target);
  if (!entry) return failed('not_found');
  if (queueEnded(entry.state)) return failed('bad_state');
  const current = running(draft);
  if (current === entry) return changed(draft, entry);
  if (current) settle(draft, current, 'paused', 'queue_start_other');
  settle(draft, entry, 'queued', 'queue_start');
  place(draft, entry, 0);
  return changed(draft, entry);
}

/** Stops the whole list: the one running is stopped and nothing new is started until the list is started again. The list is kept. */
export function stopQueue(snapshot: QueueSnapshot, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  draft.autoRun = false;
  const current = running(draft);
  if (current) settle(draft, current, 'stopped', 'queue_stop');
  return changed(draft, current ?? null);
}

/** The entry a target names, or the one running when there is none. */
function aimed(draft: Draft, target: string | null): QueueRecord | null {
  return target === null ? running(draft) ?? null : find(draft, target);
}

/** Cancels one entry (it ends as `cancelled`, kept in the history); the list goes on with the next. */
export function cancelInQueue(snapshot: QueueSnapshot, target: string | null, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  const entry = aimed(draft, target);
  if (!entry) return failed('not_found');
  if (queueEnded(entry.state)) return failed('bad_state');
  settle(draft, entry, 'cancelled', 'queue_cancel');
  return changed(draft, entry);
}

/** Holds one entry: it is skipped (paused) and the list goes on without it. */
export function holdInQueue(snapshot: QueueSnapshot, target: string | null, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  const entry = aimed(draft, target);
  if (!entry) return failed('not_found');
  if (queueEnded(entry.state)) return failed('bad_state');
  if (entry.state !== 'paused') settle(draft, entry, 'paused', 'queue_hold');
  return changed(draft, entry);
}

/** Takes one held (or stopped) entry back into the list in its place, or all of them (no target); the list runs again. */
export function resumeInQueue(snapshot: QueueSnapshot, target: string | null, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  draft.autoRun = true;
  if (target === null) {
    for (const entry of draft.order) if (entry.state === 'paused' || entry.state === 'stopped') settle(draft, entry, 'queued', 'queue_resume');
    return changed(draft, null);
  }
  const entry = find(draft, target);
  if (!entry) return failed('not_found');
  if (queueEnded(entry.state)) return failed('bad_state');
  if (entry.state === 'paused' || entry.state === 'stopped') settle(draft, entry, 'queued', 'queue_resume');
  return changed(draft, entry);
}

/** The next request to start: when the list runs, nothing is running, and one waits. It is marked running and put first. */
export function claimFromQueue(snapshot: QueueSnapshot, at: string): QueueChange | null {
  if (!snapshot.autoRun || snapshot.entries.some(entry => entry.state === 'running')) return null;
  const draft = draftOf(snapshot, at);
  const next = draft.order.find(entry => entry.state === 'queued');
  if (!next) return null;
  settle(draft, next, 'running', 'queue_claim');
  place(draft, next, 0);
  return changed(draft, next);
}

/** Gives a started entry its task. */
export function linkQueueTask(snapshot: QueueSnapshot, entryId: string, taskId: string, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  const entry = find(draft, entryId);
  if (!entry) return failed('not_found');
  entry.taskId = taskId;
  entry.updatedAt = at;
  return changed(draft, entry);
}

/** A start that did not work: the entry waits again (its first place), with the reason; or it ends as failed when `give_up`. */
export function unclaimInQueue(snapshot: QueueSnapshot, entryId: string, reason: string, giveUp: boolean, at: string): QueueChange {
  const draft = draftOf(snapshot, at);
  const entry = find(draft, entryId);
  if (!entry) return failed('not_found');
  // Let go (held, cancelled, removed) while it was starting: what the owner decided stands; a failed start does not undo it.
  if (entry.state !== 'running') return failed('bad_state');
  settle(draft, entry, giveUp ? 'failed' : 'queued', 'queue_start_failed', reason);
  return changed(draft, entry);
}

/** What the caller read of the task runtime and the body, for `syncQueue`. */
export interface QueueFacts {
  /** The phase of a task by its id; null when there is no such task. Of the tasks of entries not ended, and of ended ones that still work. */
  phases: ReadonlyMap<string, string | null>;
  /** Tasks bound to the body, not ended and not stopped, that no entry has: one made from outside (the operator's CLI, an older path). */
  unowned: ReadonlyArray<{ taskId: string; goal: string; origin: MinecraftQueueOrigin }>;
  /** Entries whose task is being made right now. */
  starting: ReadonlySet<string>;
  newId(): string;
}

/** A task that is working: a stop has not been asked of it, and it is not stopped or ended. */
const working = (phase: string | null | undefined): boolean => phase === 'ready' || phase === 'executing' || phase === 'waiting';
/** How long a stop is given to show (the task turns `stopping`) before a task that still works against the list is stopped again. */
export const QUEUE_STRAY_GRACE_MS = 5_000;
const aged = (entry: QueueRecord, at: string): boolean => Date.parse(at) - Date.parse(entry.updatedAt) > QUEUE_STRAY_GRACE_MS;

/** Makes the list say what the tasks are. Null when it already does (and nothing is to be stopped). */
export function syncQueue(snapshot: QueueSnapshot, facts: QueueFacts, at: string): QueueChange | null {
  const draft = draftOf(snapshot, at);
  const taken = new Set<string>();
  for (const entry of [...draft.order]) syncEntry(draft, entry, facts, taken);
  // A task that works for an entry that ended (a stop that did not get through) is asked to stop again.
  for (const entry of draft.ended) {
    if (entry.taskId && working(facts.phases.get(entry.taskId)) && aged(entry, at)) {
      draft.stops.push({ entryId: entry.id, taskId: entry.taskId, reason: 'queue_stray_stop' });
    }
  }
  for (const task of facts.unowned) {
    if (taken.has(task.taskId)) continue;
    // The body is one: a task made from outside while an entry runs is kept on the list, held, and stopped.
    const other = running(draft) !== undefined;
    const entry: QueueRecord = { id: facts.newId(), seq: draft.nextSeq, goal: queueGoal(task.goal) || '(依頼)', state: other ? 'paused' : 'running',
      pos: 0, origin: task.origin, requestId: null, experienceId: null, observedAt: null, askedBy: null, taskId: task.taskId, createdAt: at, updatedAt: at,
      endedAt: null, note: other ? 'made_outside_while_running' : null };
    draft.nextSeq += 1;
    if (other) {
      draft.order.push(entry);
      draft.stops.push({ entryId: entry.id, taskId: task.taskId, reason: 'queue_extra_task' });
    } else draft.order.splice(0, 0, entry);
  }
  const next = changed(draft, null);
  return next.ok && !next.stops.length && sameList(snapshot, next.snapshot) ? null : next;
}

function syncEntry(draft: Draft, entry: QueueRecord, facts: QueueFacts, taken: Set<string>): void {
  if (!entry.taskId) {
    if (entry.state !== 'running' || facts.starting.has(entry.id)) return;
    // A start that no process is making any more (the head restarted in it): the task it made, if it got that far, is its own
    // (the same goal, seen from outside as a task nobody holds), not a second request beside it. Otherwise it waits again.
    const made = facts.unowned.find(task => !taken.has(task.taskId) && task.goal === entry.goal);
    if (made) {
      taken.add(made.taskId);
      entry.taskId = made.taskId;
      entry.updatedAt = draft.at;
    } else settle(draft, entry, 'queued', 'queue_start_lost', 'start_lost');
    return;
  }
  const phase = facts.phases.get(entry.taskId);
  if (phase === 'completed') settle(draft, entry, 'done', 'queue_done');
  else if (phase === 'failed') settle(draft, entry, 'failed', 'queue_failed', 'task_failed');
  else if (phase === null) settle(draft, entry, 'failed', 'queue_failed', 'task_missing');
  else if (phase === 'stopped' && entry.state === 'running') {
    // The task was stopped from outside the list (the mod's old button, the operator): the list stops with it.
    settle(draft, entry, 'stopped', 'queue_stopped_outside', 'stopped_outside');
    draft.autoRun = false;
  } else if (entry.state !== 'running' && working(phase) && aged(entry, draft.at)) {
    // A task works that the list does not say runs. A held one (its stop did not get through) is stopped again. One that was
    // stopped or waiting and works again was put back to work from outside: it is the one running, unless another is.
    if (entry.state === 'paused' || running(draft)) draft.stops.push({ entryId: entry.id, taskId: entry.taskId, reason: 'queue_stray_stop' });
    else {
      settle(draft, entry, 'running', 'queue_resumed_outside', 'resumed_outside');
      place(draft, entry, 0);
    }
  }
}

function sameList(a: QueueSnapshot, b: QueueSnapshot): boolean {
  return a.autoRun === b.autoRun && a.nextSeq === b.nextSeq && JSON.stringify(a.entries) === JSON.stringify(b.entries);
}

export const queueWire = (entry: QueueRecord): MinecraftQueueEntry => ({
  id: entry.id, seq: entry.seq, goal: entry.goal, state: entry.state, pos: entry.pos, origin: entry.origin,
  ...(entry.askedBy ? { askedBy: entry.askedBy } : {}), ...(entry.taskId ? { taskId: entry.taskId } : {}), createdAt: entry.createdAt, ...(entry.note ? { note: entry.note } : {}),
});

/** The list as the game side reads it. */
export function queueView(snapshot: QueueSnapshot, rev: number): MinecraftQueueView {
  const live = snapshot.entries.filter(entry => !queueEnded(entry.state)).sort((a, b) => a.pos - b.pos);
  const recent = snapshot.entries.filter(entry => queueEnded(entry.state))
    .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.seq - a.seq).slice(0, MINECRAFT_QUEUE_LIMITS.shown);
  return { rev, autoRun: snapshot.autoRun, entries: live.map(queueWire), recent: recent.map(queueWire) };
}

const LABELS: Readonly<Record<MinecraftQueueState, string>> = Object.freeze({
  running: '実行中', queued: '待ち', paused: '保留', stopped: '停止', done: '済み', failed: '失敗', cancelled: 'やめた',
});

/**
 * The list as lines for her turn (`[依頼の列]`): the one running first, then the order, at most `promptLines`. Empty when the list is
 * empty. A list that is stopped says so on its own line, so that 「再開して」 can be told from 「続けて」.
 */
export function queuePromptLines(snapshot: QueueSnapshot): string[] {
  const live = snapshot.entries.filter(entry => !queueEnded(entry.state)).sort((a, b) => a.pos - b.pos);
  if (!live.length) return [];
  const limit = MINECRAFT_QUEUE_LIMITS.promptLines;
  const lines = live.slice(0, limit).map(entry => `#${entry.seq} ${LABELS[entry.state]} 「${entry.goal.slice(0, 40)}」${entry.askedBy ? `（${entry.askedBy}）` : ''}`);
  if (live.length > limit) lines.splice(limit - 1, 1, `ほか ${live.length - limit + 1} 件`);
  if (!snapshot.autoRun) lines.push('（列は止めてある。始めると続きから動く）');
  return lines.slice(0, limit + 1);
}
