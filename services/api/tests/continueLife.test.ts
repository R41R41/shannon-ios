import { createHash } from 'node:crypto';
import { onceFor } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { FCA_REDECIDE_MAX, runFcaStep, type FcaStepPorts } from '../src/mind/action/fca/fcaRunner.js';
import { waitForQueue } from '../src/mind/action/fca/fcaStretch.js';
import type { FcaBodyLifecycle, FcaBodyQueue, FcaDecision, FcaModelInput, FcaQueueNews, FcaQueueWake, FcaToolCall, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { combineFcaTools } from '../src/wiring/fcaMinecraftTools.js';
import { sendItem } from '../src/wiring/fcaMinecraftActItem.js';
import { MC_ACT_TOOL, readActResult } from '../src/contracts/minecraftActContract.js';
import { toolOk } from '../src/mind/tools/toolRegistryPorts.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { deathBetween, type ControlView, type DeathCounter, type LifeView, type MadeIn } from '../src/contracts/continueContract.js';
import { MinecraftControl, arrivalOf } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { validControlPoll, validControlView, validLifeView, validObservationState, validUtilities } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { driftOf, lifeViewOf, madeInOf, withMadeIn } from '../src/surfaces/minecraft/minecraftMadeIn.js';
import { controlOf, holderWords } from '../src/surfaces/minecraft/minecraftLlmcControl.js';
import { readInventoryChanged, readReflexCapped, reflexCappedWords } from '../src/surfaces/minecraft/minecraftLlmcBodyEvents.js';
import { createLlmcQueue, forgetLlmcQueues, type LlmcQueue } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { forgetLlmcEvents, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { actFacts, heldAgainWords, replayWords, skipWords } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { llmcStepParts, withResend } from '../src/wiring/minecraftLlmcWiring.js';
import { heldAgainRecord, stopLineOf, waitForResend } from '../src/wiring/minecraftResumeOrder.js';
import { setIncidentHoldPort, type IncidentHoldPort, type IncidentNote } from '../src/wiring/minecraftIncidentHold.js';
import { createOperatorMinecraft, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import type { OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

/**
 * Continue contract 5 (the life), 4 (control) on the head's side, and chapter 8's order of a resume. Against the fixtures `life/*`, `control/*` and
 * `result/{resume-order,r45-resume9-replay-holds-again}`, and against what the body really produced (`fixtures/continue-life-produced/`, small copies of the body's
 * `contracts/continue/produced/`, made at body revision 471050348259; a missing file fails, never skips).
 */
const FIXTURES = join(import.meta.dirname, 'fixtures');
const CONTINUE = join(FIXTURES, 'continue');
const PRODUCED = join(CONTINUE, 'produced');
/** The body revision the copies in `continue-life-produced/` were made at (the body's `contracts/continue/produced/`, copied read-only). */
const BODY_REVISION = 'e30443dc2ca2';
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const fixture = (path: string) => JSON.parse(readFileSync(join(CONTINUE, path), 'utf8')) as { input: any; expected: any; checks: string[] };
const produced = (name: string) => {
  const path = join(PRODUCED, `${name}.json`);
  if (!existsSync(path)) throw new Error(`the body's produced file ${name} is missing from ${PRODUCED}`);
  return JSON.parse(readFileSync(path, 'utf8')) as { producedBy: string; bench: string; bodyRevision: string; answers: string | null; fixtureSha256: string | null; output: any };
};

// ---- a body played by hand --------------------------------------------------------------------------------------------------------------------------------
const AT = '2026-10-28T12:00:00.000Z';
const BODY = 'minecraft:world';
const LOOSE = { type: 'object', properties: {}, required: [], additionalProperties: false };
const lifeView = (over: Partial<LifeView> = {}): LifeView => ({ life: 2, deathEpoch: 'de-1', deathSeq: 1, since: AT, alive: true, dimension: 'overworld', dimensionSince: AT, ...over });
const bodyRun = (over: Partial<{ bodyBoot: string; connectionId: string }> = {}) => ({ bodyBoot: 'bb-1', connectionId: 'c-1', ...over });
interface Frame { life?: LifeView | null; run?: { bodyBoot: string; connectionId: string } | null; control?: unknown; connection?: string; connected?: boolean; events?: unknown[];
  receipts?: MinecraftControlReceipt[]; active?: string[]; queued?: string[]; facts?: Record<string, unknown>; utilities?: unknown; headBoot?: string }

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); forgetLlmcQueues(); forgetLlmcEvents(); setIncidentHoldPort(null); });

function rig(options: { headBoot?: string } = {}) {
  const db = new DatabaseSync(':memory:'), store = new MinecraftControlStore(db);
  closers.push(() => { try { db.close(); } catch { /* closed */ } });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  let clock = Date.parse(AT), sequence = 0;
  const control = new MinecraftControl(store, configuration, { now: () => clock, ownerAlone: () => true, leaseValid: () => true, leaseKnown: () => true, pollMilliseconds: 1,
    cancelWaitMilliseconds: 50, frameMilliseconds: 600_000, ...options });
  const handed: MinecraftControlCommand[] = [];
  /** One poll of the body: the life it is in, who it is, what it runs, what it has to say. */
  const send = (frame: Frame = {}) => {
    clock += 1_000;
    const life = frame.life === undefined ? lifeView() : frame.life, run = frame.run === undefined ? bodyRun({ connectionId: frame.connection ?? 'connection' }) : frame.run;
    const stateAt = new Date(clock).toISOString();
    const reply = control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
      schemaVersion: 1, serverId: 'world', connectionId: frame.connection ?? 'connection',
      observation: { schemaVersion: 1, bodyId: BODY, sequence: sequence++, stateAt, receivedAt: stateAt, connected: frame.connected ?? true,
        state: { world: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20, ...(frame.utilities !== undefined ? { utilities: frame.utilities } : {}) },
          ...(life ? { life } : {}), ...(run ? { bodyRun: run } : {}), ...(frame.control !== undefined ? { control: frame.control } : {}) },
        facts: { alive: life?.alive ?? true, dimension: life?.dimension ?? 'overworld', ...(life ? { life: life.life } : {}), ...(frame.facts ?? {}) } },
      skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: LOOSE }, { name: 'view', description: 'view', readOnly: true, inputSchema: LOOSE }], candidates: [],
      receipts: [...(frame.receipts ?? [])], activeOperationIds: [...(frame.active ?? [])], queuedOperationIds: [...(frame.queued ?? [])], ...(frame.events ? { events: frame.events } : {}),
    } as unknown as MinecraftControlPoll);
    handed.push(...reply.commands);
    return reply;
  };
  return { control, store, db, send, handed, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
type Rig = ReturnType<typeof rig>;
const observationOf = (r: Rig) => r.control.observe(BODY)!;

// ---- 1. the death counter, the arrival, the frame a decision read --------------------------------------------------------------------------------------------
describe('a death is a rise of deathSeq within one deathEpoch (fixtures life/death-epoch-pair, life-file-unreadable)', () => {
  const pair = fixture('life/death-epoch-pair.json');
  it('judges the two observations as the fixture says, and an epoch that changed is no death', () => {
    const known: DeathCounter = pair.input.headKnows;
    const by = (obs: { deathEpoch: string; deathSeq: number }) => deathBetween(known, obs);
    expect(by(pair.input.observations[0]).death).toBe(pair.expected.judgements[0].death);
    expect(by(pair.input.observations[1]).death).toBe(pair.expected.judgements[1].death);
    // The observation the head missed: the change of epoch alone is no death, and its counter is remembered.
    expect(by(pair.input.missed)).toEqual({ death: false, counter: { deathEpoch: 'de-2', deathSeq: 0 } });
    // The chain: de-1/3, (de-2/0 missed), de-2/1 is a death, de-3/0 is not.
    const chained = deathBetween(by(pair.input.observations[0]).counter, pair.input.observations[1]);
    expect(chained).toEqual({ death: false, counter: { deathEpoch: 'de-3', deathSeq: 0 } });
    // A life number alone, a first sight, and an observation without a counter tell nothing.
    expect(deathBetween(null, { deathEpoch: 'de-9', deathSeq: 4 }).death).toBe(false);
    expect(deathBetween(known, {}).death).toBe(false);
  });

  it('the control reads it in its polls: a death moves the arrival, a new epoch does not', () => {
    const r = rig();
    r.send({ life: lifeView({ life: 7, deathEpoch: 'de-1', deathSeq: 3 }) });
    expect(r.control.arrivalKind(BODY)).toBe('login');
    const login = r.control.arrivedAt(BODY);
    r.advance(30_000);
    r.send({ life: lifeView({ life: 8, deathEpoch: 'de-2', deathSeq: 1, alive: false, advancedBy: 'death' }) });
    expect(r.control.arrivalKind(BODY)).toBe('death');
    expect(r.control.arrivedAt(BODY)!).toBeGreaterThan(login!);
    r.send({ life: lifeView({ life: 8, deathEpoch: 'de-2', deathSeq: 1 }) }); // alive again: the same death
    const settled = r.control.arrivedAt(BODY)!;
    r.send({ life: lifeView({ life: 8, deathEpoch: 'de-3', deathSeq: 0 }) });
    expect(r.control.arrivalKind(BODY)).toBe('death');
    expect(r.control.arrivedAt(BODY)).toBe(settled);
  });

  it('a life file that could not be read: the number jumps and every old command is stale, but it is no death (life/life-file-unreadable)', () => {
    const unreadable = fixture('life/life-file-unreadable.json').expected.cases[1];
    const before = lifeView({ life: 7, deathEpoch: 'de-1', deathSeq: 3 });
    const after = lifeView({ life: unreadable.life, advancedBy: 'file_unreadable', deathEpoch: 'de-new', deathSeq: 0 });
    const r = rig();
    r.send({ life: before });
    const read = madeInOf(observationOf(r), 'hb-1')!;
    const arrivedAt = r.control.arrivedAt(BODY);
    r.send({ life: after });
    expect(r.control.arrivedAt(BODY)).toBe(arrivedAt);
    expect(arrivalOf(undefined, observationOf(r), false, false)).toBe('login');
    expect(deathBetween({ deathEpoch: 'de-1', deathSeq: 3 }, after).death).toBe(unreadable.head.lostDeath);
    expect(driftOf(read, observationOf(r))).toBe('life_changed'); // the old commands are invalid whatever the reason
    expect(unreadable.head.arrival).toBe('not_death');
  });

  it('what the body really produced: the death counter rises by one and the control tells it a death; the unreadable file is no death', () => {
    const made = produced('life--death-epoch-pair'), file = produced('life--life-file-unreadable');
    const r = rig();
    r.send({ life: made.output.first });
    r.send({ life: made.output.afterDeath });
    expect(r.control.arrivalKind(BODY)).toBe('death');
    expect(deathBetween(made.output.first, made.output.afterDeath).death).toBe(true);
    expect(file.output.notes).toContain('life_file_unreadable');
    expect(deathBetween(file.output.missing, file.output.corrupt).death).toBe(false);
    expect(file.output.corrupt.advancedBy).toBe('file_unreadable');
  });
});

describe('a portal is not a death (fixture life/portal-is-not-death)', () => {
  const sample = fixture('life/portal-is-not-death.json');
  const view = (over: Partial<LifeView>) => lifeView({ deathEpoch: 'de-p', ...over });
  const frameOf = (life: LifeView): BodyObservation => ({ schemaVersion: 1, bodyId: BODY, sequence: 1, stateAt: AT, receivedAt: AT, connected: true, state: { life: life as never },
    facts: { alive: life.alive, dimension: life.dimension, life: life.life } });
  it('tells the dimension, the death, and then nothing for the body that is alive again', () => {
    const steps = [view({ life: 5, deathSeq: 4 }), view({ life: 5, deathSeq: 4, dimension: 'the_nether', dimensionSince: '2026-10-28T12:01:00.000Z' }),
      view({ life: 6, deathSeq: 5, alive: false, advancedBy: 'death', dimension: 'the_nether', dimensionSince: '2026-10-28T12:01:00.000Z' }),
      view({ life: 6, deathSeq: 5, alive: true, advancedBy: 'death', dimension: 'overworld', dimensionSince: '2026-10-28T12:02:00.000Z' })];
    const kinds: Array<string | null> = [];
    let counter: DeathCounter | null = { deathEpoch: 'de-p', deathSeq: 4 };
    for (let index = 1; index < steps.length; index += 1) {
      const counted = deathBetween(counter, steps[index]!);
      counter = counted.counter;
      kinds.push(arrivalOf(frameOf(steps[index - 1]!), frameOf(steps[index]!), false, counted.death));
    }
    expect(kinds).toEqual(sample.expected.headArrivalKinds);
    expect(steps.map(step => step.life).slice(1)).toEqual(sample.expected.lifeAfterEach.map((life: number, index: number) => index === 0 ? life : life));
  });

  it('the real life views of the body: the portal leaves the death counter, the next death raises it by one', () => {
    const made = produced('life--portal-is-not-death').output;
    expect(made.netherLife.dimension).toBe('the_nether');
    expect(made.netherLife.life).toBe(made.lifeBefore);
    const overworld = { ...made.netherLife, dimension: 'overworld', dimensionSince: '2026-10-28T12:18:00.000Z' };
    expect(arrivalOf(frameOf(overworld), frameOf(made.netherLife), false, deathBetween(overworld, made.netherLife).death)).toBe('dimension');
    expect(deathBetween(made.netherLife, made.afterDeathLife).death).toBe(true);
    expect(arrivalOf(frameOf(made.netherLife), frameOf(made.afterDeathLife), false, true)).toBe('death');
    // The body's refusal of the old command is the body's; the head reads it as a command that never ran.
    expect(made.oldCommand).toMatchObject({ failureType: 'dimension_changed', unit: { goal: 'not_started', end: 'not_run', released: true } });
  });

  it('alive again after a death keeps the arrival (the death) and the body settles from now', () => {
    const r = rig();
    r.send({ life: lifeView({ life: 5, deathSeq: 4 }) });
    r.send({ life: lifeView({ life: 6, deathSeq: 5, alive: false }) });
    const died = r.control.arrivedAt(BODY)!;
    r.send({ life: lifeView({ life: 6, deathSeq: 5, alive: true }) });
    expect(r.control.arrivalKind(BODY)).toBe('death');
    expect(r.control.arrivedAt(BODY)).toBeGreaterThan(died);
  });
});

describe('the frame a decision read is the frame its answer and its commands belong to (fixtures life/reconnect-decision-belongs, same-dimension-return)', () => {
  const read = (r: Rig) => madeInOf(observationOf(r), 'hb-1')!;
  it('names the life, the generation of the dimension, the body and the connection of the frame, and nothing when the frame has none', () => {
    const r = rig();
    r.send({ life: lifeView({ life: 4, dimension: 'the_nether', dimensionSince: '2026-10-28T12:05:00.000Z' }), run: bodyRun({ bodyBoot: 'bb-9', connectionId: 'c-9' }) });
    expect(read(r)).toEqual({ life: 4, dim: 'the_nether', dimSince: '2026-10-28T12:05:00.000Z', bodyBoot: 'bb-9', connectionId: 'c-9', headBoot: 'hb-1', obsSeq: observationOf(r).sequence });
    r.send({ life: null });
    expect(madeInOf(observationOf(r), 'hb-1')).toBeNull();
    r.send({ run: null });
    expect(madeInOf(observationOf(r), 'hb-1')).toBeNull();
    expect(lifeViewOf(null)).toBeNull();
  });

  it('a decision that read connection c-1 is thrown away when the body is on c-2', () => {
    const sample = fixture('life/reconnect-decision-belongs.json');
    const r = rig();
    r.send({ run: bodyRun({ ...sample.input.decisionReadObs }) });
    const asked = read(r);
    r.send({ run: bodyRun({ ...sample.input.now }) });
    expect(driftOf(asked, observationOf(r))).toBe(sample.expected.discarded);
    r.send({ run: bodyRun({ bodyBoot: 'bb-2', connectionId: 'c-1' }) });
    expect(driftOf(asked, observationOf(r))).toBe('connection_changed');
  });

  it('a body that went through the Nether and came back is another generation of the overworld (dimSince), though its dim and its life are the same', () => {
    const sample = fixture('life/same-dimension-return.json');
    const r = rig();
    r.send({ life: lifeView({ life: 2, dimension: 'overworld', dimensionSince: sample.input.decisionReadObs.dimSince }) });
    const asked = read(r);
    r.send({ life: lifeView({ life: 2, dimension: 'the_nether', dimensionSince: sample.input.events[0].dimSince }) });
    expect(driftOf(asked, observationOf(r))).toBe('dimension_changed');
    r.send({ life: lifeView({ life: 2, dimension: 'overworld', dimensionSince: sample.input.events[1].dimSince }) });
    expect(observationOf(r).state).toMatchObject({ life: { dimension: 'overworld' } });
    expect(driftOf(asked, observationOf(r))).toBe(sample.expected.discarded);
  });

  it('a death is life_changed, the connection comes before the life and the life before the dimension (the table of chapter 2)', () => {
    const r = rig();
    r.send({ life: lifeView({ life: 2 }) });
    const asked = read(r);
    expect(driftOf(asked, observationOf(r))).toBeNull();
    r.send({ life: lifeView({ life: 3, deathSeq: 2, dimension: 'the_nether', dimensionSince: '2026-10-28T12:07:00.000Z' }) });
    expect(driftOf(asked, observationOf(r))).toBe('life_changed');
    r.send({ life: lifeView({ life: 3, deathSeq: 2, dimension: 'the_nether', dimensionSince: '2026-10-28T12:07:00.000Z' }), run: bodyRun({ bodyBoot: 'bb-2' }) });
    expect(driftOf(asked, observationOf(r))).toBe('connection_changed');
    expect(driftOf(asked, null)).toBeNull();
  });

  it('puts the life of the frame the decision read into a command, not the newest one', () => {
    const r = rig();
    r.send({ life: lifeView({ life: 2 }) });
    const asked = read(r);
    const context = { scopeKey: 'owner', taskId: 't', taskRevision: 1, bodyId: BODY, sessionId: 's', generation: 1, goal: 'g', completionCondition: 'c' };
    expect(withMadeIn(context, asked)).toMatchObject({ life: 2, headBoot: 'hb-1', madeIn: { life: 2, obsSeq: asked.obsSeq } });
    expect(withMadeIn(context, null)).toBe(context);
  });
});

// ---- 2. the queue: an item carries the frame its decision read; the body's events ----------------------------------------------------------------------------------
function queueRig(options: { headBoot?: string; applyLedger?: (input: any) => unknown; onReflexCapped?: (info: any) => void } = {}) {
  const r = rig(options.headBoot ? { headBoot: options.headBoot } : {});
  r.send();
  const lines: string[] = [], records: Array<{ ev: string }> = [];
  const queue = createLlmcQueue({ control: r.control, taskId: 't1', lease: { id: 'lease-1', generation: 1, holder: 'test' }, bodyId: () => BODY, observe: () => r.control.observe(BODY),
    log: line => lines.push(line), record: row => records.push(row as never),
    context: () => ({ scopeKey: 'owner', taskId: 't1', taskRevision: 1, bodyId: BODY, sessionId: 'session-1', generation: 1, goal: 'g', completionCondition: 'c' }),
    ...(options.applyLedger ? { applyLedger: options.applyLedger } : {}), ...(options.onReflexCapped ? { onReflexCapped: options.onReflexCapped } : {}) });
  closers.push(() => queue.stop());
  let counter = 0;
  const spec = (extra: Record<string, unknown> = {}) => {
    counter += 1;
    const input = { hands: [{ do: 'wait' as const, seconds: counter }], why: `[p1] 項目${counter}` };
    return { call: { id: `c${counter}`, name: MC_ACT_TOOL, input }, operationId: `step:c${counter}`, input, arguments: input as unknown as Record<string, unknown>, skill: 'act',
      node: 'p1', why: input.why, fixes: [] as string[], maxMs: 20_000, ...extra };
  };
  return { r, queue, spec, lines, records };
}

describe('an item carries the frame its decision read (fixture life/r45-death-then-old-attack, head side)', () => {
  it('puts the decision\'s life into the command\'s context and the item\'s envelope, though the body has died since', async () => {
    const q = queueRig();
    q.r.send({ life: lifeView({ life: 2 }) });
    const asked = madeInOf(observationOf(q.r), 'hb-1')!;
    q.r.send({ life: lifeView({ life: 3, deathSeq: 2, alive: true }) });
    expect(await q.queue.add(q.spec({ madeIn: asked }))).toMatchObject({ ok: true, item: 'q1' });
    q.r.send();
    const command = q.r.handed.find(item => item.queue?.item === 'q1')!;
    expect(command.context).toMatchObject({ life: 2, headBoot: 'hb-1', madeIn: { life: 2 } });
    expect(command.queue?.madeIn).toMatchObject({ life: 2, obsSeq: asked.obsSeq });
    const sample = fixture('life/r45-death-then-old-attack.json');
    expect(sample.checks).toContain('頭: context.life は判断の入力の life');
  });

  it('without a frame named (a resumed act, a test) the newest frame is the one', async () => {
    const q = queueRig();
    q.r.send({ life: lifeView({ life: 5, deathSeq: 4 }) });
    await q.queue.add(q.spec());
    q.r.send();
    expect(q.r.handed.find(item => item.queue?.item === 'q1')!.context).toMatchObject({ life: 5 });
    q.r.send({ life: null });
    await q.queue.add(q.spec({ madeIn: null }));
    q.r.send();
    const bare = q.r.handed.find(item => item.queue?.item === 'q2')!;
    expect(bare.context.life).toBeUndefined();
    expect(bare.queue?.madeIn).toBeUndefined();
  });

  it('the body refused it as a command that never ran (stale_life): the item is told as dropped, and nothing is sent again', async () => {
    const q = queueRig();
    q.r.send({ life: lifeView({ life: 2 }) });
    await q.queue.add(q.spec({ madeIn: madeInOf(observationOf(q.r), 'hb-1')! }));
    q.r.send();
    const command = q.r.handed.find(item => item.queue?.item === 'q1')!;
    const made = produced('life--r45-death-then-old-attack').output;
    q.r.send({ life: lifeView({ life: 3, deathSeq: 2 }), receipts: [{ id: command.id, connectionId: 'connection', outcome: 'failed', inputsReleased: true, observedAt: AT,
      failureType: 'stale_life', unit: { goal: 'not_started', end: 'not_run', released: true, droppedBecause: { code: 'stale_life' } } }] });
    await delay(30);
    const news = q.queue.take();
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ kind: 'dropped', item: 'q1' });
    expect(q.r.handed.filter(item => item.queue?.item === 'q1')).toHaveLength(1);
    expect(made.receipt.unit).toMatchObject({ goal: 'not_started', end: 'cut', released: true }); // the body's own produced receipt of a death in the hand
  });

  it('sendItem hands the frame of the decision to the queue as it is (and leaves the queue to read the newest when none is named)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const queue = { open: () => false, async add(spec: Record<string, unknown>) { seen.push(spec); return { ok: true as const, item: 'q9', after: null, startInMs: 1000 }; } } as unknown as LlmcQueue;
    const control = { observe: () => null } as unknown as MinecraftControl;
    const call = { id: 'c', name: MC_ACT_TOOL, input: { hands: [{ do: 'wait', seconds: 1 }], why: 'x' }, operationId: 'op', scopeKey: 'owner', taskId: 't', signal: new AbortController().signal };
    const madeIn: MadeIn = { life: 2, dim: 'overworld', dimSince: AT, bodyBoot: 'bb-1', connectionId: 'c-1', headBoot: 'hb-1', obsSeq: 4 };
    await sendItem({ queue, control, bodyId: BODY, call: call as never, skill: 'act', fixes: [], node: null, frame: null, madeIn });
    await sendItem({ queue, control, bodyId: BODY, call: call as never, skill: 'act', fixes: [], node: null, frame: null });
    await sendItem({ queue, control, bodyId: BODY, call: call as never, skill: 'act', fixes: [], node: null, frame: null, madeIn: null });
    expect(seen[0]).toMatchObject({ madeIn });
    expect(seen[1]).not.toHaveProperty('madeIn');
    expect(seen[2]).toMatchObject({ madeIn: null });
  });
});

