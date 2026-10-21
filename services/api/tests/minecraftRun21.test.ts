import { describe, expect, it } from 'vitest';
import { ProcedureMemory, runProcedures, type Procedure } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { armedAndArmoured, fastBodyState, fastJudgment, type FastBodyState, type FastThreat } from '../src/mind/action/reflex/fastJudgment.js';
import { armourCrafted, fightRefusal, RANGED_FIGHT_REFUSAL } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { createBodyRevisions, createFightOwner, fightCall } from '../src/surfaces/minecraft/minecraftFightOwner.js';
import { createRoutePlanning } from '../src/surfaces/minecraft/minecraftRoutePlanner.js';
import { abortedRouteUsage } from '../src/wiring/minecraftRouteWiring.js';
import { minecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';
import { coreIronWanted, IRON_DIG_AT_ONCE, ironMove, ironShort, type ProcedureTaskStore } from '../src/surfaces/minecraft/minecraftProceduresIron.js';
import { cheapestWater } from '../src/surfaces/minecraft/minecraftProcedureWater.js';
import { minecraftUpkeep } from '../src/surfaces/minecraft/minecraftProcedureUpkeep.js';
import type { MinecraftWorkItem } from '../src/surfaces/minecraft/minecraftFillers.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import type { TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

/** mb-r21 (Minecraft run 21, 2026-10-21): the head's part of what the run found. */
const at = new Date().toISOString();
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: 1, stateAt: at, receivedAt: at,
  connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, margin: { darkInSeconds: 300 }, position: { x: 0, y: 64, z: 0 }, inventory: [],
    nearbyThreats: [], jobs: [], ...world } }, facts: { dimension: 'overworld', danger: false } } as unknown as BodyObservation);
const pack = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const factsOf = (world: Record<string, unknown>) => minecraftProcedureFacts(frame(world));
const store = (): ProcedureTaskStore => ({ furnaces: [], visited: new Set() });
const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: true, respawnedRecently: false, healthDropped: false,
  hasWeapon: true, floorActive: false, floorKnown: true, shelterFailed: false, resting: new Set(), canCage: false, canTower: false, armorPieces: 4, ...overrides });
const kind = (verdict: ReturnType<typeof fastJudgment>) => 'decision' in verdict ? `${verdict.decision.kind}:${verdict.decision.rule}` : `hold:${verdict.hold}`;
const threat = (name: string, distance: number, canReachMe: boolean | null = true): FastThreat => ({ name, distance, canReachMe, ignited: false });
const move = (value: ReturnType<typeof ironMove>) => value.kind === 'do' ? value.item : null;

