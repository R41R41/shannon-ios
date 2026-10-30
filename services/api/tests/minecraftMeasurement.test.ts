import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { MILESTONE_NAMES, milestoneLine, milestonesShown, minecraftStage, newlyReached, stageLine } from '../src/surfaces/minecraft/minecraftMilestoneLog.js';
import { callTags, craftedOrderedTool, earlyGameLine, isFirstLook, minesIronOre, toolOrderOk, villageDistance } from '../src/surfaces/minecraft/minecraftAdoptionTags.js';
import { closeGistDecision, emptyGistAdoption, gistAdoptionLine, noteGistCall, observeGistOutcomes, showGists } from '../src/surfaces/minecraft/minecraftGistAdoption.js';
import { createMinecraftTaskMetrics } from '../src/surfaces/minecraft/minecraftTaskMetrics.js';
import { readMetricsState } from '../src/surfaces/minecraft/minecraftMetricsState.js';
import { fcaDecisionMetrics } from '../src/mind/action/fca/fcaDecisionMetrics.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

const counts = (items: unknown[], facts: Record<string, unknown> = {}) => carriedItemCounts({ inventory: items }, facts);
const BED = 'mc-bed-before-night';

describe('carried item counts', () => {
  it('reads stacks, bare names, entries and slot facts, and ignores anything not registry-shaped', () => {
    const result = counts(['oak_log×5', 'minecraft:stone_pickaxe', { name: 'white_bed', count: 1 }, 'Some user text!', { name: 'x y' }], { 'slot:1': 'bucket', 'slot:2': 'oak_log×1' });
    expect([...result]).toEqual([['oak_log', 5], ['stone_pickaxe', 1], ['white_bed', 1], ['bucket', 1]]);
  });
});

describe('milestones', () => {
  it('shows each early item, any bed, iron armour and the Nether, and reports each first-reach once', () => {
    const shown = milestonesShown(counts(['wooden_pickaxe×1', 'red_bed×1', 'iron_boots×1', 'water_bucket×1']), 'the_nether');
    expect(shown).toEqual(['wooden_pickaxe', 'bed', 'bucket', 'iron_armor', 'water_bucket', 'nether_portal']);
    expect(newlyReached(shown, new Set())).toEqual(['wooden_pickaxe', 'bed', 'bucket', 'iron_armor', 'water_bucket', 'nether_portal']);
    // Losing and re-acquiring an item is no new first reach.
    expect(newlyReached(shown, new Set(['wooden_pickaxe', 'bed']))).toEqual(['bucket', 'iron_armor', 'water_bucket', 'nether_portal']);
    expect(milestonesShown(counts(['bedrock×1']), 'overworld')).toEqual([]);
  });
  it('run 48: the diamond pickaxe is a milestone of the journal, once, in the order of the road, whether made or found', () => {
    const shown = milestonesShown(counts(['iron_pickaxe×1', 'diamond_pickaxe×1', 'diamond×1']), 'overworld');
    expect(shown).toEqual(['iron_pickaxe', 'diamond_pickaxe']);
    expect(newlyReached(shown, new Set(['iron_pickaxe']))).toEqual(['diamond_pickaxe']);
    expect(newlyReached(shown, new Set(['iron_pickaxe', 'diamond_pickaxe']))).toEqual([]);
    expect(milestoneLine('t1', 'diamond_pickaxe', 1_000_900, 31000, 57)).toBe('Shannon Minecraft milestone task=t1 name=diamond_pickaxe t=1001 tick=31000 d=57');
    // every item the meter points at has its line in the journal
    for (const item of ['iron_pickaxe', 'bucket', 'diamond_pickaxe', 'water_bucket', 'obsidian']) expect(MILESTONE_NAMES).toContain(item);
  });
  it('writes a content-free line', () => {
    expect(milestoneLine('t1', 'iron_pickaxe', 414_400, 7000, 12)).toBe('Shannon Minecraft milestone task=t1 name=iron_pickaxe t=414 tick=7000 d=12');
    expect(milestoneLine('t1', 'bed', 0, null, 1)).toBe('Shannon Minecraft milestone task=t1 name=bed t=0 tick=- d=1');
  });
});