describe('the head registers its start with every reply (fixture life/head-boot-registration, head side)', () => {
  it('answers each poll with this start\'s headBoot, and a command carries it in its context and its envelope', async () => {
    const q = queueRig({ headBoot: 'hb-2' });
    expect(q.r.send().headBoot).toBe('hb-2');
    expect(q.r.send({ life: lifeView({ life: 2 }) }).headBoot).toBe('hb-2');
    expect(q.r.control.headBoot()).toBe('hb-2');
    await q.queue.add(q.spec());
    q.r.send();
    const command = q.r.handed.find(item => item.queue?.item === 'q1')!;
    expect(command.context.headBoot).toBe('hb-2');
    expect(command.queue?.madeIn?.headBoot).toBe('hb-2');
    expect(command.queue?.queue).toContain(':hb-2:');
    // Another start of the head is another headBoot (the body drops the earlier one's waiting items and refuses its commands).
    expect(rig({ headBoot: 'hb-3' }).send().headBoot).toBe('hb-3');
    expect(fixture('life/head-boot-registration.json').expected.currentHeadBoot).toBe('hb-2');
  });
});

describe('the body\'s events beside its receipts: a reflex that hit its cap, and a reflex that used the pack (fixture control/melee-capped-bridge)', () => {
  const capped = { seq: 1, at: AT, kind: 'reflex.capped', subject: 'floor-melee', data: { limit: 'melee_hits', count: 6, bridge: 'shield', until: '2026-10-28T12:00:03.000Z' } };
  it('reads the event as the contract has it and says it as a fact', () => {
    const sample = fixture('control/melee-capped-bridge.json');
    const info = readReflexCapped(capped as never)!;
    expect(info).toMatchObject({ reflex: sample.expected.event.subject, limit: sample.expected.event.data.limit, bridge: sample.expected.event.data.bridge });
    expect(reflexCappedWords(info)).toBe('反射 floor-melee が上限に着いた（打ち 6）。盾を構えたままつなぐ（約 3 秒まで）');
    expect(readReflexCapped({ ...capped, data: { ...capped.data, limit: 'bogus' } } as never)).toBeNull();
    expect(readReflexCapped({ ...capped, kind: 'furnace.done' } as never)).toBeNull();
    expect(sample.expected.headUrgent).toBe(true);
  });

  it('the queue wakes the step for it (reflex_capped) once, the live state is told, and a poll that repeats the event changes nothing', async () => {
    const told: string[] = [];
    const q = queueRig({ onReflexCapped: info => told.push(reflexCappedWords(info)) });
    await q.queue.add(q.spec());
    q.r.send({ events: [capped] });
    expect(told).toEqual(['反射 floor-melee が上限に着いた（打ち 6）。盾を構えたままつなぐ（約 3 秒まで）']);
    const signal = new AbortController().signal;
    expect(await q.queue.ready({ signal, drain: false })).toBe('reflex_capped');
    expect(q.records.map(row => row.ev)).toContain('woke');
    q.r.send({ events: [capped] });
    expect(told).toHaveLength(1);
    // Said once: the next ready does not wake for it again.
    const waiting = q.queue.ready({ signal: AbortSignal.timeout(250), drain: false }).catch(() => 'timeout');
    expect(await waiting).not.toBe('reflex_capped');
  });

  it('the step decides again for it, with items still open, as it does for an alert', async () => {
    const fake = { open: () => true, ready: async () => 'reflex_capped' as FcaQueueWake, dropWaiting: () => 0 } as unknown as FcaBodyQueue;
    const parts = (queue: FcaBodyQueue) => ({ ports: { body: { queue } } as unknown as FcaStepPorts, signal: new AbortController().signal, runtime: {} as never, step: { scopeKey: 'owner', taskId: 't', messageIds: [] } as never,
      tools: true, stale: false, round: 1, startedAt: Date.now() });
    expect(await waitForQueue(parts(fake))).toEqual({ continuing: true, wake: 'reflex_capped' });
    expect((await waitForQueue(parts({ ...fake, ready: async () => 'message' } as unknown as FcaBodyQueue))).continuing).toBe(false);
  });

  it('a reflex\'s use of the pack outside any act goes to the ledger once, by its own id; one that does not read does not', async () => {
    const seen: any[] = [];
    const q = queueRig({ applyLedger: input => { seen.push(input); } });
    const event = (seq: number, data: Record<string, unknown>) => ({ seq, at: AT, kind: 'inventory.changed', subject: 'bread', data: { id: 'reflex:connection:7', item: 'bread', count: 1, reason: 'reflex_eat', obsSeq: 5, ...data } });
    q.r.send({ events: [event(1, {})] });
    expect(seen).toHaveLength(1);
    expect(seen[0].events).toEqual([{ id: 'reflex:connection:7', obsSeq: 5, item: 'bread', count: 1, reason: 'reflex_eat' }]);
    expect(seen[0].observation.sequence).toBeGreaterThan(0);
    q.r.send({ events: [event(1, {})] }); // the same poll again (a lost acknowledgement): the log refuses the number
    expect(seen).toHaveLength(1);
    q.r.send({ events: [event(2, { reason: 'bogus', id: 'reflex:connection:8' })] });
    expect(seen).toHaveLength(1);
    expect(q.lines.some(line => line.includes('inventory.changed not read'))).toBe(true);
    expect(readInventoryChanged({ kind: 'inventory.changed', subject: 'bread', data: { id: 'x', item: 'bread', count: 1, reason: 'reflex_eat', obsSeq: 1.5 } })).toBeNull();
    // After the queue stops, the listener is gone.
    q.queue.stop();
    q.r.send({ events: [event(3, { id: 'reflex:connection:9' })] });
    expect(seen).toHaveLength(1);
  });
});

