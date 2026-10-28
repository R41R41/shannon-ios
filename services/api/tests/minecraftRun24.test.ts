import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcedureMemory } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { MinecraftControlPoll } from '../src/contracts/minecraftControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { fastBodyState, fastJudgment, fastJudgmentCut, type FastBodyState } from '../src/mind/action/reflex/fastJudgment.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { ROUTE_COORDINATES_NOTE, ROUTE_SYSTEM, createRoutePlanning, forgetRoutes, routeFrom, routeInput, routeLines } from '../src/surfaces/minecraft/minecraftRoutePlanner.js';
import { minecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';
import { ironMove, type ProcedureTaskStore } from '../src/surfaces/minecraft/minecraftProceduresIron.js';
import { obsidianMove } from '../src/surfaces/minecraft/minecraftProceduresDeep.js';
import { minecraftProcedureChain } from '../src/surfaces/minecraft/minecraftProcedures.js';
import { rankedPools } from '../src/surfaces/minecraft/minecraftLavaPools.js';
import { lavaTraits } from '../src/surfaces/minecraft/minecraftMapRead.js';
import { WOOD_RULE, woodAdvice } from '../src/surfaces/minecraft/minecraftWoodAdvice.js';
import { PAUSED_BY_FAST_SKILL } from '../src/surfaces/minecraft/minecraftProcedureTool.js';
import { failureReview, repeatedFailure } from '../src/surfaces/minecraft/minecraftFailureReview.js';
import { netherCareLines } from '../src/surfaces/minecraft/minecraftNetherCare.js';
import { madeProgress, progressMark, targetOf } from '../src/surfaces/minecraft/minecraftProgress.js';
import { milestoneNow } from '../src/surfaces/minecraft/minecraftStage.js';
import { minecraftSituation, minecraftSkillContext } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { SimBody, setup, type Input } from './support/minecraftProcedureSim.js';

/**
 * mb-r24 (head side of Minecraft run 24, 2026-10-21: the Nether at 1,435 s for the first time): the route's old coordinates are a guess, not
 * an order; where wood is when no tree is in sight; the water while the iron cooks; a dig that goes on to its number and is cut to what the
 * furnaces allow; a creeper fought in iron; a reconnection is no respawn; the Nether's first seconds; a failure repeated is a review.
 */
const at = new Date().toISOString();
const frame = (world: Record<string, unknown>, sequence = 1, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:home',
  sequence, stateAt: at, receivedAt: at, connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, margin: { darkInSeconds: 300 },
    position: { x: 0, y: 64, z: 0 }, inventory: [], nearbyThreats: [], jobs: [], ...world } }, facts: { dimension: 'overworld', danger: false, alive: true, ...facts } } as unknown as BodyObservation);
const pack = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const factsOf = (world: Record<string, unknown>) => minecraftProcedureFacts(frame(world));
const store = (): ProcedureTaskStore => ({ furnaces: [], visited: new Set() });
const move = (value: { kind: string }) => value.kind === 'do' ? (value as unknown as { item: Record<string, any> }).item : null;
const job = (x: number, remainingEstimateMs: number, count: number, input = 'raw_iron') => ({ position: { x, y: 64, z: 2 }, remainingEstimateMs, input, count });

// -- 1. The route's coordinates are the start's guess; the pool in sight comes first ------------------------------------------------------------------

