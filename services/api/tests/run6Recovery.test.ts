import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ACTION_LIMITS } from '@shannon/mind';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { retainedOf } from '../src/mind/action/threads/store/retainedResourceStore.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionResource, leaseOf, type ActionLease } from '../src/contracts/actionThreadContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { BodyTaskContext } from '../src/contracts/bodyControlContract.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid } from '../src/wiring/actionLeaseRules.js';
import { configuredActionResourceProof, configuredRetainedResources, fcaReleaseAcknowledgement, fcaReleaseEvidence,
  minecraftFcaReleaseProof } from '../src/wiring/configuredActionResourceProof.js';
import { BODY_RECHECK_ATTEMPTS, createMinecraftBodyRecheck, type BodyRecheckResult } from '../src/wiring/minecraftBodyRecheckWiring.js';
import { createOperatorLifecycle, setDayReadiness } from '../src/wiring/operatorLifecycleWiring.js';
import type { MinecraftLifecycle } from '../src/surfaces/minecraft/minecraftLifecycle.js';
import type { LifecycleRunner } from '../src/wiring/minecraftLifecycleRunner.js';
import type { MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import { operatorEnvelope, runOperatorCli, type OperatorCliDeps } from '../src/infra/ops/operatorCli.js';
import { parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Minecraft run 6 (2026-10-14): a stop handed over during a 10 s stall of the API was never received, the step's outcome stayed
 * unknown, and the body stayed retained (`res:e84e…`) with no proof that could ever free it. The owner chose 「直しを入れてから自動で
 * 解放」: the body is asked again, and only its own original receipt (stopped, every input released) ends the retained record.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

const TASK = 'bdcaa37b-cee0-4bf1-81f7-c4a8c66a29ab';
const server = { serverId: 'shannon-home', title: 'home', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' };
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [server] }) };
const body = actionResource('minebot', 'minecraft-body');
const BODY_ID = 'minecraft:shannon-home';