describe('stage', () => {
  it('is 1 without a stone pickaxe, 2 with one and no bed or food, 3 with a bed and food, 4 with an iron pickaxe', () => {
    expect(minecraftStage(counts([]))).toBe(1);
    expect(minecraftStage(counts(['wooden_pickaxe×1', 'white_bed×1']))).toBe(1);
    expect(minecraftStage(counts(['stone_pickaxe×1']))).toBe(2);
    expect(minecraftStage(counts(['stone_pickaxe×1', 'white_bed×1']))).toBe(2);
    expect(minecraftStage(counts(['stone_pickaxe×1', 'white_bed×1', 'cooked_beef×6']))).toBe(3);
    expect(minecraftStage(counts(['iron_pickaxe×1']))).toBe(4);
    expect(minecraftStage(counts(['iron_pickaxe×1', 'white_bed×1']))).toBe(4);
  });
  it('writes the stage with the pointed and offered skills, names only', () => {
    expect(stageLine('t1', 3, 61_000, 2, [BED, 'mc-low-health'], [BED])).toBe(`Shannon Minecraft stage task=t1 d=3 t=61 stage=2 pointed=${BED},mc-low-health offered=${BED}`);
    expect(stageLine('t1', 3, 0, 1, [], [])).toBe('Shannon Minecraft stage task=t1 d=3 t=0 stage=1 pointed=- offered=-');
    expect(stageLine('t1', 1, 0, 1, ['has spaces and 日本語'], [])).toContain('pointed=-');
  });
});

describe('adoption tags', () => {
  it('derives each tag from a tool name and its arguments only', () => {
    expect(callTags('mc.find-nearest-entity', { entityType: 'sheep' })).toEqual(['animal_search']);
    expect(callTags('mc.find-nearest-entity', { entityType: 'zombie' })).toEqual([]);
    expect(callTags('mc.list-nearby-entities', {})).toEqual(['animal_search']);
    expect(callTags('mc.explore-for-structure', { structureType: 'village' })).toEqual(['village_search']);
    expect(callTags('mc.find-structure', { structureType: 'fortress' })).toEqual([]);
    expect(callTags('mc.recall-places', {})).toEqual(['village_search']);
    expect(callTags('mc.attack-continuously', { target: 'cow' })).toEqual(['food_hunt']);
    expect(callTags('mc.attack-continuously', { target: 'zombie' })).toEqual([]);
    expect(callTags('mc.start-smelting', {})).toEqual(['food_hunt']);
    expect(callTags('mc.eat-food', {})).toEqual(['food_hunt']);
    expect(callTags('mc.craft-one', { item: 'white_bed' })).toEqual(['bed_made']);
    expect(callTags('mc.sleep-in-bed', {})).toEqual(['bed_used']);
    expect(isFirstLook('minecraft.observe', 2)).toBe(true);
    expect(isFirstLook('minecraft.observe', 3)).toBe(false);
  });
  it('judges the tool order on first makings and finds iron ore mining', () => {
    expect(craftedOrderedTool('mc.craft-one', { item: 'stone_axe' })).toBe('stone_axe');
    expect(craftedOrderedTool('mc.craft-one', { item: 'stick' })).toBeNull();
    expect(toolOrderOk(['wooden_pickaxe', 'stone_pickaxe', 'stone_axe'])).toBe(true);
    expect(toolOrderOk(['stone_pickaxe', 'wooden_pickaxe', 'stone_axe'])).toBe(false);
    expect(toolOrderOk(['wooden_pickaxe', 'stone_pickaxe'])).toBe(false);
    expect(minesIronOre('mc.mine-block', { block: 'iron_ore' })).toBe(true);
    expect(minesIronOre('mc.mine-block', { block: 'coal_ore' })).toBe(false);
    expect(villageDistance([{ kind: 'village', distance: 169 }, { name: 'Village', distance: 90 }, { kind: 'x', distance: 1 }])).toBe(90);
    expect(villageDistance(undefined)).toBeNull();
  });
  it('writes a line of closed words with the iron-time facts only when given', () => {
    expect(earlyGameLine('t1', 4, 90_000, 2, ['food_hunt'], ['food_hunt'], 3, false, null))
      .toBe('Shannon Minecraft early-game task=t1 d=4 t=90 stage=2 tags=food_hunt new=food_hunt food=3 bed=false');
    expect(earlyGameLine('t1', 5, 0, 2, [], [], 12, true, { food: true, bed: true })).toBe(
      'Shannon Minecraft early-game task=t1 d=5 t=0 stage=2 tags=- new=- food=12 bed=true foodBeforeIron=true bedBeforeIron=true');
  });
});

