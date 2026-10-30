import { carried } from './minecraftConditions.js';

/**
 * A small table of recipes (amendment A-10 2): what a `make` or a `craft` hand uses up, so that an act that would spend what a
 * promise holds back can be told before it is
 * sent. Only the things the plan works with are here (planks, sticks, the table, the furnace, the tools of the
 * four materials, the
 * armour, the bucket, the shield, torches,
 * a chest, flint and steel, slabs, a ladder, a bed, the eye of ender…). **A thing that is not here is not
 * counted** (`materialsOf`
 * says so, and the decision's record keeps the
 * item), never guessed: the head does not decide for the model, it only says what it can count.
 *
 * Names are the game's, except that a kind is written by its end: `planks` is any `*_planks`, `log` any `*_log`,
 * `wool` any `*_wool`
 * (the same match the conditions use:
 * `carried`). Numbers are the game's own (Java 1.21): `yields` is how many a single craft gives.
 */
export interface Material { item: string; count: number }
interface Recipe { yields: number; needs: readonly Material[] }

const HEAD: Readonly<Record<string, string>> = { wooden: 'planks', stone: 'cobblestone', iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond' };
const TOOLS: Readonly<Record<string, { head: number; sticks: number }>> = { pickaxe: { head: 3, sticks: 2 }, axe: { head: 3, sticks: 2 },
   sword: { head: 2, sticks: 1 },
  shovel: { head: 1, sticks: 2 }, hoe: { head: 2, sticks: 2 } };
const ARMOUR: Readonly<Record<string, number>> = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
const ARMOUR_OF: Readonly<Record<string, string>> = { iron: 'iron_ingot', golden: 'gold_ingot', diamond: 'diamond', leather: 'leather' };
const FIXED: Readonly<Record<string, Recipe>> = {
  stick: { yields: 4, needs: [{ item: 'planks', count: 2 }] },
  crafting_table: { yields: 1, needs: [{ item: 'planks', count: 4 }] },
  chest: { yields: 1, needs: [{ item: 'planks', count: 8 }] },
  furnace: { yields: 1, needs: [{ item: 'cobblestone', count: 8 }] },
  bucket: { yields: 1, needs: [{ item: 'iron_ingot', count: 3 }] },
  shield: { yields: 1, needs: [{ item: 'planks', count: 6 }, { item: 'iron_ingot', count: 1 }] },
  torch: { yields: 4, needs: [{ item: 'coal', count: 1 }, { item: 'stick', count: 1 }] },
  flint_and_steel: { yields: 1, needs: [{ item: 'iron_ingot', count: 1 }, { item: 'flint', count: 1 }] },
  ladder: { yields: 3, needs: [{ item: 'stick', count: 7 }] },
  bed: { yields: 1, needs: [{ item: 'wool', count: 3 }, { item: 'planks', count: 3 }] },
  blaze_powder: { yields: 2, needs: [{ item: 'blaze_rod', count: 1 }] },
  ender_eye: { yields: 1, needs: [{ item: 'blaze_powder', count: 1 }, { item: 'ender_pearl', count: 1 }] },
  bow: { yields: 1, needs: [{ item: 'stick', count: 3 }, { item: 'string', count: 3 }] },
  arrow: { yields: 4, needs: [{ item: 'flint', count: 1 }, { item: 'stick', count: 1 }, { item: 'feather', count: 1 }] },
  fishing_rod: { yields: 1, needs: [{ item: 'stick', count: 3 }, { item: 'string', count: 2 }] },
  shears: { yields: 1, needs: [{ item: 'iron_ingot', count: 2 }] },
  bread: { yields: 1, needs: [{ item: 'wheat', count: 3 }] },
  bowl: { yields: 4, needs: [{ item: 'planks', count: 3 }] },
  cobblestone_slab: { yields: 6, needs: [{ item: 'cobblestone', count: 3 }] },
};
/** What a `make` makes from its own recipe when she lacks it (the chain the body walks: planks from logs, sticks
 * from planks, powder from rods). */
const CHAIN: ReadonlySet<string> = new Set(['planks', 'stick', 'blaze_powder']);

/** The game's id without the namespace. */
const idOf = (item: string): string => item.replace(/^minecraft:/u, '');
/** The recipe of an item, or null when the table does not have it. A kind of planks is made from logs; a slab of
 * wood from planks. */
export function recipeOf(item: string): Recipe | null {
  const id = idOf(item);
  if (id === 'planks' || id.endsWith('_planks')) return { yields: 4, needs: [{ item: 'log', count: 1 }] };
  if (id === 'bed' || id.endsWith('_bed')) return FIXED.bed!;
  const fixed = FIXED[id];
  if (fixed) return fixed;
  const tool = /^(wooden|stone|iron|golden|diamond)_(pickaxe|axe|sword|shovel|hoe)$/u.exec(id);
  if (tool) {
    const kind = TOOLS[tool[2]!]!;
    return { yields: 1, needs: [{ item: HEAD[tool[1]!]!, count: kind.head }, { item: 'stick', count: kind.sticks }] };
  }
  const armour = /^(iron|golden|diamond|leather)_(helmet|chestplate|leggings|boots)$/u.exec(id);
  if (armour) return { yields: 1, needs: [{ item: ARMOUR_OF[armour[1]!]!, count: ARMOUR[armour[2]!]! }] };
  // A slab of wood: three planks make six.
  if (/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_slab$/u.test(id)) return { yields: 6, needs: [{
     item: 'planks', count: 3 }] };
  return null;
}

/** The kind a name stands for in the table (`oak_planks` is `planks`), for the pack's counts and the chain. */
const kindOf = (item: string): string => item === 'planks' || item.endsWith('_planks') ? 'planks' : item;

/**
 * What one hand makes uses up, in the table's names. `chain` (a `make`): a part she does not hold is made from
 * its own recipe where
 * the table has one (`planks`, `stick`,
 * `blaze_powder`); a part she holds is taken first. Without `chain` (a `craft`) a part she lacks is counted as it is (the craft
 * would stop on it). `pack` is what she carries
 * (`carried`'s counts); absent: nothing. `uncounted`: the item is not in the table, so nothing is counted for it.
 */
export function materialsOf(item: string, count: number, options: { chain: boolean; pack?: ReadonlyMap<string, number> }): { spends:
   Material[]; uncounted: boolean } {
  const target = recipeOf(item);
  if (!target || !Number.isFinite(count) || count < 1) return { spends: [], uncounted: !target };
  const left = new Map<string, number>();
  const spends = new Map<string, number>();
  const remaining = (kind: string): number => left.get(kind) ?? (options.pack ? carried(options.pack, kind) : 0);
  const add = (kind: string, n: number): void => { spends.set(kind, (spends.get(kind) ?? 0) + n); };
  const take = (needed: Material, depth: number): void => {
    const kind = kindOf(needed.item);
    const held = Math.min(remaining(kind), needed.count);
    if (held > 0) { left.set(kind, remaining(kind) - held);
      add(kind, held); }
    const deficit = needed.count - held;
    if (deficit <= 0) return;
    const own = options.chain && depth < 4 && CHAIN.has(kind) ? recipeOf(kind) : null;
    if (!own) { add(kind, deficit);
      return; }
    let batches = Math.ceil(deficit / own.yields), rest = 0;
    // Planks are made from the logs she holds, as many batches as she has logs; the rest of what is lacking is
// planks she is expected to hold.
    if (kind === 'planks' && batches > remaining('log')) { batches = remaining('log');
      rest = deficit - batches * own.yields; }
    if (batches > 0) for (const part of own.needs) take({ item: part.item, count: part.count * batches }, depth + 1);
    if (rest > 0) add(kind, rest);
  };
  const batches = Math.ceil(count / target.yields);
  for (const part of target.needs) take({ item: part.item, count: part.count * batches }, 1);
  return { spends: [...spends].map(([name, n]) => ({ item: name, count: n })), uncounted: false };
}
