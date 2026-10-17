/**
 * What a Minecraft body carries, as closed counts by item id (observation-redesign P1, measurement only). Read from a body
 * observation's `state.world.inventory` (stacks as `name×count`, bare names, or `{name, count}` entries, or a name-to-count object)
 * and from its `slot:*` facts. Only registry-shaped ids are kept; nothing a user wrote can enter a count.
 */
export type ItemCounts = ReadonlyMap<string, number>;

const ITEM_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const STACK = /^(?:minecraft:)?([a-z][a-z0-9_]{0,63})(?:×(\d{1,4}))?/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The item id and count of one inventory entry, or null when it names no registry-shaped item. */
function entry(value: unknown): [string, number] | null {
  if (typeof value === 'string') {
    const match = STACK.exec(value.trim());
    return match ? [match[1]!, match[2] ? Number(match[2]) : 1] : null;
  }
  const item = record(value);
  const name = typeof item?.name === 'string' ? item.name.replace(/^minecraft:/u, '') : '';
  if (!ITEM_ID.test(name)) return null;
  // No count means one; a stack the body reports with a count of zero (or less) is not carried.
  if (item?.count === undefined || item.count === null) return [name, 1];
  const count = Number(item.count);
  return Number.isFinite(count) && count >= 1 ? [name, Math.min(Math.floor(count), 4_096)] : null;
}

type Frame = Readonly<Record<string, unknown>> | null | undefined;
export function carriedItemCounts(world: Frame, facts: Frame): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (pair: [string, number] | null) => { if (pair) counts.set(pair[0], (counts.get(pair[0]) ?? 0) + pair[1]); };
  const inventory = world?.inventory;
  if (Array.isArray(inventory)) inventory.forEach(item => add(entry(item)));
  else if (record(inventory)) {
    for (const [name, raw] of Object.entries(record(inventory)!)) {
      const count = Math.floor(Number(raw));
      add(ITEM_ID.test(name) && Number.isFinite(count) && count > 0 ? [name, count] : null);
    }
  }
  // A slot fact names an item that may already be counted in the inventory list; it only adds an item the list lacks.
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (!key.startsWith('slot:') || typeof value !== 'string') continue;
    const pair = entry(value);
    if (pair && !counts.has(pair[0])) counts.set(pair[0], pair[1]);
  }
  return counts;
}

/** The total count of the carried items whose id passes `pattern`. */
export function countMatching(counts: ItemCounts, pattern: RegExp): number {
  let total = 0;
  for (const [name, count] of counts) if (pattern.test(name)) total += count;
  return total;
}

/** A bed of any colour, light_blue_bed and light_gray_bed too (the colour may hold an underscore); edrock is no bed. */
export const BED_ITEM = /^[a-z]+(?:_[a-z]+)*_bed$/u;
/** Cooked or ready-to-eat food items that count as a food stock. */
export const COOKED_FOOD = /^(?:cooked_[a-z]+|bread|baked_potato|steak|pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|golden_carrot|cookie|apple)$/u;
/** Food of any kind that she can eat (raw included): hungry with none of it carried is not a missed meal. */
export const EDIBLE_FOOD = new RegExp('^(?:cooked_[a-z]+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|baked_potato|potato|carrot|apple|steak|'
  + 'pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|golden_carrot|cookie|melon_slice|sweet_berries|dried_kelp|beetroot)$', 'u');
