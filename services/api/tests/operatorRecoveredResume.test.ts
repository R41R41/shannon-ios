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
function service(clock = { now: at }) {
  const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
  const tasks = new Map<string, TaskView>(), resumed: string[] = [], released: string[] = [], activity: string[] = [];
  const body: { answer: { ok: boolean; words: string } } = { answer: { ok: true, words: 'completed done=true hold=- unfreeze=ok' } };
  const requests = {
    body: () => 'minecraft:world', open: () => [], get: (id: string) => tasks.get(id) ?? null,
    admit: () => { tasks.set(TASK, view(TASK, {})); return { ok: true as const, task: tasks.get(TASK)!, bodyId: 'minecraft:world' }; },
    stop: async (id: string) => { tasks.set(id, view(id, { phase: 'stopped' })); return [tasks.get(id)!]; },
    resume: (id: string) => { resumed.push(id); tasks.set(id, view(id, { phase: 'ready', status: 'queued' })); return tasks.get(id)!; },
    incident: async (op: string, incident: string) => { released.push(`${op}:${incident}`); return body.answer; },
    bodyHold: () => null, wake: () => undefined, lostActWords: () => 'q46 smelt', resolveHolds: () => [],
  } as unknown as OperatorMinecraftRequests & { wake(): void };
  const parts: OperatorMinecraftParts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => clock.now, audit, lifecycle: null, requests,
    actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false, activity: (_at, entry) => activity.push(entry.summary), note: () => undefined };
  return { operator: createOperatorMinecraft(parts), tasks, resumed, released, body, activity, audit, clock };
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

describe('A-15 (run 46): the resume of a recovery pause sends no old hold act, tells what was lost, and the time the body could not move is not counted against the request', () => {
  const HOLD = { id: 'head:same_spot_stops:186_28_212:mvsktuiz', why: 'same_spot_stops', frozen: false, command: 'skill:a5235a10', start: [0.5, 100, 0.5] as [number, number, number], end: [3.2, 100, 0.5] as [number, number, number] };
  it('1 after a hold closed by --skip-replay, a recovery pause resume leaves no pending resume (nothing to send again)', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(TASK, view(TASK, {}));
    await s.operator.hold(TASK, HOLD);
    s.tasks.set(TASK, view(TASK, { phase: 'stopped' }));
    expect((await s.operator.handle(envelope('resume', { latest: true, skipReplay: true }))).body).toMatchObject({ code: 'resumed' });
    s.operator.resumeChecked(TASK, '出し直さなかった');
    expect(s.audit.resumePending(TASK)).toBeNull();
    pausedByRecovery(s);
    expect((await s.operator.handle(envelope('resume', { latest: true }))).body).toMatchObject({ code: 'resumed', taskId: TASK });
    // the old hold is closed and stays so: no resume is pending, so no step reads it as an act to send again
    expect(s.audit.resumePending(TASK)).toBeNull();
    expect(s.audit.heldOf(TASK)).toBeNull();
  });

  it('2 the first decision is told what the lost step left (once, in the live beside the recovery notice)', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して' }));
    pausedByRecovery(s);
    await s.operator.handle(envelope('resume', { latest: true }));
    const note = s.operator.skipNote(TASK);
    expect(note).toContain('q46 smelt');
    expect(note).toContain('結果は分からない');
    expect(note).toContain('観測で確かめる');
    expect(s.operator.skipNote(TASK)).toBeNull();
  });

  it('3 a pause of the recovery is not counted against the time limit, nor the minutes an operator names; a request the limit stopped goes on when it is inside it after that', async () => {
    const clock = { now: at };
    const s = service(clock);
    const minutes = (n: number) => new Date(Date.parse(at) + n * 60_000).toISOString();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', maxMinutes: 45 }));
    const request = s.audit.requestOf('owner', TASK)!;
    expect(request.deadlineAt).toBe(minutes(45));
    // the recovery paused it at +30; the tick writes the pause at that time
    s.tasks.set(TASK, view(TASK, { phase: 'stopped', status: 'paused', pauseReason: 'fca_stopped', updatedAt: minutes(30), revision: 5 } as never));
    clock.now = minutes(100);
    s.operator.tick();
    expect(s.audit.pausedOpen(TASK)).toBe(true);
    expect(s.audit.heldMs(TASK, minutes(100))).toBe(70 * 60_000);
    // the limit is reached at +45 + 70 = +115, not before: at +100 the task is not stopped by it
    expect(s.audit.hasEvent(TASK, 'time_limit')).toBe(false);
    // the resume closes the pause (70 min) and names 10 more minutes (the VM stopped before the pause)
    await s.operator.handle(envelope('resume', { latest: true, deductMinutes: 10 }));
    expect(s.audit.pausedOpen(TASK)).toBe(false);
    expect(s.audit.heldMs(TASK, minutes(100))).toBe(80 * 60_000);
  });

  it('3b a request the time limit stopped is resumed when the time taken off leaves it inside its limit, and refused when it does not', async () => {
    const clock = { now: at };
    const s = service(clock);
    const minutes = (n: number) => new Date(Date.parse(at) + n * 60_000).toISOString();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', maxMinutes: 45 }));
    const request = s.audit.requestOf('owner', TASK)!;
    s.audit.append({ operationId: 'op-limit', scopeKey: 'owner', at: minutes(46), operator: 'ops.ryo', command: 'request', event: 'time_limit', code: 'time_limit', argsJson: request.argsJson, taskId: TASK });
    s.tasks.set(TASK, view(TASK, { phase: 'stopped', status: 'cancelled' } as never));
    clock.now = minutes(120);
    // nothing taken off: past its limit
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'refused' });
    expect(s.resumed).toEqual([]);
    // 80 minutes the body could not move: 45 + 80 = 125 > 120
    expect((await s.operator.handle(envelope('resume', { taskId: TASK, deductMinutes: 80 }))).body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(s.resumed).toEqual([TASK]);
  });
});

describe('A-15: the CLI and the contract carry --deduct-minutes', () => {
  it('reads --deduct-minutes N as deductMinutes, and refuses a value that is not a whole number of minutes', async () => {
    const { operatorEnvelope } = await import('../src/infra/ops/operatorCli.js');
    const { parseOperatorEnvelope } = await import('../src/contracts/operatorContract.js');
    const made = operatorEnvelope(['minecraft', 'resume', '--operator', 'ops', '--latest', '--skip-replay', '--deduct-minutes', '70'], {});
    expect(made).toMatchObject({ op: 'resume', args: { latest: true, skipReplay: true, deductMinutes: 70 } });
    expect(parseOperatorEnvelope(made)).toMatchObject({ ok: true, input: { command: 'resume', taskId: null, skipReplay: true, deductMinutes: 70 } });
    expect(parseOperatorEnvelope({ ...(made as object), args: { latest: true, deductMinutes: 0 } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope({ ...(made as object), args: { latest: true, deductMinutes: 2000 } })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