describe('the fight has one owner (run 21: a skeleton and a creeper, iron armour and an iron sword, nobody struck in 140 s)', () => {
  it('walks up to one or two archers when armed, armoured and healthy, and hides from them otherwise', () => {
    expect(kind(fastJudgment(state({ threats: [threat('skeleton', 7)] })))).toBe('fight:shooter_fight');
    expect(kind(fastJudgment(state({ threats: [threat('skeleton', 7), threat('stray', 8)] })))).toBe('fight:shooter_fight');
    // Three archers, no sword, armour short, health under ten, a creeper within ten metres, or one that flies or shoots over any distance.
    expect(kind(fastJudgment(state({ threats: [5, 6, 7].map(distance => threat('skeleton', distance)) })))).toBe('shelter:outnumbered_shelter');
    expect(kind(fastJudgment(state({ hasWeapon: false, threats: [threat('skeleton', 7)] })))).toBe('shelter:ranged_shelter');
    expect(kind(fastJudgment(state({ armorPieces: 1, threats: [threat('skeleton', 7)] })))).toBe('shelter:ranged_shelter');
    expect(kind(fastJudgment(state({ health: 9, threats: [threat('skeleton', 7)] })))).toBe('shelter:ranged_shelter');
    expect(kind(fastJudgment(state({ threats: [threat('skeleton', 7), threat('creeper', 9)] })))).toBe('shelter:ranged_shelter');
    expect(kind(fastJudgment(state({ threats: [threat('blaze', 7)] })))).toBe('shelter:ranged_shelter');
    // An unknown armour reads as armoured, as it always did for the outnumbered rule.
    const { armorPieces: _unknown, ...unknownArmour } = state({ threats: [threat('skeleton', 7)] });
    expect(kind(fastJudgment(unknownArmour as FastBodyState))).toBe('fight:shooter_fight');
  });

  it('reads armed and armoured from a frame, and refuses a fight against archers only when she is neither', () => {
    const world = { health: 9, inventory: pack({ iron_sword: 1 }), worn: '頭: iron_helmet(残り…)、胴: iron_chestplate(残り…)、脚: なし、足: なし',
      nearbyThreats: [{ name: 'skeleton', distance: 10, canReachMe: true }] };
    expect(armedAndArmoured(world)).toBe(true);
    expect(armedAndArmoured({ ...world, inventory: pack({ stone_pickaxe: 1 }) })).toBe(false);
    expect(armedAndArmoured({ ...world, worn: '頭: なし、胴: なし、脚: なし、足: なし' })).toBe(false);
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => frame(world))).toBeNull();
    // At the floor of the rules, or with the sword missing, the earlier refusal stands.
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => frame({ ...world, health: 6 }))).toMatchObject({ text: RANGED_FIGHT_REFUSAL });
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => frame({ ...world, inventory: [] }))).toMatchObject({ text: RANGED_FIGHT_REFUSAL });
    expect(fastBodyState(frame(world), { earlierHealth: null, sinceArrivalMs: null }).armorPieces).toBe(2);
  });

  it('keeps a fight she chose past the touches of reflexes, never past her own tool being cut off', () => {
    const revisions = createBodyRevisions();
    const decided = revisions.revision;
    revisions.soft(); revisions.soft();
    expect(revisions.current(decided)).toBe(false);
    expect(revisions.current(decided, true)).toBe(true);
    expect(revisions.since(decided)).toBe(2);
    revisions.hard();
    expect(revisions.current(decided, true)).toBe(false);
    // A decision made after the hard touch stands past soft ones.
    const later = revisions.revision;
    revisions.soft();
    expect(revisions.current(later, true)).toBe(true);
    expect(revisions.current(later)).toBe(false);
    expect(fightCall('mc.combat')).toBe(true);
    expect(fightCall('mc.attack-nearest')).toBe(true);
    expect(fightCall('mc.mine-block')).toBe(false);
    expect(fightCall('combat')).toBe(false);
  });

  it('holds the body for a fight from the check to a few seconds after its call, and not for ever', () => {
    let clock = 0;
    const owner = createFightOwner(() => clock);
    expect(owner.owned()).toBe(false);
    owner.claim();
    expect(owner.owned()).toBe(true);
    clock = 3_500;
    expect(owner.owned()).toBe(false);
    owner.began();
    clock += 30_000;
    expect(owner.owned()).toBe(true);
    clock += 31_000;
    expect(owner.owned()).toBe(false);
    owner.began(); owner.ended();
    clock += 5_000;
    expect(owner.owned()).toBe(true);
    clock += 1_500;
    expect(owner.owned()).toBe(false);
  });

  it('counts a piece of armour crafted and put on by the body\'s reflex as made', () => {
    const worn = frame({ worn: '頭: なし、胴: iron_chestplate(残り…)、脚: なし、足: なし' });
    expect(armourCrafted({ itemName: 'iron_chestplate' }, worn)).toBe('iron_chestplate');
    expect(armourCrafted({ itemName: 'iron_helmet' }, worn)).toBeNull();
    expect(armourCrafted({ itemName: 'iron_helmet' }, frame({ inventory: pack({ iron_helmet: 1 }) }))).toBe('iron_helmet');
    expect(armourCrafted({ itemName: 'iron_pickaxe' }, frame({ inventory: pack({ iron_pickaxe: 1 }) }))).toBeNull();
    expect(armourCrafted({ itemName: 'iron_chestplate' }, null)).toBeNull();
  });
});