describe('gist follow-through', () => {
  it('counts a follow within three decisions, resets the ignored streak, and sees the outcome rise', () => {
    const state = emptyGistAdoption();
    expect(showGists(state, 1, [BED], counts([]))).toMatchObject([{ skill: BED, followed: 'pending' }]);
    noteGistCall(state, 2, [BED]);
    expect(closeGistDecision(state, 2)).toEqual([{ skill: BED, shownAt: 1, followed: 'yes', outcome: 'pending', ignoredStreak: 0 }]);
    expect(observeGistOutcomes(state, 3, counts([]))).toEqual([]);
    expect(observeGistOutcomes(state, 4, counts(['red_bed×1']))).toEqual([{ skill: BED, shownAt: 1, followed: 'yes', outcome: 'yes', ignoredStreak: 0 }]);
  });
  it('lengthens the ignored streak when the window runs out, and ignores a call after it', () => {
    const state = emptyGistAdoption();
    showGists(state, 1, [BED], counts([]));
    expect(closeGistDecision(state, 1)).toEqual([]);
    expect(closeGistDecision(state, 2)).toEqual([]);
    expect(closeGistDecision(state, 3)).toMatchObject([{ followed: 'no', ignoredStreak: 1 }]);
    showGists(state, 5, [BED], counts([]));
    noteGistCall(state, 8, [BED]);
    expect(closeGistDecision(state, 7)).toMatchObject([{ followed: 'no', ignoredStreak: 2 }]);
    expect(gistAdoptionLine('t1', 7, { skill: BED, shownAt: 5, followed: 'no', outcome: '-', ignoredStreak: 2 }))
      .toBe(`Shannon Minecraft gist adoption task=t1 d=7 skill=${BED} shownAt=5 followedWithinN=no outcome=- ignoredStreak=2`);
  });
});

const frame = (world: Record<string, unknown>, facts: Record<string, unknown> = {}) => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 'x', receivedAt: 'x',
  connected: true, state: { world }, facts }) as unknown as BodyObservation;
const summaryOf = (world: Record<string, unknown>) => ({ state: { world } }) as unknown as BodyObservation;

