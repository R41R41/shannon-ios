import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
import { SKILL_CAPACITY, SKILL_GIST, SKILL_INDEX_WIDTH, skillGist, skillLint } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { gistToolNames, minecraftSituation, minecraftSkillContext, minecraftSkillPointers, observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { FOOD_STOCK, MILESTONES, adoptionTags, adoptionTools, milestoneLines, milestoneNow, minecraftStage } from '../src/surfaces/minecraft/minecraftStage.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';

/**
 * legacy-minecraft draft-6 and draft-7 (2026-10-19): the procedures from the first day to the dragon, the stages from iron to the
 * diamond pickaxe, and the pointers that name a successor before the skill it replaces.
 */
const FIRST = 'mc-first-day', FOOD_BED = 'mc-food-and-bed', DIAMOND = 'mc-diamond-obsidian', KIT = 'mc-travel-kit', EYES = 'mc-ender-eyes',
  STRONGHOLD = 'mc-stronghold', END = 'mc-end-fight', RETREAT = 'mc-night-retreat';
const NEW = [FIRST, FOOD_BED, DIAMOND, KIT, EYES, STRONGHOLD, END];
const OLD = ['mc-early-toolchain', 'mc-bed-before-night', 'mc-opening-scout', 'mc-iron-and-bucket', 'mc-nether-portal', RETREAT, 'mc-low-health',
  'mc-food-and-pace', 'mc-nether-travel', 'mc-blaze-rods'];
const ALL = new Set([...OLD, ...NEW]), BEFORE = new Set(OLD);
const at = '2026-10-19T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };
// By morning the bed's dusk window (the last ten minutes) is shut, so each stage shows its own pointer alone.
const MORNING = { time: '100', margin: { darkInSeconds: 645 } }, DUSK = { time: '9000', margin: { darkInSeconds: 200 } };
const FED = `cooked_beef×${FOOD_STOCK}`, WOOD = 'oak_planks×12';

const stack = (item: string) => { const [name, count] = item.split('×'); return { name: name!, count: Number(count ?? 1) }; };
const counts = (...items: string[]) => carriedItemCounts({ inventory: items.map(stack) }, {});
const observation = (world: Record<string, unknown>): BodyObservation => {
  const dimension = (world.dimension as string | undefined) ?? 'overworld';
  const inventory = Array.isArray(world.inventory) ? world.inventory.map(item => typeof item === 'string' ? stack(item) : item) : [];
  return { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: at, receivedAt: at, connected: true,
    state: { world: { dimension, health: 20, food: 20, ...MORNING, nearbyThreats: [], ...world, inventory } }, facts: { dimension } } as unknown as BodyObservation;
};
const pointers = (world: Record<string, unknown>, names: ReadonlySet<string> = ALL, pace: Parameters<typeof minecraftSituation>[1] = { failedStepsInARow: 0 }) =>
  minecraftSkillPointers(minecraftSituation(observation(world), pace), names).map(line => line.split('（')[0]);

describe('the stages after iron (diamonds before obsidian), from what she carries', () => {
  it('is 4 with an iron pickaxe and no bucket, 5 with a bucket, 6 with a diamond pickaxe; below 4 as before, with food at stage 3', () => {
    expect(minecraftStage(counts('iron_pickaxe×1'))).toBe(4);
    for (const bucket of ['bucket×1', 'water_bucket×1', 'lava_bucket×1']) expect(minecraftStage(counts('iron_pickaxe×1', bucket, 'iron_helmet×1', 'iron_chestplate×1', 'iron_leggings×1', 'iron_boots×1'))).toBe(5);
    // Run 16: the whole armour before diamonds; the bucket alone, or the chestplate alone, is stage 4.
    expect(minecraftStage(counts('iron_pickaxe×1', 'bucket×1'))).toBe(4);
    expect(minecraftStage(counts('iron_pickaxe×1', 'iron_helmet×1', 'iron_chestplate×1', 'iron_leggings×1', 'iron_boots×1'))).toBe(4);
    expect(minecraftStage(counts('iron_pickaxe×1', 'bucket×1', 'iron_chestplate×1', 'iron_helmet×1'))).toBe(4);
    expect(minecraftStage(counts('diamond_pickaxe×1'))).toBe(6);
    expect(minecraftStage(counts('netherite_pickaxe×1', 'blue_bed×1'))).toBe(6);
    // Stage 3 wants food enough beside the bed: four things she can eat, raw or cooked (`FOOD_STOCK`; six before mb-r23, four in the procedure).
    expect(FOOD_STOCK).toBe(4);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'beef×2', 'bread×1'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'beef×2', 'bread×2'))).toBe(3);
    expect(minecraftStage(counts('stone_pickaxe×1', FED))).toBe(2);
    // With iron in hand three are enough to stay (one meal in the mine does not send her back to the sheep); without, not.
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'bread×3', 'raw_iron×2'))).toBe(3);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'bread×3'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'bread×2', 'iron_ingot×2'))).toBe(2);
    expect(minecraftStage(counts('iron_pickaxe×1', 'milk_bucket×1', 'chainmail_helmet×1', 'chainmail_chestplate×1', 'chainmail_leggings×1', 'chainmail_boots×1'))).toBe(5);
    // Food is not what an iron pickaxe waits for: the stages from 4 never go back below it.
    expect(minecraftStage(counts('iron_pickaxe×1', 'bucket×1', 'diamond_helmet×1', 'diamond_chestplate×1', 'iron_leggings×1', 'netherite_boots×1'))).toBe(5);
    expect(minecraftStage(counts('bucket×1', 'diamond×3'))).toBe(1);
  });
});