// ---- 3. what the body says it holds ------------------------------------------------------------------------------------------------------------------------
describe('state.control: who holds the body (chapter 4)', () => {
  const since = '2026-10-28T12:00:00.000Z', until = '2026-10-28T12:00:03.000Z';
  it('reads a view and words only the facts', () => {
    const reflex: ControlView = { holder: { kind: 'reflex', actionId: 'a1', reflex: 'floor-melee', priority: 250, target: 2601, since, episode: true }, waiting: [] };
    expect(holderWords(reflex)).toBe('今の持ち主: 反射 floor-melee（相手 #2601）');
    const bridge: ControlView = { holder: { kind: 'bridge', after: 'floor-melee', hold: 'shield', target: 2601, since, until }, waiting: [{ command: 'skill:ab12', since, behind: 'floor-melee' }],
      reflexEpisode: { reflex: 'floor-melee', target: 2601, hands: 3, hits: 6, since }, combatMark: { skill: 'fight', target: 2601, until } };
    expect(holderWords(bridge)).toBe('今の持ち主: つなぎ（floor-melee の後、盾を構えている（相手 #2601）・3 秒まで）。反射 floor-melee の戦いが続いている（手 3・打ち 6（相手 #2601））。戦いの印: fight（相手 #2601）。'
      + '反射の後を待っている命令: skill:ab12（floor-melee の後）');
    expect(holderWords({ holder: { kind: 'idle' }, waiting: [] })).toBe('今の持ち主: いない');
    expect(holderWords({ holder: { kind: 'command', actionId: 'a', command: 'skill:ab12', item: 'q12', life: 3, since }, waiting: [] })).toBe('今の持ち主: 命令 skill:ab12（q12）');
    expect(holderWords({ holder: { kind: 'cleanup', command: 'stop:x', since }, waiting: [] })).toBe('今の持ち主: 片付け（stop:x の停止）');
    expect(holderWords(bridge)).not.toMatch(/すべき|してください/u);
  });

  it('takes the view from an observation, and nothing from one that has none or has a view that does not read', () => {
    const r = rig();
    const view = { holder: { kind: 'idle' }, waiting: [] };
    r.send({ control: view });
    expect(controlOf(observationOf(r))).toEqual(view);
    expect(controlOf(null)).toBeNull();
    expect(controlOf({ ...observationOf(r), state: {} })).toBeNull();
    expect(controlOf({ ...observationOf(r), state: { control: { holder: { kind: 'robot' }, waiting: [] } } })).toBeNull();
  });

  it('the holder the body produced (a command that holds the body, from its hand_start) reads', () => {
    const holder = produced('measure--hand-start').output.handStart.holder;
    const view = { holder, waiting: [] };
    expect(validControlView(view)).toBe(true);
    expect(holderWords(view as ControlView)).toContain('命令 lab:q2');
  });
});

