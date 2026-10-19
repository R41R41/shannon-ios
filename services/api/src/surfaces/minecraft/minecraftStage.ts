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
 * The four pieces of iron armour or better, carried or worn (`carriedItemCounts` reads `world.worn`): the armour before diamonds
 * (owner 2026-10-19, Minecraft run 16: with eleven iron she made the pickaxe and the bucket only, went down for diamonds at night
 * with no armour and a zombie took her from 15.7 to 0.7 health in 16 s; the owner then asked for the whole set, not the chestplate
 * alone). Chainmail is found, never made, and nearly as good. A full set of iron is 15 points: about 60% less damage taken.
 */
export const ARMOR_PIECES: readonly RegExp[] = Object.freeze(['helmet', 'chestplate', 'leggings', 'boots']
  .map(piece => new RegExp(`^(?:chainmail|iron|diamond|netherite)_${piece}$`, 'u')));
/** Every piece of `ARMOR_PIECES` carried or worn. */
export const fullArmor = (counts: ItemCounts) => ARMOR_PIECES.every(piece => countMatching(counts, piece) > 0);
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
 * no iron pickaxe. 4: an iron pickaxe and no bucket or not the whole armour (`fullArmor`, run 16). 5: a bucket and the whole
 * armour and no diamond pickaxe (diamonds). 6: a diamond pickaxe or better
 * (obsidian and the portal; obsidian is mined with nothing less). An iron pickaxe is stage 4 or more whatever else is missing: the
 * stage never goes back past it, and the stages below 4 keep their meaning (before iron) for the measurement logs. A golden pickaxe
 * counts for nothing. The pointers read it in the overworld only (null elsewhere); the logs may log the dimension apart.
 */
export function minecraftStage(counts: ItemCounts): MinecraftStage {
  if (countMatching(counts, DIAMOND_TIER_PICKAXE) > 0) return 6;
  if (countMatching(counts, IRON_TIER_PICKAXE) > 0) return countMatching(counts, BUCKET_ITEM) > 0 && fullArmor(counts) ? 5 : 4;
  if (countMatching(counts, STONE_TIER_PICKAXE) === 0) return 1;
  return countMatching(counts, BED_ITEM) > 0 && fed(counts) ? 3 : 2;
}
/** Food enough to leave the food and the bed for iron (`FOOD_STOCK`), or to stay with it once iron is in hand (`FOOD_KEPT`). */
export function fed(counts: ItemCounts): boolean {
  const food = countMatching(counts, EDIBLE_FOOD);
  return food >= FOOD_STOCK || (food >= FOOD_KEPT && countMatching(counts, IRON_IN_HAND) > 0);
}
/** What a milestone is read from: what she carries, where she is, and whether she has been to the Nether (the pace's milestone). */
export interface MilestoneFacts {
  counts: ItemCounts; dimension: string; netherReached: boolean;
  /** A respawn bed of hers is set and remembered (`world.rememberedPlaces.respawn`): her bed stands, though she does not carry it. */
  bedPlaced?: boolean;
}
/**
 * One step of the owner's order to the dragon (owner 2026-10-19): its name, when it is reached (`done`, from `MilestoneFacts`), the
 * condition and the reason in fixed words. `anchor`: a step that cannot be reached early by chance (it holds what comes before it),
 * so every step before it counts as passed. `done` null: not seen from what she carries; `optional` ones are skipped, the others
 * stay the step until a later anchor is reached.
 */
export interface Milestone {
  name: string; condition: string; why: string; done: ((facts: MilestoneFacts) => boolean) | null; anchor?: boolean; optional?: boolean;
  /**
   * Not passed by a later anchor while it is open, in the overworld before the Nether (owner 2026-10-19, Minecraft run 17: the iron
   * pickaxe at D24 passed the bed and the food, and the bed did not come back as the step until D45). The function says whether it
   * holds well enough to be left behind: a meal or two eaten later does not bring it back.
   */
  kept?: (facts: MilestoneFacts) => boolean;
}
const has = (facts: MilestoneFacts, pattern: RegExp, least = 1) => countMatching(facts.counts, pattern) >= least;
const sum = (facts: MilestoneFacts, ...weighted: Array<[RegExp, number]>) =>
  weighted.reduce((total, [pattern, weight]) => total + countMatching(facts.counts, pattern) * weight, 0);