describe('the task metrics across decisions', () => {
  const run = (kept: unknown, world: Record<string, unknown>, calls: Array<[string, unknown]>, shown = new Map<string, Set<string>>(), summary = world) => {
    const lines: string[] = [];
    const metrics = createMinecraftTaskMetrics({ taskId: 't1', createdAt: '2026-10-17T00:00:00.000Z', kept, now: () => Date.parse('2026-10-17T00:05:00.000Z'), log: line => lines.push(line) });
    metrics.context(frame(world), summaryOf(summary), { skillPointers: [`${BED}（日暮れ）`], skillGists: [{ skill: BED }] });
    for (const [name, input] of calls) metrics.noteCall(name, input, shown);
    metrics.flush(); metrics.flush();
    return { lines, kept: (metrics.checkpoint() as { minecraftMetrics: unknown }).minecraftMetrics };
  };
  it('logs a milestone once, across steps, with seconds and tick, and carries no argument or item text', () => {
    const world = { dimension: 'overworld', time: '1200', inventory: ['wooden_pickaxe×1'], biome: '', landmarks: [], nearbyEntities: [{ name: 'pig' }, { omitted: 8 }], health: 12 };
    const first = run(undefined, world, [['mc.find-nearest-entity', { entityType: 'sheep', note: 'secret user words' }]]);
    expect(first.lines).toContain('Shannon Minecraft milestone task=t1 name=wooden_pickaxe t=300 tick=1200 d=1');
    expect(first.lines).toContain(`Shannon Minecraft stage task=t1 d=1 t=300 stage=1 pointed=${BED} offered=${BED}`);
    expect(first.lines.some(line => line.startsWith('Shannon Minecraft early-game') && line.includes('tags=animal_search new=animal_search'))).toBe(true);
    expect(first.lines).toContain('Shannon Minecraft observation-gap task=t1 d=1 biome=empty entitiesOmitted=8 landmarks=false died=false deaths=0 hpMin=- hungryNoEat=0');
    expect(first.lines.join('\n')).not.toMatch(/secret|user words/u);
    const second = run(first.kept, { ...world, inventory: ['wooden_pickaxe×1', 'stone_pickaxe×1'] }, []);
    expect(second.lines.filter(line => line.includes('milestone')).map(line => line.split(' ')[4])).toEqual(['name=stone_pickaxe']);
    expect(second.lines.some(line => line.includes(' d=2 '))).toBe(true);
  });
  it('records the Nether entry and does not repeat it', () => {
    const first = run(undefined, { dimension: 'the_nether', inventory: [] }, []);
    expect(first.lines.some(line => line.includes('name=nether_portal'))).toBe(true);
    const again = run(first.kept, { dimension: 'the_nether', inventory: [] }, []);
    expect(again.lines.some(line => line.includes('name=nether_portal'))).toBe(false);
  });
  it('run 48: the decision that first sees the diamond pickaxe writes its line, once, and a kept state from before the list had it does not repeat the iron pickaxe', () => {
    const world = { dimension: 'overworld', time: '31000', inventory: ['iron_pickaxe×1', 'diamond_pickaxe×1', 'water_bucket×1'], biome: '', landmarks: [], nearbyEntities: [], health: 20 };
    const before = run(undefined, { ...world, inventory: ['iron_pickaxe×1'] }, []);
    expect(before.lines.some(line => line.includes('name=diamond_pickaxe'))).toBe(false);
    const made = run(before.kept, world, []);
    expect(made.lines).toContain('Shannon Minecraft milestone task=t1 name=diamond_pickaxe t=300 tick=31000 d=2');
    expect(made.lines).toContain('Shannon Minecraft milestone task=t1 name=water_bucket t=300 tick=31000 d=2');
    expect(made.lines.some(line => line.includes('name=iron_pickaxe'))).toBe(false);
    const again = run(made.kept, world, []);
    expect(again.lines.some(line => line.includes('milestone task=t1 name=diamond_pickaxe'))).toBe(false);
  });
  it('flags a hungry decision with food carried and no meal, and tracks health and death from samples', () => {
    const lines: string[] = [];
    const metrics = createMinecraftTaskMetrics({ taskId: 't2', createdAt: 'x', kept: undefined, now: () => 0, log: line => lines.push(line) });
    metrics.sample(frame({ health: 9 }, { alive: true }));
    metrics.sample(frame({ health: 4 }, { alive: true }));
    metrics.sample(frame({ health: 0 }, { alive: false }));
    metrics.sample(frame({ health: 0 }, { alive: false }));
    metrics.context(frame({ food: 3, inventory: ['bread×2'] }), null, {});
    metrics.flush();
    expect(lines.at(-1)).toBe('Shannon Minecraft observation-gap task=t2 d=1 biome=absent entitiesOmitted=0 landmarks=false died=true deaths=1 hpMin=4 hungryNoEat=1');
  });
  it('reads a damaged kept state as fresh', () => {
    expect(readMetricsState({ d: 'x', reached: ['bogus'], gist: { tracks: { 'Bad Name': {} } } })).toMatchObject({ d: 0, reached: [], gist: { tracks: {} } });
    expect(readMetricsState('nonsense').d).toBe(0);
  });
});

