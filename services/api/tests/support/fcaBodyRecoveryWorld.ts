import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteActionStore } from '../../src/mind/action/threads/store/actionStore.js';
import { ActionLeaseReader } from '../../src/mind/action/threads/store/actionLeaseReader.js';
import { actionResource, type ActionThreads } from '../../src/contracts/actionThreadContract.js';
import { configuredMinecraftBody } from '../../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../src/contracts/minecraftControlContract.js';
import { MinecraftControl } from '../../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../../src/surfaces/minecraft/store/minecraftControlStore.js';
import { bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid } from '../../src/wiring/actionLeaseRules.js';
import { configuredActionResourceProof, configuredRetainedResources } from '../../src/wiring/configuredActionResourceProof.js';
import { createMinecraftBodyRecheck } from '../../src/wiring/minecraftBodyRecheckWiring.js';
import { createFcaBodyRecovery, type FcaBodyRecoveryParts } from '../../src/wiring/fcaBodyRecovery.js';
import { createTaskRuntimeWiring } from '../../src/wiring/taskRuntimeWiring.js';
import { fcaMinecraftTools } from '../../src/wiring/fcaMinecraftTools.js';
import { MINECRAFT_REQUEST_CRITERIA } from '../../src/wiring/fcaMinecraftRequests.js';
import type { FcaBudget } from '../../src/wiring/fcaBudgetWiring.js';
import type { FcaModel, FcaModelInput, FcaModelOutput } from '../../src/mind/action/fca/fcaPorts.js';

/**
 * A Minecraft request, the real task runtime, the real action store and the real body control, with a body that can be made to
 * behave: finish a skill, hold it, ignore a cancel, or drop it when the API restarts (Minebot parity audit C-20/C-21, 2026-10-19).
 * A restart is the API's objects dropped and made again on the same database, the leases of its steps expired (a process that died
 * cannot renew them); the clock is the test's own.
 */
export type BodyBehaviour = 'complete' | 'hold' | 'hold-ignoring-cancel' | 'ignore-cancel-answer-release' | 'drop-on-release' | 'cancel-on-release'
  | 'unknown-release';
/** The behaviours whose body never answers a cancel of a skill it holds, and whose body answers each held skill when it is told to release. */
const IGNORES_CANCEL: readonly BodyBehaviour[] = ['hold-ignoring-cancel', 'ignore-cancel-answer-release'];
const ANSWERS_RELEASE: readonly BodyBehaviour[] = ['cancel-on-release', 'ignore-cancel-answer-release'];
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
  servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) };
const bodyResource = actionResource('minebot', 'minecraft-body');
export const BODY_ID = 'minecraft:world';

export interface WorldBody {
  connection: string; behaviour: BodyBehaviour; commands: MinecraftControlCommand[]; pending: Map<string, MinecraftControlCommand>;
  stop(): void;
}
export interface WorldApi {
  control: MinecraftControl; recheck: ReturnType<typeof createMinecraftBodyRecheck>; driver: ReturnType<typeof createTaskRuntimeWiring>;
}

