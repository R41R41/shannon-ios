import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { FcaBodyLifecycle, FcaModel, FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import type { ReflexChoiceInput } from '../src/mind/action/reflex/reflexPorts.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { combineFcaTools, fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';
import { SQLiteFcaEvidenceStore } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaDurableOutcome } from '../src/mind/action/fca/fcaEvidencePorts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const move = (): FcaModelOutput => ({ decision: { kind: 'tools', calls: [{ id: 'move', name: 'mc.move', input: {} }] }, history: [{ role: 'assistant', call: 'move' }] });
const wait = (): FcaModelOutput => ({ decision: { kind: 'wait', summary: 'Current observation checked' }, history: [{ role: 'assistant', text: 'wait' }] });
function fixture(decide: (input: FcaModelInput) => Promise<FcaModelOutput> | FcaModelOutput, options: { unknownStop?: boolean; unknownRelease?: boolean; holdSkill?: boolean; denyEntry?: boolean; sessionMilliseconds?: number; onStopAcknowledged?(): void; noImage?: boolean } = {}) {
  let clock = Date.parse('2026-10-09T00:00:00.000Z'), sequence = 0, danger = false, sourcesVisible = true;
  let extraFacts: Record<string, boolean> = options.noImage ? { imageAvailable: false } : {};
  const now = () => new Date(clock).toISOString(), memory = memoryWorld(), harness = actionHarness(now, memory.path), store = new MinecraftControlStore(harness.db);
  const outcomes: FcaDurableOutcome[] = [];
  const evidence = new SQLiteFcaEvidenceStore({ db: harness.db, state: memory.store, now,
    validStep: step => !!harness.store.check(step.lease, now()) && harness.db.prepare('SELECT step_id FROM fca_task_checkpoints WHERE task_id=?').get(step.taskId)?.step_id === step.id,
    sourcesVisible: () => true, taskVisible: () => true, observeContext: () => true, onOutcome: outcome => { outcomes.push(outcome); } });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const leaseKnown = (lease: { id: string; holder: string; generation: number }) => {
    const action = harness.store.get(lease.id);
    return !!action && action.holder === lease.holder && action.generation === lease.generation
      && ['running', 'waiting', 'stopping', 'unknown'].includes(action.state)
      && action.resources.includes(actionResource('minebot', 'minecraft-body'));
  };
  const control = new MinecraftControl(store, configuration, { now: () => clock, leaseValid: leaseKnown, leaseKnown, ownerAlone: () => true, pollMilliseconds: 1, cancelWaitMilliseconds: 10 });
  const commands: MinecraftControlCommand[] = [], choices: ReflexChoiceInput[] = [], cancelled: string[] = [], closedSessions = new Set<string>();
  const modelInputs: FcaModelInput[] = [], bodies: FcaBodyLifecycle[] = [], pending = new Map<string, MinecraftControlCommand>();
  let receipts: MinecraftControlReceipt[] = [], entryCalls = 0, afterCloseCommands = 0;
  // A body without a renderer answers a capture as a known failure without a picture (Minebot `BODY_CAPTURE_UNAVAILABLE`).
  const receipt = (command: MinecraftControlCommand, outcome: MinecraftControlReceipt['outcome'] = command.kind === 'capture' && options.noImage ? 'failed' : 'completed'): MinecraftControlReceipt => ({ id: command.id, connectionId: command.connectionId,
    outcome, inputsReleased: outcome !== 'unknown', observedAt: now(), ...(command.stop ? { stop: { bodyId: command.context.bodyId,
      sessionId: command.context.sessionId, generation: command.context.generation, requestId: command.stop.requestId,
      state: outcome === 'unknown' ? 'unknown' : 'stopped', inputsReleased: outcome !== 'unknown', observedAt: now() } } : {}),
    ...(command.operation ? { action: { schemaVersion: 1, bodyId: command.context.bodyId, sessionId: command.context.sessionId,
      generation: command.context.generation, operationId: command.operation.operationId, outcome, inputsReleased: outcome !== 'unknown',
      observedAt: now(), evidenceId: `${command.operation.operationId}:receipt` } } : {}),
    ...(command.kind === 'capture' && !options.noImage ? { image: { dataUrl: 'data:image/jpeg;base64,/9j/', capturedAt: now() } } : {}) });
  function pump() {
    clock += 1;
    const received = receipts; receipts = [];
    const response = control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: now(), receivedAt: now(), connected: true,
        state: { health: danger ? 4 : 20, phase: 'current physical observation' }, facts: { danger, stuck: false, visualRequired: false, onGround: true, ...extraFacts } },
      skills: [{ name: 'move', description: 'bounded movement', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      candidates: [{ kind: 'action', label: 'retreat one step', operation: 'move', arguments: { direction: 'back', durationMs: 100 },
        preconditions: [{ key: 'onGround', value: true }], maxDurationMs: 2000, expiresAt: new Date(clock + 3000).toISOString(), requiresImage: true }],
      activeOperationIds: [...pending.keys()], receipts: received });
    if (received.some(value => store.command(value.id)?.kind === 'stop' && value.outcome === 'completed')) options.onStopAcknowledged?.();
    for (const id of response.cancel) {
      const command = pending.get(id); if (!command) continue;
      cancelled.push(id); pending.delete(id); receipts.push(receipt(command, 'cancelled'));
    }
    for (const command of response.commands) {
      commands.push(command);
      if (closedSessions.has(command.context.sessionId)) { afterCloseCommands += 1; receipts.push(receipt(command, 'unknown')); continue; }
      if (command.kind === 'skill' && options.holdSkill) { pending.set(command.id, command); continue; }
      if (command.kind === 'stop' && options.unknownStop) { receipts.push(receipt(command, 'unknown')); continue; }
      if (command.kind === 'release' && options.unknownRelease) { receipts.push(receipt(command, 'unknown')); continue; }
      if (command.kind === 'stop') {
        // Actual stop ACK follows cancellation acknowledgements for the interrupted executor.
        for (const old of pending.values()) { cancelled.push(old.id); receipts.push(receipt(old, 'cancelled')); }
        pending.clear();
      }
      if (command.kind === 'reflex') danger = false;
      if (command.kind === 'release') closedSessions.add(command.context.sessionId);
      receipts.push(receipt(command));
    }
  }
  pump();
  const model: FcaModel = { async decide(input) { modelInputs.push(input); return decide(input); }, toolResults: results => ({ role: 'tool_results', results }) };
  const driver = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
    stepPorts(runtime, step) {
      const body = createMinecraftTaskBody({ control, runtime, step, evidence, now: () => clock, pollMilliseconds: 1,
        limits: { maxDurationMs: options.sessionMilliseconds ?? 20_000 },
        ownerAlone: () => true, sourcesVisible: () => sourcesVisible,
        entry: { async evaluate(input) { entryCalls += 1; return { sessionId: input.context.sessionId, generation: input.context.generation,
          decision: options.denyEntry ? 'continue' : 'enter', reason: 'danger' }; } },
        selector: { async choose(input) { choices.push(input); return { sessionId: input.context.sessionId, generation: input.context.generation,
          candidateId: input.candidates.find(candidate => candidate.kind === 'action')!.id }; } } });
      bodies.push(body.body);
      return { body: body.body, evidence, safeToAcknowledgeStop: body.safeToAcknowledgeStop,
        tools: combineFcaTools(fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true }), body.tools) };
    } });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id,
    { title: 'Minecraft', goal: 'Reach the building site', completionCriteria: 'Verified at site' }, 'minecraft');
  store.bind(task.id, 'minecraft:world');
  async function until(condition: () => boolean, label: string) {
    for (let i = 0; i < 500; i++) { if (condition()) return; pump(); await delay(1); }
    expect(condition(), `${label}; commands=${commands.map(c => c.kind)}; task=${driver.runtime.get('owner', task.id)?.phase}`).toBe(true);
  }
  cleanups.push(async () => { const closing = driver.close(); await until(() => !store.pending('minecraft:world').length, 'cleanup ACKs'); await closing; harness.close(); memory.close(); });
  return { ...harness, driver, store, control, task, commands, choices, modelInputs, bodies, cancelled, outcomes, pump, until,
    danger(value: boolean) { danger = value; pump(); }, sourcesVisible(value: boolean) { sourcesVisible = value; },
    facts(value: Record<string, boolean>) { extraFacts = value; pump(); }, advance(milliseconds: number) { clock += milliseconds; pump(); },
    entryCalls: () => entryCalls, afterCloseCommands: () => afterCloseCommands };
}

