import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import { combineFcaTools, fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import { actionHarness } from './support/actionThreadHarness.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture(options: { finalRace?: boolean; unknownRelease?: boolean; explicit?: boolean } = {}) {
  let clock = Date.parse('2026-10-09T00:00:00Z'), sequence = 0, danger = false, entryCalls = 0, motorHeld = false, readsHeld = 0;
  let inboxClosed = false, readWithInboxClosed = false, receipts: MinecraftControlReceipt[] = [];
  const now = () => new Date(clock).toISOString(), h = actionHarness(now), store = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'native',
    servers: [{ serverId: 'home', title: 'home', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const known = (lease: { id: string; generation: number; holder: string }) => {
    const action = h.store.get(lease.id);
    return !!action && action.holder === lease.holder && action.generation === lease.generation
      && action.resources.includes(actionResource('native', 'minecraft-body'));
  };
  const control = new MinecraftControl(store, configuration, { now: () => clock, leaseValid: known, leaseKnown: known,
    ownerAlone: () => true, pollMilliseconds: 1, cancelWaitMilliseconds: 10 });
  const commands: MinecraftControlCommand[] = [];
  function pump() {
    clock++; const received = receipts; receipts = [];
    const reply = control.poll({ scopeKey: 'owner', deviceId: 'native' }, { schemaVersion: 1, serverId: 'home', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence, stateAt: now(), receivedAt: now(), connected: true,
        state: {}, facts: { danger, onGround: true } }, candidates: [{ kind: 'action', label: 'retreat', operation: 'move', arguments: {},
        preconditions: [], maxDurationMs: 100, expiresAt: new Date(clock + 3000).toISOString() }],
      skills: [{ name: 'goal-evidence', description: 'native read', readOnly: true, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      receipts: received, activeOperationIds: [] });
    for (const command of reply.commands) {
      commands.push(command);
      if (command.kind === 'reflex') { motorHeld = true; danger = false; }
      if (command.kind === 'stop') motorHeld = false;
      const unknown = command.kind === 'release' && options.unknownRelease;
      if (command.kind === 'release' && !unknown) motorHeld = false;
      if (command.kind === 'skill') { if (motorHeld) readsHeld++; if (inboxClosed) readWithInboxClosed = true; }
      receipts.push({ id: command.id, connectionId: command.connectionId, outcome: unknown ? 'unknown' : 'completed',
        inputsReleased: !unknown, observedAt: now(), result: JSON.stringify({ boss: { verified: true } }),
        ...(command.stop ? { stop: { bodyId: command.context.bodyId, sessionId: command.context.sessionId, generation: command.context.generation,
          requestId: command.stop.requestId, state: unknown ? 'unknown' : 'stopped', inputsReleased: !unknown, observedAt: now() } } : {}),
        ...(command.operation ? { action: { schemaVersion: 1, operationId: command.operation.operationId, bodyId: command.context.bodyId,
          sessionId: command.context.sessionId, generation: command.context.generation, outcome: 'completed', inputsReleased: true, observedAt: now(), evidenceId: command.id } } : {}),
        ...(command.kind === 'capture' ? { image: { dataUrl: 'data:image/jpeg;base64,/9j/', capturedAt: now() } } : {}) });
    }
  }
  pump(); const timer = setInterval(pump, 1);
  let launched: Promise<unknown> | null = null;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now,
    model: { decide: async () => ({ decision: { kind: options.explicit ? 'tools' : 'complete', ...(options.explicit
      ? { calls: [{ id: 'verify', name: 'goal.verify', input: {} }] } : { summary: 'Provider claims goal achieved' }) } as any, history: [] }), toolResults: results => ({ results }) },
    stepPorts(runtime, step) {
      const body = createMinecraftTaskBody({ control, runtime, step, now: () => clock, pollMilliseconds: 1,
        limits: { maxDurationMs: 1000, maxDecisions: 1, maxActions: 1 }, ownerAlone: () => true, sourcesVisible: () => true,
        entry: { evaluate: async input => { entryCalls++; return { sessionId: input.context.sessionId, generation: input.context.generation, decision: 'enter', reason: 'danger' }; } },
        selector: { choose: async (input, signal) => {
          if (options.finalRace) return new Promise<null>(resolve => { if (signal.aborted) resolve(null); else signal.addEventListener('abort', () => resolve(null), { once: true }); });
          return { sessionId: input.context.sessionId, generation: input.context.generation,
            candidateId: input.candidates.find(candidate => candidate.kind === 'action')!.id };
        } } });
      const native = fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true });
      const base = combineFcaTools({ ...native, async execute(call) {
        // A hazard arriving during a final read may start a new reflex only if the monitor wasn't drained.
        danger = true; pump(); await delay(15); return native.execute(call);
      } }, body.tools);
      let guards = 0;
      const actualGuard = body.body.guard;
      const lifecycle = { ...body.body, async guard(revision: number) {
        const value = await actualGuard(revision);
        if (options.finalRace && ++guards === 2) {
          launched = body.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId: `${step.id}:concurrent-reflex`, name: 'minecraft.reflex', input: {}, signal: new AbortController().signal });
          void launched.catch(() => {});
          for (let attempt = 0; attempt < 200 && !commands.some(command => command.kind === 'stop'); attempt++) await delay(1);
          expect(commands.some(command => command.kind === 'stop')).toBe(true);
        }
        return value;
      } };
      return { body: lifecycle, safeToAcknowledgeStop: body.safeToAcknowledgeStop,
        observations: [{ start() {}, toolSignal: (_: string, signal: AbortSignal) => signal, revision: () => 0, context: () => ({ revision: 0, observation: null }), guard: async () => true,
          close: async () => { inboxClosed = true; } }],
        tools: createFcaProgressTools(base, { permit: async () => {}, observationSignal: (name, signal) => {
          if (options.explicit && !launched && name.startsWith('mc.')) {
            launched = body.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId: `${step.id}:during-explicit-check`,
              name: 'minecraft.reflex', input: {}, signal }); void launched.catch(() => {});
          }
          return body.body.toolSignal(name, signal);
        },
          binding: { id: 'native-fixture', conditions: [{ id: 'dragon', tool: 'mc.goal-evidence', input: {}, path: 'boss.verified', operator: 'eq', expected: true }] } }),
      };
    } });
  const task = driver.runtime.createChild('owner', driver.runtime.ensureRoot('owner').id, { title: 'dragon', goal: 'EnderDragon fixture' }, 'request'); store.bind(task.id, 'minecraft:home');
  closes.push(async () => { await driver.close(); await launched?.catch(() => {}); clearInterval(timer); h.close(); });
  return { driver, task, commands, entryCalls: () => entryCalls, readsHeld: () => readsHeld, readWithInboxClosed: () => readWithInboxClosed };
}
describe('common FCA final verification and native reflex ownership', () => {
  it('closes the actual body monitor before fresh native reads while keeping the task inbox monitor active', async () => {
    const f = fixture(); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('completed');
    expect(f.commands.map(command => command.kind)).toEqual(['skill']); expect(f.entryCalls()).toBe(0);
    expect(f.readsHeld()).toBe(0); expect(f.readWithInboxClosed()).toBe(false);
  });
  it('drains a reflex entering immediately after the decision guard and rejects the stale completion before any evidence query', async () => {
    const f = fixture({ finalRace: true }); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready');
    expect(f.commands.some(command => command.kind === 'stop')).toBe(true);
    expect(f.commands.some(command => command.kind === 'release')).toBe(true);
    expect(f.commands.some(command => command.kind === 'skill')).toBe(false); expect(f.readsHeld()).toBe(0);
  });
  it('retains unknown physical release instead of querying or committing completion', async () => {
    const f = fixture({ finalRace: true, unknownRelease: true }); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('unknown');
    expect(f.commands.some(command => command.kind === 'skill')).toBe(false);
  });
  it('interrupts an explicit native verification through the ordinary body signal without disabling reflex work', async () => {
    const f = fixture({ explicit: true }); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', f.task.id)?.phase).toBe('ready');
    expect(f.commands.some(command => command.kind === 'reflex')).toBe(true);
    expect(f.commands.some(command => command.kind === 'release')).toBe(true);
    expect(f.commands.some(command => command.kind === 'skill')).toBe(false);
    expect(f.driver.runtime.snapshot('owner', f.task.id)?.checkpoint).toMatchObject({ fcaProgress: {
      verification: { status: 'not_verified', checks: [{ failure: 'observation_interrupted', passed: false }] },
    } });
  });
});
