import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { gameOnlyMinecraftTask, gameOnlyStepPorts } from '../src/wiring/minecraftGameOnly.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationSources.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { MINECRAFT_REQUEST_CRITERIA } from '../src/wiring/fcaMinecraftRequests.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import type { FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import type { MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { benchC } from './helpers/benchC.js';
import { coreAreaForRepositoryPath } from '../src/mind/inhibition/autonomyCore.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function until(test: () => boolean) {
  for (let i = 0; i < 500 && !test(); i++) await delay(2);
  expect(test()).toBe(true);
}
const definition = (name: string): FcaToolDefinition => ({ name, description: name, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  domain: 'minecraft_body', effect: 'write', cost: 'none', audiences: ['owner_alone', 'others'], surfaces: ['text'] });

function fixture(options: { audited?: boolean; initiallyAlone?: boolean } = {}) {
  const now = () => new Date().toISOString(), h = actionHarness(now), audit = new OperatorAuditStore(h.db);
  const store = new MinecraftControlStore(h.db), inputs: FcaModelInput[] = [], handed: string[] = [];
  let alone = options.initiallyAlone ?? false, validLease = true, sequence = 0, release!: () => void;
  const answer = new Promise<void>(resolve => { release = resolve; });
  let driver!: ReturnType<typeof createTaskRuntimeWiring>;
  let currentStep: TaskStep | null = null;
  const allowed = (id: string) => gameOnlyMinecraftTask(id, { scopeKey: 'owner', runtime: driver.runtime, audit, bound: task => store.body(task) });
  const config = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [
    { serverId: 'world', title: 'World', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const resource = actionResource('minebot', 'minecraft-body');
  const control = new MinecraftControl(store, config, { now: Date.now, ownerAlone: () => alone, taskAudienceAllowed: allowed,
    leaseValid: (lease, taskId) => validLease && h.store.check(lease, now())?.sourceId.startsWith(`fca:${taskId}:`) === true
      && h.store.check(lease, now())!.resources.includes(resource), pollMilliseconds: 1, cancelWaitMilliseconds: 10 });
  const readPrivate = vi.fn(() => { throw Error('PRIVATE_CANARY_MUST_NOT_BE_READ'); });
  const guard = createFcaSourceGuard({ runtime: { get: (scope: string, id: string) => driver.runtime.get(scope, id), taskSources: (scope: string, id: string) => driver.runtime.taskSources(scope, id) } as never,
    state: { snapshot: readPrivate } as never, conversations: {} as never, ownerScope: 'owner', ownerAlone: () => alone, sourceFreeTaskAllowed: allowed });
  driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', now, ownerAlone: () => alone, publicTaskAllowed: allowed,
    canRunTask: (runtime, id) => guard('owner', id),
    model: { async decide(input) { inputs.push(input); await answer;
      return { decision: { kind: 'tools', calls: [{ id: 'dig-one', name: MC_ACT_TOOL, input: {} }] }, history: [] }; },
      toolResults: results => ({ role: 'user', content: results.map(r => r.text).join('\n') }) },
    stepPorts: (_runtime, step) => { currentStep = step; return gameOnlyStepPorts({ audienceAllowed: () => alone || allowed(step.taskId), keepBodyTools: () => true,
      sourcesVisible: () => guard.sources('owner', step.snapshot.task, step.snapshot.sources),
      recall: { start: readPrivate, packet: readPrivate, finishSegment: readPrivate } as never,
      bodyRecall: { packet: readPrivate } as never, evidence: { prepare: readPrivate } as never,
      body: { start() {}, revision: () => 1, context: () => ({ revision: 1, observation: control.observe('minecraft:world') }),
        async guard() { return true; }, toolSignal: (_name, signal) => signal, async close() {} },
      tools: { definitions: [definition(MC_ACT_TOOL), definition('memory.search'), definition('task.send')], async execute(call) {
        const active = currentActionExecution()!;
        expect(await active.permit([resource], call.signal)).toBe(true);
        const receipt = await control.command({ id: call.operationId, context: { scopeKey: 'owner', taskId: step.taskId,
          taskRevision: step.revision, bodyId: 'minecraft:world', sessionId: step.id, generation: step.lease.generation,
          goal: 'stone', completionCondition: 'inventory' }, lease: step.lease, kind: 'skill', skill: 'dig', arguments: { count: 1 } }, call.signal);
        return { ok: receipt.outcome === 'completed', text: receipt.result ?? 'done', retryable: false };
      } },
    }, step.taskId); } });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '（運用者経由）石を掘る', goal: '石を掘る',
    completionCriteria: MINECRAFT_REQUEST_CRITERIA, context: 'ゲーム内で石を一つ掘る。' }, randomUUID(), { sources: 'asking' });
  store.bind(task.id, 'minecraft:world');
  if (options.audited !== false) audit.append({ operationId: `operator:${randomUUID()}`, scopeKey: 'owner', at: now(), operator: 'test',
    command: 'request', event: 'accepted', code: 'accepted', argsJson: '{}', taskId: task.id });
  const scope = { scopeKey: 'owner', deviceId: 'minebot' };
  const poll = (receipts: MinecraftControlReceipt[] = []) => control.poll(scope, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, connected: true, stateAt: now(), receivedAt: now(), state: { health: 20 }, facts: {} },
    skills: [{ name: 'dig', description: 'dig', readOnly: false, inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }],
    candidates: [], receipts, activeOperationIds: [] } satisfies MinecraftControlPoll);
  poll();
  const timer = setInterval(() => {
    const commands = poll().commands;
    for (const command of commands) {
      handed.push(command.id);
      poll([{ id: command.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: now(), result: 'stone acquired' }]);
    }
  }, 2);
  closes.push(async () => { release(); await driver.close(); clearInterval(timer); h.close(); });
  return { ...h, driver, task, root, store, audit, allowed, guard, inputs, handed, release, readPrivate,
    addPrivateSource: () => driver.runtime.observeSources(currentStep!, { observationId: 'private-read', recalledMemoryIds: ['PRIVATE_CANARY'] }),
    alone(value: boolean) { alone = value; }, revokeLease() { validLease = false; } };
}