describe('the pointers name the draft-6 successor once it can be read, the old skill before', () => {
  it('points each stage at its draft-6 skill', () => {
    expect(pointers({ inventory: ['oak_log×3'] })).toEqual([FIRST]);
    // The bed pointer and the stage-2 pointer are one skill now: named once.
    // Wood enough (run 18: under twelve planks the first day's pointer stays at stage 2, beside it).
    expect(pointers({ inventory: ['stone_pickaxe×1', WOOD] })).toEqual([FOOD_BED]);
    expect(pointers({ inventory: ['stone_pickaxe×1'] })).toEqual([FOOD_BED, FIRST]);
    expect(pointers({ ...DUSK, inventory: ['stone_pickaxe×1', WOOD] })).toEqual([FOOD_BED]);
    expect(pointers({ inventory: ['stone_pickaxe×1', 'white_bed×1', WOOD] })).toEqual([FOOD_BED]);
    expect(pointers({ inventory: ['stone_pickaxe×1', 'white_bed×1', FED] })).toEqual(['mc-iron-and-bucket']);
    expect(pointers({ inventory: ['iron_pickaxe×1', FED] })).toEqual(['mc-iron-and-bucket']);
    expect(pointers({ inventory: ['iron_pickaxe×1', 'bucket×1'] })).toEqual(['mc-iron-and-bucket']);
    expect(pointers({ inventory: ['iron_pickaxe×1', 'bucket×1', 'iron_helmet×1', 'iron_chestplate×1', 'iron_leggings×1', 'iron_boots×1'] })).toEqual([DIAMOND]);
    // Stage 6 (diamond pickaxe): obsidian and the portal, and the kit while a bow, arrows or a carved pumpkin are missing.
    expect(pointers({ inventory: ['diamond_pickaxe×1'] })).toEqual([DIAMOND, KIT]);
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] })).toEqual([DIAMOND]);
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'bow×1', 'arrow×15', 'carved_pumpkin×1'] })).toEqual([DIAMOND, KIT]);
    // After the Nether: no portal pointer.
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] }, ALL, { failedStepsInARow: 0, milestones: { netherReached: true } })).toEqual([]);
  });

  it('is the old skill before draft-6 is imported (the order of code and import does not matter)', () => {
    expect(pointers({ inventory: ['oak_log×3'] }, BEFORE)).toEqual(['mc-early-toolchain']);
    expect(pointers({ inventory: ['stone_pickaxe×1'] }, BEFORE)).toEqual(['mc-bed-before-night', 'mc-opening-scout']);
    expect(pointers({ inventory: ['iron_pickaxe×1', 'bucket×1', 'iron_helmet×1', 'iron_chestplate×1', 'iron_leggings×1', 'iron_boots×1'] }, BEFORE)).toEqual(['mc-nether-portal']);
    expect(pointers({ inventory: ['diamond_pickaxe×1'] }, BEFORE)).toEqual(['mc-nether-portal']);
    expect(pointers({ dimension: 'the_end' }, BEFORE)).toEqual([]);
    // A skill she cannot read is never named, old or new.
    expect(pointers({ inventory: ['stone_pickaxe×1'] }, new Set([RETREAT]))).toEqual([]);
  });

  it('goes on to iron at stage 2 when the sheep search found none today and the food is enough', () => {
    // Searched this morning (645 s before dark) and found none.
    const marked = { failedStepsInARow: 0, noSheepDarkIn: 645 };
    expect(pointers({ inventory: ['stone_pickaxe×1', FED, WOOD] }, ALL, marked)).toEqual(['mc-iron-and-bucket']);
    // Not fed: the food pointer stays beside iron (no animals near must not hold her at stage 2 all day).
    expect(pointers({ inventory: ['stone_pickaxe×1', WOOD] }, ALL, marked)).toEqual([FOOD_BED, 'mc-iron-and-bucket']);
    expect(pointers({ inventory: ['stone_pickaxe×1', FED, WOOD] }, ALL)).toEqual([FOOD_BED]);
  });

  it('points the Nether, the eyes, the stronghold and the End by what she carries and where she is', () => {
    expect(pointers({ dimension: 'the_nether', inventory: ['blaze_rod×7'] })).toEqual(['mc-nether-travel', EYES]);
    expect(pointers({ dimension: 'the_nether', inventory: ['blaze_powder×2', 'ender_eye×12'] })).toEqual(['mc-nether-travel']);
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'blaze_rod×4', 'ender_eye×3', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] }, ALL,
      { failedStepsInARow: 0, milestones: { netherReached: true } })).toEqual([EYES]);
    // Eight eyes are enough to search (throws break some): the stronghold, and the eyes beside it while rods are left.
    const back = { failedStepsInARow: 0, milestones: { netherReached: true } };
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'ender_eye×8', 'blaze_rod×1', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] }, ALL, back)).toEqual([STRONGHOLD, EYES]);
    // Below eight with rods left: the eyes to make; with none left, the stronghold stays while she fills the frames one by one.
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'ender_eye×7', 'blaze_powder×1', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] }, ALL, back)).toEqual([EYES]);
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'ender_eye×2', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] }, ALL, back)).toEqual([STRONGHOLD]);
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'bow×1', 'arrow×32', 'carved_pumpkin×1'] }, ALL, back)).toEqual([]);
    expect(pointers({ inventory: ['diamond_pickaxe×1', 'ender_eye×14', 'bow×1', 'arrow×32'] }, ALL, back)).toEqual([STRONGHOLD, KIT]);
    // The End: the fight, and the dragon is no reason to retreat (nor an enderman); a skeleton still is.
    expect(pointers({ dimension: 'the_end', nearbyThreats: [{ name: 'ender_dragon', distance: 10 }, { name: 'enderman', distance: 3 }] })).toEqual([END]);
    expect(pointers({ dimension: 'the_end', nearbyThreats: [{ name: 'skeleton', distance: 6 }] })).toEqual([RETREAT, END]);
    expect(pointers({ dimension: 'the_end', inventory: ['blaze_rod×2'] })).toEqual([END]);
  });

  it('keeps the safety pointers first and at most three, with the gists of the shown skills only', () => {
    const world = { ...DUSK, health: 6, food: 3, inventory: ['stone_pickaxe×1'] };
    expect(pointers(world)).toEqual(['mc-low-health', FOOD_BED, 'mc-food-and-pace']);
    const context = minecraftSkillContext(minecraftSituation(observation(world), { failedStepsInARow: 0 }), ALL,
      names => new Map(names.map(name => [name, ['2. a', '3. b', '4. c']] as const)));
    expect(context.pointed).toHaveLength(3);
    expect(context.fields.skillGists?.every(gist => gist.steps.length <= SKILL_GIST.lines)).toBe(true);
  });
});

