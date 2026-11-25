import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  MINECRAFT_QUEUE_LIMITS, type MinecraftQueueCode, type MinecraftQueueOrigin, type MinecraftQueueRead, type MinecraftQueueRequest,
  type MinecraftQueueView,
} from '../contracts/minecraftQueueContract.js';
import {
  addToQueue, cancelInQueue, claimFromQueue, deleteFromQueue, holdInQueue, linkQueueTask, locateQueueEntry, markNewWorld, moveInQueue, queuePromptLines,
  queueEnded, queueView, resumeInQueue, startQueue, stopQueue, syncQueue, unclaimInQueue, type QueueChange, type QueueRecord, type QueueSnapshot,
} from '../surfaces/minecraft/minecraftRequestQueue.js';
import { ownerPlanPromptLines } from '../surfaces/minecraft/minecraftPlanOp.js';
import { MinecraftRequestQueueStore } from '../surfaces/minecraft/store/minecraftRequestQueueStore.js';

/** How long an operation's answer waits for the body to acknowledge a stop (the stop itself goes on). */
export const QUEUE_STOP_WAIT_MS = 3_000;
/** A start that failed waits again (the next pass tries it); at the third failure the entry ends as failed. */
export const QUEUE_START_ATTEMPTS = 3;
/** How long an operation's answer waits for the pass its change started (a slow start goes on; the list shows it). */
export const QUEUE_ANSWER_WAIT_MS = 2_000;

/** What the queue needs of the task runtime and the body (`fcaMinecraftRequests.ts` gives it). */
export interface QueueParts {
  db: DatabaseSync;
  scopeKey: string;
  /** Same SQLite connection and write lock as the task authority. */
  atomic<T>(work: () => T): T;
  /** The phase of a task; null when there is no such task. */
  phase(taskId: string): string | null;
  /** Tasks bound to the body that are not stopped, completed or failed (a stopping one too), with the origin when it is a request of his. */
  open(): Array<{ taskId: string; goal: string; phase: string; origin: MinecraftQueueOrigin | null }>;
  /** A current frame of one connected body is there: something can be started. */
  bodyReady(): boolean;
  /** Stops the task (the runtime's stop: it waits for the body's acknowledgement). */
  stop(taskId: string, reason: string): Promise<unknown>;
  /** Puts a stopped task back to work; false when it could not be. */
  resume(taskId: string): boolean;
  /**
   * Makes the task for an entry and binds it to the body; its id, or null when it could not be made. `again`: a new task for an entry
   * whose stopped one could not be put back to work.
   */
  start(entry: QueueRecord, again?: boolean): Promise<string | null>;
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
  /** Who asked (a voice channel's speaker), kept on the entry. */
  askedBy?: string | null;
}

