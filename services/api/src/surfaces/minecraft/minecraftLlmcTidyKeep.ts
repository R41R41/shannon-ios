import type { PlanKind } from '@shannon/mind';
import { materialsOf, type Material } from './minecraftLlmcRecipes.js';

/**
 * 2026-11-13 (flow design C-5): the materials the plan's current and next nodes will spend, so that the drop candidates and tidy's `keep=` name the
 * same things. By the node's kind (the plan facts carry the kind, not the target): what a kind of node makes is the table's own recipe
 * (`materialsOf`), counted for one of each. A material that she can also get by smelting (iron_ingot from raw_iron) holds the raw ore back as well,
 * and what smelts it (coal) is held for the iron. Only what the pack holds is listed, never more than it holds.
 */
const MAKES: Readonly<Partial<Record<PlanKind, readonly string[]>>> = {
  iron: ['iron_pickaxe', 'shield', 'bucket'],
  iron_armor: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'],
  prep_descent: ['shield', 'bucket'],
  obsidian: ['bucket', 'flint_and_steel'],
  portal: ['flint_and_steel'],
  nether: ['flint_and_steel'],
};
/** Not an item of the pack (a kind of the table): never listed. */
const KINDS_OF_TABLE: ReadonlySet<string> = new Set(['planks', 'log', 'wool']);
const SMELTS_FROM: Readonly<Record<string, string>> = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold' };

/** What the nodes of these kinds hold back, by item (the pack's items only; counts capped by what is carried). */
export function planMaterials(kinds: readonly PlanKind[], carried: ReadonlyMap<string, number>): Map<string, number> {
  const need = new Map<string, number>();
  for (const kind of new Set(kinds)) {
    for (const made of MAKES[kind] ?? []) {
      for (const part of materialsOf(made, 1, { chain: true }).spends as Material[]) {
        if (!KINDS_OF_TABLE.has(part.item)) need.set(part.item, (need.get(part.item) ?? 0) + part.count);
        else if (part.item === 'planks') need.set('planks', (need.get('planks') ?? 0) + part.count);
      }
    }
  }
  const out = new Map<string, number>();
  const hold = (item: string, count: number) => {
    const have = carried.get(item) ?? 0;
    if (have > 0 && count > 0) out.set(item, Math.min(have, Math.max(out.get(item) ?? 0, count)));
  };
  for (const [item, count] of need) {
    if (item === 'planks') continue;
    hold(item, count);
    const raw = SMELTS_FROM[item];
    if (raw) hold(raw, count);
  }
  const iron = need.get('iron_ingot') ?? 0;
  if (iron > 0 && (carried.get('raw_iron') ?? 0) > 0) hold('coal', Math.ceil(iron / 8));
  return out;
}
/** `iron_ingot:24,raw_iron:8` (the largest first, six at most), or '' for none. */
export const keepWordsOf = (held: ReadonlyMap<string, number>): string =>
  [...held].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([item, count]) => `${item}:${count}`).join(',');
