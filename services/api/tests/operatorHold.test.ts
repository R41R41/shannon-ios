import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { operatorEnvelope } from '../src/infra/ops/operatorCli.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import type { OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { driftWords, incidentOfResult } from '../src/wiring/minecraftIncidentHold.js';
import { withIncident } from '../src/wiring/minecraftLlmcWiring.js';

/**
 * 2026-10-28 (owner: 「黒箱・現場の保存・止めて直す実走（保留と再開、世界を止める、台で再現→直す→その場で確かめる）」): an operator's request may ask to be
 * held on a heavy failure (`--hold-on-failure`); the body says so in the act's receipt, the task is held (audited, stopped: no decision, no model,
 * no time counted), and `resume` goes on with the failed act sent again first.
 */
const at = '2026-10-28T00:00:00.000Z';
const TASK = '11111111-2222-4333-8444-555555555555';
const envelope = (op: string, args: Record<string, unknown> = {}) => ({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op, args });
const task = (id: string, phase: TaskView['phase']): TaskView => ({ id, phase, goal: 'エンドラを討伐して' } as unknown as TaskView);

function service() {
  const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
  const tasks = new Map<string, TaskView>();
  const activity: OperatorActivity[] = [], stopped: string[] = [], resumed: string[] = [], unfrozen: string[] = [];
  let clock = at;
  const requests = {
    body: () => 'minecraft:world', open: () => [], get: (id: string) => tasks.get(id) ?? null,
    admit: () => { tasks.set(TASK, task(TASK, 'ready')); return { ok: true as const, task: tasks.get(TASK)!, bodyId: 'minecraft:world' }; },
    stop: async (id: string) => { stopped.push(id); tasks.set(id, task(id, 'stopped')); return [tasks.get(id)!]; },
    resume: (id: string) => { resumed.push(id); tasks.set(id, task(id, 'ready')); return tasks.get(id)!; },
    position: () => [7.5, 100, 0.5] as [number, number, number],
    unfreeze: async (incident: string, command: string) => { unfrozen.push(`${incident}/${command}`); return 'completed'; },
    wake: () => undefined,
  } as unknown as OperatorMinecraftRequests & { wake(): void };
  const parts: OperatorMinecraftParts = {
    scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => clock, audit, lifecycle: null, requests,
    actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false,
    activity: (_at, entry) => activity.push(entry), note: () => undefined,
  };
  return { operator: createOperatorMinecraft(parts), audit, tasks, activity, stopped, resumed, unfrozen,
    advance: (minutes: number) => { clock = new Date(Date.parse(clock) + minutes * 60_000).toISOString(); }, now: () => clock };
}
const incident = { id: '20261028T000000-act-ab12', why: 'go_stuck', frozen: true, freeze: 'The game is frozen', command: 'command-q115',
  start: [0.5, 100, 0.5] as [number, number, number], end: [3.21, 100, 0.5] as [number, number, number] };

describe('the request and the resume, as the operator writes them', () => {
  it('reads --hold-on-failure and resume', () => {
    expect(parseOperatorEnvelope(envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }))).toMatchObject({ ok: true,
      input: { command: 'request', holdOnFailure: true } });
    expect(parseOperatorEnvelope(envelope('request', { goal: 'x', holdOnFailure: 'yes' }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope(envelope('resume', { latest: true }))).toMatchObject({ ok: true, input: { command: 'resume', taskId: null } });
    expect(parseOperatorEnvelope(envelope('resume', { taskId: TASK }))).toMatchObject({ ok: true, input: { command: 'resume', taskId: TASK } });
    expect(operatorEnvelope(['minecraft', 'request', '--operator', 'ops', '--hold-on-failure', 'エンドラを討伐して'], {}))
      .toMatchObject({ op: 'request', args: { goal: 'エンドラを討伐して', holdOnFailure: true } });
    expect(operatorEnvelope(['minecraft', 'resume', '--operator', 'ops', '--latest'], {})).toMatchObject({ op: 'resume', args: { latest: true } });
    expect(() => operatorEnvelope(['minecraft', 'request', '--operator', 'ops', '--hold-on-failure=no', 'x'], {})).toThrow();
  });
});