// ---- 4. the head's check of the new fields, and of what the body produced ----------------------------------------------------------------------------------
describe('the poll check reads the new fields of an observation', () => {
  const poll = (state: Record<string, unknown>, facts: Record<string, unknown> = {}, now = Date.parse(AT)): MinecraftControlPoll => ({ schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: BODY, sequence: 1, stateAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), connected: true, state: state as never, facts: facts as never },
    candidates: [], receipts: [], activeOperationIds: [] });
  const now = Date.parse(AT);
  it('takes a body without them, and the real life views of the body', () => {
    expect(validControlPoll(poll({}), now)).toBe(true);
    for (const name of ['life--death-epoch-pair', 'life--portal-is-not-death', 'life--life-file-unreadable', 'life--r45-death-then-old-attack']) {
      for (const [key, value] of Object.entries(produced(name).output)) {
        if (!value || typeof value !== 'object' || !('alive' in (value as object))) continue;
        const life = value as LifeView;
        expect(validLifeView(life), `${name}.${key}`).toBe(true);
        expect(validControlPoll(poll({ life, bodyRun: bodyRun(), world: { dimension: life.dimension } }, { life: life.life }), now), `${name}.${key}`).toBe(true);
      }
    }
  });

  it('refuses a life, a run, a control or a scan that does not read, and a life number below 1', () => {
    const good = { life: lifeView(), bodyRun: bodyRun(), control: { holder: { kind: 'idle' }, waiting: [] } };
    expect(validControlPoll(poll(good, { life: 2 }), now)).toBe(true);
    for (const [name, bad] of [['alive', { ...good, life: { ...lifeView(), alive: 'yes' } }], ['epoch alone', { ...good, life: { ...lifeView(), deathSeq: undefined } }],
      ['advancedBy', { ...good, life: { ...lifeView(), advancedBy: 'magic' } }], ['dimension', { ...good, life: { ...lifeView(), dimension: 'mars' } }],
      ['life 0', { ...good, life: { ...lifeView(), life: 0 } }], ['run', { ...good, bodyRun: { bodyBoot: 'x' } }], ['holder', { ...good, control: { holder: { kind: 'command', command: 'x' }, waiting: [] } }],
      ['waiting', { ...good, control: { holder: { kind: 'idle' } } }], ['utilities', { ...good, world: { utilities: { radius: 8, found: [] } } }]] as const) {
      expect(validControlPoll(poll(bad as never, { life: 2 }), now), name).toBe(false);
    }
    expect(validControlPoll(poll(good, { life: 0 }), now)).toBe(false);
    expect(validControlPoll(poll(good, { life: 1.5 }), now)).toBe(false);
  });

  it('reads the scan of the utilities (chapter 3)', () => {
    expect(validUtilities({ radius: 8, dim: 'overworld', obsSeq: 4, scanned: true, found: [{ block: 'crafting_table', at: { x: 1, y: 64, z: 2 }, distance: 3.2 }] })).toBe(true);
    expect(validUtilities({ radius: 8, scanned: false, found: [] })).toBe(true);
    expect(validUtilities({ radius: 0, scanned: true, found: [] })).toBe(false);
    expect(validUtilities({ radius: 8, scanned: true, found: [{ block: 'chest' }] })).toBe(false);
    expect(validObservationState({ world: { utilities: { radius: 8 } } }, {})).toBe(false);
  });
});

