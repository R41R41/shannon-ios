import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ACT_INPUT_SCHEMA, actProblem, MC_ACT_TOOL, type ActPos } from '../src/contracts/minecraftActContract.js';
import type { MinecraftControlReceipt, MinecraftSkillDefinition } from '../src/contracts/minecraftControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { handContinuesOnFail } from '../src/contracts/minecraftActTypes.js';
import { conditionHolds } from '../src/surfaces/minecraft/minecraftConditions.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { MC_MAKE_AT_TOOL, PURPOSE_INPUT_SCHEMA, purposeHands, type MakeAtPurpose } from '../src/surfaces/minecraft/minecraftLlmcPurpose.js';
import { candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { createLlmcQueue, forgetLlmcQueues, type LlmcQueue, type QueueAdd } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import * as actionExecution from '../src/infra/context/actionExecution.js';
import { fcaMinecraftTools } from '../src/wiring/fcaMinecraftTools.js';
import { sendItem } from '../src/wiring/fcaMinecraftActItem.js';

const at = (x: number, y = 64, z = 0): ActPos => ({ x, y, z });
const TABLE = at(2);
const PACK = { iron_ingot: 3, stick: 2 };
function frame(options: { tables?: ActPos[]; inventory?: Record<string, number>; feet?: ActPos; blocked?: ActPos[] } = {}): BodyObservation {
  const feet = options.feet ?? at(0), tables = options.tables ?? [TABLE], blocked = options.blocked ?? [];
  const cell = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
  const same = (a: ActPos, x: number, y: number, z: number) => a.x === x && a.y === y && a.z === z;
  const localMap = [`地図 v1 足=(${cell.x},${cell.y},${cell.z}) x=${cell.x - 10}..${cell.x + 10} z=${cell.z - 10}..${cell.z + 10} 方式=layers 上=北`];
  for (const y of [cell.y + 1, cell.y, cell.y - 1]) {
    localMap.push(`y=${y}`);
    for (let z = cell.z - 10; z <= cell.z + 10; z += 1) {
      const row: string[] = [];
      for (let x = cell.x - 10; x <= cell.x + 10; x += 1) row.push(tables.some(t => same(t, x, y, z)) ? 'T'
        : blocked.some(t => same(t, x, y, z)) || y === cell.y - 1 ? '#' : '.');
      localMap.push(`${z} ${row.join(' ')}`);
    }
  }
  return { schemaVersion: 1, bodyId: 'minecraft:purpose', sequence: 1, stateAt: '2026-11-03T00:00:00Z', receivedAt: '2026-11-03T00:00:00Z',
    connected: true, facts: {}, state: { world: { position: feet, health: 20, food: 20, dimension: 'overworld',
      inventory: options.inventory ?? PACK, localMap: localMap.join('\n') } as never } };
}
const input = (overrides: Partial<MakeAtPurpose> = {}): MakeAtPurpose => ({ item: 'iron_pickaxe', count: 1, table: TABLE,
  allowPlace: false, maxSeconds: 30, abortIf: {}, ...overrides });
function plan(request = input(), observation = frame()) {
  const result = purposeHands(request, observation);
  if (!result.ok) throw new Error(result.text);
  expect(validSkillInput(result.input, ACT_INPUT_SCHEMA)).toBe(true);
  expect(actProblem(result.input)).toBeNull();
  return result;
}
afterEach(() => vi.restoreAllMocks());

describe('one make-at purpose expanded from the frame', () => {
  it('uses the nearby specified table, without going, placing, picking up or making intermediates', () => {
    const result = plan();
    expect(result.input.hands).toEqual([{ do: 'craft', item: 'iron_pickaxe', count: 1, onFail: 'stop' }]);
    expect(conditionHolds(result.input.pre!, frame())).toBe(true);
    expect(result.table).toEqual(TABLE);
  });
  it('goes inside the 4.5m reach with no digging/placing authority, then crafts', () => {
    const table = at(9), result = plan(input({ table }), frame({ tables: [table] }));
    expect(result.input.hands).toEqual([
      { do: 'go', to: table, range: 4, seconds: 30, maxDig: 0, maxPlace: 0, onFail: 'stop' },
      { do: 'craft', item: 'iron_pickaxe', count: 1, onFail: 'stop', dependsOn: [1] },
    ]);
    expect(result.input.repeat).toBeUndefined();
    expect(result.input.done).toBeUndefined(); // count means additional output, even when one is already carried.
  });
  it('does not substitute a nearby table for a missing specified one', () => {
    expect(purposeHands(input({ table: at(8) }), frame())).toMatchObject({ ok: false, code: 'no_table' });
  });
  it('refuses visible competing tables rather than choosing between them', () => {
    expect(purposeHands(input(), frame({ tables: [TABLE, at(-2)] }))).toMatchObject({ ok: false, code: 'ambiguous_table' });
    expect(purposeHands(input({ table: at(9) }), frame({ tables: [TABLE, at(9)] }))).toMatchObject({ ok: false, code: 'ambiguous_table' });
  });
  it('refuses a missing table without permission, including place_here', () => {
    for (const table of [TABLE, 'place_here'] as const) {
      const result = purposeHands(input({ table }), frame({ tables: [], inventory: { ...PACK, crafting_table: 1 } }));
      expect(result).toMatchObject({ ok: false, code: 'no_table' });
      expect(result).not.toHaveProperty('input');
    }
  });
  it('places only at the requested cell when permitted, then crafts, with stop-on-failure dependencies', () => {
    const result = plan(input({ allowPlace: true }), frame({ tables: [], inventory: { ...PACK, crafting_table: 1 } }));
    expect(result.input.hands).toEqual([
      { do: 'place', block: 'crafting_table', at: [TABLE], onFail: 'stop' },
      { do: 'craft', item: 'iron_pickaxe', count: 1, onFail: 'stop', dependsOn: [1] },
    ]);
    for (const hand of result.input.hands) expect(handContinuesOnFail(hand)).toBe(false);
  });
  it('creates a table from direct materials only when its placement is authorized, checking all materials first', () => {
    const result = plan(input({ allowPlace: true }), frame({ tables: [], inventory: { ...PACK, oak_planks: 4 } }));
    expect(result.input.hands.map(hand => hand.do)).toEqual(['craft', 'place', 'craft']);
    expect(result.input.hands[0]).toMatchObject({ item: 'crafting_table', count: 1 });
    expect(result.input.hands.slice(1).map(hand => hand.dependsOn)).toEqual([[1], [2]]);
    expect(result.input.pre![0]).toContainEqual({ k: 'have', item: 'planks', n: 4 });
  });
  it('place_here means the east adjacent cell; a blocked cell never triggers a different location', () => {
    const request = input({ table: 'place_here', allowPlace: true });
    const result = plan(request, frame({ tables: [], inventory: { ...PACK, crafting_table: 1 } }));
    expect(result.table).toEqual(at(1));
    expect(purposeHands(request, frame({ tables: [], blocked: [at(1)] }))).toMatchObject({ ok: false, code: 'cannot_place' });
    expect(purposeHands(input({ table: at(0), allowPlace: true }), frame({ tables: [] }))).toMatchObject({ ok: false, code: 'cannot_place' });
  });
  it('returns exact shortages before any movement, table placement or intermediate crafting', () => {
    const result = purposeHands(input({ table: at(9), count: 2 }), frame({ tables: [at(9)], inventory: { iron_ingot: 4, stick: 1 } }));
    expect(result).toMatchObject({ ok: false, code: 'missing', missing: [{ item: 'iron_ingot', count: 2 }, { item: 'stick', count: 3 }] });
    expect(result).not.toHaveProperty('input');
    expect(purposeHands(input(), frame({ inventory: { iron_ingot: 3, oak_planks: 8 } }))).toMatchObject({
      ok: false, code: 'missing', missing: [{ item: 'stick', count: 2 }],
    });
    expect(purposeHands(input({ item: 'wooden_pickaxe', allowPlace: true }), frame({ tables: [], inventory: { oak_planks: 6, stick: 2 } })))
      .toMatchObject({ ok: false, code: 'missing', missing: [{ item: 'planks', count: 1 }] });
  });
  it('counts recipe yields and requested additional output even when the product is already held', () => {
    const result = plan(input({ item: 'torch', count: 5 }), frame({ inventory: { coal: 2, stick: 2, torch: 64 } }));
    expect(result.input.pre![0]).toContainEqual({ k: 'have', item: 'coal', n: 2 });
    expect(result.input.hands.at(-1)).toMatchObject({ item: 'torch', count: 5 });
  });
  it('preserves the whole-act time ceiling, including fractional seconds, without rounding it up', () => {
    expect(plan(input({ maxSeconds: 1.2349 })).maxMs).toBe(1234);
    const table = at(9), result = plan(input({ table, maxSeconds: 180 }), frame({ tables: [table] }));
    expect(result.maxMs).toBe(180_000);
    expect(result.input.hands[0]!.seconds).toBe(120);
    expect(purposeHands(input({ table, maxSeconds: 4 }), frame({ tables: [table] }))).toMatchObject({ ok: false, code: 'time_limit' });
    for (const maxSeconds of [0, -1, 181, NaN, Infinity]) expect(purposeHands(input({ maxSeconds }), frame()))
      .toMatchObject({ ok: false, code: 'invalid_input' });
  });
  it('copies abortIf without sharing or weakening it, including a threshold already above current HP', () => {
    const request = input({ abortIf: { hpBelow: 15, hostileWithin: 8 } }), observation = frame();
    (observation.state.world as Record<string, unknown>).health = 10;
    const result = plan(request, observation);
    expect(result.input.stopIf).toEqual(request.abortIf);
    expect(result.input.stopIf).not.toBe(request.abortIf);
    expect(request.abortIf).toEqual({ hpBelow: 15, hostileWithin: 8 });
  });
  it('refuses unknown cells, missing frames and stale-position maps, never assuming a table exists', () => {
    expect(purposeHands(input(), null)).toMatchObject({ ok: false, code: 'unobserved' });
    expect(purposeHands(input({ table: at(99), allowPlace: true }), frame())).toMatchObject({ ok: false, code: 'unobserved' });
    const stale = frame();
    (stale.state.world as Record<string, unknown>).position = at(1);
    expect(purposeHands(input(), stale)).toMatchObject({ ok: false, code: 'unobserved' });
    const unseenPack = frame();
    delete (unseenPack.state.world as Record<string, unknown>).inventory;
    expect(purposeHands(input(), unseenPack)).toMatchObject({ ok: false, code: 'unobserved' });
  });
  it('does not depend on a seed or origin: the requested coordinates move with the frame', () => {
    const feet = at(-240, -30, 312), table = at(-231, -30, 312);
    const result = plan(input({ table }), frame({ feet, tables: [table] }));
    expect(result.input.hands[0]!.to).toEqual(table);
    expect(result.input.pre![0]).toContainEqual({ k: 'at', ...feet, r: 0.25 });
  });
  it('rejects invalid counts, coordinates, recipes, missing required fields and extra permissions', () => {
    for (const bad of [{ count: 0 }, { count: 1.5 }, { count: 65 }, { table: at(0.5) }, { item: 'constructor' },
      { allowPlace: 'true' }, { canDig: ['stone'] }, { abortIf: { hpBelow: 21 } }, { abortIf: { hostileWithin: 33 } }]) {
      expect(purposeHands({ ...input(), ...bad }, frame()), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    const { abortIf: _missing, ...incomplete } = input();
    expect(purposeHands(incomplete, frame())).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

function toolsFixture(observation = frame(), available = true) {
  const skills: MinecraftSkillDefinition[] = available ? [{ name: 'act', description: 'act', readOnly: false, inputSchema: ACT_INPUT_SCHEMA }] : [];
  const added: QueueAdd[] = [];
  let open = false;
  const queue = { open: () => open, ahead: () => [], tuning: () => ({}),
    add: vi.fn(async (spec: QueueAdd) => { added.push(spec); return { ok: true as const, item: 'q1', after: null, startInMs: 30_000 }; }),
  } as unknown as LlmcQueue;
  const control = { store: { body: () => 'minecraft:purpose', bind: () => true },
    frame: () => ({ poll: { skills, connectionId: 'connection' } }), observe: () => observation,
    configuration: { deviceId: 'minebot' },
  } as unknown as MinecraftControl;
  const execution = { lease: { id: 'lease' }, permit: vi.fn(async () => true) };
  vi.spyOn(actionExecution, 'currentActionExecution').mockReturnValue(execution as unknown as ReturnType<typeof actionExecution.currentActionExecution>);
  const step = { taskId: 'task', scopeKey: 'owner', lease: { id: 'lease' } } as TaskStep;
  const tools = fcaMinecraftTools({ control, step, ownerAlone: () => true, sourcesVisible: () => true, llmc: { queue, plan: () => undefined } });
  const run = (request: MakeAtPurpose) => tools.execute({ name: MC_MAKE_AT_TOOL, input: request as unknown as Record<string, unknown>,
    scopeKey: 'owner', taskId: 'task', operationId: 'purpose-op', signal: new AbortController().signal });
  return { tools, queue, added, run, setOpen: () => { open = true; } };
}

describe('the thin entry uses the existing act queue', () => {
  it('is offered only when act is available, survives the v2 menu, and keeps its input schema separate', () => {
    const f = toolsFixture();
    expect(candidateMenuTools(f.tools.definitions).map(tool => tool.name)).toEqual([MC_ACT_TOOL, MC_MAKE_AT_TOOL]);
    expect(f.tools.definitions.find(tool => tool.name === MC_MAKE_AT_TOOL)?.nativeInputSchema).toBe(PURPOSE_INPUT_SCHEMA);
    expect(toolsFixture(frame(), false).tools.definitions.some(tool => tool.name === MC_MAKE_AT_TOOL)).toBe(false);
  });
  it('sends exactly one bounded act with pre and unchanged stopIf; never sends a purpose field to the body', async () => {
    const observation = frame();
    (observation.state.world as Record<string, unknown>).health = 5;
    const f = toolsFixture(observation), result = await f.run(input({ maxSeconds: 1.5, abortIf: { hpBelow: 15, hostileWithin: 8 } }));
    expect(result.ok).toBe(true);
    expect(f.added).toHaveLength(1);
    expect(f.added[0]).toMatchObject({ skill: 'act', maxMs: 1500, operationId: 'purpose-op',
      arguments: { stopIf: { hpBelow: 15, hostileWithin: 8 } }, pre: [[{ k: 'have', item: 'iron_ingot', n: 3 }, { k: 'have', item: 'stick', n: 2 },
        { k: 'at', x: 0, y: 64, z: 0, r: 0.25 }]] });
    expect(f.added[0]!.arguments).not.toHaveProperty('pre');
    expect(f.added[0]!.arguments).not.toHaveProperty('purpose');
    expect(f.added[0]!.input.hands.every(hand => hand.onFail === 'stop')).toBe(true);
  });
  it('sends nothing on shortage or while prior work is queued, without queuing a repair or deferred continuation', async () => {
    const short = toolsFixture(frame({ inventory: {} }));
    expect(await short.run(input())).toMatchObject({ ok: false, retryable: false });
    expect(short.added).toEqual([]);
    const busy = toolsFixture(); busy.setOpen();
    expect(await busy.run(input())).toMatchObject({ ok: false, retryable: false });
    expect(busy.added).toEqual([]);
  });
});

describe('a stopped purpose is not continued or re-enqueued by the head', () => {
  for (const stoppedBy of ['failure', 'reflex', 'stopIf', 'deadline'] as const) {
    it(`returns ${stoppedBy} through the real queue, with no second command after the receipt`, async () => {
      const db = new DatabaseSync(':memory:'), store = new MinecraftControlStore(db);
      const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
        servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
      const control = new MinecraftControl(store, configuration, { ownerAlone: () => true, leaseValid: () => true,
        pollMilliseconds: 1, frameMilliseconds: 60_000 });
      const lease = { id: 'lease-purpose', generation: 1, holder: 'test' };
      const context = { scopeKey: 'owner', taskId: 'task-purpose', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'purpose-session',
        generation: 1, goal: '指定作業台で鉄のツルハシを作る', completionCondition: '追加の1個が持ち物にある' };
      let sequence = 0;
      const poll = (receipts: MinecraftControlReceipt[] = []) => {
        const observation = frame({ tables: [at(9)] });
        return control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
          observation: { ...observation, bodyId: 'minecraft:world', sequence: ++sequence, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString() },
          skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: ACT_INPUT_SCHEMA }],
          candidates: [], receipts, activeOperationIds: [] });
      };
      poll();
      const queue = createLlmcQueue({ control, taskId: context.taskId, lease, bodyId: () => context.bodyId,
        observe: () => control.observe(context.bodyId), context: () => context, log: () => {}, record: () => {} });
      try {
        const purpose = plan(input({ table: at(9), maxSeconds: 12.5, abortIf: { hpBelow: 12, hostileWithin: 8 } }), control.observe(context.bodyId)!);
        const call = { scopeKey: 'owner', taskId: context.taskId, operationId: `purpose-${stoppedBy}`, name: MC_ACT_TOOL,
          input: purpose.input, signal: new AbortController().signal };
        expect((await sendItem({ queue, control, bodyId: context.bodyId, call, skill: 'act', fixes: [], node: null,
          frame: control.observe(context.bodyId), maxMs: purpose.maxMs })).ok).toBe(true);
        const commands = poll().commands;
        expect(commands).toHaveLength(1);
        expect(commands[0]!.queue).toMatchObject({ maxMs: 12_500, pre: purpose.input.pre });
        expect(commands[0]!.arguments).toMatchObject({ stopIf: { hpBelow: 12, hostileWithin: 8 }, hands: purpose.input.hands });
        const result = { v: 1, ok: false, done: 0, of: 2, stoppedBy, stoppedWhy: '実行を中止', ms: 500,
          at: at(0), hp: 10, food: 20, lines: [
            { i: 1, do: 'go', status: 'stopped', line: '中止' }, { i: 2, do: 'craft', status: 'skipped', line: '未実行' },
          ] };
        poll([{ id: commands[0]!.id, connectionId: 'connection', outcome: 'failed', inputsReleased: true,
          observedAt: new Date().toISOString(), result: JSON.stringify(result) }]);
        await queue.settled(1000);
        const news = queue.take();
        expect(news).toHaveLength(1);
        expect(news[0]!.result.ok).toBe(false);
        expect(news[0]!.result.text).toContain(stoppedBy);
        if (stoppedBy === 'reflex') expect(news[0]!.result.bodyReflex).toBe(true);
        expect(queue.open()).toBe(false);
        expect(await queue.ready({ signal: new AbortController().signal, drain: false })).toBe('empty');
        expect(poll().commands).toEqual([]);
        expect(poll().commands).toEqual([]);
      } finally {
        queue.stop(); db.close(); forgetLlmcQueues();
      }
    });
  }
});
