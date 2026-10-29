import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { forgetStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import { headTake, takeContext, takeSession, TAKE_NOTE_CHARS, TAKE_NOTES } from '../src/wiring/minecraftHeadTake.js';
import { feet, headIncidentKind, incidentOfResult, setIncidentHoldPort, takeEnd, takeOfResult } from '../src/wiring/minecraftIncidentHold.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import { bodyIncident, operatorMinecraftRequests, type OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import { benchC, PRODUCED_REV, RUN_BODY, until, type BenchC } from './helpers/benchC.js';

/**
 * Amendment A-12 (the body's type, produced at body revision 100a80f68157): the head asks the body to hold what it found. A release carries `context.incident.take = { id, why, notes }`
 * (notes: the last rows of the decision record); the body freezes the world, saves the scene, writes its box with the notes and holds under the head's id; its receipt says what it did
 * (`IncidentTakeResult`). The head's own box and the operator's reads (the audit line, the activity record, `held`) tell what the body answered: that it held, that it could not stop the
 * world (`notHeld`: the hold goes on, the world does not stand still), that it keeps another hold, or that it said nothing. `resume` ends the body's hold with a release naming the head's id,
 * and the resumed task's acts go in the new step's session (a release closes the session it names).
 *
 * Part 1 reads the body's own produced answers; part 2 the context of the take; part 3 goes the real way on the bench C (the stand-in body keeps a hold, closes sessions, refuses as the body
 * does) with the real operator service and the real `incident` of the operator's requests, down to the next act after the resume.
 */
const PRODUCED_FILE = new URL('./fixtures/continue/produced/measure--head-take.json', import.meta.url);
const produced = JSON.parse(readFileSync(PRODUCED_FILE, 'utf8')) as { bodyRevision: string; output: Record<string, any> };

afterEach(() => { forgetStalls(); setIncidentHoldPort(null); });

// ---- 1. the body's answers ----------------------------------------------------------------------------------------------------------------------------
describe('the head reads what the body produced for a take (fixtures/continue/produced/measure--head-take.json)', () => {
  it('is the body\'s file of the revision the amendment was written for', () => {
    expect(produced.bodyRevision).toBe(PRODUCED_REV);
    expect(Object.keys(produced.output).sort()).toEqual(['actTake', 'resume', 'resumeNothing', 'take']);
  });

  it('the release\'s answer to a take: it holds, the world stopped, the box and the scene are on the body\'s side', () => {
    const answer = takeOfResult(JSON.stringify({ incident: produced.output.take.incident }))!;
    expect(answer).toMatchObject({ id: 'head:node_stalled:lab:1793258577284', done: true, hold: 'head:node_stalled:lab:1793258577284', held: true, frozen: true, freeze: 'The game is frozen', again: false });
    expect(answer.box).toMatch(/blackbox\/continue-lab-task\/head_node_stalled_lab_1793258577284\.json\.gz$/u);
    expect(answer.scene).toMatch(/scenes\/head_node_stalled_lab_1793258577284$/u);
    expect(takeEnd(answer)).toBe('held');
    expect(headIncidentKind(answer.id)).toBe('node_stalled');
  });

  it('the resume\'s and the nothing-held resume\'s answers are not takes, and are read as releases of a hold (done, no hold left)', () => {
    for (const name of ['resume', 'resumeNothing'] as const) {
      const incident = name === 'resume' ? produced.output.resume.incident : produced.output.resumeNothing;
      expect(takeOfResult(JSON.stringify({ incident }))).toBeNull();
      expect(bodyIncident(JSON.stringify({ incident }))).toMatchObject({ done: true, hold: null });
      expect(bodyIncident(JSON.stringify({ incident }))!.unfreeze).toContain('running normally');
    }
  });

  it('the act that carried a take and was held reads as a heavy failure\'s hold (its own `incident` fields)', () => {
    const note = incidentOfResult(JSON.stringify({ held: '保留中', incident: produced.output.actTake }))!;
    expect(note).toMatchObject({ id: 'head:wait_loop:lab:1793258585062', heavy: true, held: true, frozen: true, freeze: 'The game is frozen', end: [0.5, 100, 0.5] });
    expect(headIncidentKind(note.id)).toBe('wait_loop');
  });

  it('a take answered by a body that holds another hold, or that could not stop the world, or that cannot do it, is read as each', () => {
    const base = { op: 'take', id: 'head:wait_loop:3:abc' };
    const other = takeOfResult(JSON.stringify({ incident: { ...base, done: false, hold: 'own-1', unfreeze: null } }))!;
    expect(other).toMatchObject({ done: false, hold: 'own-1', held: true });
    expect(takeEnd(other)).toBe('other_hold');
    const notHeld = takeOfResult(JSON.stringify({ incident: { ...base, done: true, hold: null, held: false, frozen: false, notHeld: 'players are on the server', box: '/b/x.json.gz', scene: '/b/s' } }))!;
    expect(notHeld).toMatchObject({ held: false, frozen: false, notHeld: 'players are on the server', box: '/b/x.json.gz' });
    expect(takeEnd(notHeld)).toBe('not_held');
    const again = takeOfResult(JSON.stringify({ incident: { ...base, done: true, hold: base.id, held: true, frozen: true, again: true } }))!;
    expect(again.again).toBe(true);
    expect(takeEnd(again)).toBe('held');
    expect(takeEnd(takeOfResult(JSON.stringify({ incident: { ...base, done: false, hold: null, unfreeze: 'no_incidents' } }))!)).toBe('failed');
    for (const text of [undefined, '', 'not json', '{}', '{"incident":{"op":"resume","id":"x","done":true}}', '{"incident":{"op":"take","id":"x"}}']) expect(takeOfResult(text)).toBeNull();
    expect(feet([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

// ---- 2. the take's context ----------------------------------------------------------------------------------------------------------------------------
describe('the release that carries a take', () => {
  const step = { id: 'step-9', taskId: 'task-1', scopeKey: 'owner', revision: 3, lease: { id: 'lease-1', generation: 2, holder: 'h' },
    snapshot: { checkpoint: null, task: { id: 'task-1', goal: 'エンドラを倒して', completionCriteria: 'c', createdAt: '2026-10-29T00:00:00.000Z' } } } as never;

  it('is sent in a session of its own, not the step\'s, from the incident\'s id', () => {
    const context = takeContext(step, RUN_BODY, { id: 'head:wait_loop:3:abc', why: 'wait だけの act が 3 回続いた', notes: ['{"ev":"a"}'] });
    expect(context.sessionId).toBe(takeSession('head:wait_loop:3:abc'));
    expect(context.sessionId).not.toBe('step-9');
    expect(context.sessionId).toMatch(/^take:[0-9a-f]{16}$/u);
    expect(takeSession('head:wait_loop:3:abc')).toBe(context.sessionId);
    expect(takeSession('head:wait_loop:3:abd')).not.toBe(context.sessionId);
    expect(context).toMatchObject({ taskId: 'task-1', bodyId: RUN_BODY, generation: 2, incident: { take: { id: 'head:wait_loop:3:abc', why: 'wait だけの act が 3 回続いた', notes: ['{"ev":"a"}'] } } });
  });

  it('carries the last 20 notes of at most 400 characters, an id of at most 150, and no notes key when there are none', () => {
    const notes = Array.from({ length: 30 }, (_, index) => `${index}:${'x'.repeat(500)}`);
    const take = takeContext(step, RUN_BODY, { id: 'i'.repeat(200), why: 'w'.repeat(500), notes }).incident!.take!;
    expect(TAKE_NOTES).toBe(20);
    expect(TAKE_NOTE_CHARS).toBe(400);
    expect(take.notes).toHaveLength(20);
    expect(take.notes![0]!.startsWith('10:')).toBe(true);
    expect(take.notes!.every(note => note.length <= 400)).toBe(true);
    expect(take.id).toHaveLength(150);
    expect(take.why).toHaveLength(300);
    expect(takeContext(step, RUN_BODY, { id: 'a', why: 'b', notes: [] }).incident!.take).not.toHaveProperty('notes');
  });

  it('never throws: a body away, or a receipt that carries no answer (a body before the take), is told as not sent', async () => {
    const control = (command: () => Promise<unknown>) => ({ command } as never);
    const parts = { step, bodyId: RUN_BODY, id: 'head:wait_loop:3:abc', why: 'w', notes: [] };
    expect(await headTake({ control: control(async () => { throw new Error('FCA_BODY_UNAVAILABLE'); }), ...parts })).toEqual({ sent: false, why: 'FCA_BODY_UNAVAILABLE' });
    const silent = await headTake({ control: control(async () => ({ outcome: 'completed', result: undefined })), ...parts });
    expect(silent).toMatchObject({ sent: false });
    expect((silent as { why: string }).why).toContain('答えなかった');
    const asked: unknown[] = [];
    const answered = await headTake({ control: control(async () => ({ outcome: 'completed', result: JSON.stringify({ incident: { op: 'take', id: 'head:wait_loop:3:abc', done: true, hold: 'head:wait_loop:3:abc', held: true, frozen: true } }) })), ...parts }, undefined);
    expect(answered).toMatchObject({ sent: true, take: { held: true } });
    void asked;
  });
});

// ---- 3. the real way ------------------------------------------------------------------------------------------------------------------------------------
describe('take, held, resume, and the next act in a new session, on the bench C', () => {
  const benches: BenchC[] = [];
  afterEach(() => { for (const bench of benches.splice(0)) bench.close(); });
  let counter = 0;
  const make = (scene: string) => { const bench = benchC({ scene, run: `11111111-2222-4333-8444-${String(++counter).padStart(12, '0')}` }); benches.push(bench); return bench; };
  const envelope = (op: string, args: Record<string, unknown> = {}) => ({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op, args });
  const waitHands = [{ do: 'wait' as const, seconds: 1 }];
  const waited = { hands: [{ do: 'wait', goal: 'done' as const, line: 'wait 1 秒' }] };

  /** The real operator service over the bench's control, and the hold port as the server wires it (`operatorServerWiring.ts`): all but the stop of the task, which a test plays. */
  async function setup(bench: BenchC) {
    const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
    const tasks = new Map<string, TaskView>(), activity: OperatorActivity[] = [], stopped: string[] = [], resumed: string[] = [];
    const view = (phase: TaskView['phase']) => ({ id: bench.run, phase, goal: 'エンドラを討伐して' } as unknown as TaskView);
    type Real = ReturnType<typeof operatorMinecraftRequests>;
    let real: Real | null = null;
    const requests = { body: () => RUN_BODY, open: () => [], get: (id: string) => tasks.get(id) ?? null,
      admit: () => { tasks.set(bench.run, view('ready')); return { ok: true as const, task: tasks.get(bench.run)!, bodyId: RUN_BODY }; },
      stop: async (id: string) => { stopped.push(id); tasks.set(id, view('stopped')); return [tasks.get(id)!]; },
      resume: (id: string) => { resumed.push(id); tasks.set(id, view('ready')); return tasks.get(id)!; }, wake: () => undefined,
      incident: (...args: Parameters<Real['incident']>) => real!.incident(...args), bodyHold: () => real?.bodyHold() ?? null, position: () => real?.position() ?? null,
      heldActWords: (...args: Parameters<Real['heldActWords']>) => real!.heldActWords(...args), resolveHolds: (...args: Parameters<Real['resolveHolds']>) => real!.resolveHolds(...args),
    } as unknown as OperatorMinecraftRequests & { wake(): void };
    const parts: OperatorMinecraftParts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => new Date().toISOString(), audit, lifecycle: null, requests,
      actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false, activity: (_at, entry) => activity.push(entry), note: () => undefined };
    const operator = createOperatorMinecraft(parts);
    setIncidentHoldPort({
      holdRequested: id => audit.holdOnFailure(id), hold: (id, incident) => operator.hold(id, incident), notHeld: () => undefined, bodyHeld: async () => false,
      resumePending: id => {
        const row = audit.resumePending(id);
        if (!row) return null;
        const detail = JSON.parse(row.detail ?? '{}') as { incident?: string; command?: string; start?: unknown };
        return { incident: String(detail.incident ?? ''), command: String(detail.command ?? ''), start: feet(detail.start) };
      },
      resumeChecked: (id, line) => operator.resumeChecked(id, line), heldMs: id => operator.heldMs(id), skipNote: id => operator.skipNote(id), heldAgainNote: id => operator.heldAgainNote(id),
    });
    expect((await operator.handle(envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }))).body).toMatchObject({ outcome: 'accepted', taskId: bench.run });
    tasks.set(bench.run, view('executing'));
    await bench.begin();
    real = operatorMinecraftRequests({ control: bench.control(), runtime: {} as never, ownerScope: 'owner', stop: async () => [], atomic: work => work(), bound: () => [], spec: () => ({}) as never });
    return { audit, operator, activity, stopped, resumed, tasks, bodyHold: () => real!.bodyHold() };
  }
  async function runAct(bench: BenchC, mark: string) {
    await bench.decide('次', () => bench.add(waitHands));
    expect(await until(() => bench.body.hasBeenHanded(mark))).toBe(true);
    const id = bench.body.idOf(mark);
    bench.body.begin(id);
    bench.body.finish(id, waited);
    await bench.settle(90);
  }
  const heldDetail = (s: Awaited<ReturnType<typeof setup>>, run: string) => JSON.parse(s.audit.heldOf(run)!.detail!) as Record<string, any>;

  it('a wait loop: the body is asked, holds and freezes, the box has the notes; the audit and the activity say so; resume ends the body\'s hold, and the new step\'s act is accepted', async () => {
    const bench = make('held');
    const s = await setup(bench);
    for (const mark of ['q1', 'q2', 'q3']) await runAct(bench, mark);
    expect(await until(() => s.audit.heldOf(bench.run) !== null)).toBe(true);

    // The body was asked once, in a session of its own, with the head's id and the last rows of the record as notes.
    expect(bench.body.takes).toHaveLength(1);
    const take = bench.body.takes[0]!;
    expect(take.id).toMatch(/^head:wait_loop:3:/u);
    expect(take.session).toBe(takeSession(take.id));
    expect(take.session).not.toBe(bench.head.stepId);
    expect(take.why).toContain('wait だけの act が 3 回続いた');
    expect(take.notes!.length).toBeGreaterThan(0);
    expect(take.notes!.length).toBeLessThanOrEqual(20);
    // Rows of the record, each cut at 400 characters (a long row is cut, so it is not always whole JSON).
    const events = take.notes!.map(note => /^\{"ev":"([a-z_]+)"/u.exec(note)?.[1]);
    expect(events.every(Boolean)).toBe(true);
    expect(events).toEqual(expect.arrayContaining(['sent', 'request']));
    expect(take.notes!.every(note => note.length <= 400)).toBe(true);
    expect(bench.body.incidentHold).toMatchObject({ id: take.id, task: bench.run, frozen: true });
    expect(bench.body.frozenNow()).toBe(true);

    // The audit line and the activity say what the body did.
    const detail = heldDetail(s, bench.run);
    expect(detail).toMatchObject({ incident: take.id, frozen: true, take: 'held', command: '' });
    expect(detail.box).toBe(`/body/blackbox/${bench.run}/${take.id.replace(/[^A-Za-z0-9._-]/gu, '_')}.json.gz`);
    expect(s.audit.heldOf(bench.run)!.detail!.length).toBeLessThanOrEqual(600);
    const entry = s.activity.find(item => item.reasonCode === 'operator_hold_head')!;
    expect(entry.summary).toContain('体も同じ id で保留し、世界を止め、黒箱と現場を取った');
    expect(entry.detail).toContain('take=held');
    expect(entry.detail).toContain(detail.box);

    // The head's own box has the body's whole answer beside the rows.
    const box = JSON.parse(readFileSync(join(bench.records, detail.record ?? `${bench.run}/head-holds/${take.id.replace(/[^A-Za-z0-9._-]/gu, '_')}.json`), 'utf8'));
    expect(box).toMatchObject({ kind: 'wait_loop', id: take.id, detail: { take: 'held', body: { held: true, frozen: true, done: true, hold: take.id, box: detail.box } } });
    expect(box.detail.body.scene).toContain('/body/scenes/');
    expect(box.tail.length).toBeGreaterThan(0);

    // `held` says the body holds the same hold (its frame shows it); a task held is not sent acts that the body would take: the body refuses them as held.
    await bench.spin(4);
    const status = (await s.operator.handle(envelope('held'))).body as { held: Array<{ body: string }> };
    expect(status.held[0]!.body).toContain('体も同じ保留');
    expect(status.held[0]!.body).not.toContain('食い違い');
    await bench.decide('保留中の act', () => bench.add(waitHands));
    expect(await until(() => bench.body.refused.length > 0)).toBe(true);
    expect(bench.body.refused[0]).toMatchObject({ because: 'held' });

    // The resume: a release naming the head's id ends the body's hold and unfreezes the world; the task is queued again.
    const reply = await s.operator.handle(envelope('resume', { taskId: bench.run }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(bench.body.incidentHold).toBeNull();
    expect(bench.body.frozenNow()).toBe(false);
    const release = bench.body.releases.find(item => (item.incident as { op?: string } | null)?.op === 'resume')!;
    expect(release.incident).toMatchObject({ op: 'resume', id: take.id, done: true, hold: null });
    expect(s.resumed).toEqual([bench.run]);
    const oldSession = release.session;
    expect(oldSession).toBe(bench.head.stepId);

    // An act of the old step's session is refused: the release closed it. The resumed step is another step, whose session is its own.
    const refusedBefore = bench.body.refused.length;
    await bench.decide('古いセッション', () => bench.add(waitHands));
    expect(await until(() => bench.body.refused.length > refusedBefore)).toBe(true);
    expect(bench.body.refused.at(-1)).toMatchObject({ because: 'closed_session', session: oldSession });
    const second = bench.startHead();
    expect(second.stepId).not.toBe(oldSession);
    const body = bench.lifecycle();
    body.start(new AbortController().signal);
    expect(await until(() => s.audit.recent('owner', 20).some(row => row.command === 'resume' && row.code === 'replayed'))).toBe(true);
    const checked = s.audit.recent('owner', 20).find(row => row.command === 'resume' && row.code === 'replayed')!;
    expect(checked.detail).toContain('頭が見つけた詰まり（wait_loop）');
    const handedBefore = bench.body.handed.length;
    await bench.decide('再開の後', () => bench.add(waitHands));
    expect(await until(() => bench.body.handed.length > handedBefore)).toBe(true);
    const next = bench.body.handed.slice(handedBefore).find(command => command.kind === 'skill' && command.skill === 'act')!;
    expect(next).toBeDefined();
    expect(next.context.sessionId).toBe(second.stepId);
    expect(next.context.sessionId).not.toBe(oldSession);
    await bench.settle(80);
    expect(bench.body.refused.at(-1)).toMatchObject({ because: 'closed_session' }); // still the old one: the new session\'s act was not refused
    expect(bench.body.refused.filter(item => item.command === next.id)).toEqual([]);
    expect(bench.body.entries.get(next.id)?.state).toBe('waiting');
  }, 60_000);

  it('a world the body could not stop: the body took the box and the scene only, the hold goes on, and both the audit and the activity say the world is moving', async () => {
    const bench = make('notheld');
    bench.body.canFreeze = false;
    const s = await setup(bench);
    for (const mark of ['q1', 'q2', 'q3']) await runAct(bench, mark);
    expect(await until(() => s.audit.heldOf(bench.run) !== null)).toBe(true);
    expect(bench.body.incidentHold).toBeNull();
    const detail = heldDetail(s, bench.run);
    expect(detail).toMatchObject({ take: 'not_held', frozen: false, notHeld: 'players are on the server' });
    expect(detail.box).toContain('/body/blackbox/');
    const entry = s.activity.find(item => item.reasonCode === 'operator_hold_head')!;
    expect(entry.summary).toContain('世界を止められず保留していない');
    expect(entry.summary).toContain('players are on the server');
    expect(entry.summary).toContain('世界は動いている');
    // The head holds all the same: the task is stopped, no new act goes (the stop path), and the status says what is true of the world.
    expect(s.stopped).toEqual([bench.run]);
    await bench.spin(3);
    const status = (await s.operator.handle(envelope('held'))).body as { held: Array<{ body: string }> };
    expect(status.held[0]!.body).toContain('世界を止められず保留していない');
    expect(status.held[0]!.body).not.toContain('食い違い');
    // And it resumes: a body that holds nothing answers done.
    expect((await s.operator.handle(envelope('resume', { taskId: bench.run }))).body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
  }, 60_000);

  it('a body that keeps a hold of its own: the take changes nothing, the hold it keeps is told, and the resume ends both', async () => {
    const bench = make('otherhold');
    const s = await setup(bench);
    await runAct(bench, 'q1'); // the task has sent an act (a release names the lease of the last one)
    bench.body.incidentHold = { id: 'own-go_stuck-1', task: bench.run, why: 'go_stuck', frozen: true };
    await bench.spin(3);
    const asked = await headTake({ control: bench.control(), step: bench.head.step as never, bodyId: RUN_BODY, id: 'head:same_spot_stops:10_64_10:zz', why: '同じ所で止まった', notes: ['{"ev":"x"}'] });
    expect(asked).toMatchObject({ sent: true, take: { done: false, hold: 'own-go_stuck-1' } });
    expect(takeEnd((asked as { take: Parameters<typeof takeEnd>[0] }).take)).toBe('other_hold');
    expect(bench.body.incidentHold!.id).toBe('own-go_stuck-1');
    // The head holds all the same, naming the hold the body keeps.
    expect(await s.operator.hold(bench.run, { id: 'head:same_spot_stops:10_64_10:zz', why: '同じ所で止まった', frozen: false, command: '', take: 'other_hold', bodyHold: 'own-go_stuck-1' })).toBe(true);
    expect(heldDetail(s, bench.run)).toMatchObject({ take: 'other_hold', bodyHold: 'own-go_stuck-1', frozen: false });
    expect(s.activity.find(item => item.reasonCode === 'operator_hold_head')!.summary).toContain('別の保留 own-go_stuck-1');
    await bench.spin(3);
    const status = (await s.operator.handle(envelope('held'))).body as { held: Array<{ body: string }> };
    expect(status.held[0]!.body).toContain('別の保留 own-go_stuck-1');
    expect(status.held[0]!.body).not.toContain('食い違い');
    expect((await s.operator.handle(envelope('resume', { taskId: bench.run }))).body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    expect(bench.body.incidentHold).toBeNull();
    expect(bench.body.releases.filter(item => (item.incident as { op?: string } | null)?.op === 'resume').map(item => (item.incident as { id: string }).id)).toEqual(['head:same_spot_stops:10_64_10:zz', 'own-go_stuck-1']);
  }, 60_000);

  it('a body that does not answer the take (before incidents): the head holds all the same and says the body was not reached', async () => {
    const bench = make('silent');
    bench.body.incidentsSupported = false;
    const s = await setup(bench);
    for (const mark of ['q1', 'q2', 'q3']) await runAct(bench, mark);
    expect(await until(() => s.audit.heldOf(bench.run) !== null)).toBe(true);
    const detail = heldDetail(s, bench.run);
    expect(detail).toMatchObject({ take: 'failed', frozen: false });
    expect(detail).not.toHaveProperty('box');
    expect(s.activity.find(item => item.reasonCode === 'operator_hold_head')!.summary).toContain('体へ頼めなかった');
    expect(bench.body.incidentHold).toBeNull();
    expect(bench.body.takes).toHaveLength(0);
  }, 60_000);

  it('the hold\'s detail stays whole JSON within 600 characters with long paths, dropping the head\'s box path before the body\'s', async () => {
    const bench = make('long');
    const s = await setup(bench);
    expect(await s.operator.hold(bench.run, { id: 'head:node_stalled:p1.1.1:mvsgm3nm', why: 'w'.repeat(200), frozen: true, command: '', take: 'held', freeze: 'f'.repeat(120),
      box: `/home/azureuser/.cache/minebot/blackbox/${bench.run}/${'b'.repeat(120)}.json.gz`, scene: `/home/azureuser/.cache/minebot/scenes/${'s'.repeat(150)}`,
      record: `${bench.run}/head-holds/${'r'.repeat(100)}.json` })).toBe(true);
    const text = s.audit.heldOf(bench.run)!.detail!;
    expect(text.length).toBeLessThanOrEqual(600);
    const detail = JSON.parse(text);
    expect(detail).toMatchObject({ incident: 'head:node_stalled:p1.1.1:mvsgm3nm', take: 'held' });
    expect(detail).not.toHaveProperty('record');
    expect(detail.box).toContain('/blackbox/');
  }, 30_000);
});
