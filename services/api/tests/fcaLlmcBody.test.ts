import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { ACT_INPUT_SCHEMA, MC_ACT_TOOL, type ActResult } from '../src/contracts/minecraftActContract.js';
import type { BodyPlanView } from '../src/contracts/bodyControlContract.js';
import { configuredMinecraftLlmc } from '../src/wiring/minecraftLlmcWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * Design mb-llm-centric 2.3 and 2.7 through the real control: `mc.act` is offered in the head's words, checked before the body sees it,
 * sent as the body's `act` skill with the task's plan in its context, and its result read back as lines; with the switch off nothing of it.
 */
const at = '2026-10-21T00:00:00.000Z', closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const PLAN: BodyPlanView = { revision: 3, current: 'p2', nodes: [{ id: 'p1', parentId: null, title: '木', state: 'done' },
  { id: 'p2', parentId: null, title: '食料', state: 'continue' }] };
const HANDS = { hands: [{ do: 'walk', to: { x: 3, y: 64, z: 4 } }, { do: 'chest', at: [{ x: 4, y: 64, z: 4 }], op: 'takeAll' }], stopIf: { hostileWithin: 8 } };

function fixture(llmc: boolean, input: unknown = HANDS) {
  const h = actionHarness(() => at), calls: FcaModelInput[] = [], bodyStore = new MinecraftControlStore(h.db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  let sequence = 0;
  const control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(at), ownerAlone: () => true, pollMilliseconds: 1,
    leaseValid: lease => !!h.store.check(lease, at)?.resources.includes(actionResource('minebot', 'minecraft-body')) });
  const loose = { type: 'object', properties: { hands: { type: 'array', items: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
    required: [], additionalProperties: false };
  const poll = (receipts: MinecraftControlReceipt[] = [], active: string[] = []) => control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, {
    schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: at, receivedAt: at, connected: true, state: { world: {} }, facts: {} },
    skills: [{ name: 'act', description: 'the body\'s own words', readOnly: false, inputSchema: loose },
      { name: 'move-to', description: 'Move.', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    candidates: [], receipts, activeOperationIds: active,
  } satisfies MinecraftControlPoll);
  poll();
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
    model: { async decide(request) { calls.push(request); return request.history.length
      ? { decision: { kind: 'wait', summary: 'next' }, history: [{ role: 'assistant', content: 'read the act' }] }
      : { decision: { kind: 'tools', calls: [{ id: 'act-1', name: MC_ACT_TOOL, input }] }, history: [{ role: 'assistant', content: 'act' }] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_runtime, step) => ({ tools: fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true,
      ...(llmc ? { llmc: { plan: () => PLAN } } : {}) }) }),
  });
  const root = driver.runtime.ensureRoot('owner'), task = driver.runtime.createChild('owner', root.id, { title: 'Food', goal: 'エンドラを倒して' }, 'owner-request');
  bodyStore.bind(task.id, 'minecraft:world');
  closes.push(async () => { await driver.close(); h.close(); });
  return { ...h, driver, task, control, bodyStore, calls, poll };
}
async function dispatched(f: ReturnType<typeof fixture>) {
  await f.driver.tick();
  for (let count = 0; count < 1000 && !f.bodyStore.pending('minecraft:world').length; count++) await delay(1);
  return f.poll().commands[0];
}

describe('mc.act through the control (switch on)', () => {
  it('offers only the mode\'s tools, sends the act with the plan, and reads its result as lines', async () => {
    const f = fixture(true), command = (await dispatched(f))!;
    expect(f.calls[0]!.tools.map(tool => tool.name).filter(name => /^(mc|minecraft)\./u.test(name))).toEqual(['minecraft.observe', MC_ACT_TOOL]);
    expect(f.calls[0]!.tools.find(tool => tool.name === MC_ACT_TOOL)!.nativeInputSchema).toBe(ACT_INPUT_SCHEMA);
    expect(command).toMatchObject({ kind: 'skill', skill: 'act', arguments: HANDS, context: { taskId: f.task.id, plan: PLAN } });
    const result: ActResult = { v: 1, ok: true, done: 2, of: 2, at: { x: 3, y: 64, z: 4 }, hp: 20, food: 19, ms: 2_100,
      lines: [{ i: 1, do: 'walk', status: 'done', line: '(0,64,0)→(3,64,4) 1.5秒' }, { i: 2, do: 'chest', status: 'done', line: 'bread×6 を取った' }],
      container: { at: { x: 4, y: 64, z: 4 }, kind: 'chest', items: [] } };
    f.poll([{ id: command.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at, result: JSON.stringify(result) }]);
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    const read = JSON.stringify(f.calls[1]!.history);
    expect(read).toContain('act 全部済み（2/2、2.1秒）');
    expect(read).toContain('2 chest 済 bread×6 を取った');
  });

  it('refuses a hand with a field it does not take before the body sees it', async () => {
    const f = fixture(true, { hands: [{ do: 'walk', to: { x: 1, y: 2, z: 3 }, block: 'dirt' }] });
    expect(await dispatched(f)).toBeUndefined();
    await f.driver.drain(); await f.driver.tick(); await f.driver.drain();
    expect(JSON.stringify(f.calls[1]!.history)).toContain('block は使えない');
  });
});

describe('the switch off: as before', () => {
  it('every body skill is offered in the body\'s words, and a command carries no plan', async () => {
    const f = fixture(false, { hands: [] }), command = (await dispatched(f))!;
    expect(f.calls[0]!.tools.map(tool => tool.name).filter(name => /^(mc|minecraft)\./u.test(name))).toEqual(['minecraft.observe', MC_ACT_TOOL, 'mc.move-to']);
    expect(f.calls[0]!.tools.find(tool => tool.name === MC_ACT_TOOL)!.description).toBe('the body\'s own words');
    expect(command.context.plan).toBeUndefined();
    f.poll([{ id: command.id, connectionId: 'connection', outcome: 'completed', inputsReleased: true, observedAt: at, result: 'done' }]);
    await f.driver.drain();
  });

  it('the wiring makes nothing of the mode while SHANNON_MINECRAFT_LLM_CENTRIC is off', () => {
    expect(configuredMinecraftLlmc({ ANTHROPIC_API_KEY: 'k' }, { recordUsage() {} })).toBeNull();
    expect(configuredMinecraftLlmc({ SHANNON_MINECRAFT_LLM_CENTRIC: 'on' }, { recordUsage() {} }, { log: () => {} })).toBeNull();
    const on = configuredMinecraftLlmc({ SHANNON_MINECRAFT_LLM_CENTRIC: 'on', ANTHROPIC_API_KEY: 'k' }, { recordUsage() {} }, { log: () => {} })!;
    expect(on.names).toEqual({ main: 'claude-sonnet-5-5', escalate: null, plan: 'claude-opus-5-5' });
    expect(on.models.escalate).toBeNull();
    expect(on.planner).toBeTypeOf('function');
    expect(on.summarizer).not.toBeNull();
  });
});
