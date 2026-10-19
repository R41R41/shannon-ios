import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
import { SKILL_CAPACITY, SKILL_GIST, SKILL_INDEX_WIDTH, skillGist, skillLint } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { gistToolNames, minecraftSituation, minecraftSkillContext, minecraftSkillPointers, observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { FOOD_STOCK, adoptionTags, minecraftStage } from '../src/surfaces/minecraft/minecraftStage.js';
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
const FED = `cooked_beef×${FOOD_STOCK}`;

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
    for (const bucket of ['bucket×1', 'water_bucket×1', 'lava_bucket×1']) expect(minecraftStage(counts('iron_pickaxe×1', bucket))).toBe(5);
    expect(minecraftStage(counts('diamond_pickaxe×1'))).toBe(6);
    expect(minecraftStage(counts('netherite_pickaxe×1', 'blue_bed×1'))).toBe(6);
    // Stage 3 wants food enough beside the bed: six things she can eat, raw or cooked.
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'beef×3', 'bread×2'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'beef×3', 'bread×3'))).toBe(3);
    expect(minecraftStage(counts('stone_pickaxe×1', FED))).toBe(2);
    // With iron in hand three are enough to stay (one meal in the mine does not send her back to the sheep); without, not.
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'bread×3', 'raw_iron×2'))).toBe(3);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'bread×3'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1', 'bread×2', 'iron_ingot×2'))).toBe(2);
    expect(minecraftStage(counts('iron_pickaxe×1', 'milk_bucket×1'))).toBe(5);
    // Food is not what an iron pickaxe waits for: the stages from 4 never go back below it.
    expect(minecraftStage(counts('iron_pickaxe×1', 'bucket×1'))).toBe(5);
    expect(minecraftStage(counts('bucket×1', 'diamond×3'))).toBe(1);
  });
});

