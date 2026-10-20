import { describe, expect, it } from 'vitest';
import { minecraftAgendaLines, preemptForNeed, withMinecraftAgenda } from '../src/surfaces/minecraft/minecraftAgenda.js';
import type { FcaExternalTools } from '../src/mind/action/fca/fcaPorts.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

/** mb-arch: the executor around her body tools: the small work of a wait, a need taken in a wait and the wait resumed, one detour after. */
const AT = '2026-10-20T10:00:00.000Z';
const NAMES = ['mc.wait-time', 'mc.withdraw-from-furnace', 'mc.mine-block', 'mc.attack-continuously', 'mc.craft-one', 'mc.place-block-at',
  'mc.start-smelting', 'mc.move-to', 'mc.dig-block-at', 'mc.find-blocks'];
let tasks = 0;

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: AT, receivedAt: AT, connected: true,
    state: { world: { position: { x: 0, y: 64, z: 0 }, margin: { darkInSeconds: 300 }, nearbyThreats: [], inventory: [], ...world } } as never,
    facts: { danger: false } };
}
const need = (kind: string, name: string, distance: number, position = { x: Math.round(distance), y: 64, z: 0 }) =>
  ({ id: `${kind}:b:${position.x},${position.y},${position.z}`, need: kind, name, position, distance, canReach: true });

function fixture(world: Record<string, unknown>, options: { advance?: Record<string, number>; judge?: boolean; during?: (name: string) => void;
  without?: string[] } = {}) {
  let clock = Date.parse(AT);
  const taskId = `agenda-${++tasks}`;
  const calls: Array<{ name: string; input: unknown; operationId: string }> = [];
  let current = frame(world);
  const inner: FcaExternalTools = {
    definitions: NAMES.filter(name => !options.without?.includes(name)).map(name => ({ name, description: name, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      domain: 'minecraft_body', effect: name === 'mc.find-blocks' ? 'read' : 'write', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] })) as never,
    async execute(request) {
      calls.push({ name: request.name, input: request.input, operationId: request.operationId });
      options.during?.(request.name);
      clock += options.advance?.[request.name] ?? 1_000;
      if (request.signal.aborted) return { ok: false, text: 'cancelled', retryable: true };
      if (request.name === 'mc.place-block-at') return { ok: true, text: 'furnaceを(10, 64, 2)に設置しました', retryable: false };
      return { ok: true, text: `${request.name} done`, retryable: false };
    },
  };
  const tools = withMinecraftAgenda(inner, { on: true, taskId, observe: () => current, now: () => clock,
    ...(options.judge !== undefined ? { judge: { takeNow: async () => options.judge! } } : {}) });
  const call = (name: string, input: unknown = {}, last = true) => tools.execute({ scopeKey: 'owner', taskId, operationId: `step:${name}`, name, input,
    signal: new AbortController().signal, last });
  return { taskId, calls, call, setWorld: (next: Record<string, unknown>) => { current = frame({ ...world, ...next }); } };
}