describe('the owner\'s order to the dragon, as the step now and the next', () => {
  // A bed and three meals carried, as at every step past the bed: the bed step is kept until they are (run 17, `kept`), tested apart.
  const SETTLED = ['white_bed×1', 'bread×3'];
  const at = (items: string[], dimension = 'overworld', netherReached = false) => milestoneNow({ counts: counts(...items, ...SETTLED), dimension, netherReached });
  const step = (items: string[], dimension?: string, netherReached?: boolean) => { const { now, next } = at(items, dimension, netherReached); return [now.name, next?.name]; };

  it('lists the owner\'s order from the spawn to the dragon', () => {
    expect(MILESTONES.map(milestone => milestone.name)).toEqual(['スポーン', '木', '木と石のツルハシ', '石の斧', '木材', '食料と羊とベッド', '村の回収', '鉄', 'バケツ', '鉄の全身の防具',
      'ダイヤ', '黒曜石', 'ゲート', 'ネザー', 'ネザー要塞', 'ブレイズ', 'パール', 'アイ', 'エンド要塞', 'ベッドで地点', 'カボチャ', 'エンド', 'クリスタル', 'ドラゴン']);
    expect(MILESTONES.every(milestone => milestone.condition && milestone.why)).toBe(true);
  });

  it('reads the step from what she carries and where she is', () => {
    expect(step([])).toEqual(['木', '木と石のツルハシ']);
    expect(step(['oak_log×3'])).toEqual(['木と石のツルハシ', '石の斧']);
    expect(step(['stone_pickaxe×1'])).toEqual(['石の斧', '木材']);
    expect(step(['stone_pickaxe×1', 'stone_axe×1', 'oak_log×3'])).toEqual(['食料と羊とベッド', '鉄']);
    // The village is optional (not seen from what she carries): the bed and the food lead to iron.
    expect(step(['stone_pickaxe×1', 'stone_axe×1', 'oak_planks×12', 'white_bed×1', FED])).toEqual(['鉄', 'バケツ']);
    // An iron pickaxe passes everything before it while the bed and food hold (without them, the bed step comes back: run 17).
    expect(step(['iron_pickaxe×1'])).toEqual(['バケツ', '鉄の全身の防具']);
    expect(step(['iron_pickaxe×1', 'bucket×1'])).toEqual(['鉄の全身の防具', 'ダイヤ']);
    // Armour made before the bucket passes no bucket.
    expect(step(['iron_pickaxe×1', 'iron_helmet×1', 'iron_chestplate×1', 'iron_leggings×1', 'iron_boots×1'])).toEqual(['バケツ', '鉄の全身の防具']);
    expect(step(['iron_pickaxe×1', 'bucket×1', 'iron_helmet×1', 'iron_chestplate×1', 'iron_leggings×1', 'iron_boots×1'])).toEqual(['ダイヤ', '黒曜石']);
    expect(step(['diamond_pickaxe×1'])).toEqual(['黒曜石', 'ゲート']);
    expect(step(['diamond_pickaxe×1', 'obsidian×10'])).toEqual(['ゲート', 'ネザー']);
    // A carved pumpkin made early is no step ahead: the order holds.
    expect(step(['diamond_pickaxe×1', 'carved_pumpkin×1'])).toEqual(['黒曜石', 'ゲート']);
    expect(step([], 'the_nether', true)).toEqual(['ネザー要塞', 'ブレイズ']);
    expect(step(['blaze_rod×3'], 'the_nether', true)).toEqual(['ブレイズ', 'パール']);
    expect(step(['blaze_rod×6'], 'the_nether', true)).toEqual(['パール', 'アイ']);
    expect(step(['blaze_rod×6', 'ender_pearl×12'], 'overworld', true)).toEqual(['アイ', 'エンド要塞']);
    expect(step(['ender_eye×12'], 'overworld', true)).toEqual(['エンド要塞', 'ベッドで地点']);
    expect(step([], 'the_end', true)).toEqual(['クリスタル', 'ドラゴン']);
  });

  it('does not step back as things are used up, and pearls gathered first pass no blaze rods', () => {
    // The obsidian went into the frame; the flint and steel made to light it keeps the step at the gate.
    expect(step(['diamond_pickaxe×1', 'flint_and_steel×1'])).toEqual(['ゲート', 'ネザー']);
    // Eyes thrown or placed: the rods and pearls they took stay behind her (back in the overworld, the pace's milestone unset).
    expect(step(['ender_eye×5'])).toEqual(['アイ', 'エンド要塞']);
    expect(step(['ender_eye×8'])).toEqual(['エンド要塞', 'ベッドで地点']);
    // Twelve pearls from endermen before any rod: the Nether fortress and the rods are still to come.
    expect(step(['ender_pearl×12'], 'the_nether', true)).toEqual(['ネザー要塞', 'ブレイズ']);
    // Rods carried show the Nether was reached, even when the pace has not said so.
    expect(step(['diamond_pickaxe×1', 'blaze_rod×2'])).toEqual(['ブレイズ', 'パール']);
  });

  it('is two lines of fixed words: the step now with its condition and reason, and the next with its condition', () => {
    const lines = milestoneLines({ counts: counts('diamond_pickaxe×1', ...SETTLED), dimension: 'overworld', netherReached: false });
    expect(lines).toEqual(['今の節目: 黒曜石（条件: obsidian を10個。なぜ: ゲートの枠に最小10個）', '次の節目: ゲート（条件: 枠を建てて火をつけ、入る）']);
    for (const facts of [[], ['stone_pickaxe×1'], ['iron_pickaxe×1'], ['ender_eye×12']]) {
      expect(milestoneLines({ counts: counts(...facts), dimension: 'overworld', netherReached: false }).every(line => [...line].length <= 70)).toBe(true);
    }
    expect(milestoneLines({ counts: counts(), dimension: 'the_end', netherReached: true })).toHaveLength(2);
  });

  it('rides on every decision with an observation, a skill pointed or not, and none without one', () => {
    const calm = minecraftSkillContext(minecraftSituation(observation({ inventory: ['iron_pickaxe×1', 'bucket×1', 'white_bed×1', 'bread×3'], worn: '頭: iron_helmet(残り165/165)、胴: iron_chestplate(残り240/240)、脚: iron_leggings(残り225/225)、足: iron_boots(残り195/195)、左手: なし' }), { failedStepsInARow: 0 }), new Set());
    expect(calm.fields).toEqual({ milestone: ['今の節目: ダイヤ（条件: diamond_pickaxe を持つ。なぜ: 黒曜石はこれでしか掘れない）', '次の節目: 黒曜石（条件: obsidian を10個）'] });
    const pointed = minecraftSkillContext(minecraftSituation(observation({ inventory: ['oak_log×1'] }), { failedStepsInARow: 0 }), ALL);
    expect(pointed.fields.milestone?.[0]).toMatch(/^今の節目: 木と石のツルハシ/u);
    expect(pointed.fields.skillPointers).toHaveLength(1);
    expect(minecraftSkillContext(minecraftSituation(null, { failedStepsInARow: 0 }), ALL).fields).toEqual({});
  });
});