describe('what the body produced goes through the head\'s readers (chapter 9; the files are copies made at one body revision, and each names the fixture it answers)', () => {
  const files = ['life--death-epoch-pair', 'life--life-file-unreadable', 'life--portal-is-not-death', 'life--r45-death-then-old-attack', 'control--different-target',
    'control--handover-reservation', 'control--r45-attack-waited-6-4s', 'control--stale-owner-cleanup', 'measure--hand-start'];
  it('has every copy, made by the body for the fixture of this head (the sha256 of the fixture it answers), at one revision', () => {
    // the body now makes every fixture's file (23 and the catalog), and the sync writes PRODUCED.json beside them: the nine of the life and control contracts are among them
    expect(readdirSync(PRODUCED)).toEqual(expect.arrayContaining(files.map(name => `${name}.json`)));
    expect(readdirSync(PRODUCED)).toContain('PRODUCED.json');
    const revisions = new Set<string>();
    for (const name of files) {
      const made = produced(name);
      revisions.add(made.bodyRevision);
      expect(made.producedBy, name).toMatch(/^backend\/scripts\//u);
      expect(['offline', 'A', 'B', 'C']).toContain(made.bench);
      if (made.answers) expect(made.fixtureSha256, name).toBe(sha256(readFileSync(join(CONTINUE, `${made.answers}.json`))));
    }
    expect([...revisions]).toEqual([BODY_REVISION]);
  });

  const receiptOf = (part: Record<string, any>): MinecraftControlReceipt => ({ id: 'skill:abc', connectionId: 'connection', outcome: part.outcome ?? 'completed',
    inputsReleased: part.unit?.released ?? true, observedAt: AT, ...(part.result ? { result: JSON.stringify(part.result) } : {}), ...(part.unit ? { unit: part.unit } : {}),
    // The lab calls the body's actuator below its control loop, which adds `acceptedAt` to the times; the poll check wants it, so it is added here as the loop does.
    ...(part.bodyTimes ? { bodyTimes: { acceptedAt: part.bodyTimes.startedAt ?? part.bodyTimes.endedAt, ...part.bodyTimes } } : {}), ...(part.failureType ? { failureType: part.failureType } : {}) });
  const pollWith = (receipt: MinecraftControlReceipt): MinecraftControlPoll => ({ schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: BODY, sequence: 1, stateAt: AT, receivedAt: AT, connected: true, state: {}, facts: {} }, candidates: [], receipts: [receipt], activeOperationIds: [] });

  it('a death in the hand: the act\'s result reads, its outcome says what cut it, and the poll that carries it is taken', () => {
    const made = produced('life--r45-death-then-old-attack');
    const receipt = receiptOf({ outcome: made.output.receipt.outcome, unit: made.output.receipt.unit, bodyTimes: made.output.receipt.bodyTimes, failureType: made.output.receipt.failureType,
      result: made.output.result });
    expect(validControlPoll(pollWith(receipt), Date.parse(AT))).toBe(true);
    const result = readActResult(receipt.result)!;
    expect(result.outcome).toMatchObject({ goal: 'not_started', end: 'cut', cutBy: 'death', life: 2 });
    expect(result.lines.map(line => line.status)).toEqual(['stopped', 'skipped']);
    expect(result.lines[0]).toMatchObject({ cutBy: 'death', code: 'cancelled', motorOps: 0 });   // A-4: the closed code of the hand that was cut from outside is 'cancelled'; the unit says it too
    expect(receipt.unit).toMatchObject({ goal: 'not_started', end: 'cut', code: 'cancelled' });
    expect(made.output.lifeAfter.life).toBe(made.output.lifeBefore + 1);
  });

  it('a hand-over from a reflex: the act\'s result carries it and the head says it; a different target hands nothing over', () => {
    const waited = produced('control--r45-attack-waited-6-4s').output.trial, different = produced('control--different-target').output;
    const receipt = receiptOf({ unit: waited.unit, result: produced('control--r45-attack-waited-6-4s').output.result });
    expect(validControlPoll(pollWith(receipt), Date.parse(AT))).toBe(true);
    const result = readActResult(receipt.result)!;
    expect(result.handover).toMatchObject({ from: 'floor-melee', target: waited.handover.target, confirmed: true, shield: waited.handover.shield });
    expect(actFacts(result).join('\n')).toContain(`反射 floor-melee から引き継いだ: 相手 #${waited.handover.target}`);
    expect(different.handover).toBeNull();
    expect(validControlPoll(pollWith(receiptOf({ unit: different.unit, bodyTimes: different.bodyTimes })), Date.parse(AT))).toBe(true);
    for (const kept of produced('control--handover-reservation').output.cases) {
      if (!kept.handover) continue;
      expect(actFacts({ handover: kept.handover, lines: [] } as never).join('\n')).toContain(kept.handover.confirmed ? '同じ相手と確かめて続けた' : '同じ相手とは確かめられなかった');
    }
    expect(produced('control--stale-owner-cleanup').output).toEqual({ oldRefused: true, newKeysKept: true });
  });
});