describe('the pointers name the draft-6 successor once it can be read, the old skill before', () => {
  it('points each stage at its draft-6 skill', () => {
    expect(pointers({ inventory: ['oak_log×3'] })).toEqual([FIRST]);
    // The bed pointer and the stage-2 pointer are one skill now: named once.
    expect(pointers({ inventory: ['stone_pickaxe×1'] })).toEqual([FOOD_BED]);
    expect(pointers({ ...DUSK, inventory: ['stone_pickaxe×1'] })).toEqual([FOOD_BED]);
    expect(pointers({ inventory: ['stone_pickaxe×1', 'white_bed×1'] })).toEqual([FOOD_BED]);
    expect(pointers({ inventory: ['stone_pickaxe×1', 'white_bed×1', FED] })).toEqual(['mc-iron-and-bucket']);
    expect(pointers({ inventory: ['iron_pickaxe×1', FED] })).toEqual(['mc-iron-and-bucket']);
    expect(pointers({ inventory: ['iron_pickaxe×1', 'bucket×1'] })).toEqual([DIAMOND]);
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
    expect(pointers({ inventory: ['iron_pickaxe×1', 'bucket×1'] }, BEFORE)).toEqual(['mc-nether-portal']);
    expect(pointers({ inventory: ['diamond_pickaxe×1'] }, BEFORE)).toEqual(['mc-nether-portal']);
    expect(pointers({ dimension: 'the_end' }, BEFORE)).toEqual([]);
    // A skill she cannot read is never named, old or new.
    expect(pointers({ inventory: ['stone_pickaxe×1'] }, new Set([RETREAT]))).toEqual([]);
  });

  it('goes on to iron at stage 2 when the sheep search found none today and the food is enough', () => {
    // Searched this morning (645 s before dark) and found none.
    const marked = { failedStepsInARow: 0, noSheepDarkIn: 645 };
    expect(pointers({ inventory: ['stone_pickaxe×1', FED] }, ALL, marked)).toEqual(['mc-iron-and-bucket']);
    // Not fed: the food pointer stays beside iron (no animals near must not hold her at stage 2 all day).
    expect(pointers({ inventory: ['stone_pickaxe×1'] }, ALL, marked)).toEqual([FOOD_BED, 'mc-iron-and-bucket']);
    expect(pointers({ inventory: ['stone_pickaxe×1', FED] }, ALL)).toEqual([FOOD_BED]);
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

  it.each([...NEW, RETREAT])('%s: a gist of three whole lines within 90 characters whose first line names a body tool with its arguments', name => {
    const gist = gistOf(name), text = body(name);
    expect(gist).toHaveLength(SKILL_GIST.lines);
    expect(gist.map(line => line.slice(0, 2))).toEqual(['2.', '3.', '4.']);
    expect(gist.every(line => [...line].length <= SKILL_GIST.width && !line.endsWith('…'))).toBe(true);
    expect(gist.join('')).not.toContain('minecraft.observe');
    // The first move is a tool and its arguments (run 14: a gist shown 13 times, the skill never opened): in the first two lines.
    // A tool that takes no argument (the bed, the shelter) is named alone.
    expect(gist.slice(0, 2).join('')).toMatch(/mc\.[a-z-]+（[^）]+）|mc\.(?:sleep-in-bed|dig-shelter)\b/u);
    // A followed gist is recorded by a tool only it names; the first day's are all generic (wood, crafting), measured by its adoption tags.
    if (name === FIRST) expect(gistToolNames(gist).size).toBe(0);
    else expect(gistToolNames(gist).size).toBeGreaterThan(0);
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
    // Before night: food and a bed, the sheep first, food animals, the village taken from without breaking chests or hurting villagers.
    expect(gistOf(FOOD_BED).join('')).toMatch(/mc\.find-nearest-entity（entityType=sheep）.*maxKills=3.*white_bed.*food_animals/u);
    expect(body(FOOD_BED)).toMatch(/チェストは壊さず.*mc\.check-container.*mc\.withdraw-from-container.*hay_block.*mc\.harvest-crop.*村人とアイアンゴーレムは攻撃しない/su);
    // The first day: wood, wooden and stone tools, the stone axe, how much wood.
    expect(gistOf(FIRST).join('')).toMatch(/mc\.mine-block（blockName=.*oak_log.*wooden_pickaxe.*stone_pickaxe と stone_axe/u);
    expect(body(FIRST)).toMatch(/原木1本で板4枚.*作業台に板4.*ベッドに板3.*チェストに板8/u);
    // Obsidian: a diamond pickaxe only, at least ten, water on a lava source; diamonds before it.
    expect(gistOf(DIAMOND).join('')).toMatch(/diamond_ore.*黒曜石は diamond_pickaxe（ダイヤ3＋棒2）でしか掘れない.*water_bucket.*obsidian、count=10.*nether_portal/u);
    expect(body(DIAMOND)).toMatch(/ゲートは最小10個/u);
    expect(body(DIAMOND)).toMatch(/溶岩源.*water_bucket.*黒曜石に変える/su);
    expect(body(DIAMOND)).toMatch(/8マス/u);
    // The kit: bow from string, arrows from flint, feather and stick, a carved pumpkin with shears, inventory and a spare pickaxe.
    expect(body(KIT)).toMatch(/糸3＋棒3.*火打石＋棒＋羽根.*shears.*mc\.deposit-to-container.*予備のツルハシ/su);
    // Pearls: piglins for gold with gold armour on, or endermen; no boat; the Nether's eighth and its beds.
    expect(gistOf(EYES).join('')).toMatch(/golden_boots、destination=feet.*gold_ingot、entityName=piglin/u);
    expect(body(EYES)).toMatch(/entityName=enderman/u);
    expect(body(EYES)).toContain('ボートは使わない');
    expect(body(EYES)).toMatch(/ネザーの1マスはオーバーワールドの8マス.*ベッドを使うと爆発する/u);
    // Triangulation: two throws 50-100 m apart, the eye's position read by find-nearest-entity, 400-500 m legs, find-structure within 64 m.
    expect(gistOf(STRONGHOLD).join('')).toMatch(/ender_eye.*mc\.find-nearest-entity（eye_of_ender）.*50〜100m.*400〜500m.*64m以内.*stronghold/u);
    expect(body(STRONGHOLD)).toMatch(/結果に方角があればそれ/u);
    expect(body(STRONGHOLD)).toMatch(/spawner.*end_portal_frame.*mc\.use-item-on-block（itemName=ender_eye）/su);
    expect(body(STRONGHOLD)).toMatch(/mc\.activate-block.*昼でも地点が決まり/su);
    // The End: pumpkin on the head, crystals from afar, caged ones climbed, the dragon in melee, the void.
    expect(gistOf(END).join('')).toMatch(/carved_pumpkin、destination=head.*end_crystal.*近くで叩くと爆発.*mc\.tower-up.*iron_bars/u);
    expect(body(END)).toMatch(/ender_dragon.*最後は近接で叩く.*虚空に落ちない.*ベッドを使うと爆発/su);
    // The dragon perches now and then, crystals or not: they heal it, so they go first (not "all crystals, then it lands").
    expect(body(END)).toMatch(/回復の元なので先に壊す.*時々中央の台/u);
    // The night: the bed if she has one, else the shelter at once.
    expect(gistOf(RETREAT).join('')).toMatch(/mc\.sleep-in-bed.*ベッドが無ければ.*mc\.dig-shelter.*mc\.stair-mine/u);
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
