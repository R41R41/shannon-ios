import type { BodyPlanView } from '../../src/contracts/bodyControlContract.js';
import type { TaskStep } from '../../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaBodyLifecycle } from '../../src/mind/action/fca/fcaPorts.js';
import type { MinecraftControl } from '../../src/surfaces/minecraft/minecraftControl.js';
import { createLlmcQueue, type LlmcQueue } from '../../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { minecraftTaskContext } from '../../src/wiring/fcaMinecraftTools.js';

/**
 * The task queue of a step for the tests that run the real control and tools (design minebot-task-queue): the queue the mode's step parts make, and a
 * body lifecycle that is nothing but the queue's port (so the runner stretches), with the news that had no tool result to carry them kept in `news`.
 */
export function queueFor(control: MinecraftControl, step: TaskStep, plan?: BodyPlanView, bodyId = 'minecraft:world'): LlmcQueue {
  return createLlmcQueue({ control, taskId: step.taskId, lease: step.lease, bodyId: () => bodyId,
    context: () => minecraftTaskContext(step, bodyId, step.id, plan), observe: () => control.observe(bodyId), log: () => undefined });
}
export function queueBody(queue: LlmcQueue, news: string[] = [], stop?: { control: MinecraftControl; step: TaskStep }): FcaBodyLifecycle {
  return { start(signal) { signal.addEventListener('abort', () => { queue.cancelAll(); if (stop) stop.control.cancelTask(stop.step.taskId); }, { once: true }); }, revision: () => 0, context: () => { queue.mark(); return { revision: 0, observation: null }; }, async guard() { return true; },
    guardFor: async () => !queue.stale(), toolSignal: (_name, parent) => parent, async close() { await queue.settled(); queue.stop(); }, queue, noteNews: text => { news.push(text); } };
}
