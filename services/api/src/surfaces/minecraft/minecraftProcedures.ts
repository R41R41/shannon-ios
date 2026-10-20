import type { Procedure, ProcedureMemory } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { MILESTONES } from './minecraftStage.js';
import type { MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import type { McMove } from './minecraftProcedureMoves.js';
import { axeMove, bedAndFoodMove, pickaxeMove, storeMove, woodMove } from './minecraftProceduresEarly.js';
import { IRON_PLAN, ironHeld, ironMove, type ProcedureTaskStore } from './minecraftProceduresIron.js';
import { diamondMove, gateMove, obsidianMove } from './minecraftProceduresDeep.js';

/**
 * The milestones' procedures, one place for both forms (session mb-arch, owner 2026-10-20: the planner chooses the procedure, the
 * executor runs it): the words a decision is shown when it drifts from the step (`say`, mb-head's PROCEDURES of run 19, used by
 * `minecraftMilestoneFollow.ts`), and the moves the executor makes (`move`), keyed by the milestone's name (`MILESTONES`). A step is done
 * when its milestone is (`Milestone.done`, the one definition), the armour's when the spare pickaxe is made too or no iron is left for it.
 */
/** The executor's tool the planner starts a procedure with (`minecraftProcedureTool.ts`). */
export const MINECRAFT_PROCEDURE_TOOL = 'mc.run-procedure';

export interface ProcedureContext {
  store: ProcedureTaskStore;
  /** The body's tool that casts obsidian many at a time, when its catalog offers one. */
  batchObsidian: string | null;
}
interface Step {
  say: readonly string[];
  move(facts: MinecraftProcedureFacts, memory: ProcedureMemory, context: ProcedureContext): McMove;
}

const LOG_STEP = 'mc.mine-block（blockName=近くの原木1種類、例 oak_log。「,」で並べない、count=3 以上。原木1個で板4枚、板12枚分まで）';
const BED_WORDS = [
  '羊を探す: mc.find-nearest-entity（entityType=sheep、maxDistance=128）。見えている羊は mc.attack-continuously（entityName=sheep、maxKills=3）',
  '同じ色の羊毛3個と板材3枚で mc.craft-one（itemName=white_bed など羊毛の色の _bed）',
  '128 m に羊が居なければ探しに出る: mc.explore-for-structure（structureType=sheep、持っている羊毛の色を color に）か、'
    + '村 mc.explore-for-structure（structureType=village、maxDistance=160）。村なら家のベッドを壊して持つ',
  '焼いた食料が6個に足りなければ mc.attack-continuously（entityName=food_animals、maxKills=4）→ mc.start-smelting（inputItem=beef など）',
];
const IRON_WORDS = ['mc.mine-block（blockName=iron_ore、count=30、searchRadius=48）→ かまど2台で mc.start-smelting（inputItem=raw_iron）'
  + '→ mc.craft-one（itemName=iron_pickaxe）'];
const STEPS: ReadonlyMap<string, Step> = new Map<string, Step>([
  ['木', { say: [LOG_STEP], move: woodMove }],
  ['木と石のツルハシ', { say: ['mc.craft-one（itemName=wooden_pickaxe）→ mc.mine-block（blockName=stone、count=8）→ mc.craft-one（itemName=stone_pickaxe）'],
    move: pickaxeMove }],
  ['石の斧', { say: ['mc.craft-one（itemName=stone_axe。丸石3・棒2）'], move: axeMove }],
  ['木材', { say: [LOG_STEP], move: storeMove }],
  ['食料と羊とベッド', { say: BED_WORDS, move: bedAndFoodMove }],
  ['鉄', { say: IRON_WORDS, move: (facts, memory, context) => ironMove(facts, memory, context.store) }],
  ['バケツ', { say: ['mc.craft-one（itemName=bucket。鉄3）'], move: (facts, memory, context) => ironMove(facts, memory, context.store) }],
  ['鉄の全身の防具', { say: ['mc.craft-one（itemName=iron_helmet・iron_chestplate・iron_leggings・iron_boots。鉄24）'
    + '→ mc.equip-item（itemName=iron_chestplate、destination=torso など）'],
    move: (facts, memory, context) => ironMove(facts, memory, context.store) }],
  // Owner 2026-10-20 (30 minutes to the Nether): the way from diamonds to the gate, with the body's own tools (Minebot catalog).
  ['ダイヤ', { say: [
    'mc.stair-mine（targetY=-58）→ mc.mine-block（blockName=deepslate_diamond_ore,diamond_ore、count=3、searchRadius=32）→ mc.craft-one（itemName=diamond_pickaxe）',
    '見つからなければ mc.stair-mine の direction を変えて横へ約20ブロック進み、また mine-block'], move: diamondMove }],
  ['黒曜石', { say: [
    'mc.find-blocks（blockName=lava、maxDistance=32）→ mc.use-item-on-block（溶岩の座標、itemName=water_bucket）→ mc.mine-block（blockName=obsidian、count=10）',
    '水はバケツで汲み戻す: mc.use-item-on-block（水の座標、itemName=bucket）。流れる溶岩は丸石になるので、溜まり（源）にかける'],
  move: (facts, memory, context) => obsidianMove(facts, memory, context.batchObsidian) }],
  ['ゲート', { say: [
    '火打石: mc.mine-block（blockName=gravel、count=10）→ mc.craft-one（itemName=flint_and_steel）',
    '平らな地面で mc.build-structure（structureName=nether_portal、x、y、z、facing）→ 点いたか観測で確かめ → mc.enter-portal（枠の内側の座標）'],
  move: (facts, memory, context) => gateMove(facts, memory, context.store) }],
]);

/** The milestones the executor can run, in the owner's order. */
export const PROCEDURE_MILESTONES: readonly string[] = Object.freeze(MILESTONES.map(milestone => milestone.name).filter(name => STEPS.has(name)));

/** The words a drifting decision is shown for a milestone (empty for one without a procedure). */
export function procedureWords(milestone: string): readonly string[] {
  return STEPS.get(milestone)?.say ?? [];
}

/** The armour's step goes on to the spare pickaxe while the iron for it is there. */
function spareDone(facts: MinecraftProcedureFacts): boolean {
  return IRON_PLAN.every(planned => planned.have(facts)) || ironHeld(facts) < 3;
}

/** The procedures from `from` to `through` (both included, in the owner's order); empty when `from` has none or comes after `through`. */
export function minecraftProcedureChain(from: string, through: string | null,
  context: ProcedureContext): Procedure<MinecraftProcedureFacts, MinecraftWorkItem>[] {
  const start = PROCEDURE_MILESTONES.indexOf(from);
  const end = through === null ? start : PROCEDURE_MILESTONES.indexOf(through);
  if (start < 0 || end < start) return [];
  return PROCEDURE_MILESTONES.slice(start, end + 1).map(name => {
    const milestone = MILESTONES.find(item => item.name === name)!;
    const step = STEPS.get(name)!;
    return {
      id: name,
      done: facts => milestone.done?.(facts.milestone) === true && (name !== '鉄の全身の防具' || spareDone(facts)),
      next: (facts, memory) => step.move(facts, memory, context),
    };
  });
}
