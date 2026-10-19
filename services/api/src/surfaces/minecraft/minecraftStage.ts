import { BED_ITEM, EDIBLE_FOOD, countMatching, type ItemCounts } from './minecraftItems.js';

/**
 * The stage of her Minecraft opening, read from what she carries: the one definition, shared by the skill pointers
 * (`minecraftSkillPointers.ts`, observation redesign P7) and the measurement logs (`minecraftMilestoneLog.ts`, P1). Stateless: it is
 * computed again at every decision from the observation alone, so it can never go stale and nothing of it is stored. The counts come
 * from `carriedItemCounts` (the body's `{name, count}` stacks, `name×count` strings and `slot:*` facts), matched by exact item id.
 * Each stage names one skill, and each skill has the calls that count as acting on it (`adoptionTags`), so that following a skill can
 * be measured beyond the few body tools only it uses. Closed facts and tool names only, never her content.
 */
export type MinecraftStage = 1 | 2 | 3 | 4 | 5 | 6;

const STONE_TIER_PICKAXE = /^(?:stone|iron|diamond|netherite)_pickaxe$/u;
const IRON_TIER_PICKAXE = /^(?:iron|diamond|netherite)_pickaxe$/u;
const DIAMOND_TIER_PICKAXE = /^(?:diamond|netherite)_pickaxe$/u;
/** An empty bucket or a full one: the cast of obsidian needs water, and a lava or milk bucket was an empty one. */
export const BUCKET_ITEM = /^(?:bucket|water_bucket|lava_bucket|milk_bucket)$/u;
/**
 * Food enough to go on to iron (owner 2026-10-19, Minecraft run 15: at night with no food and no bed she died four times to zombies):
 * six items she can eat, raw or cooked. Below it the opening stays at stage 2, the food and the bed, whatever else she carries.
 * Once iron is in hand (ore or ingots, before the pickaxe) `FOOD_KEPT` is enough, so that one meal in the mine does not send her back
 * to the sheep: the stage is stateless, and the iron she carries stands for "already on to iron".
 */
export const FOOD_STOCK = 6, FOOD_KEPT = 3;
const IRON_IN_HAND = /^(?:raw_iron|iron_ingot|(?:deepslate_)?iron_ore)$/u;

/**
 * 1: no stone pickaxe (the first day). 2: a stone pickaxe (or better) and no bed or less than `FOOD_STOCK` food. 3: a bed and food,
 * no iron pickaxe. 4: an iron pickaxe and no bucket. 5: a bucket and no diamond pickaxe (diamonds). 6: a diamond pickaxe or better
 * (obsidian and the portal; obsidian is mined with nothing less). An iron pickaxe is stage 4 or more whatever else is missing: the
 * stage never goes back past it, and the stages below 4 keep their meaning (before iron) for the measurement logs. A golden pickaxe
 * counts for nothing. The pointers read it in the overworld only (null elsewhere); the logs may log the dimension apart.
 */
export function minecraftStage(counts: ItemCounts): MinecraftStage {
  if (countMatching(counts, DIAMOND_TIER_PICKAXE) > 0) return 6;
  if (countMatching(counts, IRON_TIER_PICKAXE) > 0) return countMatching(counts, BUCKET_ITEM) > 0 ? 5 : 4;
  if (countMatching(counts, STONE_TIER_PICKAXE) === 0) return 1;
  return countMatching(counts, BED_ITEM) > 0 && fed(counts) ? 3 : 2;
}
/** Food enough to leave the food and the bed for iron (`FOOD_STOCK`), or to stay with it once iron is in hand (`FOOD_KEPT`). */
export function fed(counts: ItemCounts): boolean {
  const food = countMatching(counts, EDIBLE_FOOD);
  return food >= FOOD_STOCK || (food >= FOOD_KEPT && countMatching(counts, IRON_IN_HAND) > 0);
}
/** A finished call of hers: the tool and its arguments as she gave them. */
export interface AdoptionCall { name: string; input: unknown }
interface Adoption { tag: string; skills: readonly string[]; matches(call: AdoptionCall): boolean }

const BED = 'mc-bed-before-night', SCOUT = 'mc-opening-scout', IRON = 'mc-iron-and-bucket', TOOLCHAIN = 'mc-early-toolchain', PORTAL = 'mc-nether-portal';
// legacy-minecraft draft-6 (2026-10-19): the successors of the four above and the path from diamonds to the dragon.
const FIRST_DAY = 'mc-first-day', FOOD_BED = 'mc-food-and-bed', DIAMOND = 'mc-diamond-obsidian', KIT = 'mc-travel-kit', EYES = 'mc-ender-eyes',
  STRONGHOLD = 'mc-stronghold', END = 'mc-end-fight';
