import type { MinecraftPlanAnswer, MinecraftPlanCode, MinecraftPlanOp } from '../contracts/minecraftPlanOpContract.js';
import { ownerNodeChange, ownerPlanOf, putOwnerNodeOp } from '../surfaces/minecraft/minecraftPlanOp.js';
import type { MinecraftQueue } from './fcaMinecraftQueue.js';

/**
 * The owner's hand on one node of a request's plan, the one way in for the mod's button, her voice and the game chat (`applyQueueIntent`). The
 * request (the one the list names, else the one that runs) is found on the list; its node is found in the plan the step of that task holds; the
 * change is put for the task's next read of the plan, and the acts that serve the node are cut now (`surfaces/minecraft/minecraftPlanOp.ts`).
 * `wake` tells the task, when the words came with a turn of his (the mod's button has none): it decides again at once.
 */
let waker: ((taskId: string, text: string, context: { requestId?: string | null; experienceId?: string | null; observedAt?: string | null }) => void) | null = null;
/** Set once by the wiring that has the runtime. */
export function configurePlanOpWake(wake: typeof waker): void { waker = wake; }

const refusal = (code: MinecraftPlanCode, detail?: string): MinecraftPlanAnswer => ({ ok: false, code, ...(detail ? { detail } : {}) });

export async function answerPlanOp(queue: MinecraftQueue, request: { op: MinecraftPlanOp; node: string; task?: string | undefined },
  context: { requestId?: string | null; experienceId?: string | null; observedAt?: string | null; log?(line: string): void }): Promise<MinecraftPlanAnswer> {
  const target = request.task?.trim() || null;
  const entry = target ? queue.locate(target) : queue.current();
  const taskId = entry?.taskId ?? (target && !entry ? target : null);
  if (!taskId) return refusal('no_task');
  const plan = ownerPlanOf(taskId);
  if (!plan) return refusal('no_plan');
  const change = ownerNodeChange(plan.tree(), request.node, request.op);
  if (!change.ok) return refusal(change.problem, change.detail);
  putOwnerNodeOp(taskId, { node: change.node.id, title: change.node.title, op: request.op });
  let cut = '';
  if (change.cut.size) {
    try { cut = await plan.cut(change.cut); } catch (error) { cut = `cut failed ${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`; }
  }
  context.log?.(`Shannon Minecraft owner node op task=${taskId} node=${change.node.id} op=${request.op} cut=${cut ? 'yes' : 'none'}`);
  if (waker && context.experienceId) {
    try { waker(taskId, `ゲーム内の本人の操作（計画の節）: ${change.note}`, context); } catch { /* the plan takes the change at its next read anyway */ }
  }
  return { ok: true, code: 'ok', node: change.node };
}
