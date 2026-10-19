import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { fcaOutcomeEpisode, UNVERIFIED_COMPLETION } from '../src/mind/action/fca/fcaOutcomeEpisode.js';
import type { FcaDurableOutcome } from '../src/mind/action/fca/fcaEvidencePorts.js';
import { FLOOR_FIGHT_REFUSAL, ONE_HIT_WAIT_REFUSAL, RANGED_FIGHT_REFUSAL, fightRefusal } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { bedSearchMemory, minecraftSituation, minecraftSkillContext, minecraftSkillPointers, withRecoverableDrops } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { milestoneNow } from '../src/surfaces/minecraft/minecraftStage.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { fastJudgment, type FastBodyState } from '../src/mind/action/reflex/fastJudgment.js';
import { FCA_BODY_TOOL_ABSENT } from '../src/mind/action/fca/fcaRunner.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';

/**
 * Minecraft run 17, decision by decision (2026-10-19, task 446e2865): a turned-back completion remembered as a success, a fight at 11
 * health with a skeleton that cancelled the floor's retreat, "one hit left" shown for eleven decisions while she waited, the bed passed
 * by the iron pickaxe, the stage back to wood after each death, seven cooked porkchops left in a furnace.
 */
const observation = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1,
  bodyId: 'minecraft:world', sequence: 1, stateAt: 'x', receivedAt: 'x', connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '100', margin: { darkInSeconds: 645 }, nearbyThreats: [], ...world,
    inventory: ((world.inventory as string[] | undefined) ?? []).map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; }) } },
  facts: { dimension: 'overworld', ...facts } }) as unknown as BodyObservation;
const skeleton = (distance: number) => ({ name: 'skeleton', distance, canReachMe: true });

describe('a completion turned back is remembered as not achieved', () => {
  const outcome = (actualTaskStatus: string): FcaDurableOutcome => ({ scopeKey: 'owner', taskId: 'task', stepId: 'step', outcomeId: 'out', goal: 'エンドラを討伐してください',
    action: { id: 'c', name: 'fca.complete', input: { summary: '討伐は未達成です' } }, expectation: null, comparison: null, observation: 'observed',
    result: { ok: true, text: JSON.stringify({ actualStatus: actualTaskStatus }) }, observedAt: '2026-10-19T16:30:00.000Z', sources: [], actualTaskStatus,
    segment: { actions: [{ name: 'mc.mine-block' }], eventIds: ['e1'], closedBy: 'fca.complete' } } as unknown as FcaDurableOutcome);
  it('is a failure with the fixed words "未達" when the task went back to work, a success when it completed', () => {
    // Run 17: three of these were `[success] complete: …未達成です` and one was recalled at D36 as done.
    expect(fcaOutcomeEpisode(outcome('queued'))).toMatchObject({ status: 'failure', interpretation: UNVERIFIED_COMPLETION });
    expect(fcaOutcomeEpisode(outcome('completed'))).toMatchObject({ status: 'success' });
    expect(fcaOutcomeEpisode(outcome('completed'))!.interpretation).not.toBe(UNVERIFIED_COMPLETION);
    // A completion held for children (a wait) or a task that failed at it: not this.
    expect(fcaOutcomeEpisode(outcome('running'))!.interpretation).not.toBe(UNVERIFIED_COMPLETION);
    expect(fcaOutcomeEpisode(outcome('failed'))).toMatchObject({ status: 'failure' });
    expect(fcaOutcomeEpisode(outcome('failed'))!.interpretation).not.toBe(UNVERIFIED_COMPLETION);
  });
});