describe('what counts as acting on a draft-6 skill (tool and argument)', () => {
  const tags = (pointed: string[], name: string, input: unknown) => adoptionTags(pointed, { name, input }).map(item => `${item.skill}:${item.tag}`);
  it('matches the first moves of each new skill, only while it is pointed', () => {
    expect(tags([FIRST], 'mc.mine-block', { blockName: 'oak_log', count: 6 })).toEqual([`${FIRST}:wood_gather`]);
    expect(tags([FIRST], 'mc.craft-one', { itemName: 'stone_axe' })).toEqual([`${FIRST}:tool_craft`]);
    expect(tags([FOOD_BED], 'mc.find-nearest-entity', { entityType: 'sheep' })).toEqual([`${FOOD_BED}:sheep_search`]);
    expect(tags([FOOD_BED], 'mc.attack-continuously', { entityName: 'food_animals', maxKills: 4 })).toEqual([`${FOOD_BED}:food_hunt`]);
    expect(tags([FOOD_BED], 'mc.start-smelting', { inputItem: 'beef', fuelItem: 'coal', x: 0, y: 0, z: 0 })).toEqual([`${FOOD_BED}:food_cook`]);
    expect(tags([FOOD_BED], 'mc.withdraw-from-container', { itemName: 'bread' })).toEqual([`${FOOD_BED}:village_loot`]);
    expect(tags([DIAMOND], 'mc.mine-block', { blockName: 'deepslate_diamond_ore' })).toEqual([`${DIAMOND}:diamond_mine`]);
    expect(tags([DIAMOND], 'mc.use-item-on-block', { itemName: 'water_bucket' })).toEqual([`${DIAMOND}:water_pour`]);
    expect(tags([DIAMOND], 'mc.mine-block', { blockName: 'obsidian', count: 10 })).toEqual([`${DIAMOND}:obsidian_mine`]);
    expect(tags([KIT], 'mc.craft-one', { itemName: 'bow' })).toEqual([`${KIT}:kit_craft`]);
    expect(tags([KIT], 'mc.use-item-on-block', { itemName: 'shears' })).toEqual([`${KIT}:pumpkin_carve`]);
    expect(tags([EYES], 'mc.use-item-on-entity', { itemName: 'gold_ingot', entityName: 'piglin', count: 8 })).toEqual([`${EYES}:pearl_barter`]);
    expect(tags([EYES], 'mc.equip-item', { itemName: 'golden_boots', destination: 'feet' })).toEqual([`${EYES}:gold_wear`]);
    expect(tags([STRONGHOLD], 'mc.use-item', { itemName: 'ender_eye' })).toEqual([`${STRONGHOLD}:eye_throw`]);
    expect(tags([STRONGHOLD], 'mc.find-nearest-entity', { entityType: 'eye_of_ender' })).toEqual([`${STRONGHOLD}:eye_track`]);
    expect(tags([STRONGHOLD], 'mc.use-item-on-block', { itemName: 'ender_eye' })).toEqual([`${STRONGHOLD}:frame_fill`]);
    expect(tags([STRONGHOLD], 'mc.activate-block', { blockName: 'white_bed' })).toEqual([`${STRONGHOLD}:spawn_set`]);
    expect(tags([END], 'mc.equip-item', { itemName: 'carved_pumpkin', destination: 'head' })).toEqual([`${END}:pumpkin_wear`]);
    expect(tags([END], 'mc.shoot-bow', { targetName: 'end_crystal', count: 3 })).toEqual([`${END}:crystal_shoot`]);
    expect(tags([END], 'mc.attack-continuously', { entityName: 'ender_dragon' })).toEqual([`${END}:dragon_attack`]);
    // Not pointed, no tag; an unrelated argument, no tag.
    expect(tags([FIRST], 'mc.use-item', { itemName: 'ender_eye' })).toEqual([]);
    expect(tags([END], 'mc.shoot-bow', { targetName: 'zombie' })).toEqual([]);
    expect(tags([EYES], 'mc.use-item', { itemName: 'bread' })).toEqual([]);
  });
});

