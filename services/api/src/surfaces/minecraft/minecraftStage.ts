import { BED_ITEM, countMatching, type ItemCounts } from './minecraftItems.js';

/**
 * The stage of her Minecraft opening, read from what she carries: the one definition, shared by the skill pointers
 * (`minecraftSkillPointers.ts`, observation redesign P7) and the measurement logs (`minecraftMilestoneLog.ts`, P1). Stateless: it is
 * computed again at every decision from the observation alone, so it can never go stale and nothing of it is stored. The counts come
 * from `carriedItemCounts` (the body's `{name, count}` stacks, `name×count` strings and `slot:*` facts), matched by exact item id.
 * Each stage names one skill, and each skill has the calls that count as acting on it (`adoptionTags`), so that following a skill can
 * be measured beyond the few body tools only it uses. Closed facts and tool names only, never her content.
 */
export type MinecraftStage = 1 | 2 | 3 | 4;

const STONE_TIER_PICKAXE = /^(?:stone|iron|diamond|netherite)_pickaxe$/u;
const IRON_TIER_PICKAXE = /^(?:iron|diamond|netherite)_pickaxe$/u;

/**
 * 1: no stone pickaxe (the early toolchain). 2: a stone pickaxe (or better) and no bed. 3: a bed and no iron pickaxe. 4: an iron
 * pickaxe or better (the Nether path). An iron pickaxe is stage 4 whatever else is missing: the stage never goes back. A golden
 * pickaxe counts for nothing. The pointers read it in the overworld only (null elsewhere); the logs may log the dimension apart.
 */
export function minecraftStage(counts: ItemCounts): MinecraftStage {
  if (countMatching(counts, IRON_TIER_PICKAXE) > 0) return 4;
  if (countMatching(counts, STONE_TIER_PICKAXE) === 0) return 1;
  return countMatching(counts, BED_ITEM) > 0 ? 3 : 2;
}
/** A finished call of hers: the tool and its arguments as she gave them. */
export interface AdoptionCall { name: string; input: unknown }
interface Adoption { tag: string; skills: readonly string[]; matches(call: AdoptionCall): boolean }

const BED = 'mc-bed-before-night', SCOUT = 'mc-opening-scout', IRON = 'mc-iron-and-bucket', TOOLCHAIN = 'mc-early-toolchain', PORTAL = 'mc-nether-portal';
/** The text of one argument, lower-case; undefined when it is not text. */
function argument(call: AdoptionCall, key: string): string | undefined {
  const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, unknown> : null;
  const value = input?.[key];
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}
const tool = (name: string, key: string, test: RegExp) => (call: AdoptionCall) => call.name === name && test.test(argument(call, key) ?? '');
const anyOf = (...tests: Array<(call: AdoptionCall) => boolean>) => (call: AdoptionCall) => tests.some(test => test(call));
const VILLAGE = /village/u, TOOLCHAIN_ITEMS = /^(?:[a-z_]+_planks|stick|crafting_table|wooden_pickaxe|stone_pickaxe|wooden_axe)$/u;
const villageCheck = anyOf(tool('mc.recall-places', 'kind', VILLAGE), tool('mc.find-structure', 'structureType', VILLAGE),
  tool('mc.explore-for-structure', 'structureType', VILLAGE));

/**
 * The calls that count as acting on a skill (a tool and an argument), beyond the tools only it names. Used for the content-free
 * line `Shannon Minecraft stage adoption`: which skill was pointed at the decision, which tag her call matched, never any text.
 * This is the per-skill measure of the pointers. P1's early-game tags (`minecraftAdoptionTags.ts`) and gist predicates (`predicateSkills`)
 * are separate measures over some of the same calls; the two are not merged, and neither changes what she sees.
 */
export const ADOPTIONS: readonly Adoption[] = Object.freeze([
  { tag: 'sheep_search', skills: [BED, SCOUT], matches: tool('mc.find-nearest-entity', 'entityType', /^sheep$/u) },
  { tag: 'village_check', skills: [BED, SCOUT], matches: villageCheck },
  { tag: 'sheep_hunt', skills: [BED], matches: tool('mc.attack-continuously', 'entityName', /^sheep$/u) },
  { tag: 'bed_craft', skills: [BED], matches: tool('mc.craft-one', 'itemName', /^[a-z_]*_bed$/u) },
  { tag: 'bed_sleep', skills: [BED], matches: call => call.name === 'mc.sleep-in-bed' },
  { tag: 'food_hunt', skills: [SCOUT], matches: tool('mc.attack-continuously', 'entityName', /^(?:cow|pig|chicken|sheep|rabbit)$/u) },
  { tag: 'iron_find', skills: [IRON], matches: tool('mc.find-blocks', 'blockName', /iron/u) },
  { tag: 'iron_mine', skills: [IRON], matches: tool('mc.mine-block', 'blockName', /iron/u) },
  { tag: 'iron_smelt', skills: [IRON], matches: tool('mc.start-smelting', 'inputItem', /iron/u) },
  { tag: 'iron_tool_craft', skills: [IRON], matches: tool('mc.craft-one', 'itemName', /^(?:iron_pickaxe|bucket|shield)$/u) },
  { tag: 'iron_armor_craft', skills: [IRON], matches: tool('mc.craft-one', 'itemName', /^iron_(?:helmet|chestplate|leggings|boots)$/u) },
  { tag: 'wood_gather', skills: [TOOLCHAIN], matches: tool('mc.mine-block', 'blockName', /_log$/u) },
  { tag: 'tool_craft', skills: [TOOLCHAIN], matches: tool('mc.craft-one', 'itemName', TOOLCHAIN_ITEMS) },
  { tag: 'stone_mine', skills: [TOOLCHAIN], matches: tool('mc.mine-block', 'blockName', /^(?:stone|cobblestone)$/u) },
  { tag: 'lava_find', skills: [PORTAL], matches: tool('mc.find-blocks', 'blockName', /lava/u) },
  { tag: 'obsidian_mine', skills: [PORTAL], matches: tool('mc.mine-block', 'blockName', /^obsidian$/u) },
  { tag: 'lava_pour', skills: [PORTAL], matches: tool('mc.use-item-on-block', 'itemName', /^lava_bucket$/u) },
  { tag: 'water_pour', skills: [PORTAL], matches: tool('mc.use-item-on-block', 'itemName', /^water_bucket$/u) },
  { tag: 'portal_build', skills: [PORTAL], matches: tool('mc.build-structure', 'structureName', /^nether_portal$/u) },
  { tag: 'portal_enter', skills: [PORTAL], matches: call => call.name === 'mc.enter-portal' },
]);

/** For a call made while the named skills were pointed: each pointed skill and the tag the call matched (none when it matched nothing). */
export function adoptionTags(pointed: readonly string[], call: AdoptionCall): Array<{ skill: string; tag: string }> {
  return ADOPTIONS.filter(adoption => adoption.matches(call)).flatMap(adoption =>
    adoption.skills.filter(skill => pointed.includes(skill)).map(skill => ({ skill, tag: adoption.tag })));
}