describe('the route\'s old place (run 24: "溶岩の溜まりのそば（-21,-55,128）" was walked to, 76 m, while pools lay at 20 m and 44 m)', () => {
  const route = routeFrom({ legs: [
    { milestone: '黒曜石', goal: '溶岩の溜まりで黒曜石', where: '東130m 地下の溶岩', x: -21, y: -55, z: 128, targetSeconds: 950 },
    { milestone: 'ゲート', goal: '溶岩の溜まりのそば', where: '同じ所', x: -21, y: -55, z: 128, targetSeconds: 1000 }] }, 18, 0, 'start')!;
  const map = '溶岩の溜まり 2か所: 20m 北西 (-75,-39,186)（水源12個・岩に覆われていない）、44m 西 (-98,-55,178)（水源30個）';
  const world = { position: { x: -60, y: -40, z: 190 }, mapSummary: map };

  it('shows the coordinates as the start\'s guess with how far they are now, the pools in sight that are nearer, and the rule', () => {
    const text = routeLines(route, '黒曜石', world).join('\n');
    expect(text).toContain('開始時の見立て -21,-55,128・今から73m');
    expect(text).toContain('いま見える近い溶岩: 20m 北西 (-75,-39,186)（水源12個・岩に覆われていない）、44m 西 (-98,-55,178)（水源30個）');
    expect(text).toContain(ROUTE_COORDINATES_NOTE);
    // Nothing nearer in sight: no list, the guess alone.
    expect(routeLines(route, '黒曜石', { ...world, mapSummary: '溶岩の溜まり 1か所: 90m 東 (30,-55,128)' }).join('\n')).not.toContain('いま見える近い');
  });

  it('reads what the body says of a pool: how many sources, and whether rock covers it', () => {
    expect(lavaTraits('（水源12個・岩に覆われていない）')).toEqual({ size: 12, covered: false });
    expect(lavaTraits('（水源3個・岩に覆われている）')).toEqual({ size: 3, covered: true });
    expect(lavaTraits('')).toEqual({ size: null, covered: null });
  });

  it('ranks the pools a find lists by distance, size and cover, and leaves out a pool where the water made nothing', () => {
    const text = ['(-55, -37, 186) 距離29m（岩に覆われている・水源3個）', '(-75, -39, 186) 距離20m（水源12個）', '(-96, -55, 177) 距離44m（水源30個）'].join('\n');
    expect(rankedPools(text, 10, null, [])).toEqual([{ x: -75, y: -39, z: 186 }, { x: -96, y: -55, z: 177 }, { x: -55, y: -37, z: 186 }]);
    expect(rankedPools(text, 10, null, [{ x: -75, y: -39, z: 186 }])[0]).toEqual({ x: -96, y: -55, z: 177 });
  });

  it('does not pour on a pool again, in the next run either, once the water made nothing there', () => {
    const facts = factsOf({ position: { x: -60, y: -40, z: 190 }, inventory: pack({ diamond_pickaxe: 1, water_bucket: 1 }) });
    const found = '(-75, -39, 186) 距離20m\n(-96, -55, 177) 距離44m';
    const kept = store();
    const walk = (memory: ProcedureMemory) => move(obsidianMove(facts, memory, 'mc.use-item-on-block', kept))!.then!(found);
    const first = walk(new ProcedureMemory());
    expect(first.input).toMatchObject({ x: -75, y: -39, z: 186 });
    first.then!('ok').onFail!('failed', '黒曜石を0個作りました。近くに水をかけられる溶岩も、すぐ掘れる黒曜石も、もうありません');
    // A run cut by a creeper forgot the pool; the task remembers it.
    expect(walk(new ProcedureMemory()).input).toMatchObject({ x: -96, y: -55, z: 177 });
  });
});

// -- 2. Wood, when no tree is in sight ------------------------------------------------------------------------------------------------------------