describe('the route plan is asked once and its answer waited for across steps (run 21: three of four asks aborted at a step\'s end)', () => {
  const answer = { legs: [{ milestone: '鉄', goal: '洞窟', where: '北 30m', targetSeconds: 300 }] };
  it('does not end the request when a step closes without being stopped, however often it is closed', async () => {
    let aborted = false, resolve!: (value: unknown) => void;
    const lines: string[] = [];
    const planning = createRoutePlanning({ kept: undefined, taskId: 'r21-a', log: line => lines.push(line),
      planner: (_system, _input, signal) => new Promise(done => { resolve = done; signal.addEventListener('abort', () => { aborted = true; done(null); }); }) });
    planning.situate({ milestoneName: '木', elapsedSeconds: 3 }, {});
    await planning.close(false);
    await planning.close(false);
    expect(aborted).toBe(false);
    // The next step of the task takes the answer when it comes.
    const next = createRoutePlanning({ kept: undefined, taskId: 'r21-a', log: line => lines.push(line) });
    resolve(answer);
    await new Promise(done => setTimeout(done, 5));
    expect(next.situate({ milestoneName: '木', elapsedSeconds: 20 }, {}).route?.[0]).toContain('最初の計画');
    expect(next.checkpoint().minecraftRouteAsks).toBe(1);
  });

  it('gives back the ask a stop cut off, and books an unanswered request at what it can have cost, not at a million tokens', () => {
    const usage = abortedRouteUsage('claude-opus-5-5', 4_800, 9_400, 6_000);
    expect(usage).toMatchObject({ usageComplete: false, inputTokens: 4_800, outputTokens: 940 });
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(usage.estimatedCostUsd).toBeLessThan(0.1);
    // A request that ran for a very long time is booked at the ceiling of its output, still nowhere near $20.
    expect(abortedRouteUsage('claude-opus-5-5', 4_800, 600_000, 6_000).estimatedCostUsd).toBeLessThan(0.5);
  });
});

describe('the adapter\'s part of the route request', () => {
  const lease = { id: 'lease', holder: 'h', generation: 1 };
  it('ends the request when the step is stopped, not when it closes (a step is closed twice)', async () => {
    for (const stop of [false, true]) {
      const lines: string[] = [];
      let aborted = false;
      const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
        frame: () => ({ poll: { skills: [{ name: 'move-to', readOnly: false }] } }), observe: () => frame({}), working: () => null,
        imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
      const step = { id: 'step', scopeKey: 'owner', taskId: `r21-adapter-${stop}`, revision: 1, lease,
        snapshot: { task: { createdAt: at, summary: '' }, checkpoint: { consecutiveToolFailures: 0 }, history: [], sources: [] } } as unknown as TaskStep;
      const runtime = { get: () => ({ phase: 'executing' }), send: () => {} } as unknown as TaskRuntime;
      const made = createMinecraftTaskBody({ control, runtime, step, entry: null, selector: null, ownerAlone: () => true, sourcesVisible: () => true,
        pollMilliseconds: 5, log: line => lines.push(line),
        routePlanner: (_system, _input, signal) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(null); })) });
      const abort = new AbortController();
      await inActionExecution({ lease, signal: abort.signal, permit: async () => true } as never, async () => {
        made.body.start(abort.signal);
        made.body.context();
        expect(lines.some(line => line.startsWith('Shannon Minecraft route asked'))).toBe(true);
        if (stop) abort.abort();
        await made.body.close();
        await made.body.close();
      });
      expect(aborted).toBe(stop);
      expect(lines.filter(line => line.startsWith('Shannon Minecraft route close'))).toHaveLength(2);
      expect(lines.some(line => line.includes(`stopped=${stop}`))).toBe(true);
    }
  });
});

