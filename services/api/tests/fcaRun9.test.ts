import { describe, expect, it } from 'vitest';
import { selectFcaTools } from '../src/mind/action/fca/fcaToolState.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { ShannonToolDefinition } from '../src/mind/tools/toolRegistryPorts.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { MINECRAFT_SKILL_POINTER_NOTE, minecraftSituation, minecraftSkillPointers, skillNamesOfIndex } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { minecraftPace, waitTimeMilliseconds } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';

/** Minecraft run 9 (2026-10-14, task 0b9275ec): body tools dropped by a reselection, no legacy skill read, a night of idle waits. */
const tool = (name: string, domain: string): ShannonToolDefinition => ({ name, description: `${name} の説明`, domain, effect: 'read', cost: 'none',
  audiences: ['owner_alone'], surfaces: ['text'], input: { type: 'object', properties: {}, required: [], additionalProperties: false } } as unknown as ShannonToolDefinition);
const catalog = [tool('task.list', 'task_runtime'), tool('skill.read', 'skills'), tool('minecraft.observe', 'minecraft_body'),
  tool('mc.move-to', 'minecraft_body'), tool('mc.dig-block-at', 'minecraft_body'), tool('mc.wait-time', 'minecraft_body')];
const input = { task: { id: 't', title: '鉄', goal: '鉄のツルハシ', completionCriteria: '持ち物' }, messages: [], tools: catalog, history: [] } as unknown as FcaModelInput;
const choosing = (names: string[]) => ({ async select() { return { names, source: 'jev' as const }; } });
const signal = new AbortController().signal;

describe('the tool selection keeps a body\'s tools (run 9, item 2)', () => {
  it('keeps the previous selection\'s body tools when a reselection leaves every one out', async () => {
    const first = await selectFcaTools(input, catalog, undefined, choosing(['task.list', 'mc.move-to', 'mc.dig-block-at']), 'owner', signal);
    expect(first.names).toEqual(['task.list', 'mc.move-to', 'mc.dig-block-at']);
    const again = await selectFcaTools(input, catalog, { ...first, refresh: true }, choosing(['task.list', 'skill.read']), 'owner', signal);
    expect(again.names).toEqual(['task.list', 'skill.read', 'mc.move-to', 'mc.dig-block-at']);
  });
  it('adds every body tool when there is no previous one, and changes nothing when one is chosen or none is offered', async () => {
    expect((await selectFcaTools(input, catalog, undefined, choosing(['skill.read']), 'owner', signal)).names)
      .toEqual(['skill.read', 'minecraft.observe', 'mc.move-to', 'mc.dig-block-at', 'mc.wait-time']);
    expect((await selectFcaTools(input, catalog, undefined, choosing(['mc.wait-time']), 'owner', signal)).names).toEqual(['mc.wait-time']);
    const plain = catalog.slice(0, 2);
    expect((await selectFcaTools({ ...input, tools: plain }, plain, undefined, choosing(['task.list']), 'owner', signal)).names).toEqual(['task.list']);
  });
});

const observation = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world',
  sequence: 1, stateAt: '2026-10-14T11:30:00.000Z', receivedAt: '2026-10-14T11:30:00.000Z', connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '4900', margin: { darkInSeconds: 405 }, inventory: [], nearbyThreats: [], ...world } },
  facts: { dimension: 'overworld', ...facts } } as unknown as BodyObservation);
const LEGACY = new Set(['mc-night-retreat', 'mc-low-health', 'mc-food-and-pace', 'mc-nether-portal', 'mc-nether-travel', 'mc-blaze-rods']);
const calm = { failedStepsInARow: 0 };