describe('wood with no tree in sight (run 24, first world: a desert, 419 s, no log; a shipwreck 149 m south was never named)', () => {
  const desert = { position: { x: -151, y: 63, z: -43 }, biomesSeen: 'desert（ここ）・warm_ocean 南西 60m・river 東 64m',
    mapSummary: '構造物: 難破船: 149m 南 (47,55,99)（箱つき）' };
  const context = { store: store(), batchObsidian: null };
  const wood = (world: Record<string, unknown>) => {
    const facts = factsOf({ inventory: [], nearbyNeeds: [], ...world }), memory = new ProcedureMemory(), procedure = minecraftProcedureChain('木', null, context)[0]!;
    const first = procedure.next(facts, memory);
    if (first.kind === 'do') memory.record(first.key, false, 'target_not_found');
    return { facts, memory, procedure, first };
  };

  it('says there is no tree, names the wooden structure and the rule, and does not take a river for a forest', () => {
    const advice = woodAdvice(desert);
    expect(advice.trees).toBe(false);
    expect(advice.lines.join('\n')).toContain('見えている木: 無し');
    expect(advice.lines.join('\n')).toContain('難破船 149m 南 (47,55,99)');
    expect(advice.lines.join('\n')).toContain('木はほぼ無い');
    expect(advice.lines).toContain(WOOD_RULE);
    const seen = woodAdvice({ ...desert, mapSummary: '木: 112m 北 (3,70,-150) oak_log×12' });
    expect(seen.trees).toBe(true);
    expect(seen.lines[0]).toBe('見えている木: 112m 北 (3,70,-150) ×12');
    expect(seen.lines).not.toContain(WOOD_RULE);
  });

  it('is in the planner\'s input and the planner is told not to read "river" as trees', () => {
    const input = routeInput({ ...desert, inventory: [] }, 0, '木');
    expect(input).toContain('木と木材の出どころ');
    expect(input).toContain('難破船 149m 南');
    expect(ROUTE_SYSTEM).toContain('川や海があるだけで');
    const route = routeFrom({ legs: [{ milestone: '木', goal: '難破船の木材', where: '南149m', targetSeconds: 60 }] }, 0, 0, 'start')!;
    expect(routeLines(route, '木', desert).join('\n')).toContain('難破船 149m 南');
    // Once the step is past the wood, the lines are not shown.
    expect(routeLines(route, '鉄', desert).join('\n')).not.toContain('見えている木');
  });

  it('is in the first decisions too, before the route is planned, and only from a body that sends a map', () => {
    forgetRoutes();
    const planning = createRoutePlanning({ kept: null, log: () => {}, taskId: 'wood-task' });
    expect(planning.context(desert, '木', 5).join('\n')).toContain('難破船 149m 南');
    expect(planning.context({ position: desert.position }, '木', 5)).toEqual([]);
    expect(planning.context(desert, '鉄', 5)).toEqual([]);
    forgetRoutes();
  });

  it('goes to the shipwreck when digging for logs found none, and cuts the logs there', () => {
    const { facts, memory, procedure, first } = wood(desert);
    expect(first.kind === 'do' && first.item.tool).toBe('mc.mine-block');
    const next = procedure.next(facts, memory);
    expect(next.kind === 'do' && next.item).toMatchObject({ tool: 'mc.move-to', input: { x: 47, y: 55, z: 99, goalType: 'near' } });
    const walk = move(next)!;
    expect(walk.then!('ok')).toMatchObject({ tool: 'mc.mine-block' });
    // Gone to once: the next look does not walk there again.
    expect(move(procedure.next(facts, memory))).toMatchObject({ tool: 'mc.explore-for-structure' });
  });

  it('does not send the iron step across a desert for the two logs of its fuel', () => {
    const facts = factsOf({ inventory: pack({ stone_pickaxe: 1, raw_iron: 8, furnace: 1 }), nearbyNeeds: [], ...desert });
    const memory = new ProcedureMemory(), procedure = minecraftProcedureChain('鉄', null, context)[0]!;
    const fuel = procedure.next(facts, memory);
    expect(fuel.kind === 'do' && fuel.item.input).toMatchObject({ blockName: expect.stringContaining('oak_log') });
    memory.record((fuel as { key: string }).key, false, 'target_not_found');
    const again = procedure.next(facts, memory);
    expect(again.kind === 'do' && again.item.tool).toBe('mc.mine-block');
  });

  it('searches for a tree by heading, the way trees grow first and the sea last, then asks the planner', () => {
    const bare = { ...desert, mapSummary: '' };
    const { facts, memory, procedure } = wood(bare);
    const north = move(procedure.next(facts, memory))!;
    expect(north).toMatchObject({ tool: 'mc.explore-for-structure', input: { structureType: 'tree', direction: 'north' } });
    memory.record(north.key, false, 'target_not_found');
    expect(move(procedure.next(facts, memory))!.input.direction).toBe('west');
    const forest = wood({ ...bare, biomesSeen: 'plains（ここ）・forest 東 80m' });
    expect(move(forest.procedure.next(forest.facts, forest.memory))!.input.direction).toBe('east');
    // An older body that does not know the target: no heading is tried, the planner decides.
    const old = wood(bare);
    const tried = move(old.procedure.next(old.facts, old.memory))!;
    old.memory.record(tried.key, false, 'invalid_input');
    expect(old.procedure.next(old.facts, old.memory).kind).toBe('stuck');
  });
});

// -- 3. The water while the iron cooks --------------------------------------------------------------------------------------------------------------