describe('the hold and the resume', () => {
  it('holds a request that asked for it (audited, stopped), counts no held time, refuses a new request, and resumes it', async () => {
    const s = service();
    const reply = await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', maxMinutes: 45, holdOnFailure: true }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', taskId: TASK });
    expect(s.audit.holdOnFailure(TASK)).toBe(true);
    s.tasks.set(TASK, task(TASK, 'executing'));
    s.advance(20);
    expect(await s.operator.hold(TASK, incident)).toBe(true);
    expect(await s.operator.hold(TASK, incident)).toBe(false);
    expect(s.stopped).toEqual([TASK]);
    const held = s.audit.heldOf(TASK)!;
    expect(JSON.parse(held.detail!)).toMatchObject({ incident: incident.id, why: 'go_stuck', frozen: true, command: 'command-q115', start: [0.5, 100, 0.5], end: [3.21, 100, 0.5] });
    // The status (through the API) says where the body is now against where the held act began.
    const status = await s.operator.handle(envelope('held'));
    expect(status.body).toMatchObject({ code: 'held', held: [{ taskId: TASK, position: '保留した act の始まり (0.5,100,0.5)・保留した時 (3.2,100,0.5)・今 (7.5,100,0.5)（始まりから 7 m）' }] });
    expect(s.activity.at(-1)).toMatchObject({ tool: 'operator.minecraft.hold', reasonCode: 'operator_hold' });
    // A new request waits for the hold's resume or cancel.
    expect((await s.operator.handle(envelope('request', { goal: 'もう一つ' }))).body).toMatchObject({ outcome: 'refused', code: 'minecraft_busy' });
    // Two hours held: the time limit does not count them.
    s.advance(120);
    expect(s.audit.heldMs(TASK, s.now())).toBe(120 * 60_000);
    s.operator.tick();
    expect(s.stopped).toEqual([TASK]);
    const resumed = await s.operator.handle(envelope('resume', { latest: true }));
    expect(resumed.body).toMatchObject({ outcome: 'accepted', code: 'resumed', taskId: TASK, position: expect.stringContaining('（始まりから 7 m）') });
    expect(s.resumed).toEqual([TASK]);
    expect(s.audit.heldOf(TASK)).toBeNull();
    expect(s.audit.resumePending(TASK)?.sequence).toBe(held.sequence);
    s.operator.resumeChecked(TASK, '再開の確かめ: 同じ act を出し直した → 成功');
    expect(s.audit.resumePending(TASK)).toBeNull();
    // 20 minutes ran, 120 were held: at 46 minutes of running (25 more) the 45-minute limit stops it, not before.
    s.tasks.set(TASK, task(TASK, 'executing'));
    s.advance(24); s.operator.tick();
    expect(s.stopped).toEqual([TASK]);
    s.advance(2); s.operator.tick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(s.stopped).toEqual([TASK, TASK]);
  });

  it('does not hold a request that did not ask, and a resume of a task not held is refused', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して' }));
    expect(await s.operator.hold(TASK, incident)).toBe(false);
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'refused', code: 'not_held' });
  });

  it('ends a hold on cancel (the task was stopped already)', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(TASK, task(TASK, 'executing'));
    await s.operator.hold(TASK, incident);
    expect((await s.operator.handle(envelope('cancel', { latest: true }))).body).toMatchObject({ outcome: 'refused' });
    expect((await s.operator.handle(envelope('cancel', { taskId: TASK }))).body).toMatchObject({ outcome: 'accepted', code: 'stopped' });
    // The world the hold stopped moves again: a release naming the hold, of the held act's lease and session.
    expect(s.unfrozen).toEqual([`${incident.id}/command-q115`]);
    expect(s.audit.recent('owner', 5).find(row => row.command === 'cancel' && row.event === 'stopped')?.detail).toContain('unfreeze=completed');
    expect(s.audit.heldOf(TASK)).toBeNull();
    expect(s.audit.heldTasks('owner')).toEqual([]);
  });
});

describe('run 44, hold 1: a world the body could not stop', () => {
  it('is not held: the request goes on, nothing waits for a resume, and the audit and the activity say why', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(TASK, task(TASK, 'executing'));
    s.operator.notHeld(TASK, { ...incident, notHeld: 'others_present:Rai1241' });
    expect(s.stopped).toEqual([]);
    expect(s.audit.heldOf(TASK)).toBeNull();
    expect(s.audit.heldTasks('owner')).toEqual([]);
    const row = s.audit.recent('owner', 5).find(entry => entry.command === 'hold_skipped')!;
    expect(row).toMatchObject({ event: 'settled', code: 'not_held', taskId: TASK });
    expect(JSON.parse(row.detail!)).toMatchObject({ incident: incident.id, why: 'go_stuck', freeze: 'others_present:Rai1241', command: 'command-q115' });
    expect(s.activity.at(-1)).toMatchObject({ tool: 'operator.minecraft.hold', reasonCode: 'operator_hold_skipped' });
    expect((await s.operator.handle(envelope('resume', { taskId: TASK }))).body).toMatchObject({ outcome: 'refused', code: 'not_held' });
    // A request that did not ask to be held writes nothing.
    const other = service();
    await other.operator.handle(envelope('request', { goal: 'エンドラを討伐して' }));
    other.operator.notHeld(TASK, { ...incident, notHeld: 'others_present:Rai1241' });
    expect(other.audit.recent('owner', 5).some(entry => entry.command === 'hold_skipped')).toBe(false);
    expect(incidentOfResult(JSON.stringify({ incident: { id: 'x3', heavy: true, why: 'go_stuck', held: false, frozen: false, freeze: 'others_present:Rai1241',
      notHeld: 'others_present:Rai1241' } }))).toMatchObject({ held: false, notHeld: 'others_present:Rai1241' });
  });
});

describe('the step\'s side', () => {
  it('reads the incident of a receipt, and puts the hold or the resume in the command\'s context', () => {
    const result = JSON.stringify({ v: 1, ok: false, lines: [], incident: { id: 'x1', heavy: true, why: 'go_stuck', held: true, frozen: false, freeze: 'others_present:Rai1241' } });
    expect(incidentOfResult(result)).toEqual({ id: 'x1', heavy: true, why: 'go_stuck', held: true, frozen: false, freeze: 'others_present:Rai1241' });
    expect(incidentOfResult('{"v":1,"ok":true}')).toBeNull();
    expect(incidentOfResult(JSON.stringify({ incident: { id: 'x2', start: [1, 2, 3], end: [4, 2, 3] } }))).toMatchObject({ start: [1, 2, 3], end: [4, 2, 3] });
    expect(driftWords([1, 2, 3], null)).toBe('保留した act の始まり (1,2,3)・今 不明（体が見えない）');
    expect(driftWords(null, [1, 2, 3])).toBe('保留した act の始まりの位置は記録に無い');
    expect(incidentOfResult('not json')).toBeNull();
    const context = { scopeKey: 'owner', taskId: TASK } as never;
    expect(withIncident(context, false, null)).toBe(context);
    expect(withIncident(context, true, null)).toMatchObject({ incident: { hold: true } });
    expect(withIncident(context, true, 'x1')).toMatchObject({ incident: { hold: true, resume: 'x1' } });
  });
});