describe('the iron procedure (run 21: the iron armour at 1,074 s instead of about 680)', () => {
  const allOf = (extra: Record<string, number> = {}) => pack({ stone_pickaxe: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1, ...extra });
  const job = (x: number, remainingEstimateMs: number, count: number, input = 'raw_iron') => ({ position: { x, y: 64, z: 2 }, remainingEstimateMs, input, count });

  it('digs the 32 iron of the pieces (36 with the spare pickaxe and the flint) in a first dig of 24 and a second of what is left (mb-r23; 16 and 20 before)', () => {
    const none = factsOf({ inventory: allOf() });
    expect(coreIronWanted(none)).toBe(32);
    expect(ironShort(none)).toBe(36);
    expect(IRON_DIG_AT_ONCE).toBe(24);
    expect(move(ironMove(none, new ProcedureMemory(), store()))).toMatchObject({ tool: 'mc.mine-block', input: { blockName: 'iron_ore', count: 24 } });
    // 24 held in the furnaces: the second dig takes the 12 left, the spare's and the flint's with it, not a third trip.
    const half = factsOf({ inventory: allOf(), jobs: [job(10, 90_000, 24)] });
    expect(ironShort(half)).toBe(12);
    const enough = factsOf({ inventory: allOf({ iron_ingot: 36 }) });
    expect(ironShort(enough)).toBe(0);
    // Every piece made: the spare pickaxe's 3 and the flint's 1 are what is left to dig.
    const made = factsOf({ inventory: allOf({ iron_pickaxe: 1, iron_sword: 1, bucket: 1 }), worn: '頭: iron_helmet、胴: iron_chestplate、脚: iron_leggings、足: iron_boots' });
    expect(coreIronWanted(made)).toBe(0);
    expect(ironShort(made)).toBe(4);
  });

  it('puts the raw iron into furnaces before anything else, half and half into two furnaces, a third when the two are full', () => {
    const memory = new ProcedureMemory(), s = store();
    const first = move(ironMove(factsOf({ inventory: allOf({ raw_iron: 16, furnace: 1 }) }), memory, s))!;
    expect(first.tool).toBe('mc.place-block-at');
    const fill = first.then!('furnace を(12, 64, 2)に設置しました')!;
    expect(fill).toMatchObject({ tool: 'mc.start-smelting', input: { inputItem: 'raw_iron', count: 8 } });
    // The first furnace runs with 8; the 8 left go whole into the second (she walks to the first, sets it down within 8 m, and fills it).
    s.furnaces = [{ x: 12, y: 64, z: 2 }];
    const running = factsOf({ inventory: allOf({ raw_iron: 8, furnace: 1 }), jobs: [job(12, 80_000, 8)] });
    const walk = move(ironMove(running, new ProcedureMemory(), s))!;
    expect(walk.tool).toBe('mc.move-to');
    expect(walk.then!('ok')!.then!('furnace を(13, 64, 2)に設置しました')).toMatchObject({ tool: 'mc.start-smelting', input: { count: 8 } });
    // Two furnaces full of the meat the body queued behind the batch: a third takes the iron (10 of the 12, the rest waits).
    s.furnaces = [{ x: 12, y: 64, z: 2 }, { x: 13, y: 64, z: 2 }];
    const full = factsOf({ inventory: allOf({ raw_iron: 12, furnace: 1 }), jobs: [job(12, 40_000, 4, 'mutton'), job(13, 40_000, 4, 'beef')] });
    const third = move(ironMove(full, new ProcedureMemory(), s))!;
    expect(third.tool).toBe('mc.move-to');
    expect(third.then!('ok')!.then!('furnace を(14, 64, 2)に設置しました')).toMatchObject({ tool: 'mc.start-smelting', input: { count: 10 } });
  });

  it('takes the ingots a furnace has made as soon as they make the next piece, before the batch is done', () => {
    // 8 raw iron put in 50 s ago... 5 are made, 3 left to smelt (30 s): the pickaxe takes 3.
    const facts = factsOf({ inventory: allOf(), jobs: [job(12, 30_000, 8)] });
    const item = move(ironMove(facts, new ProcedureMemory(), { furnaces: [{ x: 12, y: 64, z: 2 }], visited: new Set() }))!;
    expect(item).toMatchObject({ tool: 'mc.withdraw-from-furnace', input: { x: 12, y: 64, z: 2, waitForCompletion: false } });
    // The body answers a part taken as `waiting_external` with the words of what it gave: that is done, anything else is not.
    expect(item.accepts!('waiting_external', '完成済みのiron_ingot×5を回収しました。材料3個の精錬は未完了です。')).toBe(true);
    // mb-r22: a furnace that has nothing ready yet is not a failed call either (the batch still smelts); it is noted and not asked again at once.
    expect(item.accepts!('waiting_external', '完成品はまだありません（材料3個が残っています）')).toBe(true);
    expect(item.accepts!('failed', '完成済みのiron_ingot×5を回収しました')).toBe(false);
  });

  it('stays by the furnaces, with small work or a short wait, when the next ingots are near; digs when they are not', () => {
    const lacking = (remaining: number, count: number, extra: Record<string, number> = {}) => factsOf({ inventory: allOf(extra), jobs: [job(12, remaining, count)] });
    const s = { furnaces: [{ x: 12, y: 64, z: 2 }], visited: new Set<string>() };
    // 8 raw just put in (80 s left): 3 ingots in 30 s for the pickaxe: a wait of that long, not a dig of 60 s and more.
    const memory = new ProcedureMemory();
    const hold = move(ironMove(lacking(80_000, 8), memory, s))!;
    expect(hold).toMatchObject({ tool: 'mc.wait-time', input: { milliseconds: 30_000 } });
    // The body refuses a wait when it has something definite to do: the hold is off and the dig goes on.
    hold.onFail!('wait_refused', '待ちを断りました');
    expect(move(ironMove(lacking(80_000, 8), memory, s))).toMatchObject({ tool: 'mc.mine-block' });
    // The chestplate takes 8: 8 raw with 80 s left is 80 s away from enough, longer than the hold: the dig goes on.
    const bucketDone = { iron_pickaxe: 1, iron_sword: 1, water_bucket: 1 };
    expect(move(ironMove(lacking(80_000, 8, bucketDone), new ProcedureMemory(), s))).toMatchObject({ tool: 'mc.mine-block', input: { count: 20 } });
    // A furnace with 20 s or less left is waited for as the body takes it.
    expect(move(ironMove(lacking(15_000, 3), new ProcedureMemory(), s))).toMatchObject({ tool: 'mc.withdraw-from-furnace', input: { waitForCompletion: true } });
  });
});