describe('Minecraft executor (mb-arch)', () => {
  it('digs the iron still needed while waiting on the furnace, then waits on it', async () => {
    const f = fixture({ jobs: [{ position: { x: 5, y: 64, z: 0 }, remainingEstimateMs: 40_000, input: 'raw_iron', count: 6 }],
      nearbyNeeds: [need('iron', 'iron_ore', 10)] });
    const result = await f.call('mc.withdraw-from-furnace', { x: 5, y: 64, z: 0, waitForCompletion: true });
    expect(f.calls.map(call => call.name)).toEqual(['mc.mine-block', 'mc.withdraw-from-furnace']);
    expect(f.calls[0]!.operationId).toBe('step:mc.withdraw-from-furnace:filler1');
    expect(result.text).toContain('待つ間に: mc.mine-block（まだ要る鉄が近い）');
    expect(minecraftAgendaLines(f.taskId)).toEqual(['待つ間に: mc.mine-block（まだ要る鉄が近い）→ mc.mine-block done']);
    expect(minecraftAgendaLines(f.taskId)).toEqual([]);
  });

  it('starts a second furnace for raw meat while the first smelts iron: make it, place it, fill it where it stands', async () => {
    const f = fixture({ jobs: [{ position: { x: 2, y: 64, z: 0 }, remainingEstimateMs: 60_000, input: 'raw_iron', count: 9 }],
      inventory: [{ name: 'porkchop', count: 5 }, { name: 'coal', count: 3 }, { name: 'cobblestone', count: 12 }] });
    await f.call('mc.withdraw-from-furnace', { x: 2, y: 64, z: 0, waitForCompletion: true });
    expect(f.calls.map(call => call.name)).toEqual(['mc.craft-one', 'mc.place-block-at', 'mc.start-smelting', 'mc.withdraw-from-furnace']);
    expect(f.calls[2]!.input).toEqual({ x: 10, y: 64, z: 2, inputItem: 'porkchop', fuelItem: 'coal', count: 5 });
  });

  it('rel23: the second furnace is set within 8 m of the first: she walks to the first one before placing it when she stands further than 3 m', async () => {
    const f = fixture({ jobs: [{ position: { x: 5, y: 64, z: 0 }, remainingEstimateMs: 60_000, input: 'raw_iron', count: 9 }],
      inventory: [{ name: 'porkchop', count: 5 }, { name: 'coal', count: 3 }, { name: 'cobblestone', count: 12 }] });
    await f.call('mc.withdraw-from-furnace', { x: 5, y: 64, z: 0, waitForCompletion: true });
    expect(f.calls.map(call => call.name)).toEqual(['mc.craft-one', 'mc.move-to', 'mc.place-block-at', 'mc.start-smelting', 'mc.withdraw-from-furnace']);
    expect(f.calls[1]!.input).toEqual({ x: 5, y: 64, z: 0, range: 3 });
    const carried = fixture({ jobs: [{ position: { x: 5, y: 64, z: 0 }, remainingEstimateMs: 60_000, input: 'raw_iron', count: 9 }],
      inventory: [{ name: 'porkchop', count: 5 }, { name: 'coal', count: 3 }, { name: 'furnace', count: 1 }] });
    await carried.call('mc.withdraw-from-furnace', { x: 5, y: 64, z: 0, waitForCompletion: true });
    expect(carried.calls.map(call => call.name)).toEqual(['mc.move-to', 'mc.place-block-at', 'mc.start-smelting', 'mc.withdraw-from-furnace']);
  });

  it('does not wait at all when the work used the whole timer', async () => {
    const f = fixture({ nearbyNeeds: [need('fuel', 'coal_ore', 10)] }, { advance: { 'mc.mine-block': 19_000 } });
    const result = await f.call('mc.wait-time', { milliseconds: 20_000 });
    expect(f.calls.map(call => call.name)).toEqual(['mc.mine-block']);
    expect(result.text).toMatch(/^待つ時間を、待つ間の仕事に使った/u);
  });

  it('takes a bed that came into reach during the wait, then resumes the wait', async () => {
    const bed = need('bed', 'red_bed', 13, { x: 69, y: 66, z: 4 });
    let stopped = false;
    const f = fixture({}, { during: name => { if (name === 'mc.wait-time' && !stopped) { stopped = true; expect(preemptForNeed(f.taskId, { ...bed,
      at: AT, data: { x: 69, y: 66, z: 4 } } as never)).toBe(true); } } });
    const result = await f.call('mc.wait-time', { milliseconds: 30_000 });
    expect(f.calls.map(call => call.name)).toEqual(['mc.wait-time', 'mc.move-to', 'mc.dig-block-at', 'mc.wait-time']);
    expect(f.calls[2]!.input).toEqual({ x: 69, y: 66, z: 4, takeEquipment: true });
    expect(f.calls[3]!.operationId).toBe('step:mc.wait-time:resume');
    expect(result.text).toContain('再開: mc.wait-time');
  });

  it('takes one detour after a call: a standing bed always, a food animal only when the judge says now', async () => {
    const f = fixture({ nearbyNeeds: [need('bed', 'red_bed', 20, { x: 20, y: 64, z: 0 })] });
    await f.call('mc.mine-block', { blockName: 'stone', count: 3 });
    expect(f.calls.map(call => call.name)).toEqual(['mc.mine-block', 'mc.move-to', 'mc.dig-block-at']);
    const skip = fixture({ nearbyNeeds: [need('food', 'pig', 6)] }, { judge: false });
    await skip.call('mc.mine-block', { blockName: 'stone', count: 3 });
    expect(skip.calls.map(call => call.name)).toEqual(['mc.mine-block']);
    const take = fixture({ nearbyNeeds: [need('food', 'pig', 6)] }, { judge: true });
    await take.call('mc.mine-block', { blockName: 'stone', count: 3 });
    expect(take.calls.map(call => call.name)).toEqual(['mc.mine-block', 'mc.attack-continuously']);
  });

  it('takes no detour between calls chosen together, at night, or after a shelter; a failed item says only how it failed', async () => {
    const bed = need('bed', 'red_bed', 20, { x: 20, y: 64, z: 0 });
    const between = fixture({ nearbyNeeds: [bed] });
    await between.call('mc.mine-block', { blockName: 'stone' }, false);
    expect(between.calls.map(call => call.name)).toEqual(['mc.mine-block']);
    const night = fixture({ nearbyNeeds: [bed], margin: { lightInSeconds: 300 } });
    await night.call('mc.mine-block', { blockName: 'stone' });
    expect(night.calls.map(call => call.name)).toEqual(['mc.mine-block']);
    const shelter = fixture({ nearbyNeeds: [bed] });
    await shelter.call('mc.dig-shelter');
    expect(shelter.calls.map(call => call.name)).toEqual(['mc.dig-shelter']);
  });

  it('never spins on a filler whose tool is not offered, and resumes a timer for what is left of it', async () => {
    const f = fixture({ nearbyNeeds: [need('food', 'pig', 6)] }, { without: ['mc.attack-continuously'] });
    // The food animal's tool is not offered: nothing runs, and the wait goes on at once.
    const result = await Promise.race([f.call('mc.wait-time', { milliseconds: 30_000 }), new Promise(resolve => setTimeout(() => resolve('stuck'), 500))]);
    expect(result).not.toBe('stuck');
    expect(f.calls.map(call => call.name)).toEqual(['mc.wait-time']);
    const bed = need('bed', 'red_bed', 13, { x: 69, y: 66, z: 4 });
    let stopped = false;
    const g = fixture({}, { advance: { 'mc.move-to': 10_000 }, during: name => { if (name === 'mc.wait-time' && !stopped) { stopped = true;
      preemptForNeed(g.taskId, { ...bed, at: AT, data: { x: 69, y: 66, z: 4 } } as never); } } });
    await g.call('mc.wait-time', { milliseconds: 30_000 });
    expect(g.calls.at(-1)).toMatchObject({ name: 'mc.wait-time', operationId: 'step:mc.wait-time:resume', input: { milliseconds: 18_000 } });
  });

  it('leaves reads alone, does not dig the ore the call itself was digging, and is off with its switch', async () => {
    const f = fixture({ nearbyNeeds: [need('iron', 'iron_ore', 5)] });
    await f.call('mc.find-blocks', { blockName: 'iron_ore' });
    await f.call('mc.mine-block', { blockName: 'iron_ore', count: 3 });
    expect(f.calls.map(call => call.name)).toEqual(['mc.find-blocks', 'mc.mine-block']);
    const inner = { definitions: [], execute: async () => ({ ok: true, text: 'x', retryable: false }) } as FcaExternalTools;
    expect(withMinecraftAgenda(inner, { on: false, taskId: 't', observe: () => null })).toBe(inner);
  });
});