// ---- 5. a decision whose frame the body has left is thrown away (runner) ---------------------------------------------------------------------------------------
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const NOW = '2026-10-26T00:00:00.000Z';
const ACT: FcaToolDefinition = { name: MC_ACT_TOOL, description: 'act', input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
const act = (id: string): FcaDecision => ({ kind: 'tools', calls: [{ id, name: MC_ACT_TOOL, input: { hands: [{ do: 'wait' }], why: id } }] });
const READ: MadeIn = { life: 2, dim: 'overworld', dimSince: AT, bodyBoot: 'bb-1', connectionId: 'c-1', headBoot: 'hb-1', obsSeq: 7 };

/** The common runner with a body lifecycle played by hand (as `fcaStretch.test.ts` does it). */
function stepRig(decisions: FcaDecision[], lifecycle: Partial<FcaBodyLifecycle> = {}, queue?: FcaBodyQueue) {
  const db = new DatabaseSync(':memory:'); databases.push(db); migrateAgentTasks(db);
  const actions = new SQLiteActionStore(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => NOW, leaseValid: (_scope, _task, lease, time) => !!actions.check(lease, time) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
  const inputs: FcaModelInput[] = [], order: string[] = [], executed: string[] = [];
  const body: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => { order.push('context'); return { revision: 0, observation: null }; }, async guard() { return true; },
    guardFor: async () => true, toolSignal: (_name, parent) => parent, async close() {}, recallWanted: () => false, transient: () => ({ map: 'm' }), ...(queue ? { queue } : {}), ...lifecycle };
  const run = async () => {
    const action = actions.claim(actions.enqueue({ scopeKey: 'owner', sourceId: `st-${Math.random()}`, kind: 'agentTask', origin: 'owner_request' }, NOW).id, 'worker', NOW)!;
    const step = runtime.beginStep('owner', task.id, leaseOf(action), runtime.get('owner', task.id)!.revision)!;
    const ports: FcaStepPorts = { runtime, ownerAlone: () => true, keepBodyTools: () => true, body, permit: async () => true,
      model: { async decide(input) {
        order.push('decide');
        const index = inputs.length;
        inputs.push(input);
        return { decision: decisions[index] ?? { kind: 'wait', summary: 'end' } as FcaDecision, history: [{ role: 'user', content: `d${index}` }, { role: 'assistant', content: `t${index}` }] };
      }, toolResults(value) { return { role: 'user', content: value.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: item.text })) }; } },
      tools: combineFcaTools({ definitions: [ACT], async execute(call) { executed.push(String((call.input as { why?: unknown }).why)); return toolOk("済み"); } }) };
    const logged = console.info, said = console.log, warned = console.warn;
    console.info = () => undefined; console.log = () => undefined; console.warn = () => undefined;
    try { await runFcaStep(step, ports, new AbortController().signal); } finally { console.info = logged; console.log = said; console.warn = warned; }
    actions.finish(step.lease, 'completed', 'yielded', NOW); runtime.acknowledgeReceipt('owner', step.id);
    return runtime.get('owner', task.id)!;
  };
  return { run, inputs, order, executed };
}

describe('an answer made on a frame the body has left is thrown away and asked again (fixtures life/death-at-each-moment, portal-pending-other-dimension)', () => {
  const sample = fixture('life/death-at-each-moment.json');
  const drifting = (answers: Array<'life_changed' | 'dimension_changed' | 'connection_changed' | null>) => {
    const asked: MadeIn[] = [];
    const lifecycle = { readOf: () => READ, drifted: (read: MadeIn) => { asked.push(read); return answers.shift() ?? null; } };
    return { lifecycle, asked };
  };

  it('discards the answer given while the model was thinking when the body died, asks again on a new frame, and runs only the second answer', async () => {
    const d = drifting(['life_changed']);
    const f = stepRig([act('first'), act('second')], d.lifecycle);
    await f.run();
    expect(f.inputs).toHaveLength(2);
    expect(f.executed).toEqual(['second']);
    expect(d.asked).toEqual([READ, READ]);
    expect(sample.expected.awaiting_model.discarded).toBe('life_changed');
  });

  it('names the frame the request was made on (read right after the context), not whatever the lifecycle says later', async () => {
    const later: MadeIn = { ...READ, life: 3 };
    let reads = 0;
    const asked: MadeIn[] = [];
    const f = stepRig([act('a')], { readOf: () => (reads += 1) === 1 ? READ : later, drifted: read => { asked.push(read); return null; } });
    await f.run();
    expect(asked[0]).toEqual(READ);
    expect(f.executed).toEqual(['a']);
  });

  it('a dimension that changed, and a connection that changed, are the same (the other dimension\'s generation, the other body)', async () => {
    for (const why of ['dimension_changed', 'connection_changed'] as const) {
      const d = drifting([why]);
      const f = stepRig([act('old'), act('new')], d.lifecycle);
      await f.run();
      expect(f.executed, why).toEqual(['new']);
    }
  });

  it('after the fourth answer in a row it stops asking: the answer goes through as a stale one and none of its calls runs', async () => {
    const d = drifting(['life_changed', 'life_changed', 'life_changed', 'life_changed', 'life_changed']);
    const f = stepRig([act('1'), act('2'), act('3'), act('4'), act('5')], d.lifecycle);
    const task = await f.run();
    expect(f.inputs).toHaveLength(FCA_REDECIDE_MAX + 1);
    expect(f.executed).toEqual([]);
    expect(task.phase).not.toBe('failed');
  });

  it('a lifecycle that names no frame is never asked (a body before the contract)', async () => {
    const f = stepRig([act('a')], { drifted: () => 'life_changed' });
    await f.run();
    expect(f.executed).toEqual(['a']);
  });
});

// ---- 6. the order of a resume (chapter 8) -----------------------------------------------------------------------------------------------------------------------
describe('the first decision of a resumed step waits for the act that was sent again (fixture result/resume-order)', () => {
  it('waits until nothing is open, gives up on a signal or on its limit, and does not mind a failed send', async () => {
    let open = true;
    const tick = async (_ms: number) => { await Promise.resolve(); };
    let rounds = 0;
    const closes = () => { rounds += 1; if (rounds > 3) open = false; return open; };
    expect(await waitForResend({ sent: Promise.resolve(), open: closes, signal: new AbortController().signal, limitMs: 10_000, sleep: tick })).toBe('ended');
    expect(rounds).toBe(4);
    const stop = new AbortController();
    stop.abort();
    expect(await waitForResend({ sent: null, open: () => true, signal: stop.signal, limitMs: 10_000, sleep: tick })).toBe('aborted');
    let clock = 0;
    expect(await waitForResend({ sent: Promise.reject(new Error('refused')), open: () => true, signal: new AbortController().signal, limitMs: 100, now: () => clock, sleep: async ms => { clock += ms; } })).toBe('limit');
    expect(await waitForResend({ sent: Promise.resolve(), open: () => false, signal: new AbortController().signal, limitMs: 0 })).toBe('ended');
  });

  it('is waited for before the request is built and before the model is asked', async () => {
    let open = true;
    const wrapped = withResend({ start() {} } as unknown as FcaBodyLifecycle, async () => { await delay(30); open = false; }, () => undefined, 't', { open: () => open, limitMs: () => 5_000 });
    const f = stepRig([act('a')], { start: wrapped.start.bind(wrapped), beforeDecision: wrapped.beforeDecision!.bind(wrapped) });
    open = true;
    await f.run();
    expect(open).toBe(false);
    expect(f.order.slice(0, 2)).toEqual(['context', 'decide']);
    // Without a resend there is no gate at all.
    const plain = { start() {} } as unknown as FcaBodyLifecycle;
    expect(withResend(plain, null, () => undefined, 't', { open: () => false, limitMs: () => 0 })).toBe(plain);
  });

  it('a step\'s first request is built only after the gate: nothing is read from the body before the second try ended', async () => {
    const events: string[] = [];
    const f = stepRig([act('a')], { beforeDecision: async () => { await delay(30); events.push('second try ended'); }, context: () => { events.push('context'); return { revision: 0, observation: null }; } });
    await f.run();
    expect(events.slice(0, 2)).toEqual(['second try ended', 'context']);
  });
});