const EYE = /^ender_eye$/u, BLAZE = /^blaze_(?:rod|powder)$/u;
/** Been to the Nether: the pace's milestone (set by `mc.goal-evidence`), being there or past it, or carrying what only it gives. */
const nether = (facts: MilestoneFacts) => facts.netherReached || facts.dimension === 'the_nether' || facts.dimension === 'the_end'
  || has(facts, BLAZE) || has(facts, EYE);
/** An eye made: the rods and pearls it took are behind her even once she throws or places most of them. */
const eyeMade = (facts: MilestoneFacts) => has(facts, EYE);
export const MILESTONES: readonly Milestone[] = Object.freeze([
  { name: 'スポーン', condition: '始めから', why: '周りの木・動物・村を見る', done: () => true },
  { name: '木', condition: '原木か板材を持つ', why: '作業台と道具はすべて木から', done: facts => has(facts, /_(?:log|planks)$/u) || has(facts, /^crafting_table$/u) },
  { name: '木と石のツルハシ', condition: 'stone_pickaxe を持つ', why: '石が掘れ、丸石で道具とかまどが作れる', done: facts => has(facts, STONE_TIER_PICKAXE), anchor: true },
  { name: '石の斧', condition: 'stone_axe 以上を持つ', why: '木を早く集められる', done: facts => has(facts, /^(?:stone|iron|diamond|netherite)_axe$/u) },
  { name: '木材', condition: '板材にして12枚分以上', why: '作業台・棒・ベッド・チェストに要る', done: facts => sum(facts, [/_log$/u, 4], [/_planks$/u, 1]) >= 12 },
  { name: '食料と羊とベッド', condition: 'ベッドと食べ物6個', why: '夜を飛ばせ、空腹で回復が止まらない（鉄より先）',
    kept: facts => (has(facts, BED_ITEM) || facts.bedPlaced === true) && countMatching(facts.counts, EDIBLE_FOOD) >= FOOD_KEPT,
    done: facts => has(facts, STONE_TIER_PICKAXE) && (has(facts, BED_ITEM) || facts.bedPlaced === true) && fed(facts.counts), anchor: true },
  { name: '村の回収', condition: '持ち物では見えない', why: '村があればベッド・食料・鉄が早い', done: null, optional: true },
  // Run 17 mined iron 3, 8, 8 and 13 at a time and smelted and waited each time: the step says to take it all at once.
  { name: '鉄', condition: 'iron_pickaxe を持つ', why: '鉄鉱石は一度に30個掘る（ツルハシ3・バケツ3・防具24）', done: facts => has(facts, IRON_TIER_PICKAXE), anchor: true },
  { name: 'バケツ', condition: 'bucket を持つ', why: '黒曜石を作る水を運ぶ', done: facts => has(facts, IRON_TIER_PICKAXE) && has(facts, BUCKET_ITEM), anchor: true },
  // Run 16: down for diamonds at night with no armour. The bucket is part of it, or armour made first would pass the bucket.
  { name: '鉄の全身の防具', condition: '兜・胸当て・脚・靴を鉄で着る（鉄24）', why: '受ける傷が約6割減る。余裕があれば予備のツルハシ（鉄3）も',
    done: facts => has(facts, IRON_TIER_PICKAXE) && has(facts, BUCKET_ITEM) && fullArmor(facts.counts), anchor: true },
  { name: 'ダイヤ', condition: 'diamond_pickaxe を持つ', why: '黒曜石はこれでしか掘れない', done: facts => has(facts, DIAMOND_TIER_PICKAXE), anchor: true },
  // The frame takes the obsidian: with the flint and steel (made to light it) the obsidian step stays behind her.
  { name: '黒曜石', condition: 'obsidian を10個', why: 'ゲートの枠に最小10個', anchor: true,
    done: facts => has(facts, DIAMOND_TIER_PICKAXE) && (has(facts, /^obsidian$/u, 10) || has(facts, /^flint_and_steel$/u)) },
  { name: 'ゲート', condition: '枠を建てて火をつけ、入る', why: 'ネザーへの入口', done: nether, anchor: true },
  { name: 'ネザー', condition: 'ネザーに入った', why: '要塞とブレイズはネザーにだけある', done: nether, anchor: true },
  { name: 'ネザー要塞', condition: 'ブレイズロッドを持つ', why: 'ブレイズは要塞にだけ湧く', done: facts => has(facts, BLAZE) || eyeMade(facts), anchor: true },
  { name: 'ブレイズ', condition: 'ロッド6本分（パウダー12、目安は8本）', why: 'アイ12個にパウダーが12要る', anchor: true,
    done: facts => sum(facts, [/^blaze_rod$/u, 2], [/^blaze_powder$/u, 1], [EYE, 1]) >= 12 || eyeMade(facts) },
  // Not an anchor: pearls gathered first (endermen) must not pass the blaze rods still missing.
  { name: 'パール', condition: 'パール12個分', why: 'アイの材料', done: facts => sum(facts, [/^ender_pearl$/u, 1], [EYE, 1]) >= 12 || eyeMade(facts) },
  // Eyes break as they are thrown and go into the frames: eight are enough to call this step passed (`EYES_TO_SEARCH`).
  { name: 'アイ', condition: 'ender_eye を12個', why: '要塞を探し、ポータルの枠を埋める', done: facts => has(facts, EYE, 8), anchor: true },
  { name: 'エンド要塞', condition: '持ち物では見えない', why: 'エンドへのポータルがある', done: null },
  { name: 'ベッドで地点', condition: '持ち物では見えない', why: 'エンドで死んでも要塞の近くから戻れる', done: null },
  { name: 'カボチャ', condition: 'carved_pumpkin を持つ', why: '頭に着けるとエンダーマンが怒らない', done: facts => has(facts, /^carved_pumpkin$/u) },
  { name: 'エンド', condition: 'エンドに入った', why: 'ドラゴンがいる', done: facts => facts.dimension === 'the_end', anchor: true },
  { name: 'クリスタル', condition: '持ち物では見えない', why: 'ドラゴンの回復の元', done: null },
  { name: 'ドラゴン', condition: '討伐の確かめ（goal-evidence）', why: '頼まれた目標', done: null },
]);

