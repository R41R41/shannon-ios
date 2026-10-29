import type { TaskRecord, TaskRuntime, TaskSpec, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { OPERATOR_TITLE_PREFIX, operatorRequestContext } from '../contracts/operatorContract.js';
import { rejectedTaskReport } from './taskRuntimeWiring.js';

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
    /** A-17: a held request the unknown exit failed (its hold row stood open) is stopped again, resumable; null for any other failed task. */
    /** A-20: a request a refused decision failed (the credit ran out) is stopped again, resumable; null for any other failed task. */
    reopenRejected: (id: string, summary: string) => parts.runtime.reopenRejected?.(parts.ownerScope, id, summary, rejectedTaskReport(parts.runtime.get(parts.ownerScope, id)?.title ?? '')) ?? null,
    reopenRetired: (id: string, summary: string) => parts.runtime.reopenRetired?.(parts.ownerScope, id, summary) ?? null,
    /** Continue contract 1: the commands a cleanup left held for this task are resumed or cancelled on the hold axis only (their results are left as they are; nothing is sent). */
    resolveHolds: (id: string, how: 'resume' | 'cancel') => parts.control.resolveHolds(id, how),
    /** The body's feet now (the newest frame), or null: a held request's status and resume say how far it is from where the act began. */
    position: (): [number, number, number] | null => {
      const id = body();
      const at = (id ? parts.control.observe(id)?.state.world as { position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined : undefined)?.position;
      return at && [at.x, at.y, at.z].every(n => typeof n === 'number') ? [at.x as number, at.y as number, at.z as number] : null;
    },
    /**
     * A held request's hold ended on the body (2026-10-28 cancel; run 44 resume): a release of its held act's lease and session, naming the hold
     * (`context.incident.cancel` or `resume`): the body ends the hold and moves the world again (`/tick unfreeze`), and says so in the receipt.
     * `ok` only when the body says it holds nothing of it any more; `words` what came back (or why nothing did).
     */
    incident: async (op: 'resume' | 'cancel', incident: string, commandId: string, taskId: string): Promise<IncidentAnswer> => {
      // The held act's own command, else the task's latest one (a hold taken back from the body's refusal names no act).
      const sent = (commandId ? parts.control.store.command(commandId) : null) ?? parts.control.store.lastOfTask(taskId);
      if (!sent) return { ok: false, words: 'no_command' };
      const id = `${op === 'resume' ? 'unhold' : 'unfreeze'}:${incident}:${Date.now()}`.slice(0, 150);
      const context = { ...sent.context, incident: { [op]: incident } };
      try {
        const receipt = await parts.control.command({ id, context, lease: sent.lease, kind: 'release', stop: { context, requestId: id, reason: 'cancel' }, milliseconds: 8_000 });
        const said = bodyIncident(receipt.result);
        const ok = receipt.outcome === 'completed' && said?.done === true;
        return { ok, words: said ? `${receipt.outcome} done=${said.done} hold=${said.hold ?? '-'} unfreeze=${String(said.unfreeze ?? '-').slice(0, 60)}`
          : `${receipt.outcome} (体が保留について何も言わなかった: 古い体)` };
      } catch (error) { return { ok: false, words: error instanceof Error ? error.message : 'unknown' }; }
    },
    /**
     * Run 45: a held act in words for the next decision when it is not sent again: its item and first hand, and how it ended (the code and the first
     * words in brackets of its stop line). 「保留した act q12（go (159,20,220)）は出し直さなかった。前の結果: search_timeout（…）」.
     */
    heldActWords: (commandId: string, why: string): string => {
      const sent = commandId ? parts.control.store.command(commandId) : null;
      const item = String(sent?.queue?.item ?? '');
      const hand = ((sent?.arguments as { hands?: Array<Record<string, unknown>> } | undefined)?.hands ?? [])[0];
      const to = hand?.to as { x?: unknown; y?: unknown; z?: unknown } | undefined;
      const handWords = hand ? `${String(hand.do ?? '?')}${to && typeof to.x === 'number' ? ` (${to.x},${to.y},${to.z})` : ''}` : '';
      let stop = '';
      try {
        const lines = (JSON.parse(commandId ? parts.control.store.receipt(commandId)?.result ?? '' : '') as { lines?: Array<{ status?: string; line?: string }> }).lines ?? [];
        // Run 47 (hold 3: the decision after a skipped resume sent the same go again): the hand's line as the body wrote it, its fix and hint to the end, not the code alone.
        stop = String(lines.find(entry => entry.status !== 'done' && entry.status !== 'skipped')?.line ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400);
      } catch { stop = ''; }
      return `保留した act${item ? ` ${item}` : ''}${handWords ? `（${handWords}）` : ''}は出し直さなかった。前の結果: ${stop || why}`.slice(0, 600);
    },
    /**
     * Amendment A-15: the act the task's step lost, in words for the first decision after a resume of a task the recovery paused (「q46 の 作業台とかまどを置く…」): its item and first hand.
     */
    lostActWords: (taskId: string): string => {
      // The act the recovery closed (the step the VM stop or the restart lost), not the newest one: an act sent again meanwhile is not the lost one (run 46). The newest is the fallback.
      const sent = parts.control.store.lastClosedOfTask(taskId) ?? parts.control.store.lastOfTask(taskId);
      const item = String(sent?.queue?.item ?? '');
      const hand = ((sent?.arguments as { hands?: Array<Record<string, unknown>> } | undefined)?.hands ?? [])[0];
      return `${item}${hand ? ` ${String(hand.do ?? '')}` : ''}`.trim();
    },
    /** The hold the body says it keeps (its newest frame, `state.incidentHold`, run 44), or null. */
    bodyHold: (): BodyHold | null => {
      const id = body();
      const held = (id ? parts.control.observe(id)?.state as { incidentHold?: unknown } | undefined : undefined)?.incidentHold;
      if (!held || typeof held !== 'object') return null;
      const value = held as Record<string, unknown>;
      return typeof value.id === 'string' && typeof value.task === 'string' ? { id: value.id, task: value.task, why: String(value.why ?? '') } : null;
    },
  };
}
export type OperatorMinecraftRequests = ReturnType<typeof operatorMinecraftRequests>;
export interface IncidentAnswer { ok: boolean; words: string }
export interface BodyHold { id: string; task: string; why: string }
/** What a release naming a hold did, from its receipt's result (`{"incident": {"done", "hold", "unfreeze"}}`), or null. */
export function bodyIncident(result: string | undefined): { done: boolean; hold: string | null; unfreeze: string | null } | null {
  if (!result || !result.startsWith('{')) return null;
  try {
    const value = (JSON.parse(result) as { incident?: Record<string, unknown> }).incident;
    if (!value || typeof value.done !== 'boolean') return null;
    return { done: value.done, hold: typeof value.hold === 'string' ? value.hold : null, unfreeze: typeof value.unfreeze === 'string' ? value.unfreeze : null };
  } catch { return null; }
}