describe('situational pointers to her skills (run 9, items 1 and 3)', () => {
  it('names the night retreat at night, before dark and with a threat near, and nothing on a calm day', () => {
    const pointers = (world: Record<string, unknown>) => minecraftSkillPointers(minecraftSituation(observation(world), calm), LEGACY);
    expect(pointers({})).toEqual([]);
    expect(pointers({ time: '18000' })).toEqual(['mc-night-retreat（夜・暗くなる直前・敵が近い）']);
    expect(pointers({ time: String(24_000 * 3 + 14_000) })).toEqual(['mc-night-retreat（夜・暗くなる直前・敵が近い）']);
    expect(pointers({ margin: { darkInSeconds: 30 } })).toEqual(['mc-night-retreat（夜・暗くなる直前・敵が近い）']);
    expect(pointers({ nearbyThreats: [{ name: 'zombie', distance: 8 }] })).toEqual(['mc-night-retreat（夜・暗くなる直前・敵が近い）']);
    expect(pointers({ nearbyThreats: [{ name: 'enderman', distance: 8 }, { name: 'creeper', distance: 28 }] })).toEqual([]);
  });
  it('names low health, food and pace, the portal with an iron pickaxe, and the Nether skills in the Nether', () => {
    const at = (world: Record<string, unknown>, pace: Parameters<typeof minecraftSituation>[1] = calm) => minecraftSkillPointers(minecraftSituation(observation(world), pace), LEGACY);
    expect(at({ health: 8 })).toEqual(['mc-low-health（体力が半分以下）']);
    expect(at({ food: 4 })).toEqual(['mc-food-and-pace（空腹・進展が止まった・待ちが続いた）']);
    expect(at({}, { failedStepsInARow: 3 })).toEqual(['mc-food-and-pace（空腹・進展が止まった・待ちが続いた）']);
    expect(at({}, { failedStepsInARow: 0, idleWaitSeconds: 390 })).toEqual(['mc-food-and-pace（空腹・進展が止まった・待ちが続いた）']);
    expect(at({ inventory: ['iron_pickaxe×1(耐久250/250)'] })).toEqual(['mc-nether-portal（鉄のツルハシがありネザーへ向かう前）']);
    expect(at({ inventory: ['iron_pickaxe×1'] }, { failedStepsInARow: 0, milestones: { netherReached: true } })).toEqual([]);
    expect(minecraftSkillPointers(minecraftSituation(observation({ dimension: 'the_nether', nearbyEntities: [{ name: 'blaze', distance: 20 }] },
      { dimension: 'the_nether' }), calm), LEGACY)).toEqual(['mc-nether-travel（ネザーにいる）', 'mc-blaze-rods（ネザーでブレイズが近い）']);
    expect(minecraftSituation(null, calm).night).toBe(false);
    expect(MINECRAFT_SKILL_POINTER_NOTE).toContain('skill_read');
  });
  it('names only skills she can read now, from the index as the index writes them', () => {
    const index = '[ボクのスキル 21/25（目次。中身は skill_read で開く）]\n- mc-early-toolchain（試し）（運用作成）: マイクラ序盤\n- mc-night-retreat（試し）（運用作成）: マイクラの夜';
    expect([...skillNamesOfIndex(index)]).toEqual(['mc-early-toolchain', 'mc-night-retreat']);
    expect(minecraftSkillPointers(minecraftSituation(observation({ time: '18000', health: 6 }), calm), skillNamesOfIndex(index)))
      .toEqual(['mc-night-retreat（夜・暗くなる直前・敵が近い）']);
  });
  it('sums her idle waits into the pace note', () => {
    expect(waitTimeMilliseconds({ milliseconds: 110000 })).toBe(110_000);
    expect(waitTimeMilliseconds({ ms: '60000' })).toBe(60_000);
    expect(waitTimeMilliseconds({})).toBe(0);
    const step = { snapshot: { task: { createdAt: '2026-10-14T11:16:55.000Z' }, checkpoint: null } } as unknown as TaskStep;
    expect(minecraftPace(step, [], Date.parse('2026-10-14T11:40:00.000Z'), null, 390_000)).toMatchObject({ idleWaitSeconds: 390 });
    expect(minecraftPace(step, [], Date.parse('2026-10-14T11:40:00.000Z'))).not.toHaveProperty('idleWaitSeconds');
  });
});
