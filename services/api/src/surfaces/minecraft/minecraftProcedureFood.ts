import type { ProcedureMemory } from '@shannon/mind';
import { EDIBLE_FOOD } from './minecraftItems.js';
import { FOOD_STOCK, fed } from './minecraftStage.js';
import { carried, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { doing, type McMove } from './minecraftProcedureMoves.js';
import { finalFailure } from './minecraftProcedureUpkeep.js';

/**
 * The food of the opening (mb-r22, run 22: 130 s of the first five minutes went to a chicken the body "could not attack" for 62 s, and a
 * second chicken walked to 34 m that the arbiter cut, while the sheep taken for the bed's wool had already given the mutton). The food
 * is not what holds the opening: with `FOOD_ENOUGH` pieces in the pack the procedure goes on to the iron, and the furnaces' waits and the
 * detours after a call (`minecraftFillers.ts`) bring the rest. An animal that cannot be reached or hit is given up at once and the next
 * kind tried; a kind that fails is not asked again in the run, and the hunt ends without a stop of the run (it is small work).
 */
export const FOOD_ENOUGH = FOOD_STOCK;
/** Food short of this is looked for further off than the near animals. */
const FOOD_LOW = 3;
/** How far an animal is walked to for food: near when the pack holds some, further when it holds little. */
const NEAR = 24, FAR = 48;
/** What an animal gives, for ranking (a cow or a pig two or three pieces, a sheep one or two, a chicken one and it runs). */
const WORTH: Readonly<Record<string, number>> = Object.freeze({ cow: 2, pig: 2, mooshroom: 2, sheep: 1.5, rabbit: 0.8, chicken: 0.7 });

const edible = (facts: MinecraftProcedureFacts) => carried(facts, EDIBLE_FOOD);
const skipped = (memory: ProcedureMemory): Set<string> => {
  const known = memory.notes.get('food:skip');
  if (known instanceof Set) return known as Set<string>;
  const fresh = new Set<string>();
  memory.notes.set('food:skip', fresh);
  return fresh;
};

/** The animal named in a failure's words, `chicken に攻撃できません`, else the one asked for. */
function failedName(text: string, asked: string): string {
  return /(?:^|[^a-z_])([a-z_]{3,20})\s*に攻撃できません/u.exec(text)?.[1] ?? asked;
}

/** Food hunting is best effort: a failure is noted (the animal given up) and the run goes on, except the failures only the planner can settle. */
function giveUpOn(memory: ProcedureMemory, asked: string) {
  return (failure: string, text: string): boolean => {
    if (finalFailure(failure)) return false;
    skipped(memory).add(failedName(text, asked));
    memory.notes.set('food:misses', Number(memory.notes.get('food:misses') ?? 0) + 1);
    return true;
  };
}

/** The animals in reach, the best first: what they give against how far they are (a sheep for the bed's wool counts, it gives mutton). */
function animals(facts: MinecraftProcedureFacts, memory: ProcedureMemory, within: number): Array<{ name: string; distance: number }> {
  const out = facts.needs.filter(need => (need.need === 'food' || need.need === 'bed_wool') && need.canReach && (need.distance ?? Infinity) <= within)
    .map(need => ({ name: need.need === 'bed_wool' ? 'sheep' : need.name, distance: need.distance ?? Infinity }))
    .filter(animal => !skipped(memory).has(animal.name));
  return out.sort((a, b) => a.distance / (WORTH[a.name] ?? 1) - b.distance / (WORTH[b.name] ?? 1));
}

/** Food enough to go on: an animal in reach hunted, else any food animal near when the pack holds little; null when it holds enough or the hunt is given up. */
export function foodMove(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  const food = edible(facts);
  if (fed(facts.counts) || food >= FOOD_ENOUGH || Number(memory.notes.get('food:misses') ?? 0) >= 2) return null;
  const best = animals(facts, memory, food < FOOD_LOW ? FAR : NEAR)[0];
  if (best) {
    return doing({ tool: 'mc.attack-continuously', input: { entityName: best.name, maxKills: 2, maxDistance: 32 }, why: '食べ物の動物を取る',
      expectMs: 20_000, key: `food:${best.name}:${food}`, accepts: giveUpOn(memory, best.name) });
  }
  if (food >= FOOD_LOW || memory.notes.has('food:blind')) return null;
  memory.notes.set('food:blind', true);
  return doing({ tool: 'mc.attack-continuously', input: { entityName: 'food_animals', maxKills: 3, maxDistance: 32 }, why: '食べ物の動物を探して取る',
    expectMs: 30_000, key: `food:any:${food}`, accepts: giveUpOn(memory, 'food_animals') });
}