describe('fights and waits refused before they are sent', () => {
  it('refuses a fight while the floor retreats, and at half health with a ranged enemy near (run 17, D14)', () => {
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => observation({ health: 11 }, { floorActive: true })))
      .toMatchObject({ failure: 'refused', retryable: true, text: FLOOR_FIGHT_REFUSAL });
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => observation({ health: 10, nearbyThreats: [skeleton(12)] }))).toMatchObject({ text: RANGED_FIGHT_REFUSAL });
    expect(fightRefusal('mc.attack-continuously', { entityName: 'hostile' }, () => observation({ health: 6, nearbyThreats: [skeleton(8)] }))).toMatchObject({ text: RANGED_FIGHT_REFUSAL });
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => observation({ health: 15, nearbyThreats: [skeleton(12)] }))).toBeNull();
    // From inside her cage (holdPosition), as the body lane lets it through: a creeper or an archer at the gap.
    expect(fightRefusal('mc.attack-continuously', { entityName: 'creeper', holdPosition: true }, () => observation({ health: 20 }))).toBeNull();
    expect(fightRefusal('mc.attack-continuously', { entityName: 'skeleton', holdPosition: true }, () => observation({ health: 8, nearbyThreats: [skeleton(3)] }))).toBeNull();
    expect(fightRefusal('mc.combat', { target: 'zombie' }, () => observation({ health: 8, nearbyThreats: [{ name: 'zombie', distance: 3 }] }))).toBeNull();
    // A zombie named at her side is hers to fight, a skeleton behind a wall (cannot reach her) is no reason.
    expect(fightRefusal('mc.combat', { target: 'zombie' }, () => observation({ health: 8, nearbyThreats: [{ name: 'zombie', distance: 2 }, skeleton(15)] }))).toBeNull();
    expect(fightRefusal('mc.combat', { target: 'skeleton' }, () => observation({ health: 8, nearbyThreats: [{ ...skeleton(10), canReachMe: false }] }))).toBeNull();
    expect(fightRefusal('mc.mine-block', { blockName: 'stone' }, () => observation({ health: 5, nearbyThreats: [skeleton(5)] }, { floorActive: true }))).toBeNull();
  });
  it('refuses a wait with one hit left and a threat near (run 17, D25-D35), and lets other waits through', () => {
    const oneHit = { margin: { darkInSeconds: 645, hitsLeft: { from: 'creeper', hits: 1 } } };
    expect(fightRefusal('mc.wait-time', { milliseconds: 50_000 }, () => observation({ ...oneHit, nearbyThreats: [{ name: 'creeper', distance: 9 }] })))
      .toMatchObject({ failure: 'refused', text: ONE_HIT_WAIT_REFUSAL });
    expect(fightRefusal('mc.wait-time', { milliseconds: 50_000 }, () => observation({ ...oneHit, nearbyThreats: [] }))).toBeNull();
    // Sealed in her hole (the zombie outside cannot reach her): the night shelter's own wait.
    expect(fightRefusal('mc.wait-time', { milliseconds: 50_000 }, () => observation({ ...oneHit, nearbyThreats: [{ name: 'zombie', distance: 3, canReachMe: false }] }))).toBeNull();
    expect(fightRefusal('mc.wait-time', { milliseconds: 50_000 }, () => observation({ margin: { hitsLeft: { from: 'zombie', hits: 4 } }, nearbyThreats: [{ name: 'zombie', distance: 5 }] }))).toBeNull();
  });
  it('says a body tool absent from the menu is the reflex or the catalog, not "no tool of this task"', () => {
    expect(FCA_BODY_TOOL_ABSENT).toMatch(/体の反射が体を使用中/u);
  });
});

describe('the lines beside the milestone, and the milestone itself', () => {
  const ALL = new Set(['mc-night-shelter', 'mc-iron-and-bucket', 'mc-food-and-bed']);
  const context = (world: Record<string, unknown>) => minecraftSkillContext(minecraftSituation(observation(world), { failedStepsInARow: 0 }), ALL);
  it('reminds of a furnace left with its time up, and of one hit left with a threat near', () => {
    const jobs = [{ input: 'porkchop', count: 7, status: 'verification_due', remainingEstimateMs: 0, position: { x: 12, y: 84, z: 119 } }];
    expect(context({ jobs }).fields.reminders).toEqual(['かまどのporkchop×7（12,84,119）は焼き上がりの時刻を過ぎた。離れる前に withdraw-from-furnace で取り出す']);
    expect(context({ jobs: [{ ...jobs[0], status: 'waiting_external' }] }).fields.reminders).toBeUndefined();
    const oneHit = context({ margin: { darkInSeconds: 645, hitsLeft: { from: 'creeper', hits: 1 } }, nearbyThreats: [{ name: 'creeper', distance: 9 }] });
    expect(oneHit.fields.reminders?.[0]).toMatch(/^あと1撃で倒れる（creeper）。開けた所で待たない: 離れる（flee-from）・3段上る（tower-up）・囲う（build-around-self）/u);
    expect(context({ margin: { darkInSeconds: 645, hitsLeft: { from: 'creeper', hits: 1 } } }).fields.reminders).toBeUndefined();
  });
  it('keeps the bed and food as the step until they hold, whatever later anchor is reached (run 17, D24-D45)', () => {
    const at = (items: string[], extra: Partial<Parameters<typeof milestoneNow>[0]> = {}) => {
      const { now, next } = milestoneNow({ counts: carriedItemCounts({ inventory: items.map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; }) }, {}),
        dimension: 'overworld', netherReached: false, ...extra });
      return [now.name, next?.name];
    };
    // Its next is the step it came back from (review: not the iron already in hand).
    expect(at(['iron_pickaxe×1', 'bucket×1'])).toEqual(['食料と羊とベッド', '鉄の全身の防具']);
    expect(at(['iron_pickaxe×1', 'bucket×1', 'white_bed×1', 'bread×2'])).toEqual(['食料と羊とベッド', '鉄の全身の防具']);
    // A meal or two eaten after leaving it does not bring it back: three are enough to stay away.
    expect(at(['iron_pickaxe×1', 'bucket×1', 'white_bed×1', 'bread×3'])).toEqual(['鉄の全身の防具', 'ダイヤ']);
    // A respawn bed set at her base counts as her bed.
    expect(at(['iron_pickaxe×1', 'bucket×1', 'bread×3'], { bedPlaced: true })).toEqual(['鉄の全身の防具', 'ダイヤ']);
    // Not in the Nether or beyond.
    expect(at(['blaze_rod×3'], { dimension: 'the_nether', netherReached: true })).toEqual(['ブレイズ', 'パール']);
  });
  it('counts what she can still pick up after a death (run 17, D16 and D36: back to the first wood)', () => {
    const world = { lastDeath: '1分前 overworld (100,64,-20) 5m 東 落とした物: iron_pickaxe×1 消えるまで最長約4分→拾いに戻れる',
      deaths: [{ at: '2026-10-19T16:32:10.000Z', lostItems: ['iron_pickaxe×1', 'cobblestone×134', 'white_bed×1'] }] };
    const counts = withRecoverableDrops(new Map(), world);
    expect(counts.get('iron_pickaxe')).toBe(1);
    expect(counts.get('cobblestone')).toBe(134);
    expect(withRecoverableDrops(new Map(), { ...world, lastDeath: '3分前 … 落とした物: iron_pickaxe×1 は、戻った時にはもう無かった' }).size).toBe(0);
    expect(withRecoverableDrops(new Map(), { deaths: world.deaths }).size).toBe(0);
    // Picked up again: counted once (the larger), and dropped in the Nether: none in the overworld.
    expect(withRecoverableDrops(new Map([['cobblestone', 134]]), world).get('cobblestone')).toBe(134);
    expect(withRecoverableDrops(new Map(), { ...world, dimension: 'overworld', deaths: [{ ...world.deaths[0], dimension: 'the_nether' }] }).size).toBe(0);
    expect(minecraftSkillContext(minecraftSituation(observation({ inventory: [], ...world }), { failedStepsInARow: 0 }), ALL).fields.reminders?.[0])
      .toMatch(/^死んだ所に落とし物が残っている（iron_pickaxe×1・cobblestone×134・white_bed×1）。消える前に拾いに戻る/u);
    const situation = minecraftSituation(observation({ inventory: [], ...world }), { failedStepsInARow: 0 });
    expect(situation.stage).toBe(4);
    expect(minecraftSkillPointers(situation, ALL)).not.toContain('mc-first-day（石のツルハシがまだ無い）');
  });
});