/** The body catalog's tool names (`Shannon-fresh-world backend/src/services/minebot/instantSkills`, plus `goal-evidence`): only these as `mc.`. */
const REAL_TOOLS = new Set(['mc.mine-block', 'mc.craft-one', 'mc.find-nearest-entity', 'mc.attack-continuously', 'mc.start-smelting', 'mc.sleep-in-bed',
  'mc.find-structure', 'mc.find-blocks', 'mc.check-container', 'mc.withdraw-from-container', 'mc.harvest-crop', 'mc.stair-mine', 'mc.use-item-on-block',
  'mc.build-structure', 'mc.enter-portal', 'mc.recall-places', 'mc.deposit-to-container', 'mc.place-block-at', 'mc.list-inventory-items', 'mc.equip-item',
  'mc.use-item-on-entity', 'mc.pickup-nearest-item', 'mc.use-item', 'mc.move-to', 'mc.list-nearby-entities', 'mc.explore-for-structure', 'mc.activate-block',
  'mc.shoot-bow', 'mc.tower-up', 'mc.goal-evidence', 'mc.dig-shelter', 'mc.leave-water', 'mc.build-around-self']);
const pack6 = () => standardSkillPack('legacy-minecraft', 'draft-6')!, pack7 = () => standardSkillPack('legacy-minecraft', 'draft-7')!;
const body = (name: string) => [...pack6().skills, ...pack7().skills].find(entry => entry.name === name)!.body;
const gistOf = (name: string) => skillGist(body(name), observeOnlyStep);

