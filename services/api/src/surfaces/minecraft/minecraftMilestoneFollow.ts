import { ADOPTIONS, type AdoptionCall } from './minecraftStage.js';

/**
 * The owner's order (`milestone`) followed or not, decision by decision (Minecraft run 18, 2026-10-20: the step was 「木材」 for twelve
 * decisions and 「食料と羊とベッド」 for the next twenty-seven, and not one of them searched for sheep or a village; sheep were 25-41 m
 * away at the start). A daytime decision that calls body tools and none of them works at the step now counts once; one that does
 * clears the count. From `MILESTONE_DRIFT.decisions` in a row on, the step's own procedure, with tools and arguments, is put at the
 * head of the decision's pointers (`milestoneSteps`) until a decision follows it. Fixed words, closed facts; kept in the checkpoint.
 */
export const MILESTONE_DRIFT = Object.freeze({ decisions: 3 });

interface Procedure { tags: readonly string[]; tools?: readonly string[]; also?: (call: AdoptionCall) => boolean; steps: readonly string[] }
const WOOD = ['wood_gather', 'tool_craft'], IRON = ['iron_find', 'iron_mine', 'iron_smelt', 'iron_tool_craft', 'iron_armor_craft', 'descend'];
const FURNACE = ['mc.withdraw-from-furnace'];
const argumentOf = (call: AdoptionCall, key: string) => {
  const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {};
  return typeof input[key] === 'string' ? String(input[key]).toLowerCase() : '';
};
/** Making and setting the furnace or the table the iron is smelted and crafted at (the review of run 18: counted as going elsewhere). */
const ironPrep = (call: AdoptionCall) => (call.name === 'mc.craft-one' && /^(?:furnace|crafting_table|stick)$/u.test(argumentOf(call, 'itemName')))
  || (call.name === 'mc.place-block-at' && /^(?:furnace|crafting_table)$/u.test(argumentOf(call, 'blockName')));
const LOG_STEP = 'mc.mine-block（blockName=近くの原木1種類、例 oak_log。「,」で並べない、count=3 以上。原木1個で板4枚、板12枚分まで）';
/** By the milestone's name (`MILESTONES`); a step not here (from the diamonds on) has no procedure to put first. */
const PROCEDURES: ReadonlyMap<string, Procedure> = new Map<string, Procedure>([
  ['木', { tags: WOOD, steps: [LOG_STEP] }],
  ['木と石のツルハシ', { tags: [...WOOD, 'stone_mine'],
    steps: ['mc.craft-one（itemName=wooden_pickaxe）→ mc.mine-block（blockName=stone、count=8）→ mc.craft-one（itemName=stone_pickaxe）'] }],
  ['石の斧', { tags: WOOD, steps: ['mc.craft-one（itemName=stone_axe。丸石3・棒2）'] }],
  ['木材', { tags: WOOD, steps: [LOG_STEP] }],
  // Not the furnace: run 18 took iron out of it at D34 and D35 while this was the step.
  ['食料と羊とベッド', { tags: ['sheep_search', 'sheep_hunt', 'bed_craft', 'bed_sleep', 'food_hunt', 'food_cook', 'village_check', 'village_loot', 'village_food'],
    steps: [
      '羊を探す: mc.find-nearest-entity（entityType=sheep、maxDistance=128）。見えている羊は mc.attack-continuously（entityName=sheep、maxKills=3）',
      '同じ色の羊毛3個と板材3枚で mc.craft-one（itemName=white_bed など羊毛の色の _bed）',
      '128 m に羊が居なければ探しに出る: mc.explore-for-structure（structureType=sheep、持っている羊毛の色を color に）か、'
        + '村 mc.explore-for-structure（structureType=village、maxDistance=160）。村なら家のベッドを壊して持つ',
      '焼いた食料が6個に足りなければ mc.attack-continuously（entityName=food_animals、maxKills=4）→ mc.start-smelting（inputItem=beef など）',
    ] }],
  ['鉄', { tags: IRON, tools: FURNACE, also: ironPrep,
    steps: ['mc.mine-block（blockName=iron_ore、count=30、searchRadius=48）→ かまど2台で mc.start-smelting（inputItem=raw_iron）→ mc.craft-one（itemName=iron_pickaxe）'] }],
  ['バケツ', { tags: IRON, tools: FURNACE, also: ironPrep, steps: ['mc.craft-one（itemName=bucket。鉄3）'] }],
  ['鉄の全身の防具', { tags: IRON, tools: [...FURNACE, 'mc.equip-item'], also: ironPrep,
    steps: ['mc.craft-one（itemName=iron_helmet・iron_chestplate・iron_leggings・iron_boots。鉄24）→ mc.equip-item（itemName=iron_chestplate、destination=torso など）'] }],
]);