/** The text of one argument, lower-case; undefined when it is not text. */
function argument(call: AdoptionCall, key: string): string | undefined {
  const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, unknown> : null;
  const value = input?.[key];
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}
const tool = (name: string, key: string, test: RegExp) => (call: AdoptionCall) => call.name === name && test.test(argument(call, key) ?? '');
const anyOf = (...tests: Array<(call: AdoptionCall) => boolean>) => (call: AdoptionCall) => tests.some(test => test(call));
const VILLAGE = /village/u, TOOLCHAIN_ITEMS = /^(?:[a-z_]+_planks|stick|crafting_table|wooden_pickaxe|stone_pickaxe|wooden_axe|stone_axe|stone_sword)$/u;
const villageCheck = anyOf(tool('mc.recall-places', 'kind', VILLAGE), tool('mc.find-structure', 'structureType', VILLAGE),
  tool('mc.explore-for-structure', 'structureType', VILLAGE));
const STRONGHOLD_TYPE = /^stronghold$/u, RAW_FOOD = /^(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/u;
const named = (name: string) => (call: AdoptionCall) => call.name === name;

/**
 * The calls that count as acting on a skill (a tool and an argument), beyond the tools only it names. Used for the content-free
 * line `Shannon Minecraft stage adoption`: which skill was pointed at the decision, which tag her call matched, never any text.
 * This is the per-skill measure of the pointers. P1's early-game tags (`minecraftAdoptionTags.ts`) and gist predicates (`predicateSkills`)
 * are separate measures over some of the same calls; the two are not merged, and neither changes what she sees.
 */
export const ADOPTIONS: readonly Adoption[] = Object.freeze([
  { tag: 'sheep_search', skills: [BED, SCOUT, FOOD_BED], matches: tool('mc.find-nearest-entity', 'entityType', /^sheep$/u) },
  { tag: 'village_check', skills: [BED, SCOUT, FOOD_BED, FIRST_DAY], matches: villageCheck },
  { tag: 'sheep_hunt', skills: [BED, FOOD_BED], matches: tool('mc.attack-continuously', 'entityName', /^sheep$/u) },
  { tag: 'bed_craft', skills: [BED, FOOD_BED], matches: tool('mc.craft-one', 'itemName', /^[a-z_]*_bed$/u) },
  { tag: 'bed_sleep', skills: [BED, FOOD_BED], matches: named('mc.sleep-in-bed') },
  { tag: 'food_hunt', skills: [SCOUT, FOOD_BED], matches: tool('mc.attack-continuously', 'entityName', /^(?:cow|pig|chicken|sheep|rabbit|food_animals)$/u) },
  { tag: 'food_cook', skills: [FOOD_BED], matches: tool('mc.start-smelting', 'inputItem', RAW_FOOD) },
  { tag: 'village_loot', skills: [FOOD_BED], matches: anyOf(named('mc.check-container'), named('mc.withdraw-from-container')) },
  { tag: 'village_food', skills: [FOOD_BED], matches: anyOf(named('mc.harvest-crop'), tool('mc.mine-block', 'blockName', /^hay_block$/u)) },
  { tag: 'iron_find', skills: [IRON], matches: tool('mc.find-blocks', 'blockName', /iron/u) },
  { tag: 'iron_mine', skills: [IRON], matches: tool('mc.mine-block', 'blockName', /iron/u) },
  { tag: 'iron_smelt', skills: [IRON], matches: tool('mc.start-smelting', 'inputItem', /iron/u) },
  { tag: 'iron_tool_craft', skills: [IRON], matches: tool('mc.craft-one', 'itemName', /^(?:iron_pickaxe|bucket|shield)$/u) },
  { tag: 'iron_armor_craft', skills: [IRON], matches: tool('mc.craft-one', 'itemName', /^iron_(?:helmet|chestplate|leggings|boots)$/u) },
  { tag: 'wood_gather', skills: [TOOLCHAIN, FIRST_DAY], matches: tool('mc.mine-block', 'blockName', /_log$/u) },
  { tag: 'tool_craft', skills: [TOOLCHAIN, FIRST_DAY], matches: tool('mc.craft-one', 'itemName', TOOLCHAIN_ITEMS) },
  { tag: 'stone_mine', skills: [TOOLCHAIN, FIRST_DAY], matches: tool('mc.mine-block', 'blockName', /^(?:stone|cobblestone)$/u) },
  { tag: 'diamond_descend', skills: [DIAMOND], matches: named('mc.stair-mine') },
  { tag: 'diamond_find', skills: [DIAMOND], matches: tool('mc.find-blocks', 'blockName', /diamond/u) },
  { tag: 'diamond_mine', skills: [DIAMOND], matches: tool('mc.mine-block', 'blockName', /diamond_ore$/u) },
  { tag: 'diamond_tool_craft', skills: [DIAMOND], matches: tool('mc.craft-one', 'itemName', /^(?:diamond_pickaxe|flint_and_steel)$/u) },
  { tag: 'lava_find', skills: [PORTAL, DIAMOND], matches: tool('mc.find-blocks', 'blockName', /lava/u) },
  { tag: 'obsidian_mine', skills: [PORTAL, DIAMOND], matches: tool('mc.mine-block', 'blockName', /^obsidian$/u) },
  { tag: 'lava_pour', skills: [PORTAL], matches: tool('mc.use-item-on-block', 'itemName', /^lava_bucket$/u) },
  { tag: 'water_pour', skills: [PORTAL, DIAMOND], matches: tool('mc.use-item-on-block', 'itemName', /^water_bucket$/u) },
  { tag: 'portal_build', skills: [PORTAL, DIAMOND], matches: tool('mc.build-structure', 'structureName', /^nether_portal$/u) },
  { tag: 'portal_enter', skills: [PORTAL, DIAMOND], matches: named('mc.enter-portal') },
  { tag: 'kit_craft', skills: [KIT], matches: tool('mc.craft-one', 'itemName', /^(?:bow|arrow|shears|chest)$/u) },
  { tag: 'pumpkin_carve', skills: [KIT], matches: tool('mc.use-item-on-block', 'itemName', /^shears$/u) },
  { tag: 'kit_deposit', skills: [KIT], matches: named('mc.deposit-to-container') },
  { tag: 'kit_durability', skills: [KIT], matches: named('mc.list-inventory-items') },
  { tag: 'gold_wear', skills: [EYES], matches: tool('mc.equip-item', 'itemName', /^golden_(?:helmet|chestplate|leggings|boots)$/u) },
  { tag: 'pearl_barter', skills: [EYES], matches: tool('mc.use-item-on-entity', 'itemName', /^gold_ingot$/u) },
  { tag: 'enderman_hunt', skills: [EYES], matches: tool('mc.attack-continuously', 'entityName', /^enderman$/u) },
  { tag: 'eye_craft', skills: [EYES], matches: tool('mc.craft-one', 'itemName', /^(?:blaze_powder|ender_eye)$/u) },
  { tag: 'eye_throw', skills: [STRONGHOLD], matches: tool('mc.use-item', 'itemName', /^ender_eye$/u) },
  { tag: 'eye_track', skills: [STRONGHOLD], matches: tool('mc.find-nearest-entity', 'entityType', /^eye_of_ender$/u) },
  { tag: 'stronghold_find', skills: [STRONGHOLD], matches: anyOf(tool('mc.find-structure', 'structureType', STRONGHOLD_TYPE),
    tool('mc.explore-for-structure', 'structureType', STRONGHOLD_TYPE)) },
  { tag: 'spawner_break', skills: [STRONGHOLD], matches: tool('mc.mine-block', 'blockName', /^spawner$/u) },
  { tag: 'frame_fill', skills: [STRONGHOLD], matches: tool('mc.use-item-on-block', 'itemName', /^ender_eye$/u) },
  { tag: 'spawn_set', skills: [STRONGHOLD], matches: tool('mc.activate-block', 'blockName', /^[a-z_]*_bed$/u) },
  { tag: 'pumpkin_wear', skills: [END], matches: tool('mc.equip-item', 'itemName', /^carved_pumpkin$/u) },
  { tag: 'crystal_shoot', skills: [END], matches: tool('mc.shoot-bow', 'targetName', /^end_crystal$/u) },
  { tag: 'pillar_climb', skills: [END], matches: named('mc.tower-up') },
  { tag: 'dragon_attack', skills: [END], matches: tool('mc.attack-continuously', 'entityName', /^ender_dragon$/u) },
]);

/** For a call made while the named skills were pointed: each pointed skill and the tag the call matched (none when it matched nothing). */
export function adoptionTags(pointed: readonly string[], call: AdoptionCall): Array<{ skill: string; tag: string }> {
  return ADOPTIONS.filter(adoption => adoption.matches(call)).flatMap(adoption =>
    adoption.skills.filter(skill => pointed.includes(skill)).map(skill => ({ skill, tag: adoption.tag })));
}
