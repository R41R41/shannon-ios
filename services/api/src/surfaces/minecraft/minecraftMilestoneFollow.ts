import { ADOPTIONS, type AdoptionCall } from './minecraftStage.js';
import { MINECRAFT_PROCEDURE_TOOL, PROCEDURE_MILESTONES, procedureWords } from './minecraftProcedures.js';

/**
 * The owner's order (`milestone`) followed or not, decision by decision (Minecraft run 18, 2026-10-20: the step was 「木材」 for twelve
 * decisions and 「食料と羊とベッド」 for the next twenty-seven, and not one of them searched for sheep or a village; sheep were 25-41 m
 * away at the start). A daytime decision that calls body tools and none of them works at the step now counts once; one that does
 * clears the count. From `MILESTONE_DRIFT.decisions` in a row on, the step's own procedure, with tools and arguments, is put at the
 * head of the decision's pointers (`milestoneSteps`) until a decision follows it. Fixed words, closed facts; kept in the checkpoint.
 */
export const MILESTONE_DRIFT = Object.freeze({ decisions: 3 });

interface Procedure { tags: readonly string[]; tools?: readonly string[]; also?: (call: AdoptionCall) => boolean }
const WOOD = ['wood_gather', 'tool_craft'], IRON = ['iron_find', 'iron_mine', 'iron_smelt', 'iron_tool_craft', 'iron_armor_craft', 'descend'];
const FURNACE = ['mc.withdraw-from-furnace'];
const argumentOf = (call: AdoptionCall, key: string) => {
  const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {};
  return typeof input[key] === 'string' ? String(input[key]).toLowerCase() : '';
};
/** Making and setting the furnace or the table the iron is smelted and crafted at (the review of run 18: counted as going elsewhere). */
const ironPrep = (call: AdoptionCall) => (call.name === 'mc.craft-one' && /^(?:furnace|crafting_table|stick)$/u.test(argumentOf(call, 'itemName')))
  || (call.name === 'mc.place-block-at' && /^(?:furnace|crafting_table)$/u.test(argumentOf(call, 'blockName')));
const BED_STEP = '食料と羊とベッド';
/** Gravel for the flint of the flint and steel. */
const gravel = (call: AdoptionCall) => call.name === 'mc.mine-block' && /gravel/u.test(argumentOf(call, 'blockName'));
/**
 * By the milestone's name (`MILESTONES`): how a call is seen to work at it. Its procedure's words live with the executor's moves for it
 * (`procedureWords`, `minecraftProcedures.ts`, session mb-arch): one place for both.
 */
const PROCEDURES: ReadonlyMap<string, Procedure> = new Map<string, Procedure>([
  ['木', { tags: WOOD }],
  ['木と石のツルハシ', { tags: [...WOOD, 'stone_mine'] }],
  ['石の斧', { tags: WOOD }],
  ['木材', { tags: WOOD }],
  // Not the furnace: run 18 took iron out of it at D34 and D35 while this was the step.
  [BED_STEP, { tags: ['sheep_search', 'sheep_hunt', 'bed_craft', 'bed_sleep', 'food_hunt', 'food_cook', 'village_check', 'village_loot', 'village_food'] }],
  ['鉄', { tags: IRON, tools: FURNACE, also: ironPrep }],
  ['バケツ', { tags: IRON, tools: FURNACE, also: ironPrep }],
  // Owner 2026-10-20 (30 minutes to the Nether): the way from diamonds to the gate, with the body's own tools (Minebot catalog).
  ['ダイヤ', { tags: ['descend', 'diamond_find', 'diamond_mine', 'diamond_tool_craft'] }],
  ['黒曜石', { tags: ['lava_find', 'water_pour', 'lava_pour', 'obsidian_mine'], also: gravel }],
  ['ゲート', { tags: ['portal_build', 'portal_enter', 'diamond_tool_craft'], also: gravel }],
  ['鉄の全身の防具', { tags: IRON, tools: [...FURNACE, 'mc.equip-item'], also: ironPrep }],
]);

/** The executor's procedure started at or through the step (`mc.run-procedure`, mb-arch) works at it. */
function runsProcedure(milestone: string, call: AdoptionCall): boolean {
  if (call.name !== MINECRAFT_PROCEDURE_TOOL) return false;
  const from = PROCEDURE_MILESTONES.indexOf(argumentOf(call, 'milestone')), at = PROCEDURE_MILESTONES.indexOf(milestone);
  const through = argumentOf(call, 'through') ? PROCEDURE_MILESTONES.indexOf(argumentOf(call, 'through')) : from;
  return from >= 0 && at >= from && at <= Math.max(from, through);
}

/** Whether a call works at the named step: a tag of its own (`ADOPTIONS`), one of its tools, or the executor's procedure for it. */
export function followsMilestone(milestone: string, call: AdoptionCall): boolean {
  const procedure = PROCEDURES.get(milestone);
  if (!procedure) return false;
  return procedure.tools?.includes(call.name) === true || procedure.also?.(call) === true || runsProcedure(milestone, call)
    || ADOPTIONS.some(adoption => procedure.tags.includes(adoption.tag) && adoption.matches(call));
}

/**
 * The fixed words put first: the step, how many daytime decisions in a row went elsewhere, and its procedure. `lead`: a bed or a
 * village she knows of (`minecraftBedLead.ts`), first in the bed's step (run 19: an igloo's bed 13 m away was never taken).
 */
export function milestoneSteps(milestone: string, decisions: number, lead?: string | null): string[] {
  if (!PROCEDURES.has(milestone)) return [];
  const first = milestone === BED_STEP && lead ? [lead] : [];
  return [`今の節目「${milestone}」から${decisions}回続けて別のことをした。いまの作業の区切りで、まずこれを進める:`, ...first, ...procedureWords(milestone)];
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
  const context = (milestone: string | null, calm: boolean, lead?: string | null): string[] => {
    now = milestone ? { milestone, calm } : null;
    return calm && milestone && before?.milestone === milestone && before.decisions >= MILESTONE_DRIFT.decisions
      ? milestoneSteps(milestone, before.decisions, lead) : [];
  };
  return {
    /** At the decision's context: the steps to put first (none while the count is short, at night, or for a step without them). */
    context,
    /** The decision's situation with the steps put first (`milestoneSteps`), told to `shown` with the count when there are any. */
    situate<T extends { milestoneName?: string | null; calm: boolean; bedLead?: string | null }>(situation: T): T & { milestoneSteps?: readonly string[] } {
      const steps = context(situation.milestoneName ?? null, situation.calm, situation.bedLead);
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