describe('the water (run 24: the bucket at 433 s, the water at 628-691 s as the diamonds\' first move, 430 meant)', () => {
  const underground = (extra: Record<string, unknown> = {}) => factsOf({ position: { x: 0, y: 45, z: 0 },
    inventory: pack({ stone_pickaxe: 1, iron_pickaxe: 1, iron_sword: 1, bucket: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1 }),
    jobs: [job(12, 100_000, 10)], ...extra });

  it('fills the bucket at once, below ground, when the furnaces\' time pays for the walk to the water', () => {
    const item = move(ironMove(underground(), new ProcedureMemory(), store()))!;
    expect(item).toMatchObject({ tool: 'mc.find-blocks', input: { blockName: 'water' } });
    expect(item.then!('(12, 36, 10) 距離15m')).toMatchObject({ tool: 'mc.move-to', input: { x: 12, y: 36, z: 10 } });
  });

  it('leaves water that costs more than that for the descent, and does not give up the look for water', () => {
    const memory = new ProcedureMemory(), item = move(ironMove(underground(), memory, store()))!;
    expect(item.then!('(150, 36, 10) 距離150m')).toBeNull();
    expect(memory.notes.get('water:none')).toBeUndefined();
    expect(memory.notes.get('water:cheap:none')).toBe(true);
    // Not looked for again and again in the same run: the dig goes on.
    expect(move(ironMove(underground(), memory, store()))).toMatchObject({ tool: 'mc.mine-block' });
  });

  it('is first in the order of a sim run underground: the water is in the bucket before the last piece of armour is worn', async () => {
    const body = new SimBody(), events: string[] = [];
    body.y = 45;
    for (const [name, count] of Object.entries({ stone_pickaxe: 1, coal: 16, cobblestone: 30, oak_planks: 16, stick: 8, crafting_table: 1, furnace: 3 })) body.add(name, count);
    body.tool_find_blocks = (input: Input) => {
      body.spend(0.5);
      return { ok: true, text: input.blockName === 'water' ? '(8, 45, 2) 距離9m' : '見つかりませんでした', retryable: false };
    };
    const scoop = body.tool_use_item_on_block.bind(body), wear = body.tool_equip_item.bind(body);
    body.tool_use_item_on_block = (input: Input) => {
      if (input.itemName === 'bucket') events.push('water');
      return scoop(input);
    };
    body.tool_equip_item = (input: Input) => {
      events.push('wear');
      return wear(input);
    };
    await setup(body).call({ milestone: '鉄', through: '鉄の全身の防具' });
    expect(events.indexOf('water')).toBeGreaterThan(-1);
    expect(events.indexOf('wear')).toBeGreaterThan(-1);
    expect(events.indexOf('water')).toBeLessThan(events.indexOf('wear'));
  });
});

// -- 4. The iron dig goes on to its number and is cut to what the furnaces allow ------------------------------------------------------------------

describe('the iron dig (run 24: 11 of 24, cut by a fight, then 20 dug again; the pickaxe at 400 s with its ingots done at 335 s)', () => {
  const kit = pack({ stone_pickaxe: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1 });

  it('goes on to the number of the dig that was cut: 13 more after 11, not a new 20', () => {
    const kept = store();
    expect(move(ironMove(factsOf({ inventory: kit }), new ProcedureMemory(), kept))).toMatchObject({ tool: 'mc.mine-block', input: { count: 24 } });
    // 11 are in the furnace now; the task goes on (a new run, a new memory), the furnace has long to cook.
    const cut = factsOf({ inventory: kit, jobs: [job(12, 300_000, 11)] });
    expect(move(ironMove(cut, new ProcedureMemory(), kept))).toMatchObject({ tool: 'mc.mine-block', input: { count: 13 } });
  });

  it('cuts a dig to about when the next piece\'s ingots are ready, so the piece is made then (4 at the least)', () => {
    const memory = new ProcedureMemory();
    // The hold is off (the body refused the waits): the dig goes on, but only as long as the 6 raw iron cooking need for the pickaxe's 3.
    memory.notes.set('hold:off', true);
    const cooking = factsOf({ inventory: kit, jobs: [job(12, 44_000, 6), job(13, 50_000, 5)] });
    expect(move(ironMove(cooking, memory, store()))).toMatchObject({ tool: 'mc.mine-block', input: { count: 4 } });
    // With the ingots a long way off the dig is whole.
    expect(move(ironMove(factsOf({ inventory: kit, jobs: [job(12, 300_000, 6)] }), new ProcedureMemory(), store()))).toMatchObject({ input: { count: 20 } });
  });
});

