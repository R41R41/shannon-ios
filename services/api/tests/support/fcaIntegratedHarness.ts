import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { memoryWorld } from './memoryWorld.js';
import { actionHarness } from './actionThreadHarness.js';
import { actionResource, leaseOf } from '../../src/contracts/actionThreadContract.js';
import { configuredMinecraftBody } from '../../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../src/contracts/minecraftControlContract.js';
import { inActionExecution } from '../../src/infra/context/actionExecution.js';
import { underWriteLock } from '../../src/infra/sqlite/lockWaits.js';
import type { WebSearchOperation } from '../../src/infra/models/webSearch.js';
import { createFcaConversationBridge, createFcaSourceGuard, conversationFcaProvenance } from '../../src/mind/action/fca/fcaConversationPorts.js';
import type { FcaModelInput, FcaModelOutput } from '../../src/mind/action/fca/fcaPorts.js';
import { toolSessionMemory } from '../../src/mind/tools/shannonToolTypes.js';
import { ShannonAutonomyService } from '../../src/mind/action/ownTime/autonomyService.js';
import { configuredAutonomy } from '../../src/mind/inhibition/inhibitionPorts.js';
import { createAutonomyStore } from '../../src/wiring/autonomyStoreWiring.js';
import { createTaskRuntimeWiring } from '../../src/wiring/taskRuntimeWiring.js';
import { createFcaSharedWiring } from '../../src/wiring/fcaSharedWiring.js';
import { connectFcaMemoryTools } from '../../src/wiring/fcaMemoryWiring.js';
import { fcaResearchTools } from '../../src/wiring/fcaResearchWiring.js';
import { fcaMinecraftTools, combineFcaTools } from '../../src/wiring/fcaMinecraftTools.js';
import { fcaMinecraftRequests } from '../../src/wiring/fcaMinecraftRequests.js';
import { MinecraftControl } from '../../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../../src/surfaces/minecraft/store/minecraftControlStore.js';
import { createMinecraftTaskBody } from '../../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { createFcaSleepWiring } from '../../src/wiring/fcaSleepWiring.js';
import type { SleepMemoryAnalyzer } from '../../src/mind/sleep/sleepConsolidation.js';
import type { KnowledgeAnalyzer } from '../../src/mind/sleep/knowledgeConsolidation.js';

export function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
export async function until(condition: () => boolean, reason: string) {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await delay(1);
  expect(condition(), reason).toBe(true);
}
export const round = (decision: FcaModelOutput['decision']): FcaModelOutput => ({ decision, history: [{ role: 'assistant', content: decision.kind }] });