/**
 * Where she is in the owner's order: the step after the last anchor reached (every step before it passed), skipping the steps
 * reached by chance on the way and the optional ones, and the step after it. Stateless, from the facts alone.
 */
export function milestoneNow(facts: MilestoneFacts): { now: Milestone; next: Milestone | null } {
  const lastAnchor = MILESTONES.reduce((last, milestone, index) => milestone.anchor && milestone.done?.(facts) ? index : last, -1);
  const open = (index: number) => !MILESTONES[index]!.optional && !MILESTONES[index]!.done?.(facts);
  let now = MILESTONES.findIndex((_, index) => index > lastAnchor && open(index));
  if (now < 0) now = MILESTONES.length - 1;
  // A kept step passed by a later anchor and still open comes first (the bed and the food before the bucket and the armour).
  const kept = facts.dimension === 'overworld' && !nether(facts)
    ? MILESTONES.findIndex((milestone, index) => milestone.kept && index < now && !milestone.kept(facts)) : -1;
  // Its next is the step it came back from, not one already behind her.
  if (kept >= 0) return { now: MILESTONES[kept]!, next: MILESTONES[now]! };
  const next = MILESTONES.findIndex((milestone, index) => index > now && !milestone.optional);
  return { now: MILESTONES[now]!, next: next < 0 ? null : MILESTONES[next]! };
}
/** The two lines a decision carries (`milestone`): the step now with its condition and reason, and the next one. Fixed words only. */
export function milestoneLines(facts: MilestoneFacts): string[] {
  const { now, next } = milestoneNow(facts);
  return [`今の節目: ${now.name}（条件: ${now.condition}。なぜ: ${now.why}）`, ...(next ? [`次の節目: ${next.name}（条件: ${next.condition}）`] : [])];
}