// -- 5. A fight, not a flight, for a creeper in iron ---------------------------------------------------------------------------------------------------

describe('a creeper met in iron armour and an iron sword (run 24: two flights from creepers cut the procedure; 60 s)', () => {
  const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: false, respawnedRecently: false, healthDropped: false,
    hasWeapon: true, floorActive: false, floorKnown: true, shelterFailed: false, resting: new Set(), canCage: false, canTower: false, armorPieces: 4, strongArmor: 4, ...overrides });
  const creeper = (distance: number, ignited = false) => ({ name: 'creeper', distance, canReachMe: true, ignited });
  const verdict = (overrides: Partial<FastBodyState>) => {
    const result = fastJudgment(state(overrides));
    return 'decision' in result ? `${result.decision.kind}:${result.decision.rule}` : `hold:${result.hold}`;
  };

  it('lets a creeper at 8 m alone, and fights it at 5 m (the blast through iron is a fifth of her health)', () => {
    expect(verdict({ threats: [creeper(8)] })).toBe('hold:no_threat');
    expect(verdict({ threats: [creeper(5)] })).toBe('fight:creeper_fight');
    const result = fastJudgment(state({ threats: [creeper(5)] }));
    expect('decision' in result && result.decision).toMatchObject({ skill: 'attack-continuously', arguments: { entityName: 'creeper' } });
  });

  it('still runs from one that is lit, from one with others at her, when hurt, and without iron or a weapon', () => {
    expect(verdict({ threats: [creeper(5.5, true)] })).toBe('flee:creeper_flee');
    expect(verdict({ threats: [creeper(5), { name: 'zombie', distance: 4, canReachMe: true, ignited: false }] })).not.toBe('fight:creeper_fight');
    expect(verdict({ health: 10, threats: [creeper(5)] })).not.toBe('fight:creeper_fight');
    expect(verdict({ strongArmor: 1, threats: [creeper(5)] })).toBe('flee:creeper_flee');
    expect(verdict({ hasWeapon: false, threats: [creeper(5)] })).toBe('flee:creeper_flee');
    expect(verdict({ strongArmor: 1, threats: [creeper(8)] })).toBe('flee:creeper_flee');
  });

  it('counts the iron pieces she wears from the body\'s line', () => {
    const worn = '頭: iron_helmet(残り200)、胴: iron_chestplate(残り300)、脚: leather_leggings、足: なし';
    const read = fastBodyState(frame({ worn, inventory: pack({ iron_sword: 1 }) }), { earlierHealth: null, sinceArrivalMs: null });
    expect(read).toMatchObject({ armorPieces: 3, strongArmor: 2 });
  });
});

describe('a procedure a fast skill cut (run 24: the fight with the silverfish ended "止められた" and cost a decision to begin again)', () => {
  const run = async (reason?: unknown) => {
    const body = new SimBody(), controller = new AbortController();
    // The dig is begun and the fast skill takes the body: nothing is dug yet, so the step is not done when the run looks again.
    body.tool_mine_block = () => {
      controller.abort(reason);
      return { ok: true, text: '掘り始めた', retryable: false };
    };
    return setup(body).tools.execute({ scopeKey: 'owner', taskId: 'cut-task', operationId: 'op', name: 'mc.run-procedure', input: { milestone: '木' },
      signal: controller.signal, last: true });
  };

  it('is a pause, not a failed step: the body\'s reflex mark, and the words that say the same call goes on', async () => {
    const result = await run(fastJudgmentCut());
    expect(result).toMatchObject({ ok: false, bodyReflex: true });
    expect(result.text).toContain(PAUSED_BY_FAST_SKILL);
  });

  it('is a failure as before when the task itself was stopped', async () => {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.bodyReflex).toBeUndefined();
    expect(result.text).not.toContain(PAUSED_BY_FAST_SKILL);
  });
});

// -- 6. A reconnection is no respawn -------------------------------------------------------------------------------------------------------------------

