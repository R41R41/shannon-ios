import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { CLEANUP_LIMIT_MS, dependStateOf, handDependsProblem, unitFromOutcome, unitView, type HoldState, type InventoryEvent, type ItemOutcome, type OperationState,
  type StageRow } from '../src/contracts/continueContract.js';
import { actProblem, actOutcomeOf, MC_ACT_TOOL, readActResult, type ActInput, type ActResult } from '../src/contracts/minecraftActContract.js';
import { actToShort, expandShortAct, handToLine, lineToHand, SHORT_ACT_DESCRIPTION, shortHandProblem } from '../src/contracts/minecraftActShortContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { eventsCommandId, eventsOfReceipt, readEventsReply, storedPages } from '../src/surfaces/minecraft/minecraftControlEvents.js';
import { forgetCleanups } from '../src/surfaces/minecraft/minecraftControlRecovery.js';
import { validBodyTimes, validBodyVersion, validControlPoll, validEventsMore, validUnit } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { llmcResult, actResultText } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { createLlmcQueue, forgetLlmcQueues, madeInOf, type QueueAdd, type QueueDeps, type QueueRecordRow } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { heldAgainWords, replayWords, skipWords } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { applyLedger, emptyLedgerSeen, type LedgerInput, type LedgerSeen } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { forgetActNodes } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { isSafeState, readingOf, stepAxes, type OperationAxes, type OperationEvent } from '../src/surfaces/minecraft/store/minecraftOperationState.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { reconcileOperations } from '../src/surfaces/minecraft/store/minecraftOperationReconcile.js';


/**
 * The continue contract's D1, the head's side of chapters 1 and 2 (results and how a stop goes on), the store's half of chapter 3 (the receipt box and the pages), and
 * chapter 8's 再開: the fixtures of `fixtures/continue/result/` and `fixtures/continue/continue/` the head owns, through the real store, control and queue with the body
 * played by hand. The body's real outputs (`produced/`) do not exist yet: the receipts here are built from the fixtures' `input` and `expected`.
 */
const FIXTURES = new URL('./fixtures/continue/', import.meta.url);
const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8')) as Record<string, any>;
const AT = '2026-10-28T12:00:00.000Z';
const lease = { id: 'lease-1', generation: 1, holder: 'test' };
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) try { close(); } catch { /* closed */ } forgetLlmcQueues(); forgetActNodes(); forgetCleanups(); });

// ---- the harness: a real control and store, the body played by hand ---------------------------------------------------------------------------------------
const LOOSE = { type: 'object', properties: {}, required: [], additionalProperties: false };
const LIFE = { life: 3, alive: true, since: AT, dimension: 'overworld', dimensionSince: AT };
interface RigOptions { headBoot?: string; db?: DatabaseSync; connection?: string; life?: boolean }
function rig(options: RigOptions = {}) {
  const db = options.db ?? new DatabaseSync(':memory:'), store = new MinecraftControlStore(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.now(), ownerAlone: () => true, leaseValid: () => true, pollMilliseconds: 1,
    cancelWaitMilliseconds: 50, frameMilliseconds: 60_000, headBoot: options.headBoot ?? 'hb-1' });
  let sequence = 0, connection = options.connection ?? 'connection';
  const running: string[] = [], queued: string[] = [], receipts: MinecraftControlReceipt[] = [], handed: MinecraftControlCommand[] = [], replies: ReturnType<MinecraftControl['poll']>[] = [];
  const poll = (extra: Partial<MinecraftControlPoll> = {}, facts: Record<string, boolean> = {}) => {
    const reply = control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
      schemaVersion: 1, serverId: 'world', connectionId: connection,
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true,
        state: { world: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20 }, ...(options.life === false ? {} : { life: LIFE, bodyRun: { bodyBoot: 'bb-1', connectionId: connection } }) },
        facts }, candidates: [],
      skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: LOOSE }, { name: 'events', description: 'events', readOnly: true, inputSchema: LOOSE },
        { name: 'view', description: 'view', readOnly: true, inputSchema: LOOSE }],
      receipts: [...receipts], activeOperationIds: [...running], queuedOperationIds: [...queued], ...extra,
    } as never);
    for (const id of reply.acknowledged) { const index = receipts.findIndex(item => item.id === id); if (index >= 0) receipts.splice(index, 1); }
    handed.push(...reply.commands);
    replies.push(reply);
    return reply;
  };
  poll();
  const context = { scopeKey: 'owner', taskId: 't1', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'session-1', generation: 1, goal: 'g', completionCondition: 'c' };
  closers.push(() => { try { db.close(); } catch { /* closed */ } });
  return { db, store, control, poll, running, queued, receipts, handed, replies, context, setConnection: (next: string) => { connection = next; sequence = 0; } };
}
type Rig = ReturnType<typeof rig>;

/** The result JSON of an act as the body writes it. */
function actResult(lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): string {
  const done = lines.filter(line => line.status === 'done').length;
  return JSON.stringify({ v: 1, ok: done === lines.length, done, of: lines.length, ms: 1500, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20,
    lines: lines.map((line, index) => ({ i: index + 1, do: 'wait', line: '', ...line })), ...extra });
}
const completed = (id: string, extra: Partial<MinecraftControlReceipt> = {}): MinecraftControlReceipt =>
  ({ id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: AT, ...extra });
const unknownReceipt = (id: string): MinecraftControlReceipt => ({ id, connectionId: 'connection', outcome: 'unknown', inputsReleased: false, observedAt: AT });
const insert = (rigged: Rig, id: string, extra: Partial<MinecraftControlCommand> = {}) => {
  const command = { schemaVersion: 1, id, serverId: 'world', connectionId: 'connection', kind: 'skill', skill: 'act', context: rigged.context, lease, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    arguments: {}, ...extra } as MinecraftControlCommand;
  rigged.store.insert(command, AT, undefined, { headBoot: 'hb-1' });
  return command;
};

// ---- 1. the two axes ------------------------------------------------------------------------------------------------------------------------------------------
describe('the operation states: the result axis and the hold axis are two axes (fixture result/held-two-axes.json, unknown-state-machine.json)', () => {
  const asEvent = (name: string): OperationEvent => name === 'late_cleanup_released' ? { kind: 'release_proved' } : name === 'real_receipt' ? { kind: 'receipt', reading: 'known' }
    : name === 'operator_resume' ? { kind: 'operator_resume' } : { kind: 'operator_cancel' };
  const sample = fixture('result/held-two-axes.json');
  sample.input.orders.forEach((order: string[], index: number) => {
    it(`applies ${order.join(' then ')} separately: ${JSON.stringify(sample.expected.orders[index])}`, () => {
      let axes: OperationAxes = { state: 'settled_unknown', hold: 'held', told: true };
      for (const name of order) axes = stepAxes(axes, asEvent(name));
      expect({ result: axes.state, hold: axes.hold }).toEqual({ result: sample.expected.orders[index].result, hold: sample.expected.orders[index].hold });
    });
  });
  it('is corrected only after an unknown the model was told; an unknown it was not told is an ordinary result', () => {
    expect(stepAxes({ state: 'settled_unknown', hold: 'none', told: true }, { kind: 'receipt', reading: 'known' }).state).toBe('corrected');
    expect(stepAxes({ state: 'released', hold: 'none', told: true }, { kind: 'receipt', reading: 'known' }).state).toBe('corrected');
    expect(stepAxes({ state: 'settled_unknown', hold: 'none', told: false }, { kind: 'receipt', reading: 'known' }).state).toBe('settled_known');
    expect(stepAxes({ state: 'sent', hold: 'none', told: false }, { kind: 'receipt', reading: 'known' }).state).toBe('settled_known');
    expect(stepAxes({ state: 'sent', hold: 'none', told: false }, { kind: 'receipt', reading: 'unknown' }).state).toBe('settled_unknown');
  });
  it('never goes back: a known result stays, a second unknown changes nothing, a proof of release does not unsettle a known one', () => {
    const known: OperationAxes = { state: 'settled_known', hold: 'none', told: false };
    expect(stepAxes(known, { kind: 'receipt', reading: 'unknown' })).toEqual(known);
    expect(stepAxes(known, { kind: 'release_proved' })).toEqual(known);
    expect(stepAxes({ state: 'corrected', hold: 'none', told: true }, { kind: 'receipt', reading: 'known' }).state).toBe('corrected');
  });
  it('says what is safe: sent and settled_unknown are not, the rest are (an open item the step waits for excepted)', () => {
    const safe = (['sent', 'settled_known', 'settled_unknown', 'released', 'corrected'] as OperationState[]).map(state => [state, isSafeState(state)]);
    expect(safe).toEqual([['sent', false], ['settled_known', true], ['settled_unknown', false], ['released', true], ['corrected', true]]);
    expect(isSafeState('sent', true)).toBe(true);
    expect(readingOf({ outcome: 'completed', inputsReleased: false })).toBe('unknown');
    expect(readingOf({ outcome: 'cancelled', inputsReleased: true })).toBe('known');
  });
  it('reads the dependency table: the state of what is relied on is what the table says (dependStateOf, unitFromOutcome)', () => {
    const table = fixture('continue/dependency-table.json');
    for (const row of table.outcomes as Array<{ goal: any; end: any; released: boolean; dependState: string; old: { outcome?: any; inputsReleased: boolean } }>) {
      expect(dependStateOf(unitView({ goal: row.goal, end: row.end, released: row.released })), JSON.stringify(row)).toBe(row.dependState);
    }
    expect(dependStateOf(unitView(undefined))).toBe('pending');
    expect(dependStateOf(unitView({ goal: 'done', end: 'finished', released: true }, false))).toBe('unknown');
    expect(unitFromOutcome('unknown', false)).toEqual({ goal: 'unknown', end: 'unknown', released: false });
  });
});