/** The server's existing composition, sharing one durable DB. Only inference/web and the paired actuator are scripted. */
export function integratedFcaHarness(parts: {
  decide(input: FcaModelInput, signal: AbortSignal): FcaModelOutput | Promise<FcaModelOutput>;
  web?: WebSearchOperation;
  sleep?: { analyzer: SleepMemoryAnalyzer; knowledgeAnalyzer?: KnowledgeAnalyzer; minimumMessages?: number };
}) {
  const world = memoryWorld(), calls: FcaModelInput[] = [];
  const activity = createAutonomyStore(world.path);
  const autonomy = new ShannonAutonomyService({ store: activity, config: configuredAutonomy({}), now: world.now });
  const tools = autonomy.tools;
  let searches = 0, foregroundCalls = 0, turnNumber = 0, sequence = 0, alone = true;
  const connectActions = () => actionHarness(world.now, world.path, parts.sleep ? world.store.fcaDatabase() : undefined);
  let actions = connectActions();
  let sleep: ReturnType<typeof createFcaSleepWiring> | null = null;
  let driver!: ReturnType<typeof createTaskRuntimeWiring>;
  let shared!: ReturnType<typeof createFcaSharedWiring>;
  let visible!: ReturnType<typeof createFcaSourceGuard>;
  let bridge!: ReturnType<typeof createFcaConversationBridge>;
  let control!: MinecraftControl;
  let bodyStore!: MinecraftControlStore;
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
    servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const ownerAlone = () => alone;
  tools.useReads({ web: async input => { searches++; return parts.web ? parts.web(input) : {
    status: 'results', text: '分光装置の公開資料を三件確認しました。', sources: [{ title: 'Public fixture', url: 'https://example.com/spectrometer' }],
  }; } });
  function connect() {
    sleep = parts.sleep ? createFcaSleepWiring({ store: world.store, ownerScope: 'owner', now: world.now,
      values: { SHANNON_SKILLS: 'off', SHANNON_KNOWLEDGE_ENABLED: 'false', SHANNON_SLEEP_MIN_MESSAGES: String(parts.sleep.minimumMessages ?? 1) },
      analyzer: parts.sleep.analyzer, knowledgeAnalyzer: parts.sleep.knowledgeAnalyzer ?? null }) : null;
    bodyStore = new MinecraftControlStore(actions.db);
    control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(world.now()), ownerAlone, pollMilliseconds: 1,
      leaseValid: lease => !!actions.store.check(lease, world.now())?.resources.includes(actionResource('minebot', 'minecraft-body')),
      leaseKnown: lease => {
        const action = actions.store.get(lease.id);
        return !!action && action.generation === lease.generation && [action.holder, action.lastHolder].includes(lease.holder);
      },
    });
    driver = createTaskRuntimeWiring({ db: actions.db, actions: actions.actions, scopeKey: 'owner', ownerAlone, now: world.now,
      ...(sleep ? { sleepTicket: sleep.jobs.ticket, maintenanceAllowed: sleep.jobs.allowed } : {}),
      model: { async decide(input, signal) { calls.push(structuredClone(input)); return parts.decide(input, signal); },
        toolResults: results => ({ role: 'user', results }) },
      canRunTask: (runtime, id) => runtime.get('owner', id)?.kind === 'sleep' ? !!sleep?.visible(runtime, runtime.get('owner', id)!) : visible('owner', id),
      stepPorts: (runtime, step) => {
        if (step.snapshot.task.kind === 'sleep') return sleep!.step(runtime, step);
        const sourcesVisible = () => visible.sources('owner', step.snapshot.task, step.snapshot.sources);
        const body = createMinecraftTaskBody({ control, runtime, step, entry: null, selector: null, ownerAlone,
          sourcesVisible, now: () => Date.parse(world.now()), evidence: shared.evidence });
        return { body: body.body, safeToAcknowledgeStop: body.safeToAcknowledgeStop,
          recall: shared.recall, evidence: shared.evidence, observeMemory: ids => shared.observeMemory(step, ids), sourcesVisible,
          taskVisible: id => id === step.taskId ? sourcesVisible() : visible('owner', id),
          observeTasks: ids => { if (!runtime.inheritTaskSources(step, ids)) return false;
            step.snapshot.sources = runtime.taskSources('owner', step.taskId, step.messageIds); return sourcesVisible(); },
          tools: combineFcaTools(fcaResearchTools({ tools, state: world.store, conversations: world.store,
            scopeKey: 'owner', ownerAlone, sourcesVisible, observeMemory: ids => shared.observeMemory(step, ids) }),
          fcaMinecraftTools({ control, step, ownerAlone, sourcesVisible }), body.tools),
        };
      },
    });
    visible = createFcaSourceGuard({ runtime: driver.runtime, state: world.store, conversations: world.store, ownerScope: 'owner', ownerAlone });
    bridge = createFcaConversationBridge({ runtime: driver.runtime, ownerScope: 'owner', visible });
    shared = createFcaSharedWiring({ db: actions.db, runtime: driver.runtime, state: world.store, affect: world.store,
      conversations: world.store, memory: world.ports.proposals, ownerScope: 'owner', ownerAlone, visible,
      readSourceVisible: () => false, now: world.now });
    connectFcaMemoryTools({ tools, memory: shared.memory, conversation: bridge, ownerScope: 'owner', ownerAlone });
    tools.useTaskRuntime({ available: scope => bridge.taskToolsAvailable(scope), execute: (name, input, context) => bridge.executeTaskTool(name, input, context),
      observeRead: (scope, receipt) => bridge.observeRead(scope, receipt) });
    const requests = fcaMinecraftRequests({ control, runtime: driver.runtime, conversation: bridge, visible,
      ownerScope: 'owner', ownerAlone, stop: driver.stop,
      sourceVisible: id => shared.memory.read('owner', [id], { kind: 'owner' }).length === 1,
      atomic: work => underWriteLock(actions.db, null, '', work, 'fca_integration_admission') });
    tools.useMinecraftTasks(requests.tools);
  }
  // The body runs what it was handed until it sends the receipt, and reports it as active meanwhile (`controlLoop.ts`).
  const running = new Set<string>();
  function poll(receipts: readonly MinecraftControlReceipt[] = []) {
    for (const receipt of receipts) running.delete(receipt.id);
    const reply = bodyPoll(receipts);
    for (const command of reply.commands) running.add(command.id);
    return reply;
  }
  function bodyPoll(receipts: readonly MinecraftControlReceipt[]) {
    return control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: ++sequence, stateAt: world.now(), receivedAt: world.now(),
        connected: true, state: { inventory: { stone: receipts.some(receipt => receipt.outcome === 'completed') ? 1 : 0 } }, facts: {} },
      skills: [{ name: 'dig', description: 'Dig the observed stone block', readOnly: false,
        inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 16 } }, required: ['count'], additionalProperties: false } }],
      candidates: [], receipts, activeOperationIds: [...running],
    });
  }
  connect(); poll();
  async function foreground<T>(work: () => Promise<T>) {
    const action = await actions.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `conversation-${++turnNumber}` });
    expect(action, 'foreground admission must remain available while two background operations wait').not.toBeNull();
    const lease = leaseOf(action!), signal = new AbortController().signal;
    try {
      const result = await inActionExecution({ lease, signal, permit: resources => actions.actions.dispatch(lease, resources),
        checkpoint: code => actions.actions.checkpoint(lease, code) }, work);
      await actions.actions.finish(lease, 'completed', 'responded'); return result;
    } catch (error) { await actions.actions.finish(lease, 'unknown', 'response_interrupted'); throw error; }
  }
  type TurnTools = { call(name: string, input: unknown): ReturnType<typeof tools.call>; context: string; taskId: string };
  async function talk<T>(text: string, model: (input: TurnTools) => Promise<T> = async () => undefined as T) {
    const threadId = world.store.threadId('owner');
    const action = await actions.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `conversation-${++turnNumber}` });
    expect(action, 'foreground admission must remain available while two background operations wait').not.toBeNull();
    const lease = leaseOf(action!), signal = new AbortController().signal;
    const result = await inActionExecution({ lease, signal, permit: resources => actions.actions.dispatch(lease, resources),
      checkpoint: code => actions.actions.checkpoint(lease, code) }, async () => {
      const turn = bridge.begin({ scopeKey: 'owner', threadId, observedAt: world.now(), ownerAlone,
        recalledMemoryIds: conversationFcaProvenance(world.store.snapshot('owner'), world.store, 'owner', threadId, []) });
      const memory = toolSessionMemory();
      const task = driver.runtime.list('owner').find(candidate => candidate.kind === 'conversation');
      try {
        expect(await actions.actions.dispatch(lease)).toBe(true);
        foregroundCalls++;
        const value = await model({ context: turn?.context() ?? '', taskId: task!.id,
          call: (name, input) => tools.call(name, input, { scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory }, signal) });
        // The ordinary final model round reacquires after legacy foreground tool checkpoints yield the respond action.
        expect(await actions.actions.dispatch(lease)).toBe(true);
        const source = world.store.appendTurn('owner', threadId, text, '会話の返事を続けました。', world.now());
        turn?.commit(source.id);
        return { value, sourceId: source.id, taskId: task!.id };
      } catch (error) { turn?.abort(); throw error; }
    });
    await actions.actions.finish(lease, 'completed', 'responded');
    return result;
  }
  return { ...world, tools, autonomy, calls, talk, poll, foreground,
    get driver() { return driver; }, get actions() { return actions; }, get shared() { return shared; },
    get bridge() { return bridge; }, get visible() { return visible; }, get control() { return control; }, get bodyStore() { return bodyStore; },
    get sleep() { return sleep; },
    searches: () => searches, foregroundCalls: () => foregroundCalls,
    setOwnerAlone(value: boolean) { alone = value; },
    async tick() { sleep?.jobs.reconcile(driver.runtime); sleep?.jobs.admit(driver.runtime); await driver.tick(); await driver.drain(); sleep?.jobs.reconcile(driver.runtime); },
    async command() {
      await until(() => bodyStore.pending('minecraft:world').some(row => !row.delivered), 'native command must reach the actual transport queue');
      const reply = poll(); expect(reply.commands).toHaveLength(1); return reply.commands[0]!;
    },
    acknowledge(command: MinecraftControlCommand, outcome: MinecraftControlReceipt['outcome'] = 'completed', inputsReleased = true) {
      return poll([{ id: command.id, connectionId: command.connectionId, outcome, inputsReleased, observedAt: world.now(), result: JSON.stringify({ stone: 1 }) }]);
    },
    async writeMemory() { const writer = world.writer(); try { for (let n = 0; n < 8; n++) if (await writer.runOnce() === 'idle') break; } finally { writer.releaseLease(); } },
    async restart() {
      await driver.close(); await shared.recall.cancelAll(); sleep?.close(); actions.close();
      actions = connectActions(); connect(); poll();
    },
    async close() {
      // Test actuator releases any command left by a failed assertion, so cleanup never depends on a wall-clock timeout.
      for (const row of bodyStore.pending('minecraft:world')) bodyStore.settle({ id: row.command.id, connectionId: row.command.connectionId,
        outcome: 'cancelled', inputsReleased: true, observedAt: world.now() });
      await driver.close(); await shared.recall.cancelAll(); sleep?.close(); actions.close(); activity.close(); world.close();
    },
  };
}