export function minecraftWorld(options: { windowMs?: number; limit?: FcaBodyRecoveryParts['limit'];
  budget?(parts: { db: DatabaseSync; actions: ActionThreads; now(): string }): FcaBudget } = {}) {
  let clock = Date.parse('2026-10-19T09:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const db = new DatabaseSync(':memory:');
  const store = new SQLiteActionStore(db, configuredActionResourceProof(values, db), configuredRetainedResources(values));
  const actions: ActionThreads = {
    admitRespond: async draft => store.admitRespond(draft, 'test-runner', now()),
    enqueue: async draft => store.enqueue(draft, now()), claim: async id => store.claim(id, 'test-runner', now()),
    renew: async (lease, progress) => store.renew(lease, now(), progress), dispatch: async (lease, keys) => store.dispatch(lease, now(), keys),
    finish: async (lease, state, code) => store.finish(lease, state, code, now()), list: async scope => store.list(scope),
    get: async (scope, id) => { const action = store.get(id); return action?.scopeKey === scope ? action : null; },
    acknowledgeNotice: async (scope, id, notificationId, requestId) => store.acknowledgeNotice(scope, id, notificationId, requestId, now()),
    stop: async (scope, id, request) => store.stop(scope, id, request, now()), resume: async (scope, id) => store.resume(scope, id, now()),
    reconcile: async (lease, state, code) => store.reconcile(lease, state, code, now()),
    checkpoint: async (lease, code, failureCode) => store.checkpoint(lease, code, now(), failureCode),
    reconcileResource: async (lease, resource, id) => store.reconcileResource(lease, resource, id, now()),
    reserve: async (lease, id, day, yen, cap, spent) => store.reserve(lease, id, day, yen, cap, spent, now()),
    settle: async (lease, id, yen) => store.settle(lease, id, yen, now()), acknowledge: async report => store.acknowledge(report, now()),
  };
  const configuration = configuredMinecraftBody(values)!;
  const budget = options.budget?.({ db, actions, now });
  const logs: string[] = [];
  const modelInputs: FcaModelInput[] = [];
  const script: Array<(input: FcaModelInput, signal: AbortSignal) => Promise<FcaModelOutput> | FcaModelOutput> = [];
  const complete = (): FcaModelOutput => ({ decision: { kind: 'complete', summary: 'done' }, history: [{ role: 'assistant', text: 'done' }] });
  const model: FcaModel = { async decide(input, signal) {
    modelInputs.push(input);
    const next = script.shift();
    return next ? next(input, signal) : complete();
  }, toolResults: results => ({ role: 'tool_results', results }) };
  const apis: WorldApi[] = [], bodies: WorldBody[] = [];

  function startApi(): WorldApi {
    const leases = new ActionLeaseReader(db);
    const known = (lease: Parameters<typeof bodyLeaseAttempt>[2], taskId: string) => bodyLeaseAttempt(leases.get(lease.id), 'owner', lease, taskId);
    const control = new MinecraftControl(new MinecraftControlStore(db), configuration, { now: () => clock, ownerAlone: () => true,
      pollMilliseconds: 1, cancelWaitMilliseconds: 20,
      leaseKnown: (lease, taskId) => bodyLeaseKnown(known(lease, taskId), bodyResource),
      leaseValid: (lease, taskId) => bodyLeaseValid(known(lease, taskId), lease, bodyResource, now()) });
    const recheck = createMinecraftBodyRecheck({ db, control, ownerScope: 'owner', deviceId: 'minebot', tickMilliseconds: 3_600_000, releaseMilliseconds: 400,
      actions: { reconcileResource: actions.reconcileResource } });
    const driver = createTaskRuntimeWiring({ db, actions, model, scopeKey: 'owner', ownerAlone: () => true, now, providerRetryDelayMs: () => 0,
      ...(budget ? { budget } : {}),
      bodyRecovery: parts => createFcaBodyRecovery({ ...parts, passMs: 0, log: line => logs.push(line),
        ...(options.windowMs ? { windowMs: options.windowMs } : {}), ...(options.limit ? { limit: options.limit } : {}),
        body: { bound: id => control.store.body(id), connected: id => control.frame(id) !== null, release: step => recheck.releaseStep(step) } }),
      stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true }) }) });
    const api = { control, recheck, driver };
    apis.push(api);
    return api;
  }

  const receiptOf = (command: MinecraftControlCommand, outcome: MinecraftControlReceipt['outcome'] = 'completed', result?: string): MinecraftControlReceipt => ({
    id: command.id, connectionId: command.connectionId, outcome, inputsReleased: outcome !== 'unknown', observedAt: now(), ...(result ? { result } : {}),
    ...(command.stop ? { stop: { bodyId: command.context.bodyId, sessionId: command.context.sessionId, generation: command.context.generation,
      requestId: command.stop.requestId, state: outcome === 'unknown' ? 'unknown' as const : 'stopped' as const, inputsReleased: outcome !== 'unknown',
      observedAt: now() } } : {}) });

  /** The body connects to this API under a connection of its own and is polled every two milliseconds until stopped. */
  function connectBody(api: WorldApi, connection: string, behaviour: BodyBehaviour): WorldBody {
    const body: WorldBody = { connection, behaviour, commands: [], pending: new Map(), stop: () => clearInterval(timer) };
    let sequence = 0, receipts: MinecraftControlReceipt[] = [];
    const pump = () => {
      clock += 1;
      const received = receipts.splice(0, 16);
      const reply = api.control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: connection,
        observation: { schemaVersion: 1, bodyId: BODY_ID, sequence: sequence++, stateAt: now(), receivedAt: now(), connected: true, state: {}, facts: { alive: true } },
        skills: [{ name: 'move', description: 'bounded movement', readOnly: false, maxDurationMs: 1_000,
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
        candidates: [], activeOperationIds: [...body.pending.keys()], receipts: received });
      for (const id of reply.cancel) {
        const command = body.pending.get(id);
        if (!command || IGNORES_CANCEL.includes(body.behaviour)) continue;
        body.pending.delete(id);
        receipts.push(receiptOf(command, 'cancelled'));
      }
      for (const command of reply.commands) {
        body.commands.push(command);
        if (command.kind === 'skill') {
          if (body.behaviour === 'complete') receipts.push(receiptOf(command, 'completed', 'moved'));
          else body.pending.set(command.id, command);
        } else if (command.kind === 'stop' || command.kind === 'release') {
          if (ANSWERS_RELEASE.includes(body.behaviour)) for (const held of body.pending.values()) receipts.push(receiptOf(held, 'cancelled'));
          body.pending.clear();
          receipts.push(receiptOf(command, body.behaviour === 'unknown-release' ? 'unknown' : 'completed'));
        } else receipts.push(receiptOf(command));
      }
    };
    const timer = setInterval(() => { try { pump(); } catch { /* a refused poll is the body's to retry */ } }, 2);
    timer.unref();
    bodies.push(body);
    pump();
    return body;
  }

  const task = { id: '' };
  function createTask(api: WorldApi) {
    const root = api.driver.runtime.ensureRoot('owner');
    const created = api.driver.runtime.createChild('owner', root.id, { title: 'マイクラ', goal: '石を集める', completionCriteria: MINECRAFT_REQUEST_CRITERIA }, 'mc-request');
    api.control.store.bind(created.id, BODY_ID);
    task.id = created.id;
    return created;
  }

  /** The API process died: its body is gone, its steps' leases ran out, its objects are dropped. */
  async function crash(api: WorldApi, body?: WorldBody) {
    body?.stop();
    db.prepare("UPDATE mind_actions SET lease_until=? WHERE state IN ('running','waiting','stopping')").run(new Date(clock - 1_000).toISOString());
    // Time passes while the dying process lets go of what it waited for (the control counts its waits on this clock).
    const passing = setInterval(() => { clock += 5; }, 2);
    try {
      await api.driver.close();
      await api.recheck.close();
    } finally {
      clearInterval(passing);
    }
  }

  async function until(api: WorldApi, condition: () => boolean, label: string, limit = 600) {
    for (let i = 0; i < limit; i++) {
      if (condition()) return;
      await api.driver.tick();
      await delay(2);
    }
    throw new Error(`not reached: ${label}; task=${api.driver.runtime.get('owner', task.id)?.phase}; logs=${logs.join(' | ')}`);
  }

  const phase = (api: WorldApi) => api.driver.runtime.get('owner', task.id)?.phase;
  const events = () => (db.prepare('SELECT event_type FROM agent_task_events WHERE task_id=? ORDER BY rowid').all(task.id) as Array<{ event_type: string }>).map(row => row.event_type);
  const hangs = (_input: FcaModelInput, signal: AbortSignal) => new Promise<FcaModelOutput>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('model_abort')), { once: true });
  });
  const moves = (id = 'move'): FcaModelOutput => ({ decision: { kind: 'tools', calls: [{ id, name: 'mc.move', input: {} }] }, history: [{ role: 'assistant', call: id }] });
  const skillRows = () => db.prepare("SELECT id,phase,receipt_json FROM fca_body_operations WHERE json_extract(command_json,'$.kind')='skill'").all() as
    Array<{ id: string; phase: string; receipt_json: string | null }>;

  return { db, store, actions, logs, modelInputs, script, startApi, connectBody, createTask, crash, until, phase, events, hangs, moves, skillRows, task,
    advance(milliseconds: number) { clock += milliseconds; }, now, clockMs: () => clock,
    /** Time that passes while the API waits (a jump is taken for a stall of its thread and not counted: `MinecraftControl.receiptOf`). */
    async elapse(milliseconds: number) {
      for (let spent = 0; spent < milliseconds; spent += 8) {
        clock += 8;
        await delay(1);
      }
    },
    /** What the model was asked for this task (its parent, the root, is asked about its reports too). */
    inputsOf: (taskId: string) => modelInputs.filter(input => input.task.id === taskId),
    close: async () => { for (const body of bodies) body.stop(); for (const api of apis) { await api.driver.close().catch(() => undefined); await api.recheck.close().catch(() => undefined); } db.close(); } };
}
