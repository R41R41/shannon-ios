import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { createOperatorMinecraft, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import type { OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * Amendment A-14 (run 46): a task the body's recovery paused (`fca_stopped`: its step was lost to a Spot stop of the VM) has no hold row; the operator's `resume` (with --latest or the id)
 * still continues it. The world is moved by a release naming `recovered:<task>`; the runtime's resume queues the task, and the recovery pays what it is owed before its first step.
 * A task neither held nor paused by the recovery is refused as before.
 */
const TASK = '11111111-2222-4333-8444-555555555555';
const at = '2026-10-29T00:00:00.000Z';
const view = (id: string, over: Partial<TaskView>): TaskView => ({ id, phase: 'executing', status: 'running', pauseReason: null, goal: 'エンドラを討伐して', updatedAt: at, ...over } as unknown as TaskView);
function service() {
  const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
  const tasks = new Map<string, TaskView>(), resumed: string[] = [], released: string[] = [], activity: string[] = [];
  const body: { answer: { ok: boolean; words: string } } = { answer: { ok: true, words: 'completed done=true hold=- unfreeze=ok' } };
  const requests = {
    body: () => 'minecraft:world', open: () => [], get: (id: string) => tasks.get(id) ?? null,
    admit: () => { tasks.set(TASK, view(TASK, {})); return { ok: true as const, task: tasks.get(TASK)!, bodyId: 'minecraft:world' }; },
    stop: async (id: string) => { tasks.set(id, view(id, { phase: 'stopped' })); return [tasks.get(id)!]; },
    resume: (id: string) => { resumed.push(id); tasks.set(id, view(id, { phase: 'ready', status: 'queued' })); return tasks.get(id)!; },
    incident: async (op: string, incident: string) => { released.push(`${op}:${incident}`); return body.answer; },
    bodyHold: () => null, wake: () => undefined, resolveHolds: () => [],
  } as unknown as OperatorMinecraftRequests & { wake(): void };
  const parts: OperatorMinecraftParts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => at, audit, lifecycle: null, requests,
    actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false, activity: (_at, entry) => activity.push(entry.summary), note: () => undefined };
  return { operator: createOperatorMinecraft(parts), tasks, resumed, released, body, activity };
}
const envelope = (op: string, args: Record<string, unknown> = {}) => ({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op, args });
const pausedByRecovery = (s: ReturnType<typeof service>) => s.tasks.set(TASK, view(TASK, { phase: 'stopped', status: 'paused', pauseReason: 'fca_stopped' }));

describe('A-14: resume of a task the body\'s recovery paused (no hold row)', () => {
  it('--latest finds it, the body is told to move the world, the runtime resumes it', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    pausedByRecovery(s);
    const answer = await s.operator.handle(envelope('resume', { latest: true, skipReplay: true }));
    expect(answer.body).toMatchObject({ outcome: 'accepted', code: 'resumed', taskId: TASK });
    expect(s.released).toEqual([`resume:recovered:${TASK.slice(0, 12)}`]);
    expect(s.resumed).toEqual([TASK]);
    expect(String((answer.body as { message?: string }).message ?? '')).toContain('先に届けて');
    expect(s.activity.join('\n')).toContain('取り戻しで止まっていた');
  });

  it('the id names it too; a body that does not answer done leaves it paused (nothing is resumed)', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して' }));
    pausedByRecovery(s);
    s.body.answer = { ok: false, words: 'failed' };
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'refused' });
    expect(s.resumed).toEqual([]);
    s.body.answer = { ok: true, words: 'completed done=true' };
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(s.resumed).toEqual([TASK]);
  });

  it('a task neither held nor paused by the recovery is refused as before (not_held), and so is --latest with none', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して' }));
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'refused', code: 'not_held' });
    expect((await s.operator.handle(envelope('resume', { latest: true }))).body).toMatchObject({ outcome: 'refused', code: 'not_held' });
    // a task paused for another reason (the owner's pause, a failure) is not the recovery's
    s.tasks.set(TASK, view(TASK, { phase: 'stopped', status: 'paused', pauseReason: 'fca_unknown' }));
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'refused', code: 'not_held' });
    expect(s.resumed).toEqual([]);
  });
});

describe('A-14 (run 46 q46): an operation the API closed on the body\'s release proof is not told as cancelled', () => {
  it('the notice names it no_receipt and says the listed operations may or may not have taken effect', async () => {
    const { lostOperations } = await import('../src/wiring/fcaBodyRecoveryNotice.js');
    const { BODY_RECOVERY_NOTICE } = await import('../src/wiring/fcaBodyRecoveryPolicy.js');
    const closed = { id: 'skill:q46', kind: 'skill', skill: 'act', phase: 'settled', outcome: 'cancelled', released: true, closedByApi: true };
    expect(lostOperations([closed])).toEqual([{ tool: 'mc.act', outcome: 'no_receipt' }]);
    expect(lostOperations([{ ...closed, closedByApi: false, outcome: 'completed' }])).toEqual([{ tool: 'mc.act', outcome: 'completed' }]);
    expect(BODY_RECOVERY_NOTICE).toContain('may or may not have taken effect');
    expect(BODY_RECOVERY_NOTICE).toContain('check what is true now');
  });
});
