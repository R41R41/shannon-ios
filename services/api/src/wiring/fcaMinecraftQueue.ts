import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  MINECRAFT_QUEUE_LIMITS, type MinecraftQueueCode, type MinecraftQueueOrigin, type MinecraftQueueRead, type MinecraftQueueRequest,
  type MinecraftQueueView,
} from '../contracts/minecraftQueueContract.js';
import {
  addToQueue, cancelInQueue, claimFromQueue, deleteFromQueue, holdInQueue, linkQueueTask, locateQueueEntry, moveInQueue, queuePromptLines,
  queueEnded, queueView, resumeInQueue, startQueue, stopQueue, syncQueue, unclaimInQueue, type QueueChange, type QueueRecord, type QueueSnapshot,
} from '../surfaces/minecraft/minecraftRequestQueue.js';
import { MinecraftRequestQueueStore } from '../surfaces/minecraft/store/minecraftRequestQueueStore.js';

/** How long an operation's answer waits for the body to acknowledge a stop (the stop itself goes on). */
export const QUEUE_STOP_WAIT_MS = 3_000;
/** A start that failed waits again (the next pass tries it); at the third failure the entry ends as failed. */
export const QUEUE_START_ATTEMPTS = 3;

/** What the queue needs of the task runtime and the body (`fcaMinecraftRequests.ts` gives it). */
export interface QueueParts {
  db: DatabaseSync;
  scopeKey: string;
  /** Same SQLite connection and write lock as the task authority. */
  atomic<T>(work: () => T): T;
  /** The phase of a task; null when there is no such task. */
  phase(taskId: string): string | null;
  /** Tasks bound to the body that are not stopped, completed or failed (a stopping one too), with the origin when it is a request of his. */
  open(): Array<{ taskId: string; goal: string; origin: MinecraftQueueOrigin | null }>;
  /** A current frame of one connected body is there: something can be started. */
  bodyReady(): boolean;
  /** Stops the task (the runtime's stop: it waits for the body's acknowledgement). */
  stop(taskId: string, reason: string): Promise<unknown>;
  /** Puts a stopped task back to work; false when it could not be. */
  resume(taskId: string): boolean;
  /** Makes the task for an entry and binds it to the body; its id, or null when it could not be made. */
  start(entry: QueueRecord): Promise<string | null>;
  now(): string;
  log(line: string): void;
  newId?(): string;
}

export interface QueueOutcome {
  ok: boolean;
  code: MinecraftQueueCode;
  entry: QueueRecord | null;
  duplicate?: boolean;
  waiting?: 'body';
}

export interface QueueContext {
  origin: MinecraftQueueOrigin;
  requestId?: string | null;
  experienceId?: string | null;
  observedAt?: string | null;
  /** The reason the runtime's stop is given when this operation lets the running request go (journal and summaries: who asked). */
  stopReason?: string;
}

/** One operation of a request on the list as a pure change. */
function applied(request: MinecraftQueueRequest, context: QueueContext, snapshot: QueueSnapshot,
  make: { at: string; id: string | null; newId: string }): QueueChange {
  const { at, id } = make;
  switch (request.op) {
    case 'add': return addToQueue(snapshot, { id: make.newId, goal: request.goal ?? '', placement: request.placement ?? 'end', origin: context.origin,
      requestId: request.requestId ?? context.requestId, experienceId: context.experienceId, observedAt: context.observedAt }, at);
    case 'delete': return id ? deleteFromQueue(snapshot, id, at) : { ok: false, code: 'invalid' };
    case 'move': return id ? moveInQueue(snapshot, id, request.before ?? null, at) : { ok: false, code: 'invalid' };
    case 'start': return startQueue(snapshot, id, at);
    case 'stop': return stopQueue(snapshot, at);
    case 'cancel': return cancelInQueue(snapshot, id, at);
    case 'hold': return holdInQueue(snapshot, id, at);
    default: return resumeInQueue(snapshot, id, at);
  }
}

