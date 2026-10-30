import type { actSpends } from './minecraftLlmcPromises.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { recipeOf } from './minecraftLlmcRecipes.js';
import { readLayers } from './minecraftLlmcPreflightMap.js';

/**
 * What the act's hands bring in, as far as the head can tell from their arguments and the frame (A-11 1): a
 * craft or a make gives what the table says (a craft gives whole batches), a dig of
 * a cell the map draws as a work table (`T`) or a bed (`B`) picks it up unless it says `collect: false`, and a
 * pickup that names an item takes at least one. A cell the map does not
 * show, a relative one, or an item the table does not have brings in nothing here (never a guess).
 */
export function gainsOf(hands: Parameters<typeof actSpends>[0], observation: BodyObservation | null): { item: string; count: number }[] {
  const out: { item: string; count: number }[] = [];
  const world = observation?.state.world;
  const localLayers = () =>
    world && typeof world === 'object' && !Array.isArray(world) && typeof (world as { localMap?: unknown }).localMap === 'string'
      ? readLayers((world as { localMap: string }).localMap)
      : null;
  const map = localLayers();
  for (const hand of hands) {
    const createsRecipe = (value: typeof hand): value is typeof hand & { item: string } =>
      (value.do === 'craft' || value.do === 'make') && !!value.item;
    if (createsRecipe(hand)) {
      const recipe = recipeOf(hand.item);
      if (recipe)
        out.push({
          item: hand.item.replace(/^minecraft:/u, ''),
          count: Math.ceil(Math.max(1, hand.count ?? 1) / recipe.yields) * recipe.yields,
        });
    } else if (hand.do === 'dig' && hand.collect !== false && hand.rel !== true && map) {
      for (const cell of hand.at ?? []) {
        const noteMapGain = () => {
          const at = cell as { x?: unknown; y?: unknown; z?: unknown };
          if (![at.x, at.y, at.z].every((value) => typeof value === 'number' && Number.isInteger(value))) return;
          const symbol = map.layers.get(at.y as number)?.get(`${at.x as number},${at.z as number}`);
          if (symbol === 'T') out.push({ item: 'crafting_table', count: 1 });
          else if (symbol === 'B') out.push({ item: 'bed', count: 1 });
        };
        noteMapGain();
      }
    } else if (hand.do === 'pickup' && typeof hand.target === 'string' && /^[a-z][a-z0-9_]*$/u.test(hand.target))
      out.push({ item: hand.target, count: 1 });
  }
  return out;
}
