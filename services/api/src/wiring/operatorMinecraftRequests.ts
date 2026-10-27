import type { TaskRecord, TaskRuntime, TaskSpec, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { OPERATOR_TITLE_PREFIX, operatorRequestContext } from '../contracts/operatorContract.js';

/** Phases after which a task no longer holds the body or its Minecraft work. */
const FINISHED: readonly TaskView['phase'][] = ['stopped', 'completed', 'failed'];

/**
 * A task made by `admit` below: its title carries the operator's prefix and it has the Minecraft request's criteria (closed facts of the
 * record, as `admit` writes them). Its result is not sent to the root's inbox (`TaskRuntimeStoreOptions.reportsToParent`).
 */
export function operatorRequestTask(task: Pick<TaskRecord, 'title' | 'completionCriteria' | 'origin'>, criteria: string): boolean {
  return task.origin === 'owner_request' && task.title.startsWith(OPERATOR_TITLE_PREFIX) && task.completionCriteria === criteria;
}

export type OperatorAdmission = { ok: true; task: TaskView; bodyId: string } | { ok: false; code: 'body_unavailable' | 'minecraft_busy' };

/**
 * The common-task side of an operator's Minecraft request (owner decision 2026-10-14). It makes the same task as
 * `minecraft.request` and the in-game intent (a `generic` child of origin `owner_request`, the request criteria and working note, bound to the one
 * connected body), under the root because no conversation turn is its source, inside the same write lock as the conversation's
 * admission. Who handed it over is in its title and its first inbox line, never in the owner's words.
 */
export function operatorMinecraftRequests(parts: {
  control: MinecraftControl; runtime: TaskRuntime; ownerScope: string; stop(id: string, reason: string): Promise<TaskView[]>;
  atomic<T>(work: () => T): T; bound(): TaskView[];
  spec(goal: string): Required<Pick<TaskSpec, 'title' | 'goal' | 'completionCriteria' | 'context'>>;
}) {
  const open = () => parts.bound().filter(task => !FINISHED.includes(task.phase));
  const body = () => {
    const bodies = parts.control.available();
    return bodies.length === 1 ? bodies[0]! : null;
  };
  return {
    body,
    /** Minecraft-bound tasks still running, stopping or unknown: any of them refuses a new operator request. */
    open,
    get: (id: string) => parts.runtime.get(parts.ownerScope, id),
    admit(input: { operationId: string; goal: string; operator: string }): OperatorAdmission {
      return parts.atomic(() => {
        const bodyId = body();
        if (!bodyId) return { ok: false, code: 'body_unavailable' };
        if (open().length) return { ok: false, code: 'minecraft_busy' };
        const base = parts.spec(input.goal);
        const root = parts.runtime.ensureRoot(parts.ownerScope);
        const task = parts.runtime.createChild(parts.ownerScope, root.id, { ...base, origin: 'owner_request',
          title: `${OPERATOR_TITLE_PREFIX}${input.goal}`.slice(0, 120), context: `${operatorRequestContext(input.operator)}\n${base.context}` },
        `operator:${input.operationId}`, { sources: 'asking' }); // no conversation asked: nothing of the root's (2026-10-15)
        if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
        return { ok: true, task: parts.runtime.get(parts.ownerScope, task.id) ?? task, bodyId };
      });
    },
    /** The owner's stop path (`minecraft.cancel`): the runtime's stop, which waits for the body's stop acknowledgement. */
    stop: (id: string, reason: string) => parts.stop(id, reason),
    /** A stopped task queued again (the runtime's explicit resume, as the owner's resume route does): a held request's `resume`. */
    resume: (id: string) => parts.runtime.resume(parts.ownerScope, id),
    /** The body's feet now (the newest frame), or null: a held request's status and resume say how far it is from where the act began. */
    position: (): [number, number, number] | null => {
      const id = body();
      const at = (id ? parts.control.observe(id)?.state.world as { position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined : undefined)?.position;
      return at && [at.x, at.y, at.z].every(n => typeof n === 'number') ? [at.x as number, at.y as number, at.z as number] : null;
    },
    /**
     * A held request cancelled (2026-10-28): a release of its held act's lease and session, naming the hold (`context.incident.cancel`): the body ends
     * the hold and moves the world again (`/tick unfreeze`). The receipt's outcome, or why none came.
     */
    unfreeze: async (incident: string, commandId: string): Promise<string> => {
      const sent = parts.control.store.command(commandId);
      if (!sent) return 'no_command';
      const id = `unfreeze:${incident}:${Date.now()}`.slice(0, 150);
      const context = { ...sent.context, incident: { cancel: incident } };
      try {
        const receipt = await parts.control.command({ id, context, lease: sent.lease, kind: 'release', stop: { context, requestId: id, reason: 'cancel' }, milliseconds: 5_000 });
        return receipt.outcome;
      } catch (error) { return error instanceof Error ? error.message : 'unknown'; }
    },
  };
}
export type OperatorMinecraftRequests = ReturnType<typeof operatorMinecraftRequests>;