describe('what a resume leaves for the first decision, and the record of a hold that came again (fixtures result/resume-order, r45-resume9-replay-holds-again)', () => {
  const again = fixture('result/r45-resume9-replay-holds-again.json');
  it('records how the second try ended and what the queue lost meanwhile, without the try itself, at most three, each without its own mark', () => {
    const record = heldAgainRecord({ resultText: 'go 止まった search_timeout（道 0 マス）', why: 'go が止まった', replayItem: 'q61',
      dropped: [{ item: 'q65', why: 'q65 [p5] 近い鉄を掘る（鉄3・脚に不足）（depends_failed）' }, { item: 'q61', why: 'q61 [p5] go' }],
      open: [{ item: 'q65', why: 'q65 again' }, { item: 'q66', why: 'q66 [p6] 食べる' }, { item: 'q67', why: 'q67 a' }, { item: 'q68', why: 'q68 b' }] });
    expect(record.code).toBe(again.expected.holdRecord.replayResult);
    expect(record.dropped.map(entry => entry.item)).toEqual(['q65', 'q66', 'q67']);
    expect(record.dropped[0]!.why.startsWith('[p5] 近い鉄を掘る')).toBe(true);
    expect(heldAgainRecord({ resultText: '', why: '  体が   止まった  ', replayItem: null, dropped: [], open: [] })).toEqual({ code: '体が 止まった', dropped: [] });
    // The stop line is read from the body's own result, the hand that is neither done nor skipped.
    const result = JSON.stringify({ lines: [{ status: 'done', line: 'walk 済' }, { status: 'failed', line: 'go 止まった search_timeout（道 0 マス）', code: 'search_timeout' }, { status: 'skipped', line: '未実行' }] });
    expect(stopLineOf(result)).toBe('go 止まった search_timeout（道 0 マス）');
    expect(stopLineOf(JSON.stringify({ lines: [{ status: 'failed', line: 'go 止まった', code: 'go_stuck' }] }))).toBe('go 止まった 止まった go_stuck');
    expect(stopLineOf('not json')).toBe('');
    expect(stopLineOf(undefined)).toBe('');
  });

  it('says it before everything else the resume leaves, in the words of the fixture', () => {
    const line = heldAgainWords({ replayCode: again.input.replay.code, dropped: again.input.droppedMeanwhile });
    for (const part of again.expected.firstLineAfterNextResume.mustContain) expect(line).toContain(part);
    const order = fixture('result/resume-order.json');
    const skipped = skipWords({ item: 'q3', hand: order.input.cases[0].held.hand, code: order.input.cases[0].held.code });
    for (const part of order.expected.cases[0].firstLine.mustContain) expect(skipped).toContain(part);
    expect(replayWords('q12')).toContain(order.expected.cases[1].firstLine.mustContain[0]);
  });

  /** The operator's service with its requests played by hand, as `operatorHold.test.ts` does. */
  function service() {
    const TASK = '11111111-2222-4333-8444-555555555555';
    const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
    const tasks = new Map<string, TaskView>(), stopped: string[] = [], resolved: string[] = [];
    const view = (phase: TaskView['phase']) => ({ id: TASK, phase, goal: 'エンドラを討伐して' } as unknown as TaskView);
    const requests = { body: () => BODY, open: () => [], get: (id: string) => tasks.get(id) ?? null,
      admit: () => { tasks.set(TASK, view('ready')); return { ok: true as const, task: tasks.get(TASK)!, bodyId: BODY }; },
      stop: async (id: string) => { stopped.push(id); tasks.set(id, view('stopped')); return [tasks.get(id)!]; },
      resume: (id: string) => { tasks.set(id, view('ready')); return tasks.get(id)!; }, position: () => [0, 100, 0] as [number, number, number],
      incident: async () => ({ ok: true, words: 'completed done=true' }), bodyHold: () => null, heldActWords: () => '保留した act q60 は出し直さなかった', wake: () => undefined,
      resolveHolds: (id: string, how: string) => { resolved.push(`${how}:${id}`); return []; } } as unknown as OperatorMinecraftRequests & { wake(): void };
    const parts: OperatorMinecraftParts = { scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => AT, audit, lifecycle: null, requests,
      actions: { list: async () => [] } as unknown as OperatorMinecraftParts['actions'], lifecycleUnresolved: () => false, activity: () => undefined, note: () => undefined };
    const operator = createOperatorMinecraft(parts);
    const envelope = (op: string, args: Record<string, unknown> = {}) => ({ v: 1, operator: 'ops.ryo', domain: 'minecraft', op, args });
    return { TASK, operator, audit, tasks, stopped, resolved, envelope };
  }
  const note = { id: 'inc-2', why: 'go が止まった', frozen: true, command: 'skill:replay', start: [0.5, 100, 0.5] as [number, number, number], end: [3, 100, 0.5] as [number, number, number] };

  it('writes the second try\'s record into the hold, and the next resume hands the line to the first decision once (with the cancel/resume of the held commands)', async () => {
    const s = service();
    await s.operator.handle(s.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(s.TASK, { id: s.TASK, phase: 'executing', goal: 'g' } as unknown as TaskView);
    const replay = { code: again.input.replay.code, dropped: again.input.droppedMeanwhile.map((entry: { item: string; why: string }) => ({ item: entry.item, why: entry.why })) };
    expect(await s.operator.hold(s.TASK, { ...note, replay })).toBe(true);
    const detail = JSON.parse(s.audit.heldOf(s.TASK)!.detail!);
    expect(detail).toMatchObject({ incident: 'inc-2', replay });
    const resumed = await s.operator.handle(s.envelope('resume', { taskId: s.TASK, skipReplay: true }));
    expect(resumed.body).toMatchObject({ outcome: 'accepted', code: 'resumed' });
    const line = s.operator.heldAgainNote(s.TASK)!;
    for (const part of again.expected.firstLineAfterNextResume.mustContain) expect(line).toContain(part);
    expect(s.operator.heldAgainNote(s.TASK)).toBeNull();
    expect(s.operator.skipNote(s.TASK)).toContain('出し直さなかった');
    expect(s.resolved).toEqual([`resume:${s.TASK}`]);
  });

  it('a hold that is not a second try leaves no such line; a detail that would not fit loses its dropped items first and stays whole JSON; a cancel ends the held commands', async () => {
    const s = service();
    await s.operator.handle(s.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    s.tasks.set(s.TASK, { id: s.TASK, phase: 'executing', goal: 'g' } as unknown as TaskView);
    const crowded = { code: 'search_timeout', dropped: Array.from({ length: 8 }, (_, index) => ({ item: `q${60 + index}`, why: 'x'.repeat(60) })) };
    expect(await s.operator.hold(s.TASK, { ...note, why: 'w'.repeat(160), freeze: 'f'.repeat(80), replay: crowded })).toBe(true);
    const text = s.audit.heldOf(s.TASK)!.detail!;
    expect(text.length).toBeLessThanOrEqual(600);
    const detail = JSON.parse(text);
    expect(detail.replay.code).toBe('search_timeout');
    expect(detail.replay.dropped.length).toBeLessThan(8);
    await s.operator.handle(s.envelope('cancel', { taskId: s.TASK }));
    expect(s.resolved).toEqual([`cancel:${s.TASK}`]);
    const plain = service();
    await plain.operator.handle(plain.envelope('request', { goal: 'エンドラを討伐して', holdOnFailure: true }));
    plain.tasks.set(plain.TASK, { id: plain.TASK, phase: 'executing', goal: 'g' } as unknown as TaskView);
    await plain.operator.hold(plain.TASK, note);
    await plain.operator.handle(plain.envelope('resume', { taskId: plain.TASK }));
    expect(plain.operator.heldAgainNote(plain.TASK)).toBeNull();
  });
});

// ---- 7. the step parts: the frame a decision read reaches its acts; a resume end to end ------------------------------------------------------------------------
describe('the step\'s parts hand a decision\'s frame to its acts and wait for a resume\'s second try', () => {
  const lease = { id: 'lease-1', generation: 1, holder: 'test' };
  function stepParts() {
    const r = rig();
    r.send({ life: lifeView({ life: 2 }) });
    const db = r.db;
    migrateAgentTasks(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), now: () => NOW, leaseValid: () => true, conversationLeaseValid: () => true });
    const root = runtime.ensureRoot('owner');
    const task = runtime.createChild('owner', root.id, { title: 'Body task', goal: 'エンドラを倒して', completionCriteria: 'Observed result' }, 'body');
    const step = runtime.beginStep('owner', task.id, { ...lease }, runtime.get('owner', task.id)!.revision)!;
    r.control.store.bind(task.id, BODY);
    const llmc = { names: { main: 'm', escalate: null, plan: 'p' }, models: { main: {} as never, escalate: null }, summarizer: null, policy: {}, historyAhead: createFcaHistoryAhead() };
    const logs: string[] = [];
    const parts = llmcStepParts(llmc as never, step, r.control, line => logs.push(line));
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; }, toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    return { r, parts, task, step, logs, body: parts.wrap(inner as never) };
  }

  it('names the frame each context read to the tools, and the lifecycle says when the body has left it', () => {
    const s = stepParts();
    expect(s.parts.tools.llmc.madeIn()).toBeNull();
    s.body.context();
    const read = s.parts.tools.llmc.madeIn()!;
    expect(read).toMatchObject({ life: 2, dim: 'overworld', bodyBoot: 'bb-1', headBoot: s.r.control.headBoot() });
    expect(s.body.readOf!()).toEqual(read);
    expect(s.body.drifted!(read)).toBeNull();
    s.r.send({ life: lifeView({ life: 3, deathSeq: 2 }) });
    expect(s.body.drifted!(read)).toBe('life_changed');
    s.body.context();
    expect(s.parts.tools.llmc.madeIn()!.life).toBe(3);
  });

  it('a lifecycle made without the frame\'s naming (an old test) names nothing and is never drifted', () => {
    const r = rig();
    r.send();
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; }, toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    const body = withLlmcBody(inner as never, { llmc: { plan: () => undefined, planView: () => null }, taskId: 'x', createdAt: AT, observe: () => r.control.observe(BODY),
      arrival: () => ({ at: null, kind: null }), r4: { probe: () => null, planWhere: () => null } });
    body.context();
    expect(body.readOf!()).toBeNull();
  });

  /** The hold port as a test plays it: what it was asked, and what a resume left. */
  function holdPort(over: Partial<IncidentHoldPort> & { pending?: { incident: string; command: string } | null }) {
    const calls = { hold: [] as Array<IncidentNote & { command: string }>, checked: [] as string[] };
    const port: IncidentHoldPort = { holdRequested: () => true, hold: async (_task, incident) => { calls.hold.push(incident); return true; }, notHeld: () => undefined,
      bodyHeld: async () => true, resumePending: () => over.pending ?? null, skipNote: () => over.skipNote?.('t') ?? null, heldAgainNote: () => over.heldAgainNote?.('t') ?? null,
      resumeChecked: (_task, line) => { calls.checked.push(line); } };
    setIncidentHoldPort(port);
    return calls;
  }
  /** The act that was held: it ran and failed in an earlier start of the head, its result known and its release proved. */
  const heldAct = (s: ReturnType<typeof stepParts>) => {
    s.r.store.insert({ schemaVersion: 1, id: 'skill:held-1', serverId: 'world', connectionId: 'connection', kind: 'skill', skill: 'act', deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      context: { scopeKey: 'owner', taskId: s.task.id, taskRevision: 1, bodyId: BODY, sessionId: 's', generation: 1, goal: 'g', completionCondition: 'c' }, lease,
      arguments: { hands: [{ do: 'go', to: { x: 159, y: 20, z: 220 } }], why: '[p5] 行く' },
      queue: { item: 'q12', after: null, node: 'p5', maxMs: 60_000, startBy: AT, queue: 'old' } } as MinecraftControlCommand, AT, undefined, { headBoot: 'hb-0' });
    s.r.store.settleWith({ id: 'skill:held-1', connectionId: 'connection', outcome: 'failed', inputsReleased: true, observedAt: AT, unit: { goal: 'failed', end: 'finished', released: true },
      result: JSON.stringify({ v: 1, ok: false, done: 0, of: 1, ms: 1, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20, lines: [{ i: 1, do: 'go', status: 'failed', line: 'go 止まった go_stuck' }] }) });
  };
  const actResult = (lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ok: false, done: 0, of: lines.length, ms: 1000, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20,
    lines: lines.map((line, index) => ({ i: index + 1, do: 'go', line: '', ...line })), ...extra });

  it('a resume\'s lines are the first results the first decision reads, in the order: the hold that came again, the held act', () => {
    holdPort({ heldAgainNote: () => '保留した act の出し直しは search_timeout で再び保留になった。その間の q65（近い鉄を掘る）は捨てた', skipNote: () => '保留した act q60（go (1,2,3)）は出し直さなかった。前の結果: go_stuck' });
    const s = stepParts();
    s.body.context();
    s.body.transient!();
    // They are facts said once: they wait until the request's bytes carry them (), first the hold that came again, then the held act.
    const facts = onceFor(s.task.id, 'normal').map(fact => fact.text);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain('出し直しは search_timeout で再び保留');
    expect(facts[0]).toContain('q65');
    expect(facts[1]).toContain('出し直さなかった');
  });

  it('sends the held act again, keeps the first decision waiting for it, and gives it its result first, with the held act\'s mark in its words', async () => {
    const done = { waited: false };
    const calls = holdPort({ pending: { incident: 'inc-1', command: 'skill:held-1' } });
    const s = stepParts();
    heldAct(s);
    const controller = new AbortController();
    await inActionExecution({ lease: s.step.lease, signal: controller.signal, permit: async () => true } as never, async () => {
      s.body.start(controller.signal);
      const gate = s.body.beforeDecision!(controller.signal).then(() => { done.waited = true; });
      await delay(80);
      expect(done.waited).toBe(false);
      s.r.send();
      const second = s.r.handed.find(item => item.context.incident?.resume === 'inc-1')!;
      expect(second).toBeDefined();
      expect(second.queue?.madeIn).toMatchObject({ life: 2 }); // a resumed act has no decision: the newest frame
      s.r.send({ active: [second.id], receipts: [] });
      await delay(30);
      expect(done.waited).toBe(false); // still running
      s.r.send({ receipts: [{ id: second.id, connectionId: 'connection', outcome: 'failed', inputsReleased: true, observedAt: AT, unit: { goal: 'failed', end: 'finished', released: true },
        result: actResult([{ status: 'failed', goal: 'failed', end: 'finished', code: 'search_timeout', line: 'go 止まった search_timeout（道 0 マス）' }]) }] });
      await Promise.race([gate, delay(1500)]);
      expect(done.waited).toBe(true);
      s.body.context();
      const live = s.body.transient!() as { lastResults?: string[] };
      expect(live.lastResults?.[0]).toContain('保留した q12 の出し直し');
      expect(live.lastResults?.[0]).toContain('search_timeout');
      expect(calls.hold).toHaveLength(0);
    });
    controller.abort();
  });

  it('a second try that is held again is recorded with how it ended and what the queue lost, and its result is not shown as a line', async () => {
    const calls = holdPort({ pending: { incident: 'inc-1', command: 'skill:held-1' } });
    const s = stepParts();
    heldAct(s);
    const controller = new AbortController();
    await inActionExecution({ lease: s.step.lease, signal: controller.signal, permit: async () => true } as never, async () => {
      s.body.start(controller.signal);
      const gate = s.body.beforeDecision!(controller.signal);
      await delay(80);
      s.r.send();
      const second = s.r.handed.find(item => item.context.incident?.resume === 'inc-1')!;
      // An item that came into the queue meanwhile (the gate keeps the model out, a tool of the step may not).
      const input = { hands: [{ do: 'dig' as const, at: [{ x: 1, y: 64, z: 0 }] }], why: '[p5] 近い鉄を掘る' };
      const added = await s.parts.tools.llmc.queue.add({ call: { id: 'c9', name: MC_ACT_TOOL, input }, operationId: 'step:c9', input: input as never, arguments: input as never, skill: 'act', node: 'p5', why: input.why,
        fixes: [], maxMs: 20_000 });
      expect(added).toMatchObject({ ok: true });
      s.r.send({ active: [second.id] });
      const held = actResult([{ status: 'failed', goal: 'failed', end: 'finished', code: 'search_timeout', line: 'go 止まった search_timeout（6016 マス）' }],
        { incident: { id: 'inc-2', heavy: true, why: 'search_timeout', held: true, frozen: true, start: [0.5, 100, 0.5], end: [3, 100, 0.5] } });
      s.r.send({ receipts: [{ id: second.id, connectionId: 'connection', outcome: 'failed', inputsReleased: true, observedAt: AT, unit: { goal: 'failed', end: 'finished', released: true }, result: held }] });
      await delay(60);
      expect(calls.hold).toHaveLength(1);
      expect(calls.hold[0]).toMatchObject({ id: 'inc-2', replay: { code: 'search_timeout', dropped: [{ item: 'q2' }] } });
      expect(calls.hold[0]!.replay!.dropped[0]!.why).toContain('近い鉄を掘る');
      // The hold stops the step: the gate lets the model go (it will not be asked) and the held try shows no result line.
      controller.abort();
      await gate;
      s.body.context();
      expect((s.body.transient!() as { lastResults?: string[] }).lastResults).toBeUndefined();
    });
  });

});