describe('the decision metrics line', () => {
  it('has numbers, tool names and the model counts only', async () => {
    const lines: string[] = [];
    let tick = 0;
    const metrics = fcaDecisionMetrics('task-1', '2026-10-17T00:00:00.000Z', { fcaDecisionIndex: 4 },
      { clock: () => (tick += 10), now: () => Date.parse('2026-10-17T00:01:00.000Z'), log: line => lines.push(line) });
    await metrics.timed('llmMs', async () => 1);
    metrics.tool('mc.craft-one', 7);
    metrics.tool('bad name with spaces', 3);
    expect(metrics.checkpoint()).toEqual({ fcaDecisionIndex: 5, fcaCommittedAt: Date.parse('2026-10-17T00:01:00.000Z') });
    await inActionExecution({ modelMetrics: { storedTokens: 100, tailTokens: 20, inputNew: 5, inputRead: 90, inputWrite: 10, outputTokens: 30, inputTransformations: 2 } } as never,
      async () => metrics.emit());
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'fca_decision_metrics', task: 'task-1', d: 5, t: 60, obsMode: 'legacy', llmMs: 10, stepMs: 30, selectorMs: 0,
      recallMs: 0, recallStartMs: 0, evidenceMs: 0, summaryMs: 0, tools: ['mc.craft-one', 'other'], toolMs: 10, storedTokens: 100, tailTokens: 20, in: { new: 5, read: 90, write: 10, uncached: 15, hit: 857 }, out: 30,
      loopBlockedMs: 0, other: { startMs: 0, permitMs: 0, guardMs: 0, contextMs: 0, verifyMs: 0, closeMs: 0, commitMs: 0, progressMs: 0 },
      permitAsks: 0, gap: null, inputTransformations: 2 });
  });
  it('names the rest of a step and the time from the previous commit, split by what the scheduler said', async () => {
    const lines: string[] = [];
    let tick = 100;
    const committed = Date.parse('2026-10-17T00:00:50.000Z');
    const admission = { previousEndAt: committed + 300, startedAt: committed + 900, acquireMs: 40, beginMs: 5, budgetMs: 3, portsMs: 2 };
    await inActionExecution({ admission } as never, async () => {
      const metrics = fcaDecisionMetrics('task-1', '2026-10-17T00:00:00.000Z', { fcaDecisionIndex: 4, fcaCommittedAt: committed },
        { clock: () => (tick += 10), now: () => committed + 1_000, log: line => lines.push(line), enteredAt: 60 });
      await metrics.timed('permitMs', async () => 1);
      metrics.timedSync('contextMs', () => 1);
      await metrics.timed('guardMs', async () => 1);
      metrics.skipped('mc.place-block-at');
      metrics.emit();
    });
    const line = JSON.parse(lines[0]!);
    // The clock read 110 when the step's metrics began, 50 after the step was entered at 60.
    expect(line.other).toEqual({ startMs: 50, permitMs: 10, guardMs: 10, contextMs: 10, verifyMs: 0, closeMs: 0, commitMs: 0, progressMs: 0 });
    expect(line.gap).toEqual({ sinceCommitMs: 1_000, afterMs: 300, waitMs: 600, admitMs: 50, startMs: 50 });
    expect(line.skipped).toEqual(['mc.place-block-at']);
    // Without the scheduler's word only the whole is known; a first decision has no gap at all.
    const bare: string[] = [];
    const alone = fcaDecisionMetrics('task-1', '2026-10-17T00:00:00.000Z', { fcaCommittedAt: committed }, { now: () => committed + 1_000, log: line => bare.push(line) });
    alone.emit();
    expect(JSON.parse(bare[0]!).gap).toEqual({ sinceCommitMs: 1_000, afterMs: null, waitMs: null, admitMs: null, startMs: 0 });
    const first: string[] = [];
    fcaDecisionMetrics('task-1', '2026-10-17T00:00:00.000Z', {}, { log: line => first.push(line) }).emit();
    expect(JSON.parse(first[0]!).gap).toBeNull();
  });
});