/** The list of requests of her Minecraft body: kept, changed by the owner's words and buttons, and carried out one at a time. */
export function fcaMinecraftQueue(parts: QueueParts) {
  const store = new MinecraftRequestQueueStore(parts.db);
  const newId = parts.newId ?? randomUUID;
  const starting = new Set<string>();
  const failures = new Map<string, number>();
  let wake: () => void = () => {};
  let pumping: Promise<void> | null = null;
  let again = false;

  /** Reads the list, changes it, stores it: one write. */
  const transact = (change: (snapshot: QueueSnapshot) => QueueChange | null): (QueueChange & { rev: number }) | null => parts.atomic(() => {
    const before = store.read(parts.scopeKey);
    const next = change(before);
    if (!next) return null;
    return { ...next, rev: next.ok ? store.write(parts.scopeKey, next.snapshot) : before.rev };
  });

  const settleStops = async (change: QueueChange, reason?: string): Promise<void> => {
    if (!change.ok || !change.stops.length) return;
    const stops = change.stops.filter(stop => stop.taskId).map(async stop => {
      try { await parts.stop(stop.taskId!, reason ?? stop.reason); }
      catch (error) { parts.log(`Shannon Minecraft queue stop failed code=${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`); }
    });
    await Promise.race([Promise.allSettled(stops), new Promise<void>(resolve => setTimeout(resolve, QUEUE_STOP_WAIT_MS).unref())]);
  };

  const logChange = (op: string, before: QueueSnapshot, after: QueueChange): void => {
    if (!after.ok) {
      parts.log(`Shannon Minecraft queue op=${op} code=${after.code}`);
      return;
    }
    const entry = after.entry;
    const was = entry ? before.entries.find(item => item.id === entry.id)?.state ?? '-' : '-';
    const name = entry ? `#${entry.seq}` : '-';
    parts.log(`Shannon Minecraft queue op=${op} entry=${name} state=${was}→${entry?.state ?? '-'} origin=${entry?.origin ?? '-'} code=ok`);
  };

  const facts = () => {
    const open = parts.open();
    const snapshot = store.read(parts.scopeKey);
    const known = new Set(snapshot.entries.map(entry => entry.taskId).filter(Boolean));
    const phases = new Map<string, string | null>();
    for (const entry of snapshot.entries) {
      if (entry.taskId && !queueEnded(entry.state)) phases.set(entry.taskId, parts.phase(entry.taskId));
    }
    const unowned = open.filter(task => task.origin && !known.has(task.taskId)).map(task => ({ taskId: task.taskId, goal: task.goal, origin: task.origin! }));
    return { open, facts: { phases, unowned, starting, newId } };
  };

  const sync = (): void => {
    const read = facts();
    const done = transact(snapshot => syncQueue(snapshot, read.facts, parts.now()));
    if (done?.ok && done.entry === null) parts.log('Shannon Minecraft queue op=sync code=ok');
  };

  const giveUp = (entry: QueueRecord, reason: string): void => {
    const count = (failures.get(entry.id) ?? 0) + 1;
    failures.set(entry.id, count);
    transact(snapshot => unclaimInQueue(snapshot, entry.id, reason, count >= QUEUE_START_ATTEMPTS, parts.now()));
    parts.log(`Shannon Minecraft queue op=start entry=#${entry.seq} code=failed reason=${reason.slice(0, 40)} attempt=${count}`);
  };

  const begin = async (entry: QueueRecord): Promise<void> => {
    starting.add(entry.id);
    try {
      const taskId = entry.taskId ? (parts.resume(entry.taskId) ? entry.taskId : null) : await parts.start(entry);
      if (!taskId) {
        giveUp(entry, 'no_task');
        return;
      }
      const linked = transact(snapshot => linkQueueTask(snapshot, entry.id, taskId, parts.now()));
      const now = store.read(parts.scopeKey).entries.find(item => item.id === entry.id);
      // Let go, or removed, while its task was being made: the task is not to run.
      if (!linked?.ok || !now || now.state !== 'running') await parts.stop(taskId, 'queue_released_while_starting').catch(() => {});
      failures.delete(entry.id);
      parts.log(`Shannon Minecraft queue op=start entry=#${entry.seq} state=queued→${now?.state ?? '-'} origin=${entry.origin} code=ok`);
      wake();
    } catch (error) {
      giveUp(entry, error instanceof Error ? error.message : 'error');
    } finally {
      starting.delete(entry.id);
    }
  };

  /** One pass: the list says what the tasks are, and when the body is free the next waiting request is started. */
  const pumpOnce = async (): Promise<void> => {
    sync();
    const { open } = facts();
    if (open.length || !parts.bodyReady()) return;
    const claimed = transact(snapshot => claimFromQueue(snapshot, parts.now()));
    if (claimed?.ok && claimed.entry) await begin(claimed.entry);
  };

  /** Runs passes until nothing asked for another. Resolves when the pass that is running (and any asked meanwhile) ended. */
  const pump = (): Promise<void> => {
    if (pumping) {
      again = true;
      return pumping;
    }
    pumping = (async () => {
      try {
        do {
          again = false;
          await pumpOnce();
        } while (again);
      } catch (error) {
        parts.log(`Shannon Minecraft queue pump failed code=${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`);
      } finally { pumping = null; }
    })();
    return pumping;
  };

  const operate = async (request: MinecraftQueueRequest, context: QueueContext): Promise<QueueOutcome> => {
    // What happened to the tasks since the last pass comes first (a stop from outside must not undo what this word turns on). Not while a
    // task is being made: it is not on the list yet and would be taken for one made from outside.
    if (!starting.size) sync();
    const at = parts.now();
    const id = request.id?.trim() || null;
    let before: QueueSnapshot = store.read(parts.scopeKey);
    const changed = transact(snapshot => {
      before = snapshot;
      return applied(request, context, snapshot, { at, id, newId: newId() });
    })!;
    logChange(request.op, before, changed);
    if (!changed.ok) return { ok: false, code: changed.code, entry: null };
    await settleStops(changed, context.stopReason);
    const entry = changed.entry;
    // A pass already under way (a slow start) is asked to go round again, not waited for: an answer never waits on another request's start.
    const fresh = !pumping;
    const going = pump();
    if (fresh) await going;
    const duplicate = changed.duplicate === true;
    const waitingForBody = request.op === 'add' && !parts.bodyReady();
    const now = entry ? store.read(parts.scopeKey).entries.find(item => item.id === entry.id) ?? entry : null;
    return { ok: true, code: 'ok', entry: now, ...(duplicate ? { duplicate } : {}), ...(waitingForBody ? { waiting: 'body' as const } : {}) };
  };

  const view = (): MinecraftQueueView => {
    const snapshot = store.read(parts.scopeKey);
    return queueView(snapshot, snapshot.rev);
  };

  return {
    operate,
    pump,
    view,
    /** For a reader that may have the list already (`?since=`). */
    read(since?: number): MinecraftQueueRead {
      const snapshot = store.read(parts.scopeKey);
      return since !== undefined && since === snapshot.rev ? { rev: snapshot.rev, unchanged: true } : queueView(snapshot, snapshot.rev);
    },
    snapshot: (): QueueSnapshot & { rev: number } => store.read(parts.scopeKey),
    /** The entry an id, 「#3」 or 「3」 names. */
    locate: (target: string): QueueRecord | null => locateQueueEntry(store.read(parts.scopeKey), target),
    /** The entry that runs, if any. */
    current: (): QueueRecord | null => store.read(parts.scopeKey).entries.find(entry => entry.state === 'running') ?? null,
    /** The lines of `[依頼の列]` for her turn. */
    promptLines: (): string[] => queuePromptLines(store.read(parts.scopeKey)),
    /** Called from the one-second wake: a pass that never throws and never overlaps itself. */
    tick(): void { void pump(); },
    /** What to call after a task was put back to work, so that the runtime looks at it now. */
    useWake(fn: () => void): void { wake = fn; },
    limits: MINECRAFT_QUEUE_LIMITS,
  };
}

export type MinecraftQueue = ReturnType<typeof fcaMinecraftQueue>;