describe('how the body arrived (run 24: 12 s after the server cut it in the Nether it was taken for a respawn, and a shelter was dug over magma)', () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => databases.splice(0).forEach(db => db.close()));
  function fixture() {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
      onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
    let sequence = 0, now = Date.now();
    const control = new MinecraftControl(new MinecraftControlStore(db), configuration, { now: () => now, leaseValid: () => true, leaseKnown: () => true, ownerAlone: () => true });
    const scope = { scopeKey: 'owner', deviceId: 'minebot' };
    const poll = (observation: Record<string, unknown> = {}, connectionId = 'connection'): MinecraftControlPoll => ({ schemaVersion: 1, serverId: 'world', connectionId,
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), connected: true, state: { health: 20 },
        facts: { alive: true, dimension: 'overworld' }, ...observation },
      skills: [{ name: 'dig', description: 'dig', readOnly: false, inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 64 } }, required: ['count'], additionalProperties: false } }], candidates: [],
      receipts: [], activeOperationIds: [] } as unknown as MinecraftControlPoll);
    return { control, send: (patch: Record<string, unknown> = {}, connectionId?: string) => { now += 1_000; return control.poll(scope, poll(patch, connectionId)); } };
  }
  const BODY = 'minecraft:world';

  it('tells a login, a death, a new connection, a connection that came back and a portal apart, and a body that stays where it is arrives at nothing', () => {
    const f = fixture();
    f.send();
    expect(f.control.arrivalKind(BODY)).toBe('login');
    const login = f.control.arrivedAt(BODY);
    f.send();
    expect(f.control.arrivedAt(BODY)).toBe(login);
    f.send({ connected: false });
    f.send();
    expect(f.control.arrivalKind(BODY)).toBe('reconnect');
    // Continue contract 5: a death is a rise of the death counter (`state.life`'s deathSeq within one deathEpoch), told when the body is seen dead; coming up alive again is the same death.
    const life = (deathSeq: number, alive: boolean) => ({ life: deathSeq + 1, deathEpoch: 'de-1', deathSeq, since: new Date().toISOString(), alive, dimension: 'overworld', dimensionSince: new Date().toISOString() });
    f.send({ state: { health: 20, life: life(0, true) } });
    expect(f.control.arrivalKind(BODY)).toBe('reconnect');
    f.send({ facts: { alive: false, dimension: 'overworld' }, state: { health: 0, life: life(1, false) } });
    expect(f.control.arrivalKind(BODY)).toBe('death');
    const died = f.control.arrivedAt(BODY);
    f.send({ state: { health: 20, life: life(1, true) } });
    expect(f.control.arrivalKind(BODY)).toBe('death');
    expect(f.control.arrivedAt(BODY)).toBeGreaterThan(died!);
    f.send({}, 'newer');
    expect(f.control.arrivalKind(BODY)).toBe('reconnect');
    const before = f.control.arrivedAt(BODY);
    f.send({ facts: { alive: true, dimension: 'the_nether' } }, 'newer');
    expect(f.control.arrivalKind(BODY)).toBe('dimension');
    expect(f.control.arrivedAt(BODY)).toBeGreaterThan(before!);
  });

  const threats = { world: { health: 20, nearbyThreats: [{ name: 'zombie', distance: 12 }], inventory: [] } };
  const read = (arrivalKind: string | null) => fastJudgment(fastBodyState({ facts: { alive: true }, state: threats }, { earlierHealth: null, sinceArrivalMs: 12_000, arrivalKind }));
  it('shelters on a respawn or a login, and not on a connection that came back or a portal', () => {
    for (const kind of ['death', 'login', null]) expect('decision' in read(kind) && (read(kind) as { decision: { rule: string } }).decision.rule).toBe('respawn_shelter');
    for (const kind of ['reconnect', 'dimension']) expect('hold' in read(kind)).toBe(true);
  });
});

// -- 7. The Nether's first seconds --------------------------------------------------------------------------------------------------------------------