describe('Minecraft and streaming share the real runtime without sharing private context', () => {
  it('sends the production mc.act tool through its real task queue while the audience remains others', async () => {
    const b = benchC({ scene: 'streaming-mc-act', ownerAlone: () => false, gameplayAllowed: () => true });
    closes.push(async () => { b.close(); }); await b.begin();
    const result = await b.actThroughTools({ hands: [{ do: 'wait', seconds: 1 }], why: '[p1] 配信中の待機' });
    expect(result.ok).toBe(true);
    await until(() => b.body.handed.some(c => c.kind === 'skill' && c.skill === 'act'));
    const command = b.body.handed.find(c => c.kind === 'skill' && c.skill === 'act')!;
    b.body.begin(command.id); b.body.finish(command.id, { hands: [{ do: 'wait', goal: 'done' }] });
    await b.spin(5); expect(b.head.queue.open()).toBe(false);
    expect(b.body.handed.filter(c => c.kind === 'skill' && c.skill === 'act')).toHaveLength(1);
  });
  it('admits and completes a physical command while the real audience is others', async () => {
    const f = fixture();
    expect(f.allowed(f.task.id)).toBe(true);
    await f.driver.tick(); await until(() => f.inputs.length === 1);
    f.release(); await until(() => f.handed.length === 1 && f.driver.runtime.get('owner', f.task.id)?.phase === 'ready');
    expect(f.readPrivate).not.toHaveBeenCalled();
    expect(f.inputs[0]!.tools.map(t => t.name)).toEqual([MC_ACT_TOOL]);
    expect(JSON.stringify(f.inputs)).not.toContain('PRIVATE_CANARY');
    expect(f.store.safe(f.task.id)).toBe(true);
  });
  it('keeps a command decided before streaming starts, without cancelling or replaying it', async () => {
    const f = fixture({ initiallyAlone: true });
    await f.driver.tick(); await until(() => f.inputs.length === 1);
    f.alone(false); await f.driver.tick(); f.release();
    await until(() => f.handed.length === 1 && f.driver.runtime.get('owner', f.task.id)?.phase === 'ready');
    expect(new Set(f.handed).size).toBe(1); expect(f.readPrivate).not.toHaveBeenCalled();
  });
  it('does not admit an ordinary or forged-title request while others can hear', async () => {
    const f = fixture({ audited: false });
    expect(f.allowed(f.task.id)).toBe(false);
    expect(f.guard('owner', f.task.id)).toBe(false);
    await f.driver.tick(); await delay(20);
    expect(f.inputs).toEqual([]); expect(f.handed).toEqual([]);
  });
  it('denies sources, other scopes and child tasks, even when a canonical request exists', () => {
    const f = fixture(), task = f.driver.runtime.get('owner', f.task.id)!;
    expect(f.guard.sources('owner', task, [])).toBe(true);
    expect(f.guard.content?.('owner', f.task.id, 'private text', new Date().toISOString())).toBe(false);
    expect(f.guard.sources('other', task, [])).toBe(false);
    expect(f.guard.sources('owner', task, [{ stepId: 'private', threadId: 'private', experienceId: 'private', observedAt: new Date().toISOString(), recalledMemoryIds: [] }])).toBe(false);
    f.driver.runtime.createChild('owner', f.task.id, { title: 'child', goal: 'child' }, 'child');
    expect(f.allowed(f.task.id)).toBe(false);
    expect(f.readPrivate).not.toHaveBeenCalled();
  });
  it('still refuses a physical command whose action lease was revoked', async () => {
    const f = fixture(); await f.driver.tick(); await until(() => f.inputs.length === 1);
    f.revokeLease(); f.release();
    await until(() => f.driver.runtime.get('owner', f.task.id)?.phase !== 'executing');
    expect(f.handed).toEqual([]);
  });
  it('revokes the public exception if a private source is attached while the decision waits', async () => {
    const f = fixture({ initiallyAlone: true }); await f.driver.tick(); await until(() => f.inputs.length === 1);
    expect(f.addPrivateSource()).toBe(true); expect(f.allowed(f.task.id)).toBe(false);
    f.alone(false); await f.driver.tick(); f.release();
    await until(() => f.driver.runtime.get('owner', f.task.id)?.phase !== 'executing');
    expect(f.handed).toEqual([]);
    expect(JSON.stringify(f.inputs)).not.toContain('PRIVATE_CANARY');
  });
  it('does not expose private tool implementations through a filtered menu', async () => {
    const called = vi.fn(), ports = gameOnlyStepPorts({ tools: { definitions: [definition('memory.search')], execute: called } }, 'game');
    expect(ports.tools!.definitions).toEqual([]);
    await expect(ports.tools!.execute({ name: 'memory.search' } as never)).rejects.toThrow('FCA_TOOL_NOT_OFFERED');
    expect(called).not.toHaveBeenCalled();
    expect(coreAreaForRepositoryPath('services/api/src/wiring/minecraftGameOnly.ts')?.area).toBe('approval_and_budget');
    expect(coreAreaForRepositoryPath('docs/minecraft-streaming-contract.md')?.area).toBe('approval_and_budget');
  });
});