/** A finished call of hers: the tool and its arguments as she gave them. */
export interface AdoptionCall { name: string; input: unknown }
/** A test of a call, with the body tools it can match and whether it reads no argument (`adoptionTools`). */
type Matcher = ((call: AdoptionCall) => boolean) & { tools: readonly string[]; anyArgument: boolean };
interface Adoption { tag: string; skills: readonly string[]; matches: Matcher }

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
const matcher = (tools: readonly string[], anyArgument: boolean, test: (call: AdoptionCall) => boolean): Matcher => Object.assign(test, { tools, anyArgument });
const tool = (name: string, key: string, test: RegExp) => matcher([name], false, call => call.name === name && test.test(argument(call, key) ?? ''));
const anyOf = (...tests: Matcher[]) =>
  matcher(tests.flatMap(test => test.tools), tests.every(test => test.anyArgument), call => tests.some(test => test(call)));
const VILLAGE = /village/u, TOOLCHAIN_ITEMS = /^(?:[a-z_]+_planks|stick|crafting_table|wooden_pickaxe|stone_pickaxe|wooden_axe|stone_axe|stone_sword)$/u;
const villageCheck = anyOf(tool('mc.recall-places', 'kind', VILLAGE), tool('mc.find-structure', 'structureType', VILLAGE),
  tool('mc.explore-for-structure', 'structureType', VILLAGE));
const STRONGHOLD_TYPE = /^stronghold$/u, RAW_FOOD = /^(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/u;
const named = (name: string) => matcher([name], true, call => call.name === name);
const RETREAT = 'mc-night-retreat', SHELTER = 'mc-night-shelter';

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
  { tag: 'bed_sleep', skills: [BED, FOOD_BED, RETREAT, SHELTER], matches: named('mc.sleep-in-bed') },
  { tag: 'shelter_dig', skills: [RETREAT, SHELTER], matches: named('mc.dig-shelter') },
  { tag: 'shelter_build', skills: [RETREAT, SHELTER], matches: tool('mc.build-around-self', 'structureName', /^slit_shelter$/u) },
  { tag: 'water_leave', skills: [RETREAT, SHELTER], matches: named('mc.leave-water') },
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
  { tag: 'descend', skills: [DIAMOND, RETREAT, SHELTER], matches: named('mc.stair-mine') },
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

/**
 * The body tools a skill's adoption calls use (`ADOPTIONS`) that say it by their name alone: what a gist that names no tool is followed
 * by (`minecraftSkillContext`; the follow is counted by the tool's name, its arguments unseen). A tool whose adoption reads an argument
 * counts only when no other skill's adoption uses it (`use-item-on-entity` is the eyes' alone; `use-item-on-block` is water, shears and
 * eyes, so none of them).
 */
export function adoptionTools(skill: string): Set<string> {
  const own = ADOPTIONS.filter(adoption => adoption.skills.includes(skill));
  // A skill and its successor (draft-9's night shelter of the night retreat) are one: a tool both use is still theirs alone.
  const family = (name: string) => name === SHELTER ? RETREAT : name;
  const alone = (name: string) => ADOPTIONS.every(adoption =>
    !adoption.matches.tools.includes(name) || adoption.skills.every(item => family(item) === family(skill)));
  return new Set(own.flatMap(adoption => adoption.matches.tools.filter(name => adoption.matches.anyArgument || alone(name))));
}

/** For a call made while the named skills were pointed: each pointed skill and the tag the call matched (none when it matched nothing). */
export function adoptionTags(pointed: readonly string[], call: AdoptionCall): Array<{ skill: string; tag: string }> {
  return ADOPTIONS.filter(adoption => adoption.matches(call)).flatMap(adoption =>
    adoption.skills.filter(skill => pointed.includes(skill)).map(skill => ({ skill, tag: adoption.tag })));
}