describe('the Nether (run 24: 5.3 s of lag, twelve digs taken back, a disconnect 39 s after the gate)', () => {
  const nether = frame({ dimension: 'the_nether', position: { x: 5, y: 35, z: 12 } }, 1, { dimension: 'the_nether' });
  const dig = (ok: boolean) => ({ name: 'mc.mine-block', ok, summary: ok ? '掘りました' : '掘れませんでした' });

  it('tells the first seconds to wait and look, only there and only then', () => {
    const lines = netherCareLines(nether, [], 1_000, 6_000);
    expect(lines.join('\n')).toContain('ネザーに着いて5秒');
    expect(lines.join('\n')).toContain('mc.wait-time');
    expect(netherCareLines(nether, [], 1_000, 30_000)).toEqual([]);
    expect(netherCareLines(frame({}), [], 1_000, 6_000)).toEqual([]);
  });

  it('stops digging after three failed digs in a row there, and not when one worked between', () => {
    expect(netherCareLines(nether, [dig(false), dig(false), dig(false)], null, 0).join('\n')).toContain('掘りが3回続けて失敗');
    expect(netherCareLines(nether, [dig(false), dig(true), dig(false)], null, 0)).toEqual([]);
    expect(netherCareLines(frame({}), [dig(false), dig(false), dig(false)], null, 0)).toEqual([]);
  });

  it('is joined to the search for the fortress: the step after the Nether is the fortress, and the Nether skill is pointed', () => {
    const counts = new Map<string, number>();
    expect(milestoneNow({ counts, dimension: 'the_nether', netherReached: true }).now.name).toBe('ネザー要塞');
    const situation = minecraftSituation(nether, { failedStepsInARow: 0 });
    expect(situation.milestoneName).toBe('ネザー要塞');
    expect(minecraftSkillContext(situation, new Set(['mc-nether-travel'])).fields.skillPointers?.[0]).toContain('mc-nether-travel');
  });
});

describe('progress by moving (run 24: a dig of 20 m away from the place it was sent to was "progress" like any walk)', () => {
  const mark = (x: number, z: number) => progressMark(frame({ position: { x, y: 64, z } }));

  it('counts a move of 16 m or more only when the call named no place, or the place is nearer by half of that', () => {
    expect(madeProgress(mark(0, 0), mark(20, 0))).toContain('20m 動いた');
    expect(madeProgress(mark(0, 0), mark(20, 0), { x: 60, z: 0 })).toContain('20m 動いた');
    expect(madeProgress(mark(0, 0), mark(20, 0), { x: -50, z: 0 })).toBeNull();
    expect(madeProgress(mark(0, 0), mark(20, 0), { x: 20, z: 40 })).toBeNull();
    // Something made on the way still counts, wherever she went.
    const gained = progressMark(frame({ position: { x: 20, y: 64, z: 0 }, inventory: pack({ obsidian: 3 }) }));
    expect(madeProgress(mark(0, 0), gained, { x: -50, z: 0 })).toContain('obsidian+3');
    expect(targetOf({ x: 3, y: 4, z: 5 })).toEqual({ x: 3, z: 5 });
    expect(targetOf({ itemName: 'bucket' })).toBeNull();
  });
});

// -- 8. A failure repeated is a review ---------------------------------------------------------------------------------------------------------------

describe('the review of failures (run 24: none in 1,516 s; 0 obsidian at the same pool twice, with a good step between)', () => {
  const zero = '黒曜石を0個作りました。近くに水をかけられる溶岩も、すぐ掘れる黒曜石も、もうありません（(-55, -37, 186)）';
  const recent = [{ name: 'mc.use-item-on-block', ok: false, summary: zero }, { name: 'mc.move-to', ok: true, summary: '移動しました' },
    { name: 'mc.use-item-on-block', ok: false, summary: zero.replace('-55', '-56') }];

  it('looks back when the same work failed twice without anything made, though a call that worked came between', () => {
    expect(repeatedFailure(recent)).toEqual({ tool: 'mc.use-item-on-block', times: 2 });
    const review = failureReview(1, recent)!;
    expect(review).not.toBeNull();
    expect(String(review.repeatedFailure)).toContain('mc.use-item-on-block');
    expect(failureReview(0, [])).toBeNull();
  });

  it('counts neither a failure that made something, nor a pause by a fast skill, nor a find that found nothing, nor two different failures', () => {
    const made = recent.map(item => item.ok ? item : { ...item, summary: `${item.summary}\n進み（失敗には数えない）: obsidian+3` });
    expect(repeatedFailure(made)).toBeNull();
    expect(repeatedFailure(recent.map(item => ({ ...item, summary: item.ok ? item.summary : `${item.summary}\n${PAUSED_BY_FAST_SKILL}` })))).toBeNull();
    const find = { name: 'mc.find-blocks', ok: false, summary: '見つかりませんでした' };
    expect(repeatedFailure([find, find, find])).toBeNull();
    expect(repeatedFailure([recent[0]!, { ...recent[2]!, summary: '道具が足りません' }])).toBeNull();
  });
});
