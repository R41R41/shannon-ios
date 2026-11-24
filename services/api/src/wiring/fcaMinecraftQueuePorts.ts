import type { DatabaseSync } from 'node:sqlite';
import type { TaskRuntime, TaskSpec, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { SpokenWords } from '../mind/action/taskRuntime/taskExternalEventPorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type { MinecraftQueueOrigin } from '../contracts/minecraftQueueContract.js';
import type { QueueRecord } from '../surfaces/minecraft/minecraftRequestQueue.js';
import { LLMC_STALE_FRAME_MS } from '../surfaces/minecraft/minecraftLlmcLive.js';
import type { QueueParts } from './fcaMinecraftQueue.js';

/** How many of the newest tasks are looked at for ones still working: a task that works is always among the most recently changed. */
const RECENT_TASKS = 60;
/** The origins whose goal is his own typed words (the game's chat, the mod's list); the others were written by her or by the voice. */
const TYPED_BY_HIM: ReadonlySet<MinecraftQueueOrigin> = new Set<MinecraftQueueOrigin>(['chat', 'mod']);
/** The words that tell the task where its request came from (the first line of its inbox). */
const ASKED_BY: Readonly<Partial<Record<MinecraftQueueOrigin, string>>> = Object.freeze({
  chat: 'ゲーム内の本人の依頼', voice: 'Discordの通話での本人の依頼',
});
/** What the person said with a voice request (`SpokenWords`), read from the entry; none for an entry without it or with a value that cannot be read. */
function spokenWordsOf(stored: string | null | undefined): SpokenWords | undefined {
  if (!stored) return undefined;
  try {
    const said = JSON.parse(stored) as Partial<SpokenWords>;
    return said && typeof said.speakerName === 'string' && typeof said.speakerWords === 'string' ? said as SpokenWords : undefined;
  } catch {
    return undefined;
  }
}
/** The line for the entry: a voice request names who asked (a guest marked as one), the others say where it came from. */
const askedBy = (entry: QueueRecord): string => (entry.askedBy ? `Discordの通話での${entry.askedBy}の依頼` : ASKED_BY[entry.origin] ?? '本人の依頼');

/**
 * What the list of requests needs of the common task tree and the body (`fcaMinecraftQueue.ts`), made from the same parts as the
 * request tools: how a request becomes a task (the very path an in-game request always took, `newTask` and `spec`), whether a task
 * still holds the body, and the frame of the body.
 */
export function queueTaskPorts(parts: {
  db: DatabaseSync; control: MinecraftControl; runtime: TaskRuntime; ownerScope: string; atomic<T>(work: () => T): T;
  stop(id: string, reason: string): Promise<TaskView[]>; log(line: string): void;
  spec(goal: string): TaskSpec;
  /** The origin of a task that is a request of his (the operator's or the owner's, `admittedMinecraftRequest`), else null. */
  requestOrigin(task: TaskView): MinecraftQueueOrigin | null;
  /** The task for his words (his dragon words through the operator's socket when that takes them), else `own`. */
  newTask(message: string, goal: string, bodyId: string, own: () => string | Promise<string>): Promise<string>;
}): QueueParts {
  const body = (): string | null => {
    const bodies = parts.control.available();
    return bodies.length === 1 ? bodies[0]! : null;
  };
  const finished = (task: TaskView) => ['stopped', 'completed', 'failed'].includes(task.phase);
  const create = (entry: QueueRecord, bodyId: string, key: string): string => parts.atomic(() => {
    const task = parts.runtime.createChild(parts.ownerScope, parts.runtime.ensureRoot(parts.ownerScope).id, parts.spec(entry.goal), key,
      { sources: 'asking' });
    const said = spokenWordsOf(entry.said);
    // A request from no turn (the mod's list) has no source to observe: it is a task of the root's own, as the operator's.
    if (entry.experienceId) {
      parts.runtime.observeExternal(parts.ownerScope, task.id, { eventId: key, experienceIds: [entry.experienceId],
        observedAt: entry.observedAt ?? new Date().toISOString(), text: `${askedBy(entry)}: ${entry.goal}`, ...(said ? { said } : {}) });
    }
    if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
    return task.id;
  });
  return {
    db: parts.db,
    scopeKey: parts.ownerScope,
    atomic: parts.atomic,
    phase: id => parts.runtime.get(parts.ownerScope, id)?.phase ?? null,
    open: () => parts.runtime.list(parts.ownerScope, { limit: RECENT_TASKS, order: 'recent' })
      .filter(task => parts.control.store.body(task.id) && !finished(task))
      .map(task => ({ taskId: task.id, goal: task.goal, phase: task.phase, origin: parts.requestOrigin(task) })),
    bodyReady: () => {
      const id = body();
      return id !== null && !!parts.control.latest(id, LLMC_STALE_FRAME_MS);
    },
    stop: (id, reason) => parts.stop(id, reason),
    resume: id => parts.runtime.resume(parts.ownerScope, id) !== null,
    async start(entry, again) {
      const bodyId = body();
      if (!bodyId) return null;
      const key = again ? `queue:${entry.id}:${entry.updatedAt}` : entry.requestId ?? `queue:${entry.id}`;
      // Only words he typed himself may open the dragon run (its budget): a goal she or the voice wrote is a task like any other.
      return parts.newTask(TYPED_BY_HIM.has(entry.origin) ? entry.goal : '', entry.goal, bodyId, () => create(entry, bodyId, key));
    },
    now: () => new Date().toISOString(),
    log: parts.log,
  };
}