describe('the water chosen is the cheapest walk, not the nearest in three dimensions (run 21: 150 s down a cave and back)', () => {
  it('prefers the pond at the sea\'s level to the cave 30 blocks below, and the water nearer the furnaces among equals', () => {
    const from = { x: 0, y: 90, z: 0 };
    const cave = { x: 19, y: 58, z: 0 }, pond = { x: 41, y: 62, z: 0 };
    expect(Math.hypot(cave.x, cave.y - from.y, cave.z)).toBeLessThan(Math.hypot(pond.x, pond.y - from.y, pond.z));
    expect(cheapestWater(from, [cave, pond])).toEqual(pond);
    // On the surface at her own height the nearest is the cheapest.
    expect(cheapestWater({ x: 0, y: 64, z: 0 }, [{ x: 30, y: 63, z: 0 }, { x: 10, y: 63, z: 0 }])).toEqual({ x: 10, y: 63, z: 0 });
    const a = { x: 20, y: 63, z: 0 }, b = { x: 0, y: 63, z: 20 };
    expect(cheapestWater({ x: 0, y: 63, z: 0 }, [a, b], [{ x: 0, y: 63, z: 30 }])).toEqual(b);
    expect(cheapestWater(null, [a, b])).toEqual(a);
    expect(cheapestWater({ x: 0, y: 63, z: 0 }, [])).toBeUndefined();
  });
});

describe('a procedure is cut between items, not in the middle of one (run 21: a 180 s dig begun at 525 s of 600)', () => {
  it('does not begin an item that would end past the time bound, except the first of a run', async () => {
    let clock = 0;
    const item = (name: string, ms: number) => ({ name, ms });
    const procedure: Procedure<null, { name: string; ms: number }> = { id: 'p', done: () => false,
      next: (_facts, memory) => memory.succeeded('a') < 3 ? { kind: 'do', item: item('dig', 150_000), key: 'a', why: '掘る' } : { kind: 'done' } };
    const ran: string[] = [];
    const result = await runProcedures([procedure], { facts: () => null, stopWhy: () => null, now: () => clock, signal: new AbortController().signal,
      expectMs: value => value.ms, async run(value) { ran.push(value.name); clock += value.ms; return { ok: true, text: '' }; } },
    { items: 60, ms: 600_000, failuresPerKey: 2, failures: 6, repeatsPerKey: 6 });
    // 150 s each: three end at 450 s, inside the bound. With 250 s items the third (to end at 750 s) is held back.
    expect(ran).toHaveLength(3);
    expect(result.outcome).toBe('done');
    clock = 0; ran.length = 0;
    const slow: Procedure<null, { name: string; ms: number }> = { id: 'p', done: () => false,
      next: (_facts, memory) => memory.succeeded('a') < 3 ? { kind: 'do', item: item('dig', 250_000), key: 'a', why: '掘る' } : { kind: 'done' } };
    const cut = await runProcedures([slow], { facts: () => null, stopWhy: () => null, now: () => clock, signal: new AbortController().signal,
      expectMs: value => value.ms, async run(value) { ran.push(value.name); clock += value.ms; return { ok: true, text: '' }; } },
    { items: 60, ms: 600_000, failuresPerKey: 2, failures: 6, repeatsPerKey: 6 });
    expect(ran).toHaveLength(2);
    expect(cut.outcome).toBe('limit');
    expect(cut.why).toContain('始めずに区切った');
    // The first item of a run always goes, however long it is.
    clock = 0; ran.length = 0;
    const first = await runProcedures([slow], { facts: () => null, stopWhy: () => null, now: () => clock, signal: new AbortController().signal,
      expectMs: () => 900_000, async run(value) { ran.push(value.name); clock += value.ms; return { ok: true, text: '' }; } },
    { items: 60, ms: 600_000, failuresPerKey: 2, failures: 6, repeatsPerKey: 6 });
    expect(ran.length).toBeGreaterThanOrEqual(1);
    expect(first.items.length).toBe(1);
  });
});