describe('task-owned Minecraft reflex with the real FCA and physical receipt transport', () => {
  it.each([false, true])('closes the original native session when permission changes just after stop ACK (unknown release=%s)', async unknownRelease => {
    const answer = deferred<FcaModelOutput>();
    const f = fixture(() => answer.promise, { unknownRelease, onStopAcknowledged: () => f.sourcesVisible(false) });
    cleanups.push(async () => answer.resolve(wait()));
    await f.driver.tick(); await f.until(() => f.modelInputs.length === 1, 'ordinary model waiting');
    f.danger(true);
    await f.until(() => !!f.commands[0] && !!f.store.session(f.commands[0].context.sessionId)?.receipt, 'unacquired session cleanup persisted');
    expect(f.commands.map(command => command.kind)).toEqual(['stop', 'release']);
    expect(f.commands[1]?.lease).toEqual(f.commands[0]?.lease);
    expect(f.commands[1]?.context.sessionId).toEqual(f.commands[0]?.context.sessionId);
    expect(f.store.session(f.commands[0]!.context.sessionId)?.receipt).toMatchObject({
      reason: unknownRelease ? 'unknown' : 'stale_generation', control: unknownRelease ? 'held' : 'returned', actions: [] });
    expect(f.store.safe(f.task.id)).toBe(!unknownRelease);
    expect(f.afterCloseCommands()).toBe(0); expect(f.choices).toEqual([]);
    f.sourcesVisible(true); answer.resolve(wait()); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe(unknownRelease ? 'unknown' : 'ready');
  });
  it('interrupts during model wait, holds the same lease, and discards the old physical decision after returning', async () => {
    const answer = deferred<FcaModelOutput>();
    const f = fixture(() => f.modelInputs.length === 1 ? answer.promise : wait());
    cleanups.push(async () => answer.resolve(wait()));
    await f.driver.tick(); await f.until(() => f.modelInputs.length === 1, 'ordinary model waiting');
    f.danger(true);
    await f.until(() => f.commands.some(c => c.kind === 'release') && f.store.safe(f.task.id), 'bounded reflex returns');
    expect(f.choices).toHaveLength(1);
    expect(f.commands.map(c => c.kind)).toEqual(['stop', 'capture', 'capture', 'reflex', 'capture', 'release']);
    expect(f.afterCloseCommands()).toBe(0);
    expect(new Set(f.commands.map(c => JSON.stringify(c.lease))).size).toBe(1);
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('executing');
    expect(f.outcomes).toEqual([]);
    answer.resolve(move()); await f.until(() => f.driver.runtime.get('owner', f.task.id)?.phase === 'ready', 'stale model decision committed without tool replay');
    await f.driver.drain();
    expect(f.commands.some(c => c.kind === 'skill')).toBe(false);
    const snapshot = f.driver.runtime.snapshot('owner', f.task.id)!;
    expect(snapshot.history.at(-1)).toMatchObject({ role: 'tool_results', results: [{ id: 'move', ok: false }] });
    expect(snapshot.checkpoint).toMatchObject({ consecutiveToolFailures: 0 });
    expect(snapshot.messages.map(m => JSON.parse(m.text).phase)).toEqual(['entered', 'action', 'returned']);
    const action = f.commands.find(c => c.kind === 'reflex')!;
    expect(JSON.parse(snapshot.messages[1]!.text).operationId).toBe(action.operation?.operationId);
    const eventId = JSON.parse(snapshot.messages[1]!.text).eventId;
    expect(f.outcomes.filter(outcome => outcome.outcomeId === eventId)).toHaveLength(1);
    expect(f.outcomes.find(outcome => outcome.outcomeId === eventId)).toMatchObject({ observation: 'observed', action: { name: 'minecraft.reflex.action' } });
    expect(JSON.parse(snapshot.messages.at(-1)!.text).reason).toBe('hazard_cleared');
    await f.driver.tick(); await f.driver.drain();
    expect(f.modelInputs[1]?.body?.observation?.facts.danger).toBe(false);
    expect(f.modelInputs[1]?.messages).toHaveLength(3);
    expect(f.modelInputs[1]?.sharedContext?.recentOutcomes).toContainEqual(expect.objectContaining({ eventId, name: 'minecraft.reflex.action' }));
  });

  it('cancels an in-flight skill, waits for its actual stop ACK and returns current process and results without resuming it', async () => {
    const f = fixture(() => move(), { holdSkill: true });
    await f.driver.tick(); await f.until(() => f.commands.some(c => c.kind === 'skill'), 'normal skill dispatched');
    const skill = f.commands.find(c => c.kind === 'skill')!;
    f.danger(true);
    await f.until(() => f.driver.runtime.get('owner', f.task.id)?.phase === 'ready', 'interrupted skill segment safely completes');
    await f.driver.drain();
    expect(f.cancelled).toContain(skill.id);
    const reflex = f.commands.find(c => c.kind === 'reflex')!;
    expect(f.commands.indexOf(reflex)).toBeGreaterThan(f.commands.findIndex(c => c.kind === 'stop'));
    expect(reflex.lease).toEqual(skill.lease);
    expect(reflex.context.sessionId).not.toBe(skill.context.sessionId);
    expect(f.choices[0]?.context.taskState?.activeAction).toMatchObject({ name: 'mc.move', input: {}, operationId: expect.stringContaining(':move') });
    expect(f.commands.filter(c => c.kind === 'skill')).toHaveLength(1);
    expect(f.store.safe(f.task.id)).toBe(true);
    expect(f.driver.runtime.snapshot('owner', f.task.id)?.checkpoint).toMatchObject({ consecutiveToolFailures: 0 });
  });

  it('holds unknown stop outcomes and never replays after recovery or owner stop', async () => {
    const answer = deferred<FcaModelOutput>();
    const f = fixture(() => answer.promise, { unknownStop: true });
    cleanups.push(async () => answer.resolve(wait()));
    await f.driver.tick(); await f.until(() => f.modelInputs.length === 1, 'ordinary model waiting');
    f.danger(true);
    await f.until(() => f.commands.some(c => c.kind === 'stop') && f.store.receipt(f.commands[0]!.id) !== null, 'unknown physical ACK');
    await f.driver.stop(f.task.id, 'owner stopped before ordinary model unwind');
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('stopping');
    answer.resolve(wait());
    await f.until(() => f.driver.runtime.get('owner', f.task.id)?.phase === 'unknown', 'unknown task held'); await f.driver.drain();
    expect(f.commands.map(c => c.kind)).toEqual(['stop']);
    expect(f.store.safe(f.task.id)).toBe(false);
    await f.driver.tick(); await f.driver.stop(f.task.id, 'owner stopped'); await f.driver.tick(); await f.driver.drain();
    expect(f.modelInputs).toHaveLength(1);
    expect(f.commands.map(c => c.kind)).toEqual(['stop']);
    expect(f.db.prepare("SELECT state FROM mind_actions WHERE kind='agentTask'").all()).toEqual([{ state: 'unknown' }]);
  });

  it('does not invoke entry selection for every unrelated heartbeat or unchanged danger signal', async () => {
    const answer = deferred<FcaModelOutput>();
    const f = fixture(() => answer.promise, { denyEntry: true });
    cleanups.push(async () => answer.resolve(wait()));
    await f.driver.tick(); await f.until(() => f.modelInputs.length === 1, 'ordinary model waiting');
    for (let i = 0; i < 10; i++) { f.pump(); await delay(1); }
    expect(f.entryCalls()).toBe(0);
    f.danger(true); await f.until(() => f.entryCalls() === 1, 'one relevant entry check');
    for (let i = 0; i < 10; i++) { f.pump(); await delay(1); }
    expect(f.entryCalls()).toBe(1);
    expect(f.commands).toEqual([]);
    answer.resolve(wait()); await f.driver.drain();
  });

  it('offers minecraft.reflex only while the body can give a picture, and gives each decision a summarized observation (Minebot lane 2026-10-14)', async () => {
    const look = (): FcaModelOutput => ({ decision: { kind: 'tools', calls: [{ id: `look-${f.modelInputs.length}`, name: 'minecraft.reflex', input: {} }] }, history: [{ role: 'assistant', call: 'look' }] });
    const f = fixture(input => input.tools.some(tool => tool.name === 'minecraft.reflex') ? look() : wait(), { noImage: true });
    const offered = (index: number) => f.modelInputs[index]!.tools.some(tool => tool.name === 'minecraft.reflex');
    const step = async (count: number) => { for (let i = 0; i < 500 && f.modelInputs.length < count; i++) { await f.driver.tick(); f.pump(); await delay(1); } await f.until(() => f.driver.runtime.get('owner', f.task.id)?.phase !== 'executing', 'step settled'); };
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(false); // nothing tried yet on this connection
    await step(1);
    expect(offered(0)).toBe(true);
    // The session's capture came back without a picture: the session ended observation_unavailable with no decision.
    expect(f.commands.filter(command => command.kind === 'capture').length).toBeGreaterThan(0);
    expect(f.choices).toEqual([]);
    expect(f.store.session(f.commands[0]!.context.sessionId)?.receipt).toMatchObject({ reason: 'observation_unavailable', decisions: 0 });
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(true);
    await step(2);
    expect(offered(1)).toBe(false);
    const observation = f.modelInputs[1]!.body!.observation!;
    expect(observation.state).toMatchObject({ health: 20, detail: expect.stringContaining('minecraft.observe') });
    expect(observation.facts).toMatchObject({ imageAvailable: false, onGround: true });
    // Nothing more was sent to the body for a picture it cannot give.
    const sent = f.commands.length;
    // The body later reports a picture (or the retry window passes): offered again.
    f.facts({ imageAvailable: true });
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(false);
    f.facts({ imageAvailable: false });
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(true);
    f.advance(10 * 60_000);
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(false);
    // A body that says its renderer is not configured never offers it.
    f.facts({ rendererConfigured: false, imageAvailable: false });
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(true);
    expect(f.commands.length).toBe(sent);
  });

  it('never offers minecraft.reflex nor sends a capture to a body that says it has no renderer, even in danger (task 788da00a)', async () => {
    const f = fixture(() => wait(), { noImage: true });
    f.facts({ rendererConfigured: false, imageAvailable: false });
    expect(f.control.imagesUnavailable('minecraft:world')).toBe(true);
    await f.driver.tick(); await f.until(() => f.modelInputs.length === 1, 'first decision');
    expect(f.modelInputs[0]!.tools.some(tool => tool.name === 'minecraft.reflex')).toBe(false);
    f.danger(true);
    for (let i = 0; i < 20; i++) { f.pump(); await delay(1); }
    expect(f.entryCalls()).toBe(0);
    expect(f.commands.filter(command => command.kind === 'capture')).toEqual([]);
    await f.driver.drain();
  });

  it.each(['deadline', 'close'] as const)('unwinds a competing body resource wait on local %s without aborting the enclosing action', async mode => {
    const answer = deferred<FcaModelOutput>();
    const f = fixture(() => answer.promise, { sessionMilliseconds: mode === 'deadline' ? 30 : 20_000 });
    cleanups.push(async () => answer.resolve(wait()));
    const competitor = await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'another-body-owner' });
    expect(await f.actions.dispatch(leaseOf(competitor!), [actionResource('minebot', 'minecraft-body')])).toBe(true);
    await f.driver.tick(); await f.until(() => f.modelInputs.length === 1, 'ordinary model waiting');
    f.danger(true); await f.until(() => f.entryCalls() === 1 && f.bodies[0]!.revision() === 1, 'reflex waits for existing resource');
    if (mode === 'close') await f.bodies[0]!.close();
    await f.until(() => (f.driver.runtime.snapshot('owner', f.task.id)?.messages.length ?? 0) > 0, 'bounded handoff returned without a physical command');
    expect(f.commands).toEqual([]);
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('executing');
    const event = JSON.parse(f.driver.runtime.snapshot('owner', f.task.id)!.messages[0]!.text);
    expect(event).toMatchObject({ phase: 'returned', reason: mode === 'deadline' ? 'deadline' : 'cancelled' });
    expect((await f.actions.get('owner', competitor!.id))?.state).toBe('running');
    expect(f.db.prepare("SELECT state FROM mind_actions WHERE kind='agentTask'").get()?.state).toBe('running');
    answer.resolve(wait()); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready');
    await f.actions.finish(leaseOf(competitor!), 'completed', 'fixture_done');
  });
});