describe('creepers, after the review', () => {
  const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: true, respawnedRecently: false,
    healthDropped: false, hasWeapon: true, floorActive: false, floorKnown: true, shelterFailed: false, resting: new Set(), canCage: false,
    canTower: false, ...overrides });
  const rule = (overrides: Partial<FastBodyState>) => { const verdict = fastJudgment(state(overrides)); return 'decision' in verdict ? verdict.decision.rule : verdict.hold; };
  it('still hides when outnumbered with a creeper 9 m off, and flees it before any fight', () => {
    const zombies = [3, 4, 5].map(distance => ({ name: 'zombie', distance, canReachMe: true, ignited: false }));
    expect(rule({ threats: [...zombies, { name: 'creeper', distance: 9, canReachMe: true, ignited: false }] })).toBe('outnumbered_shelter');
    expect(rule({ threats: [zombies[0]!, { name: 'creeper', distance: 9, canReachMe: true, ignited: false }] })).toBe('creeper_flee');
  });
});

describe('the village mark and the successor of the night retreat', () => {
  it('marks a village search by exploring only (find-structure reads the loaded chunks)', () => {
    const memory = bedSearchMemory(null);
    memory.note({ name: 'mc.find-structure', input: { structureType: 'village' } }, { ok: true, text: '' }, () => null);
    expect(memory.checkpoint().minecraftVillageSearched).toBe(false);
  });
  it('points the night shelter before the retreat, and imports as one new skill', () => {
    const night = minecraftSituation(observation({ time: '15000', margin: undefined }), { failedStepsInARow: 0 });
    expect(minecraftSkillPointers(night, new Set(['mc-night-shelter', 'mc-night-retreat']))[0]).toMatch(/^mc-night-shelter（/u);
    expect(minecraftSkillPointers(night, new Set(['mc-night-retreat']))[0]).toMatch(/^mc-night-retreat（/u);
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => ({ carries: () => false }), tools: () => [] });
    const at = (minutes: number) => new Date(Date.parse('2026-10-20T00:00:00.000Z') + minutes * 60_000).toISOString();
    (['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-6', 'draft-7', 'draft-8'] as const).forEach((revision, index) => {
      const pack = standardSkillPack('legacy-minecraft', revision)!;
      importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'x' }, at(index));
    });
    const plan = importer.dryRun('owner', standardSkillPack('legacy-minecraft', 'draft-9')!);
    expect(plan.problems).toEqual([]);
    expect(plan.capacity.added).toBe(1);
  });
});