describe('the night with no place for the bed, or enemies near (run 21)', () => {
  const night = { margin: { lightInSeconds: 200 } };
  const bed = (extra: Record<string, number> = {}) => pack({ white_bed: 1, ...extra });
  const items = (value: ReturnType<typeof minecraftUpkeep>) => value?.item as MinecraftWorkItem | undefined;

  it('tries another spot when the bed found no place, twice at most, then leaves it to the planner', () => {
    const memory = new ProcedureMemory();
    const facts = () => factsOf({ ...night, inventory: bed() });
    const first = items(minecraftUpkeep(facts(), memory))!;
    expect(first.tool).toBe('mc.sleep-in-bed');
    first.onFail!('failed', 'ベッドを設置できる適切な場所が見つかりませんでした');
    memory.record(first.key, false, 'failed');
    const moveOff = items(minecraftUpkeep(facts(), memory))!;
    expect(moveOff).toMatchObject({ tool: 'mc.move-to', input: { x: 8, y: 64, z: 0 } });
    moveOff.then!('ok');
    const again = items(minecraftUpkeep(facts(), memory))!;
    expect(again.tool).toBe('mc.sleep-in-bed');
    again.onFail!('failed', 'ベッドを設置できる適切な場所が見つかりませんでした');
    memory.record(again.key, false, 'failed');
    const second = items(minecraftUpkeep(facts(), memory))!;
    expect(second).toMatchObject({ tool: 'mc.move-to', input: { x: -8 } });
    second.then!('ok');
    const third = items(minecraftUpkeep(facts(), memory))!;
    third.onFail!('failed', 'ベッドを設置できる適切な場所が見つかりませんでした');
    memory.record(third.key, false, 'failed');
    expect(minecraftUpkeep(facts(), memory)).toBeNull();
  });

  it('fights the enemies near first when armed, armoured and healthy and none is a creeper; else it is the planner\'s', () => {
    const armed = { ...night, inventory: bed({ iron_sword: 1 }), worn: '頭: iron_helmet、胴: iron_chestplate、脚: iron_leggings、足: iron_boots' };
    const zombie = [{ name: 'zombie', distance: 6, canReachMe: true }];
    const memory = new ProcedureMemory();
    const fight = items(minecraftUpkeep(factsOf({ ...armed, nearbyThreats: zombie }), memory))!;
    expect(fight).toMatchObject({ tool: 'mc.attack-continuously', input: { entityName: 'hostile' } });
    fight.then!('ok');
    const again = items(minecraftUpkeep(factsOf({ ...armed, nearbyThreats: zombie }), memory))!;
    expect(again.key).not.toBe(fight.key);
    again.then!('ok');
    // Twice in a run at most.
    expect(minecraftUpkeep(factsOf({ ...armed, nearbyThreats: zombie }), memory)).toBeNull();
    expect(minecraftUpkeep(factsOf({ ...night, inventory: bed(), nearbyThreats: zombie }), new ProcedureMemory())).toBeNull();
    expect(minecraftUpkeep(factsOf({ ...armed, nearbyThreats: [{ name: 'creeper', distance: 6, canReachMe: true }] }), new ProcedureMemory())).toBeNull();
  });
});