/** One operation of a request on the list as a pure change. */
function applied(request: MinecraftQueueRequest, context: QueueContext, snapshot: QueueSnapshot,
  make: { at: string; id: string | null; newId: string }): QueueChange {
  const { at, id } = make;
  switch (request.op) {
    case 'add': return addToQueue(snapshot, { id: make.newId, goal: request.goal ?? '', placement: request.placement ?? 'end', origin: context.origin,
      requestId: request.requestId ?? context.requestId, experienceId: context.experienceId, observedAt: context.observedAt, askedBy: context.askedBy }, at);
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

  /** `detail`: what the journal also keeps of the word (an add's placement, a start's target), so that a swap is seen in it. */
  const logChange = (op: string, before: QueueSnapshot, after: QueueChange, detail = ''): void => {
    if (!after.ok) {
      parts.log(`Shannon Minecraft queue op=${op} code=${after.code}`);
      return;
    }
    const entry = after.entry;
    const was = entry ? before.entries.find(item => item.id === entry.id)?.state ?? '-' : '-';
    const name = entry ? `#${entry.seq}` : '-';
    parts.log(`Shannon Minecraft queue op=${op} entry=${name} state=${was}→${entry?.state ?? '-'} origin=${entry?.origin ?? '-'} code=ok${detail}`);
  };

  const LIVE = ['ready', 'executing', 'waiting', 'stopping', 'unknown'];
  const facts = () => {
    const open = [...parts.open()];
    const byTask = new Map(open.map(task => [task.taskId, task]));
    const snapshot = store.read(parts.scopeKey);
    const known = new Set(snapshot.entries.map(entry => entry.taskId).filter(Boolean));
    const phases = new Map<string, string | null>();
    for (const entry of snapshot.entries) {
      if (!entry.taskId) continue;
      const seen = byTask.get(entry.taskId);
      if (queueEnded(entry.state)) {
        // An ended entry matters only while its task still works (a stop that did not get through).
        if (seen) phases.set(entry.taskId, seen.phase);
        continue;
      }
      const phase = seen?.phase ?? parts.phase(entry.taskId);
      phases.set(entry.taskId, phase);
      // The list's own tasks are always counted, even when they fell out of the runtime's newest tasks (`open` looks at the newest ones only).
      if (!seen && phase && LIVE.includes(phase)) open.push({ taskId: entry.taskId, goal: entry.goal, phase, origin: entry.origin });
    }
    // A task that is stopping is on its way out (its entry may just have been removed): it is not taken for a request made from outside.
    const unowned = open.filter(task => task.origin && !known.has(task.taskId) && task.phase !== 'stopping')
      .map(task => ({ taskId: task.taskId, goal: task.goal, origin: task.origin! }));
    return { open, facts: { phases, unowned, starting, newId } };
  };

  /** Makes the list say what the tasks are; stops it asked for are carried out. Gives the tasks that are open, as read for it. */
  const sync = () => {
    const read = facts();
    const done = transact(snapshot => syncQueue(snapshot, read.facts, parts.now()));
    if (done?.ok) {
      if (done.stops.length) void settleStops(done);
      if (done.entry === null) parts.log('Shannon Minecraft queue op=sync code=ok');
    }
    return read.open;
  };

  const giveUp = (entry: QueueRecord, reason: string): void => {
    const count = (failures.get(entry.id) ?? 0) + 1;
    failures.set(entry.id, count);
    transact(snapshot => unclaimInQueue(snapshot, entry.id, reason, count >= QUEUE_START_ATTEMPTS, parts.now()));
    parts.log(`Shannon Minecraft queue op=start entry=#${entry.seq} code=failed reason=${reason.slice(0, 40)} attempt=${count}`);
  };

  /**
   * The task of an entry that has run before, put back to work. Already working (put back from outside): it is that one. Not
   * settled yet (a stop still going): 'wait'. Stopped but refused by the runtime: a new task for the request, since a request is
   * not lost for a task that cannot be resumed (a refusal is not a failed start).
   */
  const takeUp = async (entry: QueueRecord): Promise<string | null> => {
    const phase = parts.phase(entry.taskId!);
    if (phase === 'stopping' || phase === 'unknown') return 'wait';
    if (phase !== 'stopped') return entry.taskId;
    if (parts.resume(entry.taskId!)) return entry.taskId;
    parts.log(`Shannon Minecraft queue op=start entry=#${entry.seq} resume refused, a new task`);
    return parts.start(entry, true);
  };

  const begin = async (entry: QueueRecord): Promise<void> => {
    starting.add(entry.id);
    try {
      const taskId = entry.taskId ? await takeUp(entry) : await parts.start(entry);
      if (taskId === 'wait') {
        transact(snapshot => unclaimInQueue(snapshot, entry.id, 'task_not_settled', false, parts.now()));
        return;
      }
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
    const open = sync();
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
    logChange(request.op, before, changed, request.op === 'add' ? ` placement=${request.placement ?? 'end'}` : '');
    if (!changed.ok) return { ok: false, code: changed.code, entry: null };
    await settleStops(changed, context.stopReason);
    const entry = changed.entry;
    // A pass already under way (a slow start) is asked to go round again, not waited for: an answer never waits on another request's start.
    const fresh = !pumping;
    const going = pump();
    if (fresh) await Promise.race([going, new Promise<void>(resolve => setTimeout(resolve, QUEUE_ANSWER_WAIT_MS).unref())]);
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
    promptLines: (): string[] => queuePromptLines(store.read(parts.scopeKey), parts.now()),
    /** `[依頼の列]` and, under it, the nodes of the plan of the request that runs (what the owner's words about a node are read against). */
    promptLinesWithPlan(): string[] {
      const lines = queuePromptLines(store.read(parts.scopeKey), parts.now());
      const entry = store.read(parts.scopeKey).entries.find(item => item.state === 'running');
      return lines.length && entry?.taskId ? [...lines, ...ownerPlanPromptLines(entry.taskId, entry.seq)] : lines;
    },
    /**
     * The world was made new (a start that kept the old one and began another): the held and stopped requests that ran before it become
     * requests of the world before (`queueStaleness`). Never throws: it is a note on the list, not a change of what runs.
     */
    worldChanged(at?: string): void {
      try {
        transact(snapshot => markNewWorld(snapshot, at ?? parts.now()));
        parts.log('Shannon Minecraft queue op=world_changed code=ok');
      } catch (error) { parts.log(`Shannon Minecraft queue op=world_changed code=failed reason=${error instanceof Error ? error.message.slice(0, 40) : 'error'}`); }
    },
    /** Called from the one-second wake: a pass that never throws and never overlaps itself. */
    tick(): void { void pump(); },
    /** What to call after a task was put back to work, so that the runtime looks at it now. */
    useWake(fn: () => void): void { wake = fn; },
    limits: MINECRAFT_QUEUE_LIMITS,
  };
}

export type MinecraftQueue = ReturnType<typeof fcaMinecraftQueue>;
