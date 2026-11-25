import type { MinecraftIntent } from '../surfaces/minecraft/minecraftIntent.js';
import type { MinecraftQueueAnswer, MinecraftQueueRequest } from '../contracts/minecraftQueueContract.js';
import { queueEnded, type QueueRecord } from '../surfaces/minecraft/minecraftRequestQueue.js';
import type { MinecraftQueue, QueueContext, QueueOutcome } from './fcaMinecraftQueue.js';
import { answerPlanOp } from './fcaMinecraftPlanOp.js';
import type { MinecraftPlanOp } from '../contracts/minecraftPlanOpContract.js';

/** Why her words about the list were not carried out: fixed reasons with fixed words (`MINECRAFT_INTENT_REFUSALS`, `VOICE_MINECRAFT_REFUSALS`). */
export type QueueIntentRefusal = 'nothing_running' | 'no_such_request' | 'queue_full' | 'no_such_node' | 'node_unchanged';
export type QueueIntentOutcome =
  | { delivered: true; as: 'task' | 'queue' | 'stop'; entry: QueueRecord | null }
  | { delivered: false; reason: QueueIntentRefusal };

const refused = (reason: QueueIntentRefusal): QueueIntentOutcome => ({ delivered: false, reason });

const delivered = (outcome: QueueOutcome, as: 'task' | 'queue' | 'stop'): QueueIntentOutcome => (outcome.ok
  ? { delivered: true, as, entry: outcome.entry }
  : refused(outcome.code === 'queue_full' ? 'queue_full' : 'no_such_request'));

/** `move`: where a request goes, as the entry it goes before (null: the end). `next` is straight after the one running. */
function anchor(queue: MinecraftQueue, target: QueueRecord, placement: string): string | null {
  if (placement === 'end') return null;
  const others = queue.snapshot().entries.filter(entry => !queueEnded(entry.state) && entry.id !== target.id).sort((a, b) => a.pos - b.pos);
  return others[others.some(entry => entry.state === 'running') ? 1 : 0]?.id ?? null;
}

async function move(queue: MinecraftQueue, intent: MinecraftIntent, context: QueueContext): Promise<QueueIntentOutcome> {
  const target = queue.locate(intent.target ?? '');
  if (!target) return refused('no_such_request');
  if (intent.placement === 'now') return delivered(await queue.operate({ op: 'start', id: target.id }, context), 'queue');
  const before = anchor(queue, target, intent.placement || 'next');
  return delivered(await queue.operate({ op: 'move', id: target.id, before }, context), 'queue');
}

async function add(queue: MinecraftQueue, intent: MinecraftIntent, context: QueueContext): Promise<QueueIntentOutcome> {
  const outcome = await queue.operate({ op: 'add', goal: intent.goal, ...(intent.placement ? { placement: intent.placement } : {}) }, context);
  if (outcome.duplicate && outcome.entry && outcome.entry.experienceId !== (context.experienceId ?? null)) throw new Error('FCA_QUEUE_REQUEST_CONFLICT');
  return delivered(outcome, 'task');
}

/**
 * `skip`, and `hold` / `resume` that name a node: the node of the plan of the request she names (the one running when she names none), the request
 * going on (`fcaMinecraftPlanOp.ts`). A node or a request not found, and a node that is already so, are refused with their own words.
 */
async function nodeOp(queue: MinecraftQueue, intent: MinecraftIntent, context: QueueContext): Promise<QueueIntentOutcome> {
  const target = intent.target?.trim() || null;
  if (!target && !queue.current()) return refused('nothing_running');
  const entry = target ? queue.locate(target) : queue.current();
  if (!entry) return refused('no_such_request');
  const answer = await answerPlanOp(queue, { op: intent.kind as MinecraftPlanOp, node: intent.node ?? '', task: entry.taskId ?? entry.id }, context);
  if (answer.ok) return { delivered: true, as: 'queue', entry };
  return refused(answer.code === 'no_task' || answer.code === 'no_plan' ? 'nothing_running'
    : answer.code === 'unchanged' || answer.code === 'not_blocked' || answer.code === 'node_done' ? 'node_unchanged' : 'no_such_node');
}

/** `cancel` and `hold`: the request she names, or the one running when she names none (refused when none is). */
async function one(queue: MinecraftQueue, intent: MinecraftIntent, context: QueueContext): Promise<QueueIntentOutcome> {
  const target = intent.target?.trim() || null;
  if (!target && !queue.current()) return refused('nothing_running');
  const entry = target ? queue.locate(target) : queue.current();
  if (!entry) return refused('no_such_request');
  return delivered(await queue.operate({ op: intent.kind === 'cancel' ? 'cancel' : 'hold', id: entry.id }, context), 'queue');
}

/** `resume`: the request she names, or the whole list when she names none. */
async function resume(queue: MinecraftQueue, intent: MinecraftIntent, context: QueueContext): Promise<QueueIntentOutcome> {
  const target = intent.target?.trim() || null;
  const entry = target ? queue.locate(target) : null;
  if (target && !entry) return refused('no_such_request');
  return delivered(await queue.operate({ op: 'resume', ...(entry ? { id: entry.id } : {}) }, context), 'queue');
}

/**
 * Her words about the list of requests as a change of it: `task` adds, `stop` stops the list, `cancel` / `hold` / `resume` act on the
 * request she names (the one running when she names none; `resume` with none is the whole list), `move` moves one. `message` is not
 * here (it goes to the task that runs). A repeat of a request she already added is the same request; the same id with another turn
 * as its source is a conflict, as an in-game request's always was.
 */
export async function applyQueueIntent(queue: MinecraftQueue, intent: MinecraftIntent, context: QueueContext): Promise<QueueIntentOutcome> {
  if (intent.node && (intent.kind === 'skip' || intent.kind === 'hold' || intent.kind === 'resume')) return nodeOp(queue, intent, context);
  switch (intent.kind) {
    case 'task': return add(queue, intent, context);
    case 'stop': return delivered(await queue.operate({ op: 'stop' }, context), 'stop');
    case 'cancel':
    case 'hold': return one(queue, intent, context);
    case 'resume': return resume(queue, intent, context);
    case 'move': return move(queue, intent, context);
    default: return refused('no_such_request');
  }
}

/** The request of a game device's POST (the mod's list screen) answered with the list as it is then. */
export async function answerQueueRequest(queue: MinecraftQueue, request: MinecraftQueueRequest, context: QueueContext): Promise<MinecraftQueueAnswer> {
  const entry = request.id ? queue.locate(request.id) : null;
  const outcome = await queue.operate(entry ? { ...request, id: entry.id } : request, context);
  return { ok: outcome.ok, code: outcome.code, queue: queue.view(), ...(outcome.entry ? { entryId: outcome.entry.id } : {}),
    ...(outcome.waiting ? { waiting: outcome.waiting } : {}) };
}