describe('the draft-6 and draft-7 skills, as the import and the gist read them', () => {
  it('ships seven new skills and one revision of the night retreat, with exact hashes and the Nether milestone on the portal skill', () => {
    expect(pack6().skills.map(entry => entry.name)).toEqual(NEW);
    expect(pack6().skills.every(entry => !entry.revises && skillArtifactSha256(entry.body) === entry.sha256)).toBe(true);
    expect(pack6().skills.find(entry => entry.name === DIAMOND)!.milestone).toBe('nether');
    const base = standardSkillPack('legacy-minecraft', 'draft-2')!.skills.find(entry => entry.name === RETREAT)!;
    expect(pack7().skills).toHaveLength(1);
    expect(pack7().skills[0]!.revises).toEqual({ bodySha256: base.sha256 });
    expect(skillArtifactSha256(pack7().skills[0]!.body)).toBe(pack7().skills[0]!.sha256);
  });

  it.each([...NEW, RETREAT])('%s: how to go on in the numbered steps (the gist, no tool names), the tools apart below them', name => {
    const gist = gistOf(name), text = body(name);
    expect(gist).toHaveLength(SKILL_GIST.lines);
    expect(gist.map(line => line.slice(0, 2))).toEqual(['2.', '3.', '4.']);
    expect(gist.every(line => [...line].length <= SKILL_GIST.width && !line.endsWith('…'))).toBe(true);
    // Short knowledge, as the old notes were (60-120 characters each, 0.7% of them naming a tool): what, in what order, why.
    expect(gist.every(line => [...line].length >= 40)).toBe(true);
    expect(gist.join('')).not.toMatch(/mc\.[a-z]|minecraft\.observe/u);
    expect(gistToolNames(gist).size).toBe(0);
    // Every numbered step says how to go on: no tool name in any of them (the observe step aside).
    const steps = text.split('## 手順')[1]!.split('## 補助')[0]!;
    expect(steps.split('\n').filter(line => /^\d+\./u.test(line) && !line.includes('minecraft.observe')).filter(line => /mc\.[a-z]/u.test(line))).toEqual([]);
    // The tools are named apart, after the steps, as bullets the gist never takes.
    const tools = steps.slice(Math.max(0, steps.indexOf('\n使う道具')));
    expect(steps.indexOf('\n使う道具')).toBeGreaterThan(0);
    expect(tools).toMatch(/mc\.[a-z]/u);
    expect(tools.split('\n').filter(line => /^\d+\./u.test(line))).toEqual([]);
    // A followed gist is recorded by its skill's specific adoption tools (the first day's are all generic: measured by its adoption tags).
    const followed = minecraftSkillContext({ ...minecraftSituation(null, { failedStepsInARow: 0 }), night: true }, new Set([name]),
      names => new Map(names.map(skill => [skill, gistOf(skill)] as const))).gistTools;
    if (name === RETREAT) expect([...followed.get(name)!].sort()).toEqual(['mc.build-around-self', 'mc.dig-shelter', 'mc.leave-water', 'mc.sleep-in-bed', 'mc.stair-mine']);
    // Only tools that say the skill by name alone (no argument read, or no other skill's): the first day's are all shared and generic.
    if (name === FIRST) expect([...adoptionTools(name)]).toEqual([]);
    else expect([...adoptionTools(name)].length).toBeGreaterThan(0);
    for (const shared of ['mc.use-item-on-block', 'mc.find-nearest-entity', 'mc.start-smelting', 'mc.equip-item']) expect(adoptionTools(name).has(shared)).toBe(false);
    expect([...text.matchAll(/mc\.[a-z][a-z-]*/gu)].map(match => match[0]).filter(tool => !REAL_TOOLS.has(tool))).toEqual([]);
    expect(text).not.toMatch(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/u);
    expect(text).toContain('旧Minebot実験');
    expect(text).not.toMatch(/朝まで待つ|回復を待つ/u);
    expect(skillLint(text)).toEqual([]);
    expect([...text.matchAll(/\b(?:study|folder|aether|aetherFolder|ownerDocs|notion|voyager|schedule|places|web|task|memory|skill|minecraft)\.[a-z][a-zA-Z0-9_]*/gu)]
      .map(match => match[0]).filter(tool => tool !== 'minecraft.observe')).toEqual([]);
    expect(`- ${name}（試し）（運用作成）: ${/description: (.*)/u.exec(text)![1]}`.length).toBeLessThanOrEqual(SKILL_INDEX_WIDTH);
  });

  it('says what the old knowledge got wrong or lacked, by the owner\'s order of things', () => {
    // Before night: food and a bed before iron, the sheep first (their meat too), food animals cooked without waiting.
    expect(gistOf(FOOD_BED).join('')).toMatch(/鉄より先に.*食料6個とベッド.*羊3頭.*羊毛3個＋板材3枚.*まとめて狩り.*焼く/u);
    expect(body(FOOD_BED)).toMatch(/チェストは壊さず.*干し草の俵.*小麦9個.*村人とアイアンゴーレムは攻撃しない/u);
    expect(body(FOOD_BED)).toMatch(/mc\.find-nearest-entity（entityType=sheep）.*food_animals.*white_bed.*mc\.check-container → mc\.withdraw-from-container.*hay_block.*mc\.harvest-crop/su);
    // The first day: wood, wooden and stone tools, the stone axe, how much wood.
    expect(gistOf(FIRST).join('')).toMatch(/最初は木.*原木を6本.*木のツルハシ（板3＋棒2）.*石のツルハシと石の斧/u);
    expect(body(FIRST)).toMatch(/原木1本で板4枚.*作業台に板4.*ベッドに板3.*チェストに板8/u);
    // Obsidian: a diamond pickaxe only, at least ten, water on a lava source; diamonds before it.
    expect(gistOf(DIAMOND).join('')).toMatch(/次はダイヤ.*高さ -54.*鉄のツルハシで掘る.*黒曜石はダイヤのツルハシでしか掘れない.*最小10個.*溶岩源.*水をかけて/u);
    expect(body(DIAMOND)).toMatch(/mc\.stair-mine（targetY=-54）.*obsidian、count=10.*itemName=water_bucket.*structureName=nether_portal/su);
    expect(body(DIAMOND)).toMatch(/8マス/u);
    // The kit: bow from string, arrows from flint, feather and stick, a carved pumpkin with shears, inventory and a spare pickaxe.
    expect(body(KIT)).toMatch(/矢32本以上.*糸3＋棒3.*火打石・棒・羽根.*ハサミ.*チェストへ預ける.*予備のツルハシ/su);
    expect(body(KIT)).toMatch(/itemName=shears.*mc\.deposit-to-container/su);
    // Pearls: piglins for gold with gold armour on, or endermen; no boat; the Nether's eighth and its beds.
    expect(gistOf(EYES).join('')).toMatch(/12＋投げる分で15.*ピグリン.*金の防具を1つ着けてから金インゴット.*エンダーマン.*ボートは使わない/u);
    expect(body(EYES)).toMatch(/golden_boots、destination=feet.*gold_ingot、entityName=piglin.*entityName=enderman/su);
    expect(body(EYES)).toMatch(/ネザーの1マスはオーバーワールドの8マス.*ベッドを使うと爆発する/u);
    // Triangulation: two throws 50-100 m apart, 400-500 m legs, a search within 64 m; the eye read by find-nearest-entity.
    expect(gistOf(STRONGHOLD).join('')).toMatch(/50〜100m離れた2地点.*交わる所.*400〜500m.*64m以内.*スポナー/u);
    expect(body(STRONGHOLD)).toMatch(/mc\.find-nearest-entity（entityType=eye_of_ender）.*結果に方角があればそれを使う/su);
    expect(body(STRONGHOLD)).toMatch(/end_portal_frame.*mc\.use-item-on-block（枠の座標、itemName=ender_eye）/su);
    expect(body(STRONGHOLD)).toMatch(/昼でも決まり.*mc\.activate-block/su);
    // The End: pumpkin on the head, crystals first (they heal it) from afar, caged ones climbed; the dragon perches now and then.
    expect(gistOf(END).join('')).toMatch(/くり抜いたカボチャを頭.*回復の元なので先に壊す.*近くで叩くと爆発.*檻つき.*時々中央の台.*近接で叩く.*最後は近接/u);
    expect(body(END)).toMatch(/虚空に落ちない.*ベッドを使うと爆発/su);
    expect(body(END)).toMatch(/carved_pumpkin、destination=head.*targetName=end_crystal.*mc\.tower-up.*entityName=ender_dragon/su);
    // The night: the bed if she has one, else the shelter at once, then down to mine.
    expect(gistOf(RETREAT).join('')).toMatch(/ベッドがあり.*寝て夜を飛ばす.*ベッドが無ければ.*すぐ縦穴.*地下へ下り/u);
  });
});