/** The production shape of action e6e2083d after run 6: unknown, slot released, the body retained, one stop delivered and never received. */
function stuck() {
  let time = Date.parse('2026-10-14T05:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close());
  migrateAgentTasks(db);
  db.exec('ALTER TABLE agent_tasks ADD COLUMN task_kind TEXT');
  db.prepare(`INSERT INTO agent_tasks (task_id,scope_key,conversation_thread_id,start_idempotency_key,title,goal,status,summary,created_at,updated_at,task_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(TASK, 'owner', 'thread', `start-${TASK}`, 'エンドラ', 'エンドラを討伐してください', 'running', '', now(), now(), 'work');
  const store = new SQLiteActionStore(db, configuredActionResourceProof(values, db), configuredRetainedResources(values));
  const queued = store.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: `fca:${TASK}:2`,
    resources: [actionResource('owner', `fca:${TASK}`)] }, now());
  const lease = leaseOf(store.claim(queued.id, 'runner-885f83db', now())!);
  expect(store.dispatch(lease, now(), [body])).toBe(true);
  const controlStore = new MinecraftControlStore(db);
  const context: BodyTaskContext = { scopeKey: 'owner', taskId: TASK, taskRevision: 2, bodyId: BODY_ID, sessionId: 'b3a70251-6f82-4c7d-ba07-dd271a3d5269:reflex:1',
    generation: lease.generation, goal: 'エンドラを討伐してください', completionCondition: '目的の達成を新しいワールド観測と実行結果から確認する。' };
  const stop: MinecraftControlCommand = { schemaVersion: 1, id: 'stop:4380c0f09e7e71750c99b3dc2acbced8a606014638effb9be6bd494b4c82e033', serverId: 'shannon-home',
    connectionId: 'b94c3b2a-1492-49cf-9830-312c09feb3c9', kind: 'stop', context, lease, deadlineAt: new Date(time + 5000).toISOString(),
    stop: { context, requestId: 'handoff-1', reason: 'handoff' } };
  controlStore.insert(stop, now()); controlStore.deliver(stop.id); controlStore.cancel(stop.id);
  time += ACTION_LIMITS.leaseMs + 1; store.transaction(() => store.sweep(now()));
  time += ACTION_LIMITS.unknownReleaseMs; store.transaction(() => store.sweep(now()));
  const configuration = configuredMinecraftBody(values)!;
  const leases = new ActionLeaseReader(db);
  const known = (attempt: ActionLease, taskId: string) => bodyLeaseAttempt(leases.get(attempt.id), 'owner', attempt, taskId);
  const control = new MinecraftControl(new MinecraftControlStore(db), configuration, { now: Date.now, ownerAlone: () => true, pollMilliseconds: 2,
    cancelWaitMilliseconds: 40, leaseKnown: (attempt, taskId) => bodyLeaseKnown(known(attempt, taskId), body),
    leaseValid: (attempt, taskId) => bodyLeaseValid(known(attempt, taskId), attempt, body, new Date().toISOString()) });
  let sequence = 0;
  const poll = (patch: { receipts?: MinecraftControlReceipt[]; active?: string[] } = {}) => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'shannon-home', connectionId: 'after-deploy', candidates: [], receipts: patch.receipts ?? [], activeOperationIds: patch.active ?? [],
    observation: { schemaVersion: 1, bodyId: BODY_ID, sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      connected: true, state: {}, facts: { alive: true } },
    skills: [{ name: 'dig', description: 'dig', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }] });
  const recheck = createMinecraftBodyRecheck({ db, control, ownerScope: 'owner', deviceId: 'minebot', tickMilliseconds: 3_600_000, releaseMilliseconds: 200,
    actions: { reconcileResource: async (attempt, resource, id) => store.reconcileResource(attempt, resource, id, now()) } });
  cleanups.push(() => void recheck.close());
  const stopped = (command: MinecraftControlCommand, state: 'stopped' | 'unknown' = 'stopped'): MinecraftControlReceipt => ({
    id: command.id, connectionId: command.connectionId, outcome: state === 'stopped' ? 'completed' : 'unknown', inputsReleased: state === 'stopped',
    observedAt: new Date().toISOString(), stop: { bodyId: BODY_ID, sessionId: command.context.sessionId, generation: command.context.generation,
      requestId: command.stop!.requestId, state, inputsReleased: state === 'stopped', observedAt: new Date().toISOString() } });
  /** The body after the deploy: it takes the re-check's release and answers as its actuator found its inputs. */
  async function answered(request: Promise<BodyRecheckResult>, answer: (command: MinecraftControlCommand) => MinecraftControlReceipt | null) {
    let pending: MinecraftControlReceipt[] = [], active: string[] = [];
    let settled: BodyRecheckResult | null = null;
    void request.then(value => { settled = value; });
    for (let i = 0; i < 400 && !settled; i++) {
      const reply = poll({ receipts: pending, active });
      pending = []; active = [];
      for (const command of reply.commands) { const receipt = answer(command); if (receipt) pending.push(receipt); else active.push(command.id); }
      await delay(2);
    }
    return request;
  }
  return { db, store, lease, stop, context, control, controlStore, recheck, poll, stopped, answered, now, advance: (ms: number) => { time += ms; } };
}

describe('the run 6 stuck lease, after the fix is deployed', () => {
  it('has the production shape: unknown, closed as having acted outside, the body retained, the stop delivered and never answered', () => {
    const f = stuck();
    // A body-moving step of a `work` task was retired as a model-only one (`unknown_retired`, effect none); now it is closed.
    expect(f.store.get(f.lease.id)).toMatchObject({ state: 'unknown', sent: false, result: 'outcome_unknown_closed' });
    expect([...retainedOf(f.db, f.lease.id)]).toEqual([body]);
    expect(f.controlStore.pending(BODY_ID)).toMatchObject([{ command: { id: f.stop.id }, delivered: true, cancelled: true }]);
    expect(minecraftFcaReleaseProof(f.db, f.lease, fcaReleaseAcknowledgement({ id: f.stop.id, receipt: '{}' }), 'owner')).toBe(false);
  });

  it('re-checks the body at start once it is connected, and the body\'s own stopped receipt ends the retained record', async () => {
    const f = stuck();
    expect(await f.recheck.request('start')).toMatchObject({ code: 'body_unavailable', actionIds: [f.lease.id] }); // Not connected yet.
    expect([...retainedOf(f.db, f.lease.id)]).toEqual([body]);
    f.poll();
    const sent: MinecraftControlCommand[] = [];
    const result = await f.answered(f.recheck.request('start'), command => { sent.push(command); return f.stopped(command); });
    expect(result).toMatchObject({ code: 'released', actionIds: [f.lease.id] });
    // One release, of the same lease and session under a new id, asked of the connection the body has now.
    expect(sent).toMatchObject([{ kind: 'release', lease: f.lease, connectionId: 'after-deploy', context: { sessionId: f.context.sessionId, taskId: TASK } }]);
    expect(sent[0]!.id).toMatch(/^recheck:[a-f0-9]{64}$/u);
    expect([...retainedOf(f.db, f.lease.id)]).toEqual([]);
    const release = f.db.prepare('SELECT request_id,released_by,reason,resources_json FROM mind_action_retained_releases WHERE action_id=?').get(f.lease.id);
    expect(release).toMatchObject({ released_by: 'domain', reason: 'domain_proof', resources_json: JSON.stringify([body]) });
    expect(String(release!.request_id)).toMatch(/^proof:fca-release:[a-f0-9]{64}$/u);
    // The action itself stays unknown (only the body exclusion ends); the body can be held by the next task.
    expect(f.store.get(f.lease.id)).toMatchObject({ state: 'unknown' });
    expect(f.store.get(f.lease.id)!.resources).not.toContain(body);
    const next = f.store.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'fca:next:1', resources: [body] }, f.now());
    expect(f.store.claim(next.id, 'runner', f.now())).not.toBeNull();
    expect(await f.recheck.request('start')).toMatchObject({ code: 'not_retained' });
  });

  it('keeps the body retained when the body cannot confirm, and stops asking on its own after a few attempts', async () => {
    const f = stuck();
    f.poll();
    let asked = 0;
    for (let attempt = 0; attempt < BODY_RECHECK_ATTEMPTS + 1; attempt++) {
      const result = await f.answered(f.recheck.request('start'), command => { asked += 1; return f.stopped(command, 'unknown'); });
      expect(result.code).toBe(attempt < BODY_RECHECK_ATTEMPTS ? 'not_confirmed' : 'not_retained');
    }
    expect(asked).toBe(BODY_RECHECK_ATTEMPTS);
    expect([...retainedOf(f.db, f.lease.id)]).toEqual([body]);
    // The operator may ask again: a request to check, answered by the body as before.
    expect(await f.answered(f.recheck.request('operator'), command => f.stopped(command))).toMatchObject({ code: 'released' });
    expect([...retainedOf(f.db, f.lease.id)]).toEqual([]);
  });

  it('accepts only the re-check\'s own receipt as proof, with nothing of the lease unsettled after it', async () => {
    const f = stuck();
    f.poll();
    // The reconcile is lost in transit: the proof is there, the record is not ended yet.
    const lost = createMinecraftBodyRecheck({ db: f.db, control: f.control, ownerScope: 'owner', deviceId: 'minebot', tickMilliseconds: 3_600_000,
      releaseMilliseconds: 200, actions: { reconcileResource: async () => false } });
    cleanups.push(() => void lost.close());
    expect(await f.answered(lost.request('operator'), command => f.stopped(command))).toMatchObject({ code: 'proof_refused' });
    const evidence = fcaReleaseEvidence(f.db, f.lease, 'owner')!;
    expect(evidence.id).toMatch(/^recheck:/u);
    const ack = fcaReleaseAcknowledgement(evidence);
    expect(minecraftFcaReleaseProof(f.db, f.lease, ack, 'owner')).toBe(true);
    expect(minecraftFcaReleaseProof(f.db, f.lease, fcaReleaseAcknowledgement({ ...evidence, receipt: '{}' }), 'owner')).toBe(false);
    expect(minecraftFcaReleaseProof(f.db, f.lease, ack, 'other-scope')).toBe(false);
    expect(minecraftFcaReleaseProof(f.db, { ...f.lease, generation: f.lease.generation + 1 }, ack, 'owner')).toBe(false);
    // Something of the same lease sent after the re-check and not settled: no proof until it is.
    const later: MinecraftControlCommand = { ...f.stop, id: 'stop:later', connectionId: 'after-deploy', deadlineAt: new Date(Date.now() + 5000).toISOString() };
    f.controlStore.insert(later, new Date().toISOString());
    expect(minecraftFcaReleaseProof(f.db, f.lease, ack, 'owner')).toBe(false);
    f.controlStore.cancel(later.id); // Never handed over: settled cancelled with nothing held.
    expect(minecraftFcaReleaseProof(f.db, f.lease, ack, 'owner')).toBe(true);
    // The next pass reconciles the proof already there, without another command to the body.
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM fca_body_operations').get()!.n;
    expect(await f.recheck.request('start')).toMatchObject({ code: 'released' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM fca_body_operations').get()!.n).toBe(before);
    expect([...retainedOf(f.db, f.lease.id)]).toEqual([]);
  });

  it('never treats the operator\'s own lifecycle operation as a body held for play', () => {
    const retained = configuredRetainedResources(values);
    expect(retained(body, [body], { kind: 'minecraft', sourceId: 'operator:0a1b2c3d-1111-4222-8333-444455556666' })).toBe(false);
    expect(retained(body, [body], { kind: 'minecraft', sourceId: 'lifecycle:abc' })).toBe(false);
    expect(retained(body, [body], { kind: 'agentTask', sourceId: `fca:${TASK}:2` })).toBe(true);
  });
});

describe('the operator\'s minecraft release', () => {
  function operator(result: BodyRecheckResult | null) {
    const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
    const activity: OperatorActivity[] = [], asked: string[] = [];
    const parts: OperatorMinecraftParts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => '2026-10-14T06:00:00.000Z', audit,
      lifecycle: null, requests: null, actions: null, lifecycleUnresolved: () => false, activity: (_at, entry) => activity.push(entry), note: () => {},
      bodyRecheck: result ? { request: async origin => { asked.push(origin); return result; } } : null };
    return { service: createOperatorMinecraft(parts), audit, activity, asked };
  }
  const envelope = { v: 1, operator: 'ops.ryo', domain: 'minecraft', op: 'release', args: {} };

  it('asks the body re-check now and answers with its result, audited from invocation to settlement', async () => {
    const s = operator({ code: 'released', actionIds: ['e6e2083d-b083-4fc8-8b9c-e0f5c7a96154'], detail: 'released' });
    expect(parseOperatorEnvelope(envelope)).toMatchObject({ ok: true, input: { command: 'release' } });
    const reply = await s.service.handle(envelope);
    expect(reply).toMatchObject({ status: 202, body: { outcome: 'accepted', code: 'released', actionId: 'e6e2083d-b083-4fc8-8b9c-e0f5c7a96154' } });
    expect(s.asked).toEqual(['operator']);
    expect(s.audit.recent('owner', 10).reverse().map(row => `${row.command}/${row.event}/${row.code}`))
      .toEqual(['release/invoked/invoked', 'release/accepted/accepted', 'release/settled/released']);
    expect(s.activity).toMatchObject([{ tool: 'operator.minecraft.release', outcome: 'done', reasonCode: 'released' }]);
  });

  it.each([
    ['not_confirmed', '保持したまま'], ['body_unavailable', '接続されていない'], ['not_retained', '保持されているマイクラの体はありません'],
  ] as const)('refuses with %s and says why, never forcing a release', async (code, text) => {
    const s = operator({ code, actionIds: [], detail: code });
    const reply = await s.service.handle(envelope);
    expect(reply.body).toMatchObject({ outcome: 'refused', code });
    expect(String((reply.body as { message: string }).message)).toContain(text);
  });

  it('is offered by the command line, which prints the result code', async () => {
    expect(operatorEnvelope(['minecraft', 'release', '--operator', 'ops'], {})).toEqual({ v: 1, operator: 'ops', domain: 'minecraft', op: 'release', args: {} });
    const directory = mkdtempSync(join(tmpdir(), 'operator-release-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'shannon.sqlite'); writeFileSync(path, '');
    const lines: string[] = [];
    const s = operator({ code: 'not_confirmed', actionIds: [], detail: 'not_confirmed' });
    const deps: OperatorCliDeps = { send: async (_socket, body) => s.service.handle(body), inspect: () => ({ step: 'applied', recent: [], open: [] }),
      socketPresent: () => true, now: () => '2026-10-14T06:00:00.000Z' };
    expect(await runOperatorCli(['minecraft', 'release'], { SHANNON_DATABASE_PATH: path, SHANNON_OPERATOR: 'ops' },
      { out: line => lines.push(line), err: line => lines.push(line) }, deps)).toBe(1);
    expect(lines).toEqual(expect.arrayContaining(['outcome: refused', 'code: not_confirmed']));
  });
});

describe('set_day right after a login (run 6)', () => {
  const state = (patch: Partial<MinecraftLifecycleState>): MinecraftLifecycleState => ({ serverId: 'shannon-home', observedAt: '2026-10-14T05:00:00.000Z',
    running: 'running', bot: 'joined', otherPlayers: 0, ...patch });
  function lifecycle(states: () => MinecraftLifecycleState) {
    const admitted: unknown[] = [];
    const service = { available: () => true, status: () => [states()], store: { unresolved: () => false } } as unknown as MinecraftLifecycle;
    const runner = { admit: async (draft: unknown) => { admitted.push(draft); return null; } } as unknown as LifecycleRunner;
    const operator = createOperatorLifecycle({ service, runner, scopeKey: 'owner', serverIds: ['shannon-home'], ownerAlone: () => true,
      allowed: () => true, setDaySettleMs: 120, setDayStepMs: 10 });
    const run = () => operator.execute({ id: 'operator:0a1b2c3d-1111-4222-8333-444455556666', serverId: 'shannon-home', action: 'set_day' }, () => {});
    return { run, admitted };
  }

  it('reads the server\'s readiness with a reason', () => {
    expect(setDayReadiness(state({}))).toBe('ready');
    expect(setDayReadiness(state({ otherPlayers: null }))).toBe('not_settled');
    expect(setDayReadiness(state({ running: 'unknown', otherPlayers: null }))).toBe('not_settled');
    expect(setDayReadiness(undefined)).toBe('not_settled');
    expect(setDayReadiness(state({ running: 'stopped' }))).toBe('not_running');
    expect(setDayReadiness(state({ otherPlayers: 2 }))).toBe('players_present');
  });

  it('waits briefly for the player count to settle, then goes on', async () => {
    const started = Date.now();
    const f = lifecycle(() => state({ otherPlayers: Date.now() - started < 40 ? null : 0 }));
    expect(await f.run()).toMatchObject({ ok: false, code: 'lease_conflict' }); // Past the gate: the admission was asked.
    expect(f.admitted).toHaveLength(1);
  });

  it('answers not_settled when the count stays unknown, and refused with the reason otherwise', async () => {
    const unknown = lifecycle(() => state({ otherPlayers: null }));
    expect(await unknown.run()).toMatchObject({ ok: false, code: 'not_settled', message: expect.stringContaining('ログイン直後') });
    expect(unknown.admitted).toEqual([]);
    expect(await lifecycle(() => state({ running: 'stopped' })).run()).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('動いていない') });
    expect(await lifecycle(() => state({ otherPlayers: 1 })).run()).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('ほかの参加者がいる') });
  });
});