// ---- 2. the store ---------------------------------------------------------------------------------------------------------------------------------------
describe('the store keeps the states (chapter 1, 「不明の結果」) and what the head keeps with a command (chapter 3)', () => {
  it('moves sent → settled_unknown → released → corrected, and the model told or not decides the last', () => {
    const f = rig();
    insert(f, 'a1');
    expect(f.store.state('a1')).toBe('sent');
    expect(f.store.safe('t1')).toBe(false);
    expect(f.store.settleWith(unknownReceipt('a1'))).toMatchObject({ acked: true, from: 'sent', to: 'settled_unknown' });
    expect(f.store.safe('t1')).toBe(false);
    f.store.markTold('a1');
    expect(f.store.release('a1', 'cleanup', AT, 'stop:x')).toBe(true);
    expect(f.store.state('a1')).toBe('released');
    expect(f.store.safe('t1')).toBe(true);
    expect(f.store.unitOf('a1')).toEqual({ goal: 'unknown', end: 'unknown', released: true });
    // The late real receipt replaces the closing and is a correction (the model was told the unknown).
    expect(f.store.settleWith(completed('a1', { unit: { goal: 'done', end: 'finished', released: true } }))).toMatchObject({ acked: true, from: 'released', to: 'corrected' });
    expect(f.store.state('a1')).toBe('corrected');
    expect(f.store.unitOf('a1')).toMatchObject({ goal: 'done' });
    expect(f.store.unsaidCorrections('t1').map(row => row.id)).toEqual(['a1']);
    f.store.markCorrectionSaid('a1');
    expect(f.store.unsaidCorrections('t1')).toEqual([]);
  });
  it('a real receipt after a release the model was not told is the ordinary result', () => {
    const f = rig();
    insert(f, 'b1');
    expect(f.store.release('b1', 'reconnect', AT, 'reconnect:c')).toBe(true);
    expect(f.store.settleWith(completed('b1'))).toMatchObject({ acked: true, to: 'settled_known' });
  });
  it('keeps the rule that a different receipt is not taken, except a real one over an unknown or a closing', () => {
    const f = rig();
    insert(f, 'c1');
    expect(f.store.settle(completed('c1'))).toBe(true);
    expect(f.store.settle(completed('c1'))).toBe(true);
    expect(f.store.settle(completed('c1', { result: 'other' }))).toBe(false);
    expect(f.store.settle(unknownReceipt('c1'))).toBe(false);
    insert(f, 'c2');
    expect(f.store.settle(unknownReceipt('c2'))).toBe(true);
    expect(f.store.settle({ ...unknownReceipt('c2'), result: 'again' })).toBe(false);
    expect(f.store.settle(completed('c2'))).toBe(true);
    expect(f.store.state('c2')).toBe('settled_known');
  });
  it('the hold axis does not change the result axis: held, then a late release leaves it held; resume and cancel are the operator\'s', () => {
    const f = rig();
    insert(f, 'd1');
    f.store.settle(unknownReceipt('d1'));
    expect(f.store.holdEvent('d1', { kind: 'cleanup_failed' })).toBe('held');
    expect(f.store.state('d1')).toBe('settled_unknown');
    expect(f.store.release('d1', 'cleanup', AT, 's')).toBe(true);
    expect([f.store.state('d1'), f.store.holdOf('d1')]).toEqual(['released', 'held']);
    expect(f.store.holdEvent('d1', { kind: 'operator_resume' })).toBe('resumed');
    expect(f.store.state('d1')).toBe('released');
    expect(f.store.holdEvent('d1', { kind: 'operator_cancel' })).toBe('cancelled');
  });
  it('safe() reads the states: an open item the step waits for is excepted, an unknown one is not, a probe is never', () => {
    const f = rig();
    insert(f, 'e1');
    insert(f, 'e2');
    insert(f, 'p1', { skill: 'probe' });
    expect(f.store.safe('t1')).toBe(false);
    expect(f.store.safe('t1', new Set(['e1', 'e2']))).toBe(true);
    f.store.settle(unknownReceipt('e1'));
    expect(f.store.safe('t1', new Set(['e1', 'e2']))).toBe(false);
    f.store.release('e1', 'cleanup', AT, 's');
    expect(f.store.safe('t1', new Set(['e2']))).toBe(true);
  });
  it('reads a database made before the columns: the columns are added once and the rows get their state from what they had', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-')), path = join(dir, 'old.sqlite');
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE fca_body_operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      command_json TEXT NOT NULL, phase TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, created_at TEXT NOT NULL)`);
    const command = JSON.stringify({ id: 'x', kind: 'skill', skill: 'act', connectionId: 'connection', context: { taskId: 't1', bodyId: 'minecraft:world' } });
    const put = (id: string, phase: string, receipt: unknown) => old.prepare('INSERT INTO fca_body_operations(id,task_id,body_id,connection_id,command_json,phase,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, 't1', 'minecraft:world', 'connection', command, phase, receipt ? JSON.stringify(receipt) : null, AT);
    put('o-open', 'running', null);
    put('o-known', 'settled', { id: 'o-known', outcome: 'completed', inputsReleased: true });
    put('o-unknown', 'settled', { id: 'o-unknown', outcome: 'unknown', inputsReleased: false });
    put('o-closed', 'settled', { id: 'o-closed', outcome: 'cancelled', inputsReleased: true, reconciled: 'release_proof' });
    old.close();
    const db = new DatabaseSync(path);
    closers.push(() => db.close());
    const store = new MinecraftControlStore(db);
    new MinecraftControlStore(db);
    const columns = db.prepare('PRAGMA table_info(fca_body_operations)').all().map(column => String(column.name));
    expect(columns).toEqual(expect.arrayContaining(['state', 'hold', 'told', 'head_boot', 'uses_json', 'fetch_seq', 'ledger_done']));
    expect(columns.filter(name => name === 'state')).toHaveLength(1);
    expect(['o-open', 'o-known', 'o-unknown', 'o-closed'].map(id => store.state(id))).toEqual(['sent', 'settled_known', 'settled_unknown', 'released']);
    expect(store.holdOf('o-open')).toBe('none');
  });
  it('keeps the promises\' definitions and the fetch position with the command, across a restart of the store (the receipt box)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-')), path = join(dir, 'box.sqlite');
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const uses = [{ id: 3, rev: 2, item: 'planks', count: 4, use: '作業台' }];
    {
      const db = new DatabaseSync(path), store = new MinecraftControlStore(db);
      const f = { ...rig(), db, store } as unknown as Rig;
      insert(f, 'q70', { skill: 'act' });
      db.close();
    }
    const db = new DatabaseSync(path), store = new MinecraftControlStore(db);
    closers.push(() => db.close());
    const command = { schemaVersion: 1, id: 'q71', serverId: 'world', connectionId: 'connection', kind: 'skill', skill: 'act', arguments: {}, deadlineAt: AT, lease,
      context: { scopeKey: 'owner', taskId: 't1', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 's', generation: 1, goal: 'g', completionCondition: 'c' } } as MinecraftControlCommand;
    store.insert(command, AT, undefined, { headBoot: 'hb-9', uses });
    store.settle({ id: 'q71', connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: AT, result: actResult([{ status: 'done' }]) });
    store.setFetchSeq('q71', 120);
    store.setFetchSeq('q71', 60);
    db.close();
    const again = new DatabaseSync(path), reopened = new MinecraftControlStore(again);
    closers.push(() => again.close());
    expect(reopened.row('q71')).toMatchObject({ uses, fetchSeq: 120, headBoot: 'hb-9', state: 'settled_known', ledgerDone: false });
    expect(reopened.unprocessed('t1').map(row => row.id)).toEqual(['q71']);
    reopened.markProcessed(['q71']);
    expect(reopened.unprocessed('t1')).toEqual([]);
  });
  it('reconcileOperations closes an unresolved operation as released with its result still unknown', () => {
    const f = rig();
    const command = insert(f, 'r1');
    const closed = reconcileOperations(f.db, lease, command.context.scopeKey, 'recheck:1', AT, 't1');
    expect(closed.map(item => item.id)).toEqual(['r1']);
    expect([f.store.state('r1'), f.store.unitOf('r1')]).toEqual(['released', { goal: 'unknown', end: 'unknown', released: true }]);
  });
});

// ---- 3. the control -------------------------------------------------------------------------------------------------------------------------------------
describe('the control: the head\'s boot, the shapes of the new fields, a unit in the receipt', () => {
  it('puts its own headBoot in every reply of a poll', () => {
    const f = rig({ headBoot: 'hb-77' });
    expect(f.replies.map(reply => reply.headBoot)).toEqual(['hb-77']);
    expect(f.poll().headBoot).toBe('hb-77');
    expect(rig().control.headBoot()).toBe('hb-1');
  });
  it('checks the shape of unit, bodyTimes, eventsMore and the poll\'s bodyVersion', () => {
    expect(validUnit({ goal: 'partial', end: 'cut', released: true, droppedBecause: { code: 'death' }, startedAt: AT })).toBe(true);
    expect(validUnit({ goal: 'done', end: 'finished', released: true, keptDespite: { item: { queue: 't:hb:1', item: 'q1' }, code: 'failed' } })).toBe(true);
    expect(validUnit({ goal: 'great', end: 'finished', released: true })).toBe(false);
    expect(validUnit({ goal: 'done', end: 'finished', released: 'yes' })).toBe(false);
    expect(validUnit({ goal: 'done', end: 'finished', released: true, droppedBecause: { code: 'because' } })).toBe(false);
    expect(validBodyTimes({ acceptedAt: AT, endedAt: AT, startedAt: AT, motorOps: 3, reflexWaitMs: 6400 })).toBe(true);
    expect(validBodyTimes({ acceptedAt: AT })).toBe(false);
    expect(validBodyTimes({ acceptedAt: AT, endedAt: AT, motorOps: -1 })).toBe(false);
    expect(validEventsMore({ command: 'skill:q70', nextSeq: 120, total: 340 })).toBe(true);
    expect(validEventsMore({ command: 'skill:q70', nextSeq: 400, total: 340 })).toBe(false);
    expect(validBodyVersion({ revision: 'abc1234', catalogHash: 'deadbeef' })).toBe(true);
    expect(validBodyVersion({ revision: '' , catalogHash: 'x' })).toBe(false);
    const f = rig();
    const now = Date.now();
    const base = { schemaVersion: 1, serverId: 'world', connectionId: 'connection', candidates: [], activeOperationIds: [], skills: [],
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), connected: true, state: {}, facts: {} } };
    const receipt = { id: 'x', connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: AT };
    expect(validControlPoll({ ...base, receipts: [{ ...receipt, unit: { goal: 'done', end: 'finished', released: true }, bodyTimes: { acceptedAt: AT, endedAt: AT },
      eventsMore: { command: 'skill:q1', nextSeq: 1, total: 2 } }], bodyVersion: { revision: 'r', catalogHash: 'h' } }, now)).toBe(true);
    expect(validControlPoll({ ...base, receipts: [{ ...receipt, unit: { goal: 'done' } }] }, now)).toBe(false);
    expect(validControlPoll({ ...base, receipts: [], bodyVersion: { revision: 1 } }, now)).toBe(false);
    expect(f.control).toBeDefined();
  });
  it('a queue item whose wait ran out is an unknown result (a state), and the receipt that comes later is read against it', async () => {
    const f = rig();
    const { receipt } = f.control.enqueue({ id: 'u1', context: f.context, lease, kind: 'skill', skill: 'act', arguments: {}, milliseconds: 30,
      queue: { item: 'q1', after: null, node: null, maxMs: 1000, startBy: AT, queue: 't1:hb-1:1' } });
    f.poll();
    await delay(80);
    f.running.push('u1');
    f.poll();
    await expect(receipt).resolves.toMatchObject({ outcome: 'unknown', inputsReleased: false, unit: { goal: 'unknown', end: 'unknown', released: false } });
    expect(f.store.state('u1')).toBe('settled_unknown');
    f.store.markTold('u1');
    f.running.length = 0;
    f.receipts.push(completed('u1', { result: actResult([{ status: 'done' }]) }));
    const settled: Array<[string | null, string]> = [];
    f.control.settledListeners.add(event => settled.push([event.from, event.to]));
    const reply = f.poll();
    expect(reply.acknowledged).toEqual(['u1']);
    expect(settled).toEqual([['settled_unknown', 'corrected']]);
  });
  it('a command that is not a queue item still throws the unknown outcome, as it did (a view, a probe, a stop)', async () => {
    const f = rig();
    const asked = f.control.command({ id: 'v1', context: f.context, lease, kind: 'skill', skill: 'view', arguments: {}, milliseconds: 30 });
    f.poll();
    await expect(asked).rejects.toThrow('FCA_BODY_OUTCOME_UNKNOWN');
  });
  it('stores a receipt before it is acknowledged: the store has it when the acknowledgement is in the reply', () => {
    const f = rig();
    insert(f, 'k1');
    f.receipts.push(completed('k1'));
    const reply = f.poll();
    expect(reply.acknowledged).toEqual(['k1']);
    expect(f.store.state('k1')).toBe('settled_known');
  });
  it('the first poll of a new connection that runs nothing proves the old connection\'s commands released (their results stay unknown)', () => {
    const f = rig();
    insert(f, 'n1');
    f.store.deliver('n1');
    f.store.confirm('n1');
    const released: string[] = [];
    f.control.releasedListeners.add(event => released.push(`${event.row.id}:${event.by}`));
    f.setConnection('connection-2');
    f.poll({}, { held: true });
    expect(f.store.state('n1')).toBe('sent');
    f.setConnection('connection-3');
    f.poll({ activeOperationIds: ['other'] });
    expect(f.store.state('n1')).toBe('sent');
    f.setConnection('connection-4');
    f.poll();
    expect(f.store.state('n1')).toBe('released');
    expect(f.store.unitOf('n1')).toEqual({ goal: 'unknown', end: 'unknown', released: true });
    expect(released).toEqual(['n1:reconnect']);
  });
});

// ---- 4. the cleanup, the gate, the restarts ---------------------------------------------------------------------------------------------------------
describe('an unknown result: the stop is sent at once, nothing moves the body until the release is proved (fixtures result/unknown-receipt-cleanup.json, head-restart-sent.json)', () => {
  const stopOf = (f: Rig) => f.handed.filter(command => command.kind === 'stop');
  const answerStop = (f: Rig, released = true) => {
    const stop = stopOf(f).at(-1)!;
    f.receipts.push({ id: stop.id, connectionId: 'connection', outcome: 'completed', inputsReleased: released, observedAt: AT,
      stop: { bodyId: stop.stop!.context.bodyId, sessionId: stop.stop!.context.sessionId, generation: stop.stop!.context.generation, requestId: stop.stop!.requestId,
        state: released ? 'stopped' : 'unknown', inputsReleased: released, observedAt: AT } });
  };
  const unknownItem = async (f: Rig, id = 'w1') => {
    insert(f, id);
    f.poll();
    f.receipts.push(unknownReceipt(id));
    f.poll();
    expect(f.store.state(id)).toBe('settled_unknown');
    f.store.markTold(id);
  };

  it('cleanup_ok: the stop is handed in, its receipt proves the release, the command is released and safe, and nothing was resent', async () => {
    const f = rig();
    await unknownItem(f);
    const owner = { taskId: 't1', context: f.context, lease };
    const done = f.control.cleanup({ ...owner, limitMs: 2_000 });
    await delay(20);
    f.poll();
    expect(stopOf(f)).toHaveLength(1);
    expect(f.handed.filter(command => command.id === 'w1')).toHaveLength(1);
    answerStop(f);
    f.poll();
    await expect(done).resolves.toBe('released');
    expect(f.store.state('w1')).toBe('released');
    expect(f.store.safe('t1')).toBe(true);
    expect(f.control.motorBlocked('t1')).toBeNull();
  });
  it('cleanup_failed: a stop that does not prove the release in time makes the command held; no motor command goes, an observation does', async () => {
    const f = rig();
    await unknownItem(f);
    const held: string[] = [];
    f.control.heldListeners.add(event => held.push(`${event.row.id}:${event.why}`));
    const done = f.control.cleanup({ taskId: 't1', context: f.context, lease, limitMs: 60 });
    await delay(10);
    f.poll();
    // The body has the stop and is working on it (it lists it as active), but does not say it released in time.
    f.running.push(stopOf(f)[0]!.id);
    f.poll();
    await expect(done).resolves.toBe('held');
    expect(held).toEqual(['w1:cleanup_timeout']);
    expect([f.store.state('w1'), f.store.holdOf('w1')]).toEqual(['settled_unknown', 'held']);
    expect(f.control.motorBlocked('t1')?.id).toBe('w1');
    await expect(f.control.command({ id: 'm1', context: f.context, lease, kind: 'skill', skill: 'act', arguments: {}, milliseconds: 100 })).rejects.toThrow('FCA_BODY_MOTOR_BLOCKED');
    const view = f.control.command({ id: 'v1', context: f.context, lease, kind: 'skill', skill: 'view', arguments: {}, milliseconds: 1_000 });
    // One command of another kind goes in a reply: the stop (cancelled when its time ran out) clears the way.
    for (let round = 0; round < 6 && !f.handed.some(command => command.id === 'v1'); round += 1) { f.poll(); await delay(15); }
    expect(f.handed.some(command => command.id === 'v1')).toBe(true);
    f.receipts.push(completed('v1', { result: '{}' }));
    f.poll();
    await expect(view).resolves.toMatchObject({ outcome: 'completed' });
    // The stop proves the release after the time: the command is released and the hold stays for the operator.
    f.running.length = 0;
    answerStop(f);
    f.poll();
    await delay(20);
    expect([f.store.state('w1'), f.store.holdOf('w1')]).toEqual(['released', 'held']);
  });
  it('a stop that cannot be sent (no body) is a hold too (通信できない時も held)', async () => {
    const f = rig();
    await unknownItem(f);
    const frames = f.control.frames as Map<string, unknown>;
    frames.clear();
    await expect(f.control.cleanup({ taskId: 't1', context: f.context, lease, limitMs: 200 })).resolves.toBe('held');
    expect(f.store.holdOf('w1')).toBe('held');
  });
  it('late_real_result: the real receipt after the release is a correction, and it is acknowledged', async () => {
    const f = rig();
    await unknownItem(f);
    const done = f.control.cleanup({ taskId: 't1', context: f.context, lease, limitMs: 2_000 });
    await delay(10);
    f.poll();
    answerStop(f);
    f.poll();
    await done;
    f.receipts.push(completed('w1', { unit: { goal: 'done', end: 'finished', released: true }, result: actResult([{ status: 'done' }]) }));
    const seen: string[] = [];
    f.control.settledListeners.add(event => seen.push(event.to));
    expect(f.poll().acknowledged).toContain('w1');
    expect(seen).toEqual(['corrected']);
  });
  it('same_result_twice: the same receipt again is acknowledged and changes nothing', () => {
    const f = rig();
    insert(f, 'x1');
    const seen: string[] = [];
    f.control.settledListeners.add(event => seen.push(event.to));
    f.receipts.push(completed('x1', { result: actResult([{ status: 'done' }]) }));
    f.poll();
    f.receipts.push(completed('x1', { result: actResult([{ status: 'done' }]) }));
    expect(f.poll().acknowledged).toEqual(['x1']);
    expect(seen).toEqual(['settled_known']);
  });
  it('head_restart (sent): the new head finds the old head\'s open command, sends the stop before any motor command, and a resent receipt is an ordinary result', async () => {
    const first = rig({ headBoot: 'hb-1' });
    insert(first, 'h1');
    first.store.deliver('h1');
    first.store.confirm('h1');
    // The head restarts: a new control (another headBoot) on the same store.
    const second = { ...rig({ headBoot: 'hb-2', db: first.db }) } as Rig;
    expect(second.control.store.uncleaned('t1', 'hb-2').map(row => row.id)).toEqual(['h1']);
    expect(second.control.motorBlocked('t1')?.id).toBe('h1');
    await expect(second.control.command({ id: 'm2', context: second.context, lease, kind: 'skill', skill: 'act', arguments: {}, milliseconds: 100 })).rejects.toThrow('FCA_BODY_MOTOR_BLOCKED');
    expect(second.replies.at(-1)!.headBoot).toBe('hb-2');
    const done = second.control.cleanup({ taskId: 't1', context: second.context, lease, limitMs: 2_000 });
    await delay(10);
    second.poll();
    expect(second.handed.filter(command => command.kind === 'stop')).toHaveLength(1);
    expect(second.handed.filter(command => command.kind === 'skill' && command.id !== 'h1')).toHaveLength(0);
    // The body cut h1 (connection_changed) and resends its receipt until it is acknowledged: the stop proves the release, then the receipt.
    answerStop(second);
    second.poll();
    await done;
    expect(second.store.state('h1')).toBe('released');
    expect(second.control.motorBlocked('t1')).toBeNull();
    second.receipts.push(completed('h1', { unit: { goal: 'partial', end: 'cut', released: true } satisfies ItemOutcome }));
    second.poll();
    // The model was never told an unknown: it is the ordinary result (corrections 0).
    expect(second.store.state('h1')).toBe('settled_known');
  });
  it('head_restart (notified): an unknown the model was told, then the head restarts, then the real receipt: a correction', () => {
    const first = rig({ headBoot: 'hb-1' });
    insert(first, 'h2');
    first.store.settle(unknownReceipt('h2'));
    first.store.markTold('h2');
    const second = rig({ headBoot: 'hb-2', db: first.db });
    expect(second.store.uncleaned('t1', 'hb-2').map(row => row.id)).toEqual(['h2']);
    expect(second.store.settleWith(completed('h2'))).toMatchObject({ to: 'corrected' });
  });
  it('body restart (sent): the new connection\'s first poll releases it, the result stays unknown, a late receipt of the old connection is never taken', () => {
    const f = rig();
    insert(f, 'b2');
    f.store.deliver('b2');
    f.store.confirm('b2');
    f.setConnection('connection-b');
    f.poll();
    expect(f.store.state('b2')).toBe('released');
    expect(f.store.settle(completed('b2', { connectionId: 'connection-b' }))).toBe(false);
  });
  it('CLEANUP_LIMIT_MS is 5 seconds (provisional)', () => expect(CLEANUP_LIMIT_MS).toBe(5_000));
});

// ---- 5. the events and their pages ------------------------------------------------------------------------------------------------------------------------
describe('the events of a result and the pages that did not fit (chapter 3; fixtures promise/events-split-delivery.json, receipt-box-then-ack.json)', () => {
  const event = (n: number): InventoryEvent => ({ id: `skill:q70:1:1:${n}`, obsSeq: 10, item: 'cobblestone', count: -1, reason: 'placed', deliverySeq: n });
  const page = (from: number, to: number, total: number, extra: Record<string, unknown> = {}) => JSON.stringify({ command: 'skill:q70', from, to, total, nextSeq: to + 1, done: to + 1 >= total,
    lost: false, events: Array.from({ length: to - from + 1 }, (_, index) => event(from + index)), ...extra });
  const body = (f: Rig, pages: Record<number, string>) => {
    // The body answers the internal `events` command with the page for its fromSeq.
    const timer = setInterval(() => {
      for (const command of f.handed.filter(item => item.skill === 'events')) {
        if (f.receipts.some(receipt => receipt.id === command.id) || f.store.receipt(command.id)) continue;
        const from = Number((command.arguments as { fromSeq: number }).fromSeq);
        f.receipts.push(completed(command.id, { result: pages[from] ?? '{}' }));
      }
      f.poll();
    }, 5);
    closers.push(() => clearInterval(timer));
  };
  it('reads a reply page and refuses what is not one', () => {
    expect(readEventsReply(page(120, 239, 340))).toMatchObject({ from: 120, to: 239, total: 340, nextSeq: 240, done: false, lost: false });
    expect(readEventsReply(page(120, 239, 340))!.events).toHaveLength(120);
    expect(readEventsReply('{}')).toBeNull();
    expect(readEventsReply(undefined)).toBeNull();
    expect(readEventsReply(JSON.stringify({ command: 'c', from: 0, to: 1, total: 2, nextSeq: 2, done: 'yes', lost: false, events: [] }))).toBeNull();
  });
  it('takes the pages of 340 events in two requests (120 in the receipt), stores each before it is acknowledged, and a range asked twice is the same events', async () => {
    const f = rig();
    insert(f, 'skill:q70');
    f.running.push('skill:q70');
    f.poll();
    const pages = { 120: page(120, 239, 340), 240: page(240, 339, 340) };
    body(f, pages);
    const got = await f.control.fetchEvents({ command: 'skill:q70', context: f.context, lease, fromSeq: 120, total: 340 });
    expect(got).toMatchObject({ lost: false, complete: true, nextSeq: 340 });
    expect(got.events.map(item => item.deliverySeq)).toEqual(Array.from({ length: 220 }, (_, index) => 120 + index));
    expect(f.store.row('skill:q70')!.fetchSeq).toBe(340);
    // Each page's receipt is in the store (the box): read again with no body at all.
    const stored = storedPages(f.store, 'skill:q70', 120, 340);
    expect(stored).toMatchObject({ lost: false, complete: true, nextSeq: 340 });
    expect(stored.events.map(item => item.id)).toEqual(got.events.map(item => item.id));
    const again = await f.control.fetchEvents({ command: 'skill:q70', context: f.context, lease, fromSeq: 120, total: 340 });
    expect(again.events.map(item => item.id)).toEqual(got.events.map(item => item.id));
    expect(f.handed.filter(command => command.id === eventsCommandId('skill:q70', 120))).toHaveLength(1);
    expect(f.store.state(eventsCommandId('skill:q70', 120))).toBe('settled_known');
  });
  it('a page the body lost (a restart) is `lost`: the difference is the ledger\'s unexplained, not a mystery', async () => {
    const f = rig();
    insert(f, 'skill:q70');
    f.running.push('skill:q70');
    f.poll();
    body(f, { 120: JSON.stringify({ command: 'skill:q70', from: 120, to: 120, total: 340, nextSeq: 340, done: true, lost: true, events: [] }) });
    const got = await f.control.fetchEvents({ command: 'skill:q70', context: f.context, lease, fromSeq: 120, total: 340 });
    expect(got).toMatchObject({ lost: true, complete: true, events: [] });
    // The ledger takes `lost` as it is given (`LedgerInput.lost`): nothing here is booked as consumed.
    const seen: LedgerSeen = emptyLedgerSeen();
    const result = applyLedger([], seen, { events: [], observation: null, at: AT, lost: true } as LedgerInput);
    expect(result.added).toEqual([]);
  });
  it('takes the events a receipt carries: the hands\' deltas and the older passes\' events, once each, in the delivery order', () => {
    const result = actResult([{ status: 'done', delta: [event(1), event(0)] }, { status: 'done', delta: [event(1), event(2)] }],
      { earlierEvents: [event(0)], eventsMore: { command: 'skill:q70', nextSeq: 3, total: 5 } });
    const taken = eventsOfReceipt({ result, eventsMore: undefined });
    expect(taken.events.map(item => item.id)).toEqual([0, 1, 2].map(n => `skill:q70:1:1:${n}`));
    expect(taken.more).toEqual({ command: 'skill:q70', nextSeq: 3, total: 5 });
  });
});

// ---- 6. the result words ------------------------------------------------------------------------------------------------------------------------------
describe('the words of a result: facts only, from the two axes (fixtures result/r43…, r45-hold…, attack-target-lost…)', () => {
  const textOf = (sample: Record<string, any>, extra: Record<string, unknown> = {}): string => {
    const lines = sample.expected.lines as Array<Record<string, unknown>>;
    const done = lines.filter(line => line.status === 'done').length;
    const result = JSON.stringify({ v: 1, ok: done === lines.length, done, of: lines.length, ms: 3000, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20,
      lines: lines.map(line => ({ line: '', ...line })), outcome: { ...sample.expected.outcome, life: 3 }, ...extra });
    return llmcResult(MC_ACT_TOOL, completed('x', { result, unit: sample.expected.receiptUnit }), null).text;
  };
  it('r43-reflex-ate-first: the eat that found nothing to do is 既に済', () => {
    const sample = fixture('result/r43-reflex-ate-first.json');
    const text = textOf(sample);
    for (const word of sample.expected.headResultText.mustContain) expect(text).toContain(word);
    expect(text).toContain('act 全部済み');
  });
  it('an act whose every hand was already satisfied says so and does not claim it did anything', () => {
    const result = JSON.stringify({ v: 1, ok: true, done: 1, of: 1, ms: 80, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'eat', status: 'done', line: '満腹', goal: 'already', end: 'finished', code: 'food_full', motorOps: 0 }], outcome: { goal: 'already', end: 'finished', life: 1 } });
    const text = actResultText(readActResult(result)!);
    expect(text).toContain('act 既に済み');
    expect(text).toContain('何も変えていない');
  });
  it('r45-hold1-go-partial: how far, from where it stopped, and from the end of the search', () => {
    const text = textOf(fixture('result/r45-hold1-go-partial.json'));
    expect(text).toContain('27.5 m');
    expect(text).toContain('(161,33,214)');
    expect(text).toContain('道探しの先端からは 10 m');
    expect(text).toContain('掘 61');
    expect(text).toContain('途中まで');
  });
  it('r45-hold2-local-go-partial: the path that was found, and the time ran out', () => {
    const sample = fixture('result/r45-hold2-local-go-partial.json');
    const progress = { ...sample.expected.line.progress, lastSearch: { status: 'success', len: 5, nodes: 120, ms: 900 } };
    const result = JSON.stringify({ v: 1, ok: false, done: 0, of: 1, stoppedBy: 'deadline', ms: 60_000, at: { x: 212, y: 61, z: 201 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'go', status: 'stopped', line: 'go 止まった limit_time', goal: 'partial', end: 'finished', code: 'limit_time', progress }] });
    expect(llmcResult(MC_ACT_TOOL, completed('x', { outcome: 'failed', result }), null).text).toContain('道は見つかっていた（5 歩）');
  });
  it('r45-hold10-goal-blocked: road 0, round the goal, and what blocks it', () => {
    const sample = fixture('result/r45-hold10-goal-blocked.json');
    const result = JSON.stringify({ v: 1, ok: false, done: 0, of: 1, ms: 5000, at: { x: 176, y: 14, z: 197 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'go', status: 'stopped', line: 'go 止まった search_timeout', ...sample.expected.line, goal: 'partial', end: 'finished' }] });
    const text = llmcResult(MC_ACT_TOOL, completed('x', { outcome: 'failed', result }), null).text;
    for (const word of sample.expected.textMustContain) expect(text, word).toContain(word);
  });
  it('r45-resume1: a go that was called and moved nothing is "not started", and the act is not started', () => {
    const sample = fixture('result/r45-resume1-dig-already-go-no-floor.json');
    const result = JSON.stringify({ v: 1, ok: false, done: 1, of: 2, ms: 22, at: { x: 161, y: 33, z: 214 }, hp: 20, food: 20, lines: sample.expected.lines.map((line: any) => ({ line: '', ...line })),
      outcome: { ...sample.expected.outcome, life: 3 } });
    const read = readActResult(result)!;
    expect(actOutcomeOf(read)).toMatchObject({ goal: 'not_started', end: 'finished' });
    const text = actResultText(read);
    expect(text).toContain('始めていない（手は呼んだが体を動かす操作は 0）');
    expect(text).toContain('既に済');
  });
  it('attack-target-lost: the target went out of sight, the result is not known (never failed, never done)', () => {
    const result = JSON.stringify({ v: 1, ok: false, done: 0, of: 1, ms: 4000, at: { x: 0, y: 64, z: 0 }, hp: 18, food: 20,
      lines: [{ i: 1, do: 'attack', status: 'stopped', line: '倒したか離れて消えた', goal: 'unknown', end: 'finished', code: 'target_lost', motorOps: 3 }] });
    const read = readActResult(result)!;
    expect(actOutcomeOf(read).goal).toBe('unknown');
    expect(actResultText(read)).toContain('結果は不明（相手を見失った');
  });
  it('a hand not run because it relied on one that failed says whose, and a cut says by what', () => {
    const result = JSON.stringify({ v: 1, ok: false, done: 1, of: 3, stoppedBy: 'reflex', ms: 900, at: { x: 0, y: 64, z: 0 }, hp: 9, food: 20,
      lines: [{ i: 1, do: 'go', status: 'stopped', line: '反射', goal: 'partial', end: 'cut', cutBy: 'reflex', motorOps: 4 },
        { i: 2, do: 'craft', status: 'skipped', line: '未実行', goal: 'not_started', end: 'not_run', code: 'depends_failed:1' }] });
    const text = actResultText(readActResult(result)!);
    expect(text).toContain('頼る手 1 が済まなかったので動かさなかった');
    expect(text).toContain('反射で止められた');
  });
  it('a reflex\'s handover is a fact: whose, how long it waited, the shield', () => {
    const result = JSON.stringify({ v: 1, ok: true, done: 1, of: 1, ms: 9000, at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, lines: [{ i: 1, do: 'fight', status: 'done', line: '倒した' }],
      handover: { from: 'melee', target: 1954, waitedMs: 6400, reflexSettledAt: AT, confirmed: true, shield: 'kept' } });
    const text = actResultText(readActResult(result)!);
    expect(text).toContain('反射 melee から引き継いだ: 相手 #1954 を 6.4 秒待った後');
    expect(text).toContain('盾は下げなかった');
  });
  it('fills goal and end for a result of a body before the contract, by the table\'s statusMap', () => {
    const read = readActResult(actResult([{ status: 'done' }, { status: 'stopped' }, { status: 'skipped' }], { stoppedBy: 'stopIf' }))!;
    expect(read.lines.map(line => [line.goal, line.end])).toEqual([['done', 'finished'], ['partial', 'cut'], ['not_started', 'not_run']]);
    expect(actOutcomeOf(read)).toMatchObject({ goal: 'partial', end: 'cut', cutBy: 'stopIf' });
  });
  it('adds nothing to a plain result: a done hand and a plain failure keep their lines as they were', () => {
    const text = actResultText(readActResult(actResult([{ status: 'done', line: '待った' }]))!);
    expect(text).not.toContain('事実:');
  });
  it('resume: the first line of a skip, of a resent act, and of one held again', () => {
    const order = fixture('result/resume-order.json');
    expect(skipWords({ item: 'q3', hand: order.input.cases[0].held.hand, code: order.input.cases[0].held.code }))
      .toEqual(expect.stringContaining(order.expected.cases[0].firstLine.mustContain[0]));
    expect(skipWords({ item: 'q3', code: 'search_timeout' })).toContain('search_timeout');
    expect(replayWords('q12')).toContain(order.expected.cases[1].firstLine.mustContain[0]);
    const again = fixture('result/r45-resume9-replay-holds-again.json');
    const words = heldAgainWords({ replayCode: again.input.replay.code, dropped: again.input.droppedMeanwhile.map((entry: any) => ({ item: entry.item, why: entry.why })) });
    for (const word of again.expected.firstLineAfterNextResume.mustContain) expect(words, word).toContain(word);
  });
});

// ---- 7. the queue -------------------------------------------------------------------------------------------------------------------------------------
describe('the queue: the head reads what the body decided and takes nothing off by the order results came in (chapter 2)', () => {
  function setup(options: Partial<QueueDeps> & { rig?: Rig } = {}) {
    const f = options.rig ?? rig();
    const lines: string[] = [], rows: QueueRecordRow[] = [];
    const queue = createLlmcQueue({ control: f.control, taskId: 't1', lease, bodyId: () => 'minecraft:world', observe: () => f.control.observe('minecraft:world'), log: line => lines.push(line),
      context: () => f.context, record: row => rows.push(row), headBoot: 'hb-1', step: 41, ...options });
    closers.push(() => queue.stop());
    let counter = 0;
    const spec = (hands: ActInput['hands'], extra: Partial<ActInput> = {}, node: string | null = 'p1'): QueueAdd => {
      counter += 1;
      const input: ActInput = { hands, why: `[${node ?? 'p0'}] 項目${counter}`, ...extra };
      return { call: { id: `c${counter}`, name: 'mc.act', input }, operationId: `step:c${counter}`, input, arguments: input as unknown as Record<string, unknown>, skill: 'act', node,
        why: input.why ?? '', fixes: [] as string[], maxMs: 20_000 };
    };
    const take = () => {
      f.poll();
      const ids = f.handed.filter(command => command.skill === 'act').map(command => command.id);
      f.running.splice(0, f.running.length, ...ids.slice(0, 1));
      f.queued.splice(0, f.queued.length, ...ids.slice(1));
      f.poll();
    };
    return { f, queue, spec, take, lines, rows };
  }
  const wait1 = [{ do: 'wait' as const, seconds: 1 }];
  const dig = (x: number) => [{ do: 'dig' as const, at: [{ x, y: 64, z: 0 }] }];
  const settle = () => delay(60);
  const idOf = (f: Rig, item: string) => f.handed.find(command => command.queue?.item === item)!.id;

  it('names the queue by task, head boot and step, carries dependsOn and madeIn in the envelope, and keeps `after`', async () => {
    const { f, queue, spec } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1), { dependsOn: ['q1'] }));
    await queue.add(spec(dig(2), { dependsOn: [] }));
    f.poll();
    const envelopes = f.handed.filter(command => command.skill === 'act').map(command => command.queue!);
    expect(envelopes.map(envelope => envelope.queue)).toEqual(['t1:hb-1:41', 't1:hb-1:41', 't1:hb-1:41']);
    expect(envelopes.map(envelope => envelope.dependsOn)).toEqual([undefined, ['q1'], []]);
    expect(envelopes[0]!.madeIn).toEqual({ life: 3, dim: 'overworld', dimSince: AT, bodyBoot: 'bb-1', connectionId: 'connection', headBoot: 'hb-1', obsSeq: expect.any(Number) });
    expect(envelopes.map(envelope => envelope.after)).toEqual([null, 'q1', 'q2']);
    expect(madeInOf(null, 'hb-1')).toBeNull();
  });
  it('sends no madeIn when the observation has no life (a body before the contract)', async () => {
    const { f, queue, spec } = setup({ rig: rig({ life: false }) });
    await queue.add(spec(wait1));
    f.poll();
    expect(f.handed.find(command => command.skill === 'act')!.queue!.madeIn).toBeUndefined();
  });
  it('cross-step-depends-refused: a mark of an earlier step\'s queue is refused before it is sent, saying which marks can be relied on', async () => {
    const { f, queue, spec } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1)));
    const refused = await queue.add(spec(dig(2), { dependsOn: ['q9'] }));
    expect(refused.ok).toBe(false);
    const text = (refused as { text: string }).text;
    for (const word of fixture('continue/cross-step-depends-refused.json').expected.textMustContain.filter((word: string) => !/^q1[23]$/u.test(word))) expect(text, word).toContain(word);
    expect(text).toContain('今の列で頼れるのは q1・q2');
    expect(text).toContain('送らなかった: dependsOn の q9 は前の段の列（今の列で頼れるのは');
    expect(f.handed.filter(command => command.skill === 'act')).toHaveLength(0);
    f.poll();
    expect(f.handed.filter(command => command.skill === 'act')).toHaveLength(2);
  });
  it('a failed item does NOT take the independent one behind it off: the head cancels nothing, reads startedAt and droppedBecause from the receipts', async () => {
    const { f, queue, spec, take } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec([{ do: 'wait', seconds: 30 }], { dependsOn: [] }));
    await queue.add(spec(dig(2), { dependsOn: ['q1'] }));
    take();
    queue.mark();
    const q1 = idOf(f, 'q1'), q2 = idOf(f, 'q2'), q3 = idOf(f, 'q3');
    f.running.shift();
    f.receipts.push(completed(q1, { outcome: 'failed', result: actResult([{ status: 'stopped', do: 'go', goal: 'failed', end: 'finished', motorOps: 2 }], { ok: false, stoppedBy: 'failure' }),
      unit: { goal: 'failed', end: 'finished', released: true } }));
    f.receipts.push({ ...completed(q3, { outcome: 'failed', failureType: 'queue_dropped', result: undefined, unit: { goal: 'not_started', end: 'not_run', released: true,
      droppedBecause: { code: 'depends_failed', item: { queue: 't1:hb-1:41', item: 'q1' } } } }) });
    f.running.push(q2);
    f.queued.splice(0, 2);
    const reply = f.poll();
    await settle();
    // The head has cancelled nothing: the body is running q2.
    expect(reply.cancel).toEqual([]);
    expect(queue.open()).toBe(true);
    const news = queue.take();
    expect(news.map(item => [item.item, item.kind, item.result.ok])).toEqual([['q1', 'ran', false], ['q3', 'dropped', false]]);
    expect(news[1]!.result.text).toContain('頼る項目 q1 が止まった');
    // The head wakes the model at once (the failure), with q2 still open.
    expect(await queue.ready({ signal: new AbortController().signal, drain: false })).toBe('alert');
    expect(queue.tail()).toBe('q2');
    // q2 goes on and ends well: the queue is empty.
    f.running.shift();
    f.receipts.push(completed(q2, { result: actResult([{ status: 'done' }]), unit: { goal: 'done', end: 'finished', released: true, startedAt: AT, keptDespite: { item: { queue: 't1:hb-1:41', item: 'q1' }, code: 'failed' } } }));
    f.poll();
    await settle();
    const [kept] = queue.take();
    expect(kept!.result.text).toContain('この項目は頼っていなかったので動かした');
    expect(await queue.ready({ signal: new AbortController().signal, drain: false })).toBe('empty');
  });
  it('an item the body dropped because of a death or another dimension says so', async () => {
    const { f, queue, spec, take } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1)));
    take();
    const q2 = idOf(f, 'q2');
    f.running.shift();
    f.queued.splice(0, 1);
    f.receipts.push(completed(idOf(f, 'q1'), { outcome: 'cancelled', unit: { goal: 'partial', end: 'cut', released: true }, result: actResult([{ status: 'stopped', goal: 'partial', end: 'cut', cutBy: 'death' }], { ok: false, stoppedBy: 'damage' }) }));
    f.receipts.push(completed(q2, { outcome: 'cancelled', unit: { goal: 'not_started', end: 'not_run', released: true, droppedBecause: { code: 'death' } } satisfies ItemOutcome }));
    f.poll();
    await settle();
    const news = queue.take();
    expect(news[1]!.kind).toBe('dropped');
    expect(news[1]!.result.text).toContain('捨てた: 死んだ（命が変わった）。手は動いていない');
  });
  it('replace-keeps-explicit-independent: the named item and the ones behind it that do not say they are independent go; the independent one stays (the ones that relied on a gone one go too)', async () => {
    const sample = fixture('continue/replace-keeps-explicit-independent.json');
    const { f, queue, spec, take } = setup();
    const hands = (x: number) => dig(x);
    await queue.add(spec(wait1));
    await queue.add(spec(hands(1)));                                   // q2 (the fixture's q13): no dependsOn
    await queue.add(spec(hands(2), { dependsOn: ['q2'] }));            // q3 relies on the gone one (the fixture's q15)
    take();
    queue.mark();
    const replacing = queue.replace(['q2']);
    await delay(100);
    f.poll();
    expect([...f.replies.at(-1)!.cancel].sort()).toEqual([idOf(f, 'q2'), idOf(f, 'q3')].sort());
    for (const id of [idOf(f, 'q2'), idOf(f, 'q3')]) f.receipts.push(completed(id, { outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 取り消された。手は動いていない' }));
    f.queued.splice(0);
    f.poll();
    expect(await replacing).toContain('消した: q2・q3');
    expect(queue.tail()).toBe('q1');
    expect(sample.expected.removed).toEqual(['q13', 'q14', 'q15']);
  });
  it('replace keeps an item that wrote dependsOn [] (the explicit independent one) and cancels the rest', async () => {
    const { f, queue, spec, take } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1)));
    await queue.add(spec(dig(2), { dependsOn: [] }));
    take();
    const replacing = queue.replace(['q2']);
    await delay(100);
    f.poll();
    expect(f.replies.at(-1)!.cancel).toEqual([idOf(f, 'q2')]);
    f.receipts.push(completed(idOf(f, 'q2'), { outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 取り消された。手は動いていない' }));
    f.queued.splice(0, 1);
    f.poll();
    const said = await replacing;
    expect(said).toContain('消した: q2');
    expect(said).toContain('残した（頼っていない）: q3');
    expect(queue.tail()).toBe('q3');
  });
  it('a result unknown: told as that (不明・出し直さない), the stop is handed in at once, no motor item goes meanwhile, and the release is told once', async () => {
    const { f, queue, spec, take, rows } = setup();
    await queue.add(spec(wait1));
    take();
    const q1 = idOf(f, 'q1');
    f.receipts.push(unknownReceipt(q1));
    f.running.length = 0;
    f.poll();
    await delay(40);
    const [news] = queue.take();
    expect(news!.kind).toBe('ran');
    for (const word of fixture('result/unknown-receipt-cleanup.json').expected.headResultText.mustContain) expect(news!.result.text, word).toContain(word);
    expect(f.store.state(q1)).toBe('settled_unknown');
    expect(f.store.row(q1)!.told).toBe(true);
    f.poll();
    const stop = f.handed.filter(command => command.kind === 'stop');
    expect(stop).toHaveLength(1);
    // Nothing that moves the body goes until the release is proved.
    const refused = await queue.add(spec(dig(1)));
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { text: string }).text).toContain('結果が不明');
    expect(f.handed.filter(command => command.skill === 'act' && command.id !== q1)).toHaveLength(0);
    // The stop's receipt proves it.
    f.receipts.push({ id: stop[0]!.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: AT,
      stop: { bodyId: 'minecraft:world', sessionId: stop[0]!.stop!.context.sessionId, generation: 1, requestId: stop[0]!.stop!.requestId, state: 'stopped', inputsReleased: true, observedAt: AT } });
    f.poll();
    await delay(40);
    expect(f.store.state(q1)).toBe('released');
    expect(queue.notes()).toEqual([expect.stringContaining('解放を確かめた（結果は不明のまま）')]);
    expect(queue.notes()).toEqual([]);
    expect(await queue.add(spec(dig(2)))).toMatchObject({ ok: true });
    // The records' rows (TODO(records)): the model was told, and the unknown receipt was received.
    expect(rows.map(row => row.ev)).toEqual(expect.arrayContaining(['unknown_notified', 'received']));
  });
  it('late_real_result: the real receipt after the release is a correction said once, and the ledger takes its events once', async () => {
    const booked: LedgerInput[] = [];
    const { f, queue, spec, take, rows } = setup({ applyLedger: input => { booked.push(input as LedgerInput); } });
    await queue.add(spec(wait1));
    take();
    const q1 = idOf(f, 'q1');
    f.receipts.push(unknownReceipt(q1));
    f.running.length = 0;
    f.poll();
    await delay(40);
    queue.take();
    f.poll();
    const stop = f.handed.find(command => command.kind === 'stop')!;
    f.receipts.push({ id: stop.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: AT,
      stop: { bodyId: 'minecraft:world', sessionId: stop.stop!.context.sessionId, generation: 1, requestId: stop.stop!.requestId, state: 'stopped', inputsReleased: true, observedAt: AT } });
    f.poll();
    await delay(40);
    queue.notes();
    expect(booked).toHaveLength(0);
    const delta: InventoryEvent = { id: `${q1}:1:1:0`, obsSeq: 4, item: 'cobblestone', count: -2, reason: 'placed' };
    f.receipts.push(completed(q1, { result: actResult([{ status: 'done', delta: [delta] }]), unit: { goal: 'done', end: 'finished', released: true } }));
    f.poll();
    f.poll();
    await delay(20);
    const notes = queue.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('訂正');
    expect(notes[0]).toContain('q1');
    expect(booked.map(input => input.events.map(item => item.id))).toEqual([[delta.id]]);
    expect(f.store.state(q1)).toBe('corrected');
    expect(f.store.unsaidCorrections('t1')).toEqual([]);
    expect(rows.map(row => row.ev)).toContain('corrected');
    expect((rows.find(row => row.ev === 'corrected') as StageRow & { ev: 'corrected' }).now).toMatchObject({ goal: 'done' });
  });
  it('books the events of a real result once, with the definitions it was sent with, and the same receipt twice is booked once', async () => {
    const seen: LedgerSeen = emptyLedgerSeen();
    let promises = [{ id: 3, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [], have: 4 }] as never[];
    const inputs: LedgerInput[] = [];
    const { f, queue, spec, take } = setup({ applyLedger: input => { inputs.push(input as LedgerInput); },
      snapshotUses: ids => ids.map(id => ({ id, rev: 1, item: 'planks', count: 4, use: '作業台' })) });
    await queue.add(spec(wait1, { uses: [3] }));
    take();
    const q1 = idOf(f, 'q1');
    expect(f.store.row(q1)!.uses).toEqual([{ id: 3, rev: 1, item: 'planks', count: 4, use: '作業台' }]);
    const event: InventoryEvent = { id: `${q1}:1:1:0`, obsSeq: 4, item: 'spruce_planks', count: -2, reason: 'fuel' };
    f.running.length = 0;
    f.receipts.push(completed(q1, { result: actResult([{ status: 'done', delta: [event] }]) }));
    f.poll();
    f.receipts.push(completed(q1, { result: actResult([{ status: 'done', delta: [event] }]) }));
    f.poll();
    await settle();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ by: { command: q1, item: 'q1' }, uses: [{ id: 3 }] });
    expect(inputs[0]!.events).toEqual([event]);
    // Put to the ledger twice, an event of one id is counted once (LedgerSeen).
    const first = applyLedger(promises, seen, { ...inputs[0]!, at: AT, observation: null });
    promises = first.promises as never[];
    const second = applyLedger(promises, first.ledgerSeen, { ...inputs[0]!, at: AT, observation: null });
    expect([first.added.length, second.added.length]).toEqual([1, 0]);
  });
  it('receipt box: a head that stopped before its plan was committed puts the stored receipts to the ledger again, and then marks them taken', async () => {
    const f = rig();
    const q = insert(f, 'skill:old1', { queue: { item: 'q5', after: null, node: null, maxMs: 1000, startBy: AT, queue: 't1:hb-0:3' } });
    const event: InventoryEvent = { id: 'skill:old1:1:1:0', obsSeq: 4, item: 'oak_planks', count: -1, reason: 'ingredient' };
    f.store.settle(completed(q.id, { result: actResult([{ status: 'done', delta: [event] }]) }));
    const booked: LedgerInput[] = [];
    setup({ rig: f, applyLedger: input => { booked.push(input as LedgerInput); } });
    await delay(30);
    expect(booked.map(input => input.events.map(item => item.id))).toEqual([['skill:old1:1:1:0']]);
    expect(booked[0]!.by).toMatchObject({ command: 'skill:old1', item: 'q5' });
    expect(f.store.unprocessed('t1')).toEqual([]);
    setup({ rig: f, applyLedger: input => { booked.push(input as LedgerInput); } });
    await delay(30);
    expect(booked).toHaveLength(1);
  });
  it('a correction the dead queue never said is said by the next one', async () => {
    const f = rig();
    insert(f, 'skill:old2');
    f.store.settle(unknownReceipt('skill:old2'));
    f.store.markTold('skill:old2');
    f.store.settle(completed('skill:old2', { result: actResult([{ status: 'done' }]) }));
    expect(f.store.state('skill:old2')).toBe('corrected');
    const { queue } = setup({ rig: f });
    expect(queue.notes()).toEqual([expect.stringContaining('訂正')]);
    expect(queue.notes()).toEqual([]);
  });
  it('a resent act says whose second try it is, and wakes with `reflex_capped` when told', async () => {
    const { f, queue, spec, take } = setup();
    await queue.add({ ...spec(wait1), resumeOf: { item: 'q12', command: 'skill:617993e2' } });
    take();
    expect(f.store.row(idOf(f, 'q1'))!.resumeOf).toBe('skill:617993e2');
    f.running.length = 0;
    f.receipts.push(completed(idOf(f, 'q1'), { result: actResult([{ status: 'done' }]) }));
    f.poll();
    await settle();
    expect(queue.take()[0]!.result.text).toContain('保留した q12 の出し直し');
    queue.noteReflexCapped();
    await queue.add(spec(dig(3)));
    expect(await queue.ready({ signal: new AbortController().signal, drain: false })).toBe('reflex_capped');
  });
  it('the live lines show what an item relies on, and what each of those is now', async () => {
    const { f, queue, spec, take } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1), { dependsOn: [] }));
    await queue.add(spec(dig(2), { dependsOn: ['q1', 'q2'] }));
    take();
    const lines = queue.lines(null);
    expect(lines[0]).not.toContain('頼る');
    expect(lines[1]).toContain('頼る: なし');
    expect(lines[2]).toContain('頼る: q1（まだ）・q2（まだ）');
    f.running.shift();
    f.receipts.push(completed(idOf(f, 'q1'), { outcome: 'failed', result: actResult([{ status: 'stopped', goal: 'failed', end: 'finished', motorOps: 1 }], { ok: false, stoppedBy: 'failure' }), unit: { goal: 'failed', end: 'finished', released: true } }));
    f.running.push(idOf(f, 'q2'));
    f.queued.splice(0, 1);
    f.poll();
    await settle();
    expect(queue.lines(null).join(' / ')).toContain('頼る: q1（止まった）・q2（まだ）');
  });
  it('indirect-depends: q1 failed, q2 (relies on q1) and q3 (relies on q2) are dropped by the body, each saying which it relied on; the head cancels none of them', async () => {
    const sample = fixture('continue/indirect-depends.json');
    const { f, queue, spec, take } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1), { dependsOn: ['q1'] }));
    await queue.add(spec(dig(2), { dependsOn: ['q2'] }));
    take();
    f.running.shift();
    f.queued.splice(0);
    f.receipts.push(completed(idOf(f, 'q1'), { outcome: 'failed', unit: { goal: 'failed', end: 'finished', released: true }, result: actResult([{ status: 'stopped', goal: 'failed', end: 'finished', motorOps: 1 }], { ok: false, stoppedBy: 'failure' }) }));
    for (const [item, on] of [['q2', 'q1'], ['q3', 'q2']] as const) {
      f.receipts.push(completed(idOf(f, item), { outcome: 'failed', failureType: 'queue_dropped', unit: { goal: 'not_started', end: 'not_run', released: true,
        droppedBecause: { code: 'depends_failed', item: { queue: 't1:hb-1:41', item: on } } } }));
    }
    const reply = f.poll();
    await settle();
    expect(reply.cancel).toEqual([]);
    const news = queue.take();
    expect(news.map(entry => [entry.item, entry.kind])).toEqual([['q1', 'ran'], ['q2', 'dropped'], ['q3', 'dropped']]);
    expect(news[1]!.result.text).toContain('頼る項目 q1 が止まった');
    expect(news[2]!.result.text).toContain('頼る項目 q2 が止まった');
    expect(Object.keys(sample.expected.queue)).toEqual(['q2', 'q3']);
    expect(await queue.ready({ signal: new AbortController().signal, drain: false })).toBe('dropped');
  });
  it('death-before-depends: the body drops the one with dependsOn [] too (death first); the head does not cancel and does not bring it back when the end of the first one comes later', async () => {
    const { f, queue, spec, take } = setup();
    await queue.add(spec(wait1));
    await queue.add(spec(dig(1), { dependsOn: [] }));
    take();
    queue.mark();
    f.queued.splice(0);
    f.receipts.push(completed(idOf(f, 'q2'), { outcome: 'cancelled', failureType: 'queue_dropped', unit: { goal: 'not_started', end: 'not_run', released: true, droppedBecause: { code: 'death' } } }));
    const reply = f.poll();
    expect(reply.cancel).toEqual([]);
    await settle();
    f.running.shift();
    f.receipts.push(completed(idOf(f, 'q1'), { outcome: 'cancelled', unit: { goal: 'partial', end: 'cut', released: true }, result: actResult([{ status: 'stopped', goal: 'partial', end: 'cut', cutBy: 'death', motorOps: 2 }], { ok: false, stoppedBy: 'damage' }) }));
    f.poll();
    await settle();
    const news = queue.take();
    expect(news.map(entry => [entry.item, entry.kind])).toEqual([['q1', 'ran'], ['q2', 'dropped']]);
    expect(queue.open()).toBe(false);
    expect(queue.stale()).toBe(true);
  });
  it('a queue that starts after the head restarted cleans up what the old start left open before it sends anything that moves the body', async () => {
    const first = rig({ headBoot: 'hb-1' });
    insert(first, 'old1');
    first.store.deliver('old1');
    first.store.confirm('old1');
    const second = rig({ headBoot: 'hb-2', db: first.db });
    const { queue, spec } = setup({ rig: second, headBoot: 'hb-2' });
    await delay(20);
    second.poll();
    expect(second.handed.filter(command => command.kind === 'stop')).toHaveLength(1);
    const refused = await queue.add(spec(dig(1)));
    expect(refused).toMatchObject({ ok: false });
    expect(second.handed.filter(command => command.skill === 'act' && command.id !== 'old1')).toHaveLength(0);
  });
  it('an act whose result is unknown is never sent again by a resume (boundary 8)', () => {
    const f = rig();
    insert(f, 'u1');
    f.store.settle(unknownReceipt('u1'));
    expect(f.store.resultUnknown('u1')).toBe(true);
    f.store.release('u1', 'cleanup', AT, 's');
    expect(f.store.resultUnknown('u1')).toBe(true);
    insert(f, 'u2');
    f.store.settle(completed('u2'));
    expect(f.store.resultUnknown('u2')).toBe(false);
    f.store.settle(completed('u1'));
    expect(f.store.resultUnknown('u1')).toBe(false);
  });
  it('tells the owner of the records when this start of the head first answers a connection', () => {
    const f = rig({ headBoot: 'hb-5' });
    const told: string[] = [];
    f.control.headBootListeners.add(event => told.push(`${event.connectionId}:${event.headBoot}`));
    f.poll();
    f.poll();
    f.setConnection('connection-9');
    f.poll();
    // The first connection was answered while the rig was made; each connection is told once.
    expect(told).toEqual(['connection-9:hb-5']);
  });
});

// ---- 8. the short hands and the checks ---------------------------------------------------------------------------------------------------------------
describe('dependsOn and uses in the short writing and the checks before sending (chapter 2; fixtures continue/act-hand-depends.json, cross-step-depends-refused.json)', () => {
  it('act-hand-depends: the four hands go to lines and back the same, dependsOn [] is none and an absent one stays absent', () => {
    const sample = fixture('continue/act-hand-depends.json');
    const hands = sample.input.act.hands as ActInput['hands'];
    const lines = hands.map(handToLine);
    expect(lines).toEqual([expect.stringMatching(/^go 40,64,0 seconds=30$/u), 'eat bread dependsOn=none', 'craft crafting_table dependsOn=1', 'equip stone_sword']);
    lines.forEach((line, index) => expect(lineToHand(line), line).toEqual(hands[index]));
    expect(lineToHand('dig 1,2,3 dependsOn=1,2')).toEqual({ do: 'dig', at: [{ x: 1, y: 2, z: 3 }], dependsOn: [1, 2] });
    expect(lineToHand('dig 1,2,3 dependsOn=x')).toEqual({ error: expect.stringContaining('dependsOn=') });
    expect(lineToHand('make stick 4 dependsOn= note="木の棒"')).toEqual({ do: 'make', item: 'stick', count: 4, dependsOn: [], note: '木の棒' });
  });
  it('refuses a hand\'s dependsOn that is itself, a later hand, out of range or repeated, before it is sent', () => {
    const hands = (dependsOn: number[]): ActInput => ({ hands: [{ do: 'wait', seconds: 1 }, { do: 'eat', dependsOn }, { do: 'wait', seconds: 1 }] });
    expect(actProblem(hands([1]))).toBeNull();
    expect(actProblem(hands([]))).toBeNull();
    expect(actProblem(hands([2]))).toContain('手2（eat）: 手 2 が自分に頼っている');
    expect(actProblem(hands([3]))).toContain('まだ先の手 3 に頼っている');
    expect(actProblem(hands([9]))).toContain('範囲外');
    expect(actProblem({ hands: [{ do: 'wait', seconds: 1 }, { do: 'wait', seconds: 1, dependsOn: [1, 1] }] })).toContain('2 度');
    expect(handDependsProblem(2, [1], 3)).toBeNull();
  });
  it('reads and writes the act\'s own dependsOn (marks) and uses (promise numbers), in the short writing', () => {
    const written = { hands: ['wait 1'], why: '[p1] 作る', dependsOn: ['q12'], uses: [3, 4] };
    const { input, errors } = expandShortAct(written);
    expect(errors).toEqual([]);
    expect(input).toMatchObject({ dependsOn: ['q12'], uses: [3, 4] });
    expect(expandShortAct({ hands: ['wait 1'], dependsOn: 'q12,q13', uses: '3' }).input).toMatchObject({ dependsOn: ['q12', 'q13'], uses: [3] });
    expect(expandShortAct({ hands: ['wait 1'], dependsOn: 'none' }).input).toMatchObject({ dependsOn: [] });
    expect(shortHandProblem(expandShortAct({ hands: ['wait 1'], uses: 'x' }).input)).toContain('uses の書き方の誤り');
    expect(actToShort(input as ActInput)).toMatchObject({ dependsOn: ['q12'], uses: [3, 4] });
    expect(actProblem({ hands: [{ do: 'wait', seconds: 1 }], dependsOn: ['q12'], uses: [3] })).toBeNull();
    expect(actProblem({ hands: [{ do: 'wait', seconds: 1 }], dependsOn: ['x'] })).toContain('dependsOn は列の項目');
    expect(actProblem({ hands: [{ do: 'wait', seconds: 1 }], dependsOn: ['q1', 'q1'] })).toContain('2 度');
  });
  it('the tool description names dependsOn and uses, and the line that dropped what waits says what stays (the tokens added are measured)', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('dependsOn=1,3');
    expect(SHORT_ACT_DESCRIPTION).toContain('欄 dependsOn');
    expect(SHORT_ACT_DESCRIPTION).toContain('dependsOn が [] か、止まった項目を含まない配列の項目は動かす');
    const added = ['- どの手にも onFail=continue|stop を付けられる。dependsOn=1,3 は頼る前の手の番号で、その手が済んでいる時だけ動く（none は何にも頼らない。書かなければ前の手が止まれば止まる）。',
      '  - 欄 dependsOn（["q12"]）: この項目が頼る今の列の項目（前の段の項目は書けない。[] は何にも頼らない）。欄 uses（[3]）: 使う約束の番号。',
      'ただし欄 dependsOn が [] か、止まった項目を含まない配列の項目は動かす。'].join('\n');
    expect(llmcTokens(added)).toBeLessThan(300);
  });
});

// ---- keep the harness honest ----------------------------------------------------------------------------------------------------------------------------
describe('the harness', () => {
  it('ActResult, HoldState and ActInput are the contract\'s types', () => {
    const result: ActResult = { v: 1, ok: true, done: 1, of: 1, ms: 1, at: { x: 0, y: 0, z: 0 }, hp: 20, food: 20, lines: [{ i: 1, do: 'wait', status: 'done', line: '', goal: 'done', end: 'finished' }],
      outcome: { goal: 'done', end: 'finished', life: 1 } };
    const hold: HoldState = 'none';
    expect([actOutcomeOf(result).goal, hold]).toEqual(['done', 'none']);
  });
});