describe('the import of draft-6 into a production of 24 skills, and draft-7 apart from it', () => {
  function production() {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    const apply = (pack: SkillPack, when: string) => importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'owner-form-20261019' }, when);
    (['draft-1', 'draft-2', 'draft-3', 'draft-4'] as const).forEach((revision, index) => apply(standardSkillPack('legacy-minecraft', revision)!, later(index)));
    // Twelve stand-ins make the 24 of production (audit K-19).
    const bodies = Array.from({ length: 12 }, (_, index) => ({ name: `filler-${index}`,
      body: `---\nname: filler-${index}\ndescription: 場を埋める\n---\n\n## 手順\n1. 何もしない。\n\n## 補助\nなし\n\n## 参考\nなし\n` }));
    apply({ schemaVersion: 1, packId: 'filler', revision: 'draft-1', sourceAuthor: 'test', sourceReference: 'test://filler', referenceRevision: 'abcdef1',
      validatorRevision: 'skill-import-v1', skills: bodies.map(entry => ({ ...entry, sha256: skillArtifactSha256(entry.body), tools: [] })) }, later(5));
    return { memory, importer, apply };
  }

  it('fits 24 + 7 in the capacity of 32, even when the old skills are on trial (no revision in it)', () => {
    const { memory, importer, apply } = production();
    expect(memory.store.all('owner')).toHaveLength(24);
    for (const name of ['mc-bed-before-night', 'mc-early-toolchain', 'mc-nether-portal', RETREAT]) memory.usedInTask('owner', fcaSkillTaskKey('run-15'), name, later(6), 'gist');
    const plan = importer.dryRun('owner', pack6());
    expect(plan.problems).toEqual([]);
    expect(plan.capacity).toEqual({ used: 24, added: 7, limit: SKILL_CAPACITY });
    expect(apply(pack6(), later(7))).toHaveProperty('receipt');
    const index = memory.index('owner');
    expect(index.split('\n')[0]).toContain('31/32');
    for (const name of NEW) expect(memory.store.byName('owner', name)).toMatchObject({ status: 'trial', madeBy: 'operator_authored', uses: [] });
    expect(index.split('\n').every(line => [...line].length <= SKILL_INDEX_WIDTH)).toBe(true);
    // The night retreat was used: its revision (draft-7) stops alone, draft-6 is in.
    expect(importer.dryRun('owner', pack7()).problems).toEqual([{ name: RETREAT, code: 'on_trial' }]);
  });

  it('revises the night retreat while unused, from its exact draft-2 body, adding no skill', () => {
    const { memory, importer, apply } = production();
    const before = memory.store.byName('owner', RETREAT)!;
    const plan = importer.dryRun('owner', pack7());
    expect(plan.problems).toEqual([]);
    expect(plan.capacity.added).toBe(0);
    expect(apply(pack7(), later(7))).toHaveProperty('receipt');
    expect(memory.store.byName('owner', RETREAT)).toMatchObject({ skillId: before.skillId, version: before.version + 1 });
    expect(apply(pack6(), later(8))).toHaveProperty('receipt');
  });
});