/** Whether a call works at the named step: a tag of its own (`ADOPTIONS`) or one of its tools. */
export function followsMilestone(milestone: string, call: AdoptionCall): boolean {
  const procedure = PROCEDURES.get(milestone);
  if (!procedure) return false;
  return procedure.tools?.includes(call.name) === true || procedure.also?.(call) === true
    || ADOPTIONS.some(adoption => procedure.tags.includes(adoption.tag) && adoption.matches(call));
}

/** The fixed words put first: the step, how many daytime decisions in a row went elsewhere, and its procedure. */
export function milestoneSteps(milestone: string, decisions: number): string[] {
  const procedure = PROCEDURES.get(milestone);
  if (!procedure) return [];
  return [`今の節目「${milestone}」から${decisions}回続けて別のことをした。いまの作業の区切りで、まずこれを進める:`, ...procedure.steps];
}

type Drift = { milestone: string; decisions: number };
function driftOf(kept: unknown): Drift | null {
  const value = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept as Record<string, unknown> : null;
  const decisions = Number(value?.decisions);
  return typeof value?.milestone === 'string' && PROCEDURES.has(value.milestone) && Number.isSafeInteger(decisions) && decisions > 0
    ? { milestone: value.milestone, decisions: Math.min(decisions, 1_000) } : null;
}

/**
 * One step's part of the count: the count kept from earlier steps, this decision's step and whether it was by day (`context`), its
 * body calls (`note`), and the count to keep (`checkpoint`, the same however often it is asked).
 */
export function milestoneFollowMemory(kept: unknown, shown?: (decisions: number) => void) {
  const before = driftOf(kept);
  let now: { milestone: string; calm: boolean } | null = null, called = false, followed = false;
  const context = (milestone: string | null, calm: boolean): string[] => {
    now = milestone ? { milestone, calm } : null;
    return calm && milestone && before?.milestone === milestone && before.decisions >= MILESTONE_DRIFT.decisions
      ? milestoneSteps(milestone, before.decisions) : [];
  };
  return {
    /** At the decision's context: the steps to put first (none while the count is short, at night, or for a step without them). */
    context,
    /** The decision's situation with the steps put first (`milestoneSteps`), told to `shown` with the count when there are any. */
    situate<T extends { milestoneName?: string | null; calm: boolean }>(situation: T): T & { milestoneSteps?: readonly string[] } {
      const steps = context(situation.milestoneName ?? null, situation.calm);
      if (!steps.length) return situation;
      shown?.(before?.decisions ?? 0);
      return { ...situation, milestoneSteps: steps };
    },
    note(call: AdoptionCall): void {
      if (!call.name.startsWith('mc.')) return;
      called = true;
      if (now && followsMilestone(now.milestone, call)) followed = true;
    },
    checkpoint(): { minecraftMilestoneDrift: Drift | null } {
      // A decision at night or without a body call leaves the count as it was; a daytime one at a step without a procedure ends it.
      if (!now || !now.calm || !called) return { minecraftMilestoneDrift: before };
      if (!PROCEDURES.has(now.milestone)) return { minecraftMilestoneDrift: null };
      if (followed) return { minecraftMilestoneDrift: null };
      const decisions = (before?.milestone === now.milestone ? before.decisions : 0) + 1;
      return { minecraftMilestoneDrift: { milestone: now.milestone, decisions } };
    },
  };
}